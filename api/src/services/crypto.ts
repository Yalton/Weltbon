import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';

const HEX_KEY_RE = /^[0-9a-f]{64}$/i;

export interface EncryptedSecret {
  ciphertext: string; // hex
  iv: string; // hex, 12 bytes
  authTag: string; // hex, 16 bytes
  bodySuffix: string; // last 4 chars of plaintext, for display
  version: 1;
}

export function encryptSecret(plaintext: string, encryptionKeyHex: string): EncryptedSecret {
  const keyBuf = Buffer.from(encryptionKeyHex, 'hex');
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', keyBuf, iv);
  const ciphertextBuf = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return {
    ciphertext: ciphertextBuf.toString('hex'),
    iv: iv.toString('hex'),
    authTag: authTag.toString('hex'),
    bodySuffix: plaintext.slice(-4),
    version: 1,
  };
}

export function decryptSecret(enc: EncryptedSecret, encryptionKeyHex: string): string | null {
  if (!HEX_KEY_RE.test(encryptionKeyHex) || enc.version !== 1) return null;
  try {
    const keyBuf = Buffer.from(encryptionKeyHex, 'hex');
    const ivBuf = Buffer.from(enc.iv, 'hex');
    const authTagBuf = Buffer.from(enc.authTag, 'hex');
    const ciphertextBuf = Buffer.from(enc.ciphertext, 'hex');

    const decipher = createDecipheriv('aes-256-gcm', keyBuf, ivBuf);
    // Out-of-order produces silently-wrong output on success and "Unsupported
    decipher.setAuthTag(authTagBuf);
    return decipher.update(ciphertextBuf, undefined, 'utf8') + decipher.final('utf8');
  } catch {
    return null;
  }
}
