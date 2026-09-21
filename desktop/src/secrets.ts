import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export interface Secrets {
  jwtSecret: string;
  llmKeyEncryptionKey: string;
}

export async function loadOrCreateSecrets(path: string): Promise<Secrets> {
  let raw: string | undefined;
  try {
    raw = await readFile(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }

  if (raw !== undefined) {
    // Malformed JSON (e.g. a half-written file from a crash mid-write) is
    // see the file-level comment.
    const parsed = JSON.parse(raw) as Partial<Secrets>;
    if (parsed.jwtSecret && parsed.llmKeyEncryptionKey) {
      return { jwtSecret: parsed.jwtSecret, llmKeyEncryptionKey: parsed.llmKeyEncryptionKey };
    }
    throw new Error(
      `${path} exists and is valid JSON but is missing jwtSecret and/or ` +
      `llmKeyEncryptionKey — refusing to overwrite it with freshly-minted ` +
      `secrets, which would make any existing encrypted LLM keys / sync ` +
      `remote credentials permanently undecryptable. Fix or remove this ` +
      `file manually if it is not needed.`
    );
  }

  const secrets: Secrets = {
    jwtSecret: randomBytes(32).toString('hex'),
    // Exactly 64 hex chars: config.ts validates /^[0-9a-f]{64}$/.
    llmKeyEncryptionKey: randomBytes(32).toString('hex'),
  };
  await mkdir(dirname(path), { recursive: true });
  // Write to a temp file then rename, so a crash mid-write can never leave a
  // half-written secrets.json for a future launch to trip over (see above).
  // the old direct-write path silently left a pre-existing file's
  const tmpPath = `${path}.tmp-${randomBytes(4).toString('hex')}`;
  await writeFile(tmpPath, JSON.stringify(secrets, null, 2), { mode: 0o600 });
  try {
    await rename(tmpPath, path);
  } catch (err) {
    // Don't leave a stray .tmp-* file behind for a future launch to trip
    // over or an operator to be confused by. Best-effort: if the unlink
    await unlink(tmpPath).catch(() => {});
    throw err;
  }
  return secrets;
}

export function secretsPath(userDataDir: string): string {
  return join(userDataDir, 'secrets.json');
}
