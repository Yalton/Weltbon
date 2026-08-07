import { db, closeDb } from '../db/client.js';
import { inviteCodes } from '../db/schema.js';
import { generateInviteToken } from '../services/invite.js';

async function main() {
  const { plaintext, hash, bodySuffix } = generateInviteToken();
  await db()
    .insert(inviteCodes)
    .values({ ownerId: null, label: 'cli-mint', hash, bodySuffix });
  console.log(`Invite code: ${plaintext}`);
  console.log(`Share this once. Consumed on first use.`);
  await closeDb();
}

main().catch((err) => {
  console.error('invite:new failed:', err);
  process.exit(1);
});
