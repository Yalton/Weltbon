import { randomBytes } from 'node:crypto';
import { db, pool } from '../db/client.js';
import { inviteCodes } from '../db/schema.js';

async function main() {
  const code = randomBytes(12).toString('base64url'); // ~16 url-safe chars
  await db.insert(inviteCodes).values({ code });
  console.log(`Invite code: ${code}`);
  console.log(`Share this once. Consumed on first use.`);
  await pool.end();
}

main().catch((err) => {
  console.error('invite:new failed:', err);
  process.exit(1);
});
