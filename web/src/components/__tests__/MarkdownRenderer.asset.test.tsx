
import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MarkdownRenderer } from '../MarkdownRenderer';

const UNIVERSE_ID = 'u1';
const ASSET_UUID = 'abc-123-def-456';
const SHARE_TOKEN = 'share-tok';

describe('MarkdownRenderer — asset:// img resolver (MEDIA-05)', () => {
  // ─── Fallback paths (no assetUrls map) ──────────────────────────────────────

  it('renders asset:// src as authed /api/universes/:uid/assets/:id/raw URL (no assetUrls map)', () => {
    const content = `![pic](asset://${ASSET_UUID})`;
    render(
      <MarkdownRenderer
        content={content}
        assets={{ universeId: UNIVERSE_ID }}
      />,
    );

    const img = screen.getByRole('img', { name: 'pic' });
    expect(img).toBeDefined();
    expect(img.getAttribute('src')).toBe(
      `/api/universes/${UNIVERSE_ID}/assets/${ASSET_UUID}/raw`,
    );
  });

  it('renders asset:// src as share /api/share/assets/:id/raw URL when shareToken present (no assetUrls map)', () => {
    const content = `![cover](asset://${ASSET_UUID})`;
    render(
      <MarkdownRenderer
        content={content}
        assets={{ universeId: UNIVERSE_ID, shareToken: SHARE_TOKEN }}
      />,
    );

    const img = screen.getByRole('img', { name: 'cover' });
    expect(img).toBeDefined();
    // Must NOT use authed path in share mode (Pitfall 4)
    expect(img.getAttribute('src')).toBe(
      `/api/share/assets/${ASSET_UUID}/raw`,
    );
    expect(img.getAttribute('src')).not.toContain('/universes/');
  });



  it('uses pre-signed URL from assetUrls map (authed path)', () => {
    const signedUrl = `/api/universes/${UNIVERSE_ID}/assets/${ASSET_UUID}/raw?e=9999999999&s=deadbeef`;
    const content = `![signed](asset://${ASSET_UUID})`;
    render(
      <MarkdownRenderer
        content={content}
        assets={{
          universeId: UNIVERSE_ID,
          assetUrls: { [ASSET_UUID]: signedUrl },
        }}
      />,
    );

    const img = screen.getByRole('img', { name: 'signed' });
    expect(img.getAttribute('src')).toBe(signedUrl);
    // Must use the map URL, not the unsigned fallback
    expect(img.getAttribute('src')).toContain('?e=');
    expect(img.getAttribute('src')).toContain('&s=');
  });

  it('uses pre-signed URL from assetUrls map (share path)', () => {
    const signedShareUrl = `/api/share/assets/${ASSET_UUID}/raw?u=${UNIVERSE_ID}&e=9999999999&s=deadbeef`;
    const content = `![share-signed](asset://${ASSET_UUID})`;
    render(
      <MarkdownRenderer
        content={content}
        assets={{
          universeId: UNIVERSE_ID,
          shareToken: SHARE_TOKEN,
          assetUrls: { [ASSET_UUID]: signedShareUrl },
        }}
      />,
    );

    const img = screen.getByRole('img', { name: 'share-signed' });
    expect(img.getAttribute('src')).toBe(signedShareUrl);
    expect(img.getAttribute('src')).toContain('/api/share/assets/');
    expect(img.getAttribute('src')).toContain('?u=');
  });

  it('falls back to constructing URL for uuids not in assetUrls map', () => {
    const OTHER_UUID = 'other-uuid-not-in-map';
    const content = `![fallback](asset://${OTHER_UUID})`;
    render(
      <MarkdownRenderer
        content={content}
        assets={{
          universeId: UNIVERSE_ID,
          assetUrls: { [ASSET_UUID]: '/api/universes/u1/assets/abc/raw?e=1&s=2' },
        }}
      />,
    );

    const img = screen.getByRole('img', { name: 'fallback' });
    // UUID not in map → falls back to plain URL construction
    expect(img.getAttribute('src')).toBe(
      `/api/universes/${UNIVERSE_ID}/assets/${OTHER_UUID}/raw`,
    );
  });

  // ─── Passthrough and error behavior ─────────────────────────────────────────

  it('passes through non-asset:// src unchanged', () => {
    const content = `![external](https://example.com/photo.png)`;
    render(
      <MarkdownRenderer
        content={content}
        assets={{ universeId: UNIVERSE_ID }}
      />,
    );

    const img = screen.getByRole('img', { name: 'external' });
    expect(img.getAttribute('src')).toBe('https://example.com/photo.png');
  });

  it('hides broken img via display:none on onError (no /missing-image.svg swap)', () => {
    const content = `![broken](asset://missing-uuid)`;
    render(
      <MarkdownRenderer
        content={content}
        assets={{ universeId: UNIVERSE_ID }}
      />,
    );

    const img = screen.getByRole('img', { name: 'broken' });
    // Verify initial state — img is visible
    expect((img as HTMLImageElement).style.display).not.toBe('none');

    // Fire error event to simulate a missing asset (D-12 graceful missing-image)
    fireEvent.error(img);

    // Img must be hidden — no /missing-image.svg src swap
    expect((img as HTMLImageElement).style.display).toBe('none');
    // src must NOT be changed to /missing-image.svg
    expect(img.getAttribute('src')).not.toContain('missing-image.svg');
  });
});
