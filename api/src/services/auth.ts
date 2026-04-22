import * as jose from 'jose';
import { env } from '../config.js';

/**
 * Issues a short-lived access JWT (1 hour) for the given userId.
 * Used by auth routes and test helpers.
 */
export async function issueAccessToken(userId: string): Promise<string> {
  return new jose.SignJWT({ sub: userId })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('1h')
    .sign(env().jwtSecret);
}
