import bcrypt from 'bcrypt';
import { SignJWT, jwtVerify } from 'jose';
import { randomBytes, randomUUID } from 'node:crypto';
import { and, eq, gt, isNull } from 'drizzle-orm';
import { db as getDb } from '../db/client.js';
import { refreshTokens } from '../db/schema.js';
import { env } from '../config.js';

export const BCRYPT_COST = 12;
export const ACCESS_TTL = '1h';
export const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
export const REFRESH_COOKIE_NAME = 'refresh';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type DrizzleDb = Pick<ReturnType<typeof getDb>, 'insert' | 'update' | 'select' | 'delete' | 'query' | 'transaction'> & Record<string, any>;

export async function hashPassword(plaintext: string): Promise<string> {
  return bcrypt.hash(plaintext, BCRYPT_COST);
}

export async function verifyPassword(plaintext: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plaintext, hash);
}

export async function issueAccessToken(userId: string): Promise<string> {
  return new SignJWT({ sub: userId })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(ACCESS_TTL)
    .sign(env().jwtSecret);
}

/**
 * Issues a refresh token, storing its bcrypt hash in DB.
 * Returns a composite "<uuid>.<secret>" -- the client stores this opaque string.
 * @param userId - owner of the token
 * @param dbHandle - optional; defaults to the global db
 */
export async function issueRefreshToken(
  userId: string,
  dbHandle: DrizzleDb = getDb()
): Promise<string> {
  const id = randomUUID();
  const secret = randomBytes(32).toString('base64url');
  const tokenHash = await bcrypt.hash(secret, BCRYPT_COST);
  const expiresAt = new Date(Date.now() + REFRESH_TTL_MS);
  await dbHandle.insert(refreshTokens).values({ id, userId, tokenHash, expiresAt });
  return `${id}.${secret}`;
}

/**
 * How long after a token is rotated a replay of it still yields an ACCESS token.
 *
 * Exists for the benign concurrent case — two browser tabs, or a StrictMode
 * double-invoke, cold-loading at the same moment and both presenting the same
 * cookie. Without it the loser gets a 401 and the user is signed out of a
 * session with perfectly valid credentials.
 *
 * A replay inside the window grants NO refresh token (see below), so it buys an
 * attacker one access token's worth of time and no persistence at all.
 */
export const REFRESH_GRACE_MS = 10_000;

/**
 * Rotates a refresh token atomically: verifies the composite, revokes the old row,
 * and issues a new token in the same transaction.
 *
 * Returns null if the composite is invalid / expired / wrong secret, or if it was
 * revoked longer ago than REFRESH_GRACE_MS. `newToken === null` means "grant an
 * access token but do NOT rotate" — the benign-replay path; the caller must not
 * set a refresh cookie in that case.
 *
 * CONCURRENCY, learned the hard way. Filtering `isNull(revokedAt)` in the read
 * alone does NOT make rotation single-use: under READ COMMITTED two transactions
 * both pass the read before either commits, and the ~250ms `bcrypt.compare`
 * below makes that window very wide. Reproduced before this guard existed — two
 * concurrent refreshes of ONE cookie both returned 200 and left TWO live tokens,
 * silently defeating the reuse-detection that single-use rotation exists to
 * provide. The claiming UPDATE's `isNull(revokedAt)` predicate is what actually
 * serialises it: the loser's UPDATE blocks on the winner's row lock, re-evaluates
 * against the committed row, matches nothing, and returns zero rows.
 */
export async function rotateRefreshToken(
  composite: string,
  dbHandle: DrizzleDb = getDb()
): Promise<{ userId: string; newToken: string | null } | null> {
  const [id, secret] = composite.split('.');
  if (!id || !secret) return null;

  return await dbHandle.transaction(async (tx) => {
    // Deliberately NOT filtered on isNull(revokedAt): a revoked row must stay
    // readable so a benign concurrent replay can be told apart from a genuine
    // stolen-token reuse. Expiry is still enforced here.
    const row = await tx.query.refreshTokens.findFirst({
      where: and(
        eq(refreshTokens.id, id),
        gt(refreshTokens.expiresAt, new Date())
      ),
    });
    if (!row) return null;
    if (!(await bcrypt.compare(secret, row.tokenHash))) return null;

    // Claim the row. Exactly one concurrent caller can win this.
    const claimed = await tx
      .update(refreshTokens)
      .set({ revokedAt: new Date() })
      .where(and(eq(refreshTokens.id, id), isNull(refreshTokens.revokedAt)))
      .returning({ id: refreshTokens.id });

    if (claimed.length === 1) {
      const newToken = await issueRefreshToken(row.userId, tx as DrizzleDb);
      // Mark WHY this row was retired. Only rotation sets this; logout and
      // revokeAllForUser leave it null, which is what makes the grace window
      // below inapplicable to an explicit logout.
      const newId = newToken.split('.')[0];
      await tx
        .update(refreshTokens)
        .set({ replacedById: newId })
        .where(eq(refreshTokens.id, id));
      return { userId: row.userId, newToken };
    }

    // Lost the claim, or it was already revoked when we read it. Re-read for the
    // authoritative values: under READ COMMITTED this statement sees the winner's
    // committed row, which the snapshot above may predate.
    const current = await tx.query.refreshTokens.findFirst({
      where: eq(refreshTokens.id, id),
      columns: { revokedAt: true, replacedById: true },
    });
    const revokedAt = current?.revokedAt;

    // The grace window applies ONLY to a token retired by ROTATION. A token
    // revoked by logout (or by revokeAllForUser on a password change) has a null
    // replacedById and is refused immediately — logout must be absolute, and an
    // earlier version of this code that omitted the check kept a logged-out
    // session alive for the whole window.
    if (
      current?.replacedById != null &&
      revokedAt &&
      Date.now() - revokedAt.getTime() <= REFRESH_GRACE_MS
    ) {
      // Benign replay: an access token, and deliberately no new refresh token.
      // Granting one here would reopen the two-live-tokens hole this guard closes.
      return { userId: row.userId, newToken: null };
    }
    return null;
  });
}

/**
 * Revokes a specific refresh token (logout current session only).
 */
export async function revokeRefreshToken(
  composite: string,
  dbHandle: DrizzleDb = getDb()
): Promise<void> {
  const [id] = composite.split('.');
  if (!id) return;
  await dbHandle
    .update(refreshTokens)
    .set({ revokedAt: new Date() })
    .where(and(eq(refreshTokens.id, id), isNull(refreshTokens.revokedAt)));
}

/**
 * Revokes ALL active refresh tokens for a user (password change, user removal).
 */
export async function revokeAllForUser(
  userId: string,
  dbHandle: DrizzleDb = getDb()
): Promise<number> {
  const result = await dbHandle
    .update(refreshTokens)
    .set({ revokedAt: new Date() })
    .where(and(eq(refreshTokens.userId, userId), isNull(refreshTokens.revokedAt)))
    .returning({ id: refreshTokens.id });
  return result.length;
}

/**
 * Verifies an access token and returns the userId (sub claim).
 * Throws on any invalid state. ALWAYS passes algorithms: ['HS256'].
 */
export async function verifyAccessToken(token: string): Promise<string> {
  const { payload } = await jwtVerify(token, env().jwtSecret, {
    algorithms: ['HS256'],
  });
  if (typeof payload.sub !== 'string') throw new Error('missing sub claim');
  return payload.sub;
}
