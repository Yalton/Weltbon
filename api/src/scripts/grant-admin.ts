import { parseArgs } from 'node:util';
import { eq } from 'drizzle-orm';
import { closeDb, db } from '../db/client.js';
import { adminAuditLog, users } from '../db/schema.js';

async function main() {
  const { positionals } = parseArgs({ allowPositionals: true, strict: false });
  const [email] = positionals;
  if (!email) {
    console.error('Usage: pnpm --filter api user:grant-admin <email>');
    process.exit(1);
  }

  const user = await db().query.users.findFirst({ where: eq(users.email, email) });
  if (!user) {
    console.error(`No user with email: ${email}`);
    process.exit(1);
  }
  if (user.isAdmin) {
    console.log(`${email} is already an administrator.`);
    await closeDb();
    return;
  }

  await db().transaction(async (tx) => {
    await tx.update(users).set({ isAdmin: true }).where(eq(users.id, user.id));
    await tx.insert(adminAuditLog).values({
      actorEmail: 'system:cli',
      targetUserId: user.id,
      targetEmail: user.email,
      action: 'promoted',
      details: { source: 'user:grant-admin' },
    });
  });
  console.log(`Granted administrator access to ${email}.`);
  await closeDb();
}

main().catch(async (err) => {
  console.error('user:grant-admin failed:', err);
  await closeDb();
  process.exit(1);
});
