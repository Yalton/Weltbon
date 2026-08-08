import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export interface Secrets {
  jwtSecret: string;
  llmKeyEncryptionKey: string;
}

/**
 * DV-10. Three secrets must persist across launches; two of them fail in ways
 * that look exactly like the data loss this app is trying to rule out.
 *
 * - jwtSecret: regenerated per launch, every relaunch silently invalidates the
 *   session, which is indistinguishable from "my data is gone".
 * - llmKeyEncryptionKey: registering a sync remote encrypts the peer's PAT at
 *   rest and 503s without this. Absent, sync looks broken on the one path the
 *   desktop app exists to prove. (This is not hypothetical — it is what blocked
 *   the containerized sync client while standing up the temp prod.)
 *
 * The third, the local user's password, lives in the database and is never read.
 *
 * Review round 1, Finding 2: only a MISSING file (ENOENT) is grounds to mint
 * fresh secrets. A file that exists but can't be read (EACCES, EIO, EMFILE,
 * ...) or is malformed (a half-written file from a prior crash) is NOT the
 * same thing — silently regenerating over it destroys llmKeyEncryptionKey
 * irrecoverably: every stored LLM key and every sync remote's encrypted_pat
 * becomes undecryptable, and the app still boots (the key is *set*, just
 * wrong), so this surfaces later as scattered decrypt errors instead of a
 * clean, loud refusal here where it's still fixable. Everything other than
 * ENOENT rethrows, and main()'s dialog reports it.
 */
export async function loadOrCreateSecrets(path: string): Promise<Secrets> {
  let raw: string | undefined;
  try {
    raw = await readFile(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    // ENOENT only: nothing existing to protect — fall through and mint fresh.
  }

  if (raw !== undefined) {
    // Malformed JSON (e.g. a half-written file from a crash mid-write) is
    // deliberately NOT caught here either, for the same reason as above —
    // see the file-level comment.
    const parsed = JSON.parse(raw) as Partial<Secrets>;
    if (parsed.jwtSecret && parsed.llmKeyEncryptionKey) {
      return { jwtSecret: parsed.jwtSecret, llmKeyEncryptionKey: parsed.llmKeyEncryptionKey };
    }
  }

  const secrets: Secrets = {
    // >=32 chars: api/src/config.ts refuses to boot below that.
    jwtSecret: randomBytes(32).toString('hex'),
    // Exactly 64 hex chars: config.ts validates /^[0-9a-f]{64}$/.
    llmKeyEncryptionKey: randomBytes(32).toString('hex'),
  };
  await mkdir(dirname(path), { recursive: true });
  // Write to a temp file then rename, so a crash mid-write can never leave a
  // half-written secrets.json for a future launch to trip over (see above).
  // rename() also reapplies mode 0600 to the final path even when path
  // already existed — writeFile's `mode` option only takes effect when the
  // destination is newly CREATED, not when overwriting an existing file, so
  // the old direct-write path silently left a pre-existing file's
  // permissions untouched.
  const tmpPath = `${path}.tmp-${randomBytes(4).toString('hex')}`;
  await writeFile(tmpPath, JSON.stringify(secrets, null, 2), { mode: 0o600 });
  await rename(tmpPath, path);
  return secrets;
}

export function secretsPath(userDataDir: string): string {
  return join(userDataDir, 'secrets.json');
}
