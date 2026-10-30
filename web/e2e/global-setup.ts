import { writeFileSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import {
  API,
  BASE_URL,
  E2E_CALENDAR,
  E2E_PIN_POSITION,
  SEED_FILE,
  api,
  psql,
  resolveDbHost,
  type Seed,
} from './seed';

/**
 * Seeds a complete public-share fixture via the API (a universe with a calendar,
 * timeline window, a language entry + dictionary word, two public entries wired
 * together with [[wikilinks]], a timeline pin, and a share token) and writes the
 * result to e2e/seed.json for the spec to read.
 *
 * Registration requires a valid invite code, so we bootstrap one straight into
 * the DB (the only non-API step) before registering a fresh user.
 */
export default async function globalSetup() {
  // Fail fast with a friendly message if the stack isn't reachable.
  try {
    const health = await fetch(`${API.replace(/\/api$/, '')}/health`);
    if (!health.ok) throw new Error(String(health.status));
  } catch (e) {
    throw new Error(
      `App not reachable at ${BASE_URL} (${e}). Start it with: docker compose up -d --build`,
    );
  }

  const dbHost = resolveDbHost();

  // 1. Mint + insert an invite code (bootstraps auth — registration needs one).
  const body = randomBytes(32).toString('base64url');
  const invitePlain = `wbn_inv_${body}`;
  const inviteHash = createHash('sha256').update(invitePlain).digest('hex');
  psql(
    dbHost,
    `insert into invite_codes (label, hash, body_suffix) values ('e2e', '${inviteHash}', '${body.slice(-3)}')`,
  );

  // 2. Register a fresh, uniquely-named user.
  const stamp = Date.now();
  const email = `e2e-${stamp}@test.local`;
  const reg = await api(null, 'POST', '/auth/register', {
    email,
    password: 'longenoughpw12',
    displayName: `E2E ${stamp}`,
    inviteCode: invitePlain,
  });
  const ownerToken = reg.accessToken as string;
  const userId = reg.user.id as string;

  // 3. Universe + calendar + timeline window.
  const uni = await api(ownerToken, 'POST', '/universes', {
    name: `E2E Share World ${stamp}`,
  });
  const uid = uni.id as string;
  await api(ownerToken, 'PATCH', `/universes/${uid}`, {
    calendar: E2E_CALENDAR,
    timelineWindow: { start: 0, end: 200000 },
  });

  // 4. Language entry + dictionary word (for the [[zephyr]] popover).
  const lang = await api(ownerToken, 'POST', `/universes/${uid}/entries`, {
    title: 'Old Tongue',
    entryType: 'language',
    isPublic: true,
    summary: 'The ancestral language',
  });
  await api(ownerToken, 'POST', `/universes/${uid}/dictionary`, {
    word: 'zephyr',
    gloss: 'a gentle western wind',
    ipa: '/ˈzɛf.ɚ/',
    partOfSpeech: 'noun',
    languageEntryId: lang.id,
  });

  // 5. Target entry (wikilink destination) + main entry (with both wikilinks).
  const target = await api(ownerToken, 'POST', `/universes/${uid}/entries`, {
    title: 'Frostspire Keep',
    entryType: 'location',
    isPublic: true,
    summary: 'A mountain fortress',
  });
  const main = await api(ownerToken, 'POST', `/universes/${uid}/entries`, {
    title: 'The Battle of Zephyrs',
    entryType: 'event',
    isPublic: true,
    summary: 'A clash at the keep',
    body: 'The siege of [[Frostspire Keep]] turned when a sudden [[zephyr]] scattered the arrows. Survivors fled the keep.',
  });

  // 6. Timeline pin (renders as a calendar date) + share token.
  await api(ownerToken, 'POST', `/universes/${uid}/entries/${main.id}/pin`, {
    label: 'Battle of Zephyrs',
    position: E2E_PIN_POSITION,
    precision: 'exact',
  });
  const share = await api(ownerToken, 'POST', '/shares', {
    universeId: uid,
    label: 'e2e share',
  });
  const shareToken = String(share.shareUrl).match(/\/share\/([^/?#]+)/)?.[1];
  if (!shareToken) throw new Error(`Could not parse share token from ${share.shareUrl}`);

  const seed: Seed = {
    uid,
    mainId: main.id,
    targetId: target.id,
    langId: lang.id,
    shareToken,
    shareUrl: share.shareUrl,
    ownerToken,
    userId,
    email,
    dbHost,
  };
  writeFileSync(SEED_FILE, JSON.stringify(seed, null, 2));
  // eslint-disable-next-line no-console
  console.log(`\n[e2e setup] seeded share universe ${uid} → /share/${shareToken}\n`);
}
