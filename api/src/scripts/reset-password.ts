import { parseArgs } from 'node:util';
import { eq } from 'drizzle-orm';
import { db, pool } from '../db/client.js';
import { users } from '../db/schema.js';
import { hashPassword, revokeAllForUser } from '../services/auth.js';

async function main() {
  const { positionals } = parseArgs({ allowPositionals: true, strict: false });
  const [email, newPassword] = positionals;

  if (!email || !newPassword) {
    console.error('Usage: pnpm --filter api user:reset-password <email> <new_password>');
    console.error('Minimum password length: 12 characters.');
    process.exit(1);
  }
  if (newPassword.length < 12) {
    console.error('Password must be at least 12 characters.');
    process.exit(1);
  }

  const user = await db().query.users.findFirst({ where: eq(users.email, email) });
  if (!user) {
    console.error(`No user with email: ${email}`);
    process.exit(1);
  }

  const passwordHash = await hashPassword(newPassword);
  await db().update(users).set({ passwordHash }).where(eq(users.id, user.id));
  const revoked = await revokeAllForUser(user.id);
  console.log(`Password updated for ${email}. Revoked ${revoked} refresh token(s).`);
  await pool().end();
}

main().catch((err) => {
  console.error('user:reset-password failed:', err);
  process.exit(1);
});
