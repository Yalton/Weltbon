import { describe, it, expect } from 'vitest';
import { tokenMintUrl } from './tokenMintUrl';

describe('tokenMintUrl — accepted input', () => {
  it('appends the token path to a bare origin without doubling the slash', () => {
    expect(tokenMintUrl('http://localhost:3001')).toBe('http://localhost:3001/settings/tokens');
  });

  it('normalises trailing slashes', () => {
    expect(tokenMintUrl('http://localhost:3001/')).toBe('http://localhost:3001/settings/tokens');
    expect(tokenMintUrl('http://localhost:3001///')).toBe('http://localhost:3001/settings/tokens');
  });

  it('preserves a subpath, for an instance hosted under one', () => {
    expect(tokenMintUrl('https://host.example/weltbon')).toBe(
      'https://host.example/weltbon/settings/tokens',
    );
  });

  it('accepts https and trims surrounding whitespace', () => {
    expect(tokenMintUrl('  https://host.example  ')).toBe('https://host.example/settings/tokens');
  });
});

describe('tokenMintUrl — the authority is taken from origin, not the raw text', () => {
  it('drops credentials, so userinfo cannot disguise the real host', () => {
    // `https://evil.com@good.com/` READS as evil.com to a human but resolves
    // to good.com. Rendering the raw text as the href would show the user one
    // host while linking to another; building from `origin` collapses that.
    expect(tokenMintUrl('https://evil.com@good.com/')).toBe(
      'https://good.com/settings/tokens',
    );
  });

  it('drops the query and fragment instead of concatenating them', () => {
    // Naive concatenation would yield ".../?a=1/settings/tokens" — a path
    // living inside the query string, which reaches the wrong endpoint.
    expect(tokenMintUrl('http://host.example/?a=1')).toBe('http://host.example/settings/tokens');
    expect(tokenMintUrl('http://host.example/#frag')).toBe('http://host.example/settings/tokens');
    expect(tokenMintUrl('http://host.example/sub?a=1#frag')).toBe(
      'http://host.example/sub/settings/tokens',
    );
  });
});

describe('tokenMintUrl — rejected input', () => {
  it('rejects javascript:, which parses successfully', () => {
    // The single case the protocol allow-list exists for: this is a valid URL
    // by every parsing measure, and would be click-to-execute as an href.
    expect(tokenMintUrl('javascript:alert(1)')).toBeNull();
    expect(tokenMintUrl('JaVaScRiPt:alert(1)')).toBeNull();
  });

  it('rejects other non-http schemes', () => {
    expect(tokenMintUrl('data:text/html,<script>alert(1)</script>')).toBeNull();
    expect(tokenMintUrl('file:///etc/passwd')).toBeNull();
  });

  it('rejects text the URL constructor cannot parse', () => {
    expect(tokenMintUrl('not a url')).toBeNull();
    // Rejected by the allow-list rather than the parser: `new URL` reads this
    // as the scheme "localhost:" with path "3001". A user who omits the scheme
    // gets no link, which is the right outcome either way.
    expect(tokenMintUrl('localhost:3001')).toBeNull();
    // Protocol-relative: no base URL to resolve against, so the parser throws.
    expect(tokenMintUrl('//host.example')).toBeNull();
  });

  it('rejects empty and whitespace-only input', () => {
    expect(tokenMintUrl('')).toBeNull();
    expect(tokenMintUrl('   ')).toBeNull();
  });
});
