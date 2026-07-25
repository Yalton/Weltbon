/**
 * Plan D Task 2 — remote base-URL validation (D-04). Pure: no DB, no I/O.
 */
import { describe, it, expect, afterEach } from 'vitest';
import {
  normalizeRemoteUrl,
  isPrivateHostname,
  InvalidRemoteUrlError,
} from '../src/services/sync/remote-url.js';

afterEach(() => {
  delete process.env.SYNC_BLOCK_PRIVATE_HOSTS;
});

describe('normalizeRemoteUrl (D-04)', () => {
  it('accepts http and https and strips trailing slashes', () => {
    expect(normalizeRemoteUrl('https://weltbon.example.com/')).toBe('https://weltbon.example.com');
    expect(normalizeRemoteUrl('http://192.168.1.50:3000')).toBe('http://192.168.1.50:3000');
    expect(normalizeRemoteUrl('  https://host.example/weltbon//  ')).toBe('https://host.example/weltbon');
  });

  it('rejects any scheme but http/https', () => {
    for (const bad of ['file:///etc/passwd', 'ftp://host.example', 'gopher://host.example']) {
      expect(() => normalizeRemoteUrl(bad)).toThrow(InvalidRemoteUrlError);
    }
  });

  it('rejects credentials embedded in the URL', () => {
    // The PAT is the only credential that may travel, and it travels in a header.
    expect(() => normalizeRemoteUrl('https://user:pw@host.example')).toThrow(/credentials/);
  });

  it('rejects query strings and fragments', () => {
    expect(() => normalizeRemoteUrl('https://host.example/?x=1')).toThrow(/query/);
    expect(() => normalizeRemoteUrl('https://host.example/#frag')).toThrow(/query/);
  });

  it('rejects garbage', () => {
    expect(() => normalizeRemoteUrl('not a url')).toThrow(InvalidRemoteUrlError);
    expect(() => normalizeRemoteUrl('')).toThrow(InvalidRemoteUrlError);
  });

  it('allows private addresses by DEFAULT — LAN sync is the primary use case', () => {
    expect(normalizeRemoteUrl('http://127.0.0.1:3000')).toBe('http://127.0.0.1:3000');
    expect(normalizeRemoteUrl('http://192.168.1.50:3000')).toBe('http://192.168.1.50:3000');
  });

  it('blocks private addresses only when SYNC_BLOCK_PRIVATE_HOSTS is set', () => {
    process.env.SYNC_BLOCK_PRIVATE_HOSTS = 'true';
    expect(() => normalizeRemoteUrl('http://127.0.0.1:3000')).toThrow(/private/);
    expect(() => normalizeRemoteUrl('http://169.254.169.254/latest/meta-data/')).toThrow(/private/);
    expect(() => normalizeRemoteUrl('http://[::1]:3000')).toThrow(/private/);
    // Public hosts still pass with the flag on.
    expect(normalizeRemoteUrl('https://weltbon.example.com')).toBe('https://weltbon.example.com');
  });
});

describe('isPrivateHostname', () => {
  it.each([
    'localhost', '127.0.0.1', '127.53.1.9', '10.0.0.1', '172.16.0.1', '172.31.255.255',
    '192.168.0.1', '169.254.169.254', '0.0.0.0', '[::1]', '::1', 'fd00::1', 'fe80::1',
  ])('treats %s as private', (h) => {
    expect(isPrivateHostname(h)).toBe(true);
  });

  it.each(['weltbon.example.com', '8.8.8.8', '172.32.0.1', '172.15.0.1', '193.168.0.1'])(
    'treats %s as public',
    (h) => {
      expect(isPrivateHostname(h)).toBe(false);
    },
  );
});
