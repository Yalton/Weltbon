/**
 * Phase 38 MEDIA-05: MarkdownRenderer asset:// img resolver tests.
 *
 * Asserts:
 * 1. Authenticated URL: asset://uuid → /api/universes/u1/assets/uuid/raw
 * 2. Share URL: asset://uuid + shareToken → /api/share/assets/uuid/raw
 * 3. Non-asset src passes through unchanged
 * 4. img onError hides the element (sets display:none) — no /missing-image.svg
 *
 * T-38-20: uuid is concatenated into a URL path, never dangerouslySetInnerHTML.
 * T-38-21: share mode uses /api/share/assets/:id/raw explicitly (Pitfall 4).
 * T-38-22: onError hides the broken img (no /missing-image.svg exists).
 */

import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MarkdownRenderer } from '../MarkdownRenderer';

const UNIVERSE_ID = 'u1';
const ASSET_UUID = 'abc-123-def-456';
const SHARE_TOKEN = 'share-tok';

describe('MarkdownRenderer — asset:// img resolver (MEDIA-05)', () => {
  it('renders asset:// src as authed /api/universes/:uid/assets/:id/raw URL', () => {
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

  it('renders asset:// src as share /api/share/assets/:id/raw URL when shareToken present', () => {
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
