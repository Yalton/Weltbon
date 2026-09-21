import bcrypt from 'bcrypt';
import { SignJWT, jwtVerify } from 'jose';
import { randomBytes, randomUUID } from 'node:crypto';
import { and, eq, gt, isNotNull, isNull } from 'drizzle-orm';
import { db as getDb } from '../db/client.js';
import { refreshTokens } from '../db/schema.js';
import { env } from '../config.js';

export const BCRYPT_COST = 12;
export const ACCESS_TTL = '1h';
export const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
export const REFRESH_COOKIE_NAME = 'refresh';

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

export const REFRESH_GRACE_MS = 10_000;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;


export async function rotateRefreshToken(
  composite: string,
  dbHandle: DrizzleDb = getDb()
): Promise<{ userId: string; newToken: string | null } | null> {
  const [id, secret] = composite.split('.');
  if (!id || !secret) return null;
  if (!UUID_RE.test(id)) return null;

  return await dbHandle.transaction(async (tx) => {
    // Include revoked rows so a grace replay is distinguishable from stolen-token reuse.
    const row = await tx.query.refreshTokens.findFirst({
      where: and(
        eq(refreshTokens.id, id),
        gt(refreshTokens.expiresAt, new Date())
      ),
    });
    if (!row) return null;
    if (!(await bcrypt.compare(secret, row.tokenHash))) return null;

    const claimed = await tx
      .update(refreshTokens)
      .set({ revokedAt: new Date() })
      .where(and(eq(refreshTokens.id, id), isNull(refreshTokens.revokedAt)))
      .returning({ id: refreshTokens.id });

    if (claimed.length === 1) {
      const newToken = await issueRefreshToken(row.userId, tx as DrizzleDb);
      const newId = newToken.split('.')[0];
      await tx
        .update(refreshTokens)
        .set({ replacedById: newId })
        .where(eq(refreshTokens.id, id));
      return { userId: row.userId, newToken };
    }

    // Re-read the winner after the conditional claim to classify the losing request.
    const current = await tx.query.refreshTokens.findFirst({
      where: eq(refreshTokens.id, id),
      columns: { revokedAt: true, replacedById: true },
    });
    const revokedAt = current?.revokedAt;

    if (
      current?.replacedById != null &&
      revokedAt &&
      Date.now() - revokedAt.getTime() <= REFRESH_GRACE_MS
    ) {
      return { userId: row.userId, newToken: null };
    }
    return null;
  });
}

async function endGraceWindowForUser(tx: DrizzleDb, userId: string): Promise<void> {
  await tx
    .update(refreshTokens)
    .set({ replacedById: null })
    .where(and(eq(refreshTokens.userId, userId), isNotNull(refreshTokens.replacedById)));
}

export async function revokeRefreshToken(
  composite: string,
  dbHandle: DrizzleDb = getDb()
): Promise<void> {
  const [id] = composite.split('.');
  if (!id) return;
  await dbHandle.transaction(async (tx) => {
    const row = await tx.query.refreshTokens.findFirst({
      where: eq(refreshTokens.id, id),
      columns: { userId: true },
    });
    if (!row) return;

    await tx
      .update(refreshTokens)
      .set({ revokedAt: new Date() })
      .where(and(eq(refreshTokens.id, id), isNull(refreshTokens.revokedAt)));

    await endGraceWindowForUser(tx as DrizzleDb, row.userId);
  });
}

export async function revokeAllForUser(
  userId: string,
  dbHandle: DrizzleDb = getDb()
): Promise<number> {
  return await dbHandle.transaction(async (tx) => {
    const result = await tx
      .update(refreshTokens)
      .set({ revokedAt: new Date() })
      .where(and(eq(refreshTokens.userId, userId), isNull(refreshTokens.revokedAt)))
      .returning({ id: refreshTokens.id });

    await endGraceWindowForUser(tx as DrizzleDb, userId);

    return result.length;
  });
}

export async function verifyAccessToken(token: string): Promise<string> {
  const { payload } = await jwtVerify(token, env().jwtSecret, {
    algorithms: ['HS256'],
  });
  if (typeof payload.sub !== 'string') throw new Error('missing sub claim');
  return payload.sub;
}
