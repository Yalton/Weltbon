import bcrypt from 'bcrypt';
import { SignJWT, jwtVerify } from 'jose';
import { randomBytes, randomUUID } from 'node:crypto';
import { and, eq, gt, isNull } from 'drizzle-orm';
import { db as defaultDb } from '../db/client.js';
import { refreshTokens } from '../db/schema.js';
import { env } from '../config.js';

export const BCRYPT_COST = 12;
export const ACCESS_TTL = '1h';
export const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
export const REFRESH_COOKIE_NAME = 'refresh';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type DrizzleDb = Pick<typeof defaultDb, 'insert' | 'update' | 'select' | 'delete' | 'query' | 'transaction'> & Record<string, any>;

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
  dbHandle: DrizzleDb = defaultDb
): Promise<string> {
  const id = randomUUID();
  const secret = randomBytes(32).toString('base64url');
  const tokenHash = await bcrypt.hash(secret, BCRYPT_COST);
  const expiresAt = new Date(Date.now() + REFRESH_TTL_MS);
  await dbHandle.insert(refreshTokens).values({ id, userId, tokenHash, expiresAt });
  return `${id}.${secret}`;
}

/**
 * Rotates a refresh token atomically: verifies the composite, revokes the old row,
 * and issues a new token in the same transaction.
 * Returns null if the composite is invalid / revoked / expired / wrong secret.
 */
export async function rotateRefreshToken(
  composite: string,
  dbHandle: DrizzleDb = defaultDb
): Promise<{ userId: string; newToken: string } | null> {
  const [id, secret] = composite.split('.');
  if (!id || !secret) return null;

  return await dbHandle.transaction(async (tx) => {
    const row = await tx.query.refreshTokens.findFirst({
      where: and(
        eq(refreshTokens.id, id),
        isNull(refreshTokens.revokedAt),
        gt(refreshTokens.expiresAt, new Date())
      ),
    });
    if (!row) return null;
    if (!(await bcrypt.compare(secret, row.tokenHash))) return null;

    await tx
      .update(refreshTokens)
      .set({ revokedAt: new Date() })
      .where(eq(refreshTokens.id, id));

    const newToken = await issueRefreshToken(row.userId, tx as DrizzleDb);
    return { userId: row.userId, newToken };
  });
}

/**
 * Revokes a specific refresh token (logout current session only).
 */
export async function revokeRefreshToken(
  composite: string,
  dbHandle: DrizzleDb = defaultDb
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
  dbHandle: DrizzleDb = defaultDb
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
