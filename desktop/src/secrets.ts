import { randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
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
 */
export async function loadOrCreateSecrets(path: string): Promise<Secrets> {
  try {
    const raw = await readFile(path, 'utf8');
    const parsed = JSON.parse(raw) as Partial<Secrets>;
    if (parsed.jwtSecret && parsed.llmKeyEncryptionKey) {
      return { jwtSecret: parsed.jwtSecret, llmKeyEncryptionKey: parsed.llmKeyEncryptionKey };
    }
  } catch {
    // Missing or unreadable — fall through and mint a fresh set.
  }

  const secrets: Secrets = {
    // >=32 chars: api/src/config.ts refuses to boot below that.
    jwtSecret: randomBytes(32).toString('hex'),
    // Exactly 64 hex chars: config.ts validates /^[0-9a-f]{64}$/.
    llmKeyEncryptionKey: randomBytes(32).toString('hex'),
  };
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(secrets, null, 2), { mode: 0o600 });
  return secrets;
}

export function secretsPath(userDataDir: string): string {
  return join(userDataDir, 'secrets.json');
}
