import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { API, SEED_FILE, psql, type Seed } from './seed';

/**
 * Best-effort cleanup: delete the seeded universe via the API (cascades its
 * entries/dictionary/pins/share tokens), then remove the e2e user + its invite
 * row directly. Never throws — a failed teardown must not fail the run.
 */
export default async function globalTeardown() {
  if (!existsSync(SEED_FILE)) return;
  let seed: Seed;
  try {
    seed = JSON.parse(readFileSync(SEED_FILE, 'utf8'));
  } catch {
    return;
  }

  try {
    await fetch(`${API}/universes/${seed.uid}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${seed.ownerToken}` },
    });
  } catch {
    /* ignore */
  }

  try {
    // Drop the consumed invite first (its consumed_by_user_id FK references the
    // user), then the user.
    psql(seed.dbHost, `delete from invite_codes where consumed_by_user_id = '${seed.userId}'`, {
      quiet: true,
    });
    psql(seed.dbHost, `delete from users where id = '${seed.userId}'`, { quiet: true });
  } catch {
    /* ignore */
  }

  try {
    unlinkSync(SEED_FILE);
  } catch {
    /* ignore */
  }
}
