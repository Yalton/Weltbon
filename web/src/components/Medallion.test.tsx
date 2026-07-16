import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { Medallion } from './Medallion';

describe('Medallion (HTML)', () => {
  it('renders the cover image when a coverThumbUrl is present', () => {
    const { container } = render(
      <Medallion
        title="Aldric"
        entryType="entity"
        icon="👑"
        coverThumbUrl="/api/universes/u1/assets/a1/thumb?e=1&s=ff"
        size="sm"
      />,
    );
    // alt="" — the medallion is decorative here; it always sits beside the
    // already-announced entry title, so it isn't queryable by accessible name.
    const img = container.querySelector('[data-medallion="cover"]') as HTMLImageElement;
    expect(img).toHaveAttribute('src', '/api/universes/u1/assets/a1/thumb?e=1&s=ff');
    expect(img).toHaveAttribute('alt', '');
    expect(img.className).toContain('object-cover');
  });

  it('renders the emoji icon when there is no cover', () => {
    render(<Medallion title="Aldric" entryType="entity" icon="👑" size="sm" />);
    expect(screen.getByText('👑')).toBeInTheDocument();
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
  });

  it('renders the illuminated monogram when there is neither cover nor icon', () => {
    render(<Medallion title="Aldric" entryType="entity" size="md" />);
    const mono = screen.getByText('A');
    expect(mono).toBeInTheDocument();
    // Serif — follows the universe's theme font inside a ThemeScope.
    expect(mono.className).toContain('font-display');
  });

  it('sizes the disc from MEDALLION_SIZES', () => {
    const { container } = render(<Medallion title="A" entryType="entity" size="lg" />);
    const disc = container.querySelector('[data-medallion]') as HTMLElement;
    expect(disc.style.width).toBe('52px');
    expect(disc.style.height).toBe('52px');
  });

  it('tints the fallback disc by entry type', () => {
    const { container } = render(<Medallion title="Vale" entryType="location" size="sm" />);
    const disc = container.querySelector('[data-medallion]') as HTMLElement;
    expect(disc.style.background).toContain('#f59e0b33');
    expect(disc.getAttribute('data-medallion')).toBe('monogram');
  });

  it('falls back to the monogram when the cover image fails to load', () => {
    const { container } = render(
      <Medallion title="Ghost" entryType="entity" coverThumbUrl="/gone.png" size="sm" />,
    );
    const img = container.querySelector('[data-medallion="cover"]') as HTMLImageElement;
    // A signed URL can expire, and an asset can be deleted between the list cache and
    // the paint. Without this the row shows a broken-image glyph.
    fireEvent.error(img);
    expect(container.querySelector('[data-medallion="monogram"]')).toBeInTheDocument();
  });

  it('retries the cover when a NEW url arrives after a failure (e.g. the user uploads a new cover)', () => {
    // This is why the failed URL is stored rather than a boolean: a plain `coverFailed`
    // flag would suppress the cover forever on a row that stays mounted, so a freshly
    // uploaded cover would never appear until a remount.
    const { container, rerender } = render(
      <Medallion title="Ghost" entryType="entity" coverThumbUrl="/old.png" size="sm" />,
    );
    fireEvent.error(container.querySelector('[data-medallion="cover"]')!);
    expect(container.querySelector('[data-medallion="monogram"]')).toBeInTheDocument();

    rerender(<Medallion title="Ghost" entryType="entity" coverThumbUrl="/new.png" size="sm" />);

    const img = container.querySelector('[data-medallion="cover"]');
    expect(img).toBeInTheDocument();
    expect(img).toHaveAttribute('src', '/new.png');
  });
});
