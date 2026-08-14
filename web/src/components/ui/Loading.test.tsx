import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Loading } from './Loading';

/**
 * #32. The app previously rendered a bare "Loading..." string in ten hand-rolled
 * copies, styled `text-neutral-500` against a near-black canvas and pinned to
 * the top-left — which reads as a broken page rather than a loading one.
 *
 * These tests pin the properties that made it wrong, not the visual design:
 * the state must be announced, it must carry a visible indicator rather than
 * only text, and it must use theme tokens so it survives both themes.
 */
describe('Loading', () => {
  it('announces itself as a live status region', () => {
    render(<Loading />);
    expect(screen.getByRole('status')).toBeInTheDocument();
  });

  // Asserted on CONTENT, not accessible name: `status` is not a name-from-content
  // role, and a live region is announced from what it contains. An aria-label
  // would satisfy a name assertion while double-announcing in readers that read
  // both. Content is the property that actually reaches the user.
  it('keeps a "Loading" announcement for screen readers', () => {
    render(<Loading />);
    expect(screen.getByRole('status')).toHaveTextContent(/loading/i);
  });

  it('accepts a caller-supplied label', () => {
    render(<Loading label="Loading universes" />);
    expect(screen.getByRole('status')).toHaveTextContent(/loading universes/i);
  });

  it('renders an animated indicator, not just text', () => {
    const { container } = render(<Loading />);
    // The spinner is the reason this component exists; assert something is
    // actually animating rather than trusting the markup to look right.
    expect(container.querySelector('.animate-spinner')).not.toBeNull();
  });

  it('uses theme ink tokens rather than a fixed neutral that vanishes on dark', () => {
    const { container } = render(<Loading />);
    // text-neutral-500 on --color-canvas-lo (#070912) was the original defect.
    expect(container.innerHTML).not.toContain('text-neutral-500');
  });

  it('fills its container when asked to, for route-level loading', () => {
    const { container } = render(<Loading fullPage />);
    const root = container.firstElementChild as HTMLElement;
    expect(root.className).toContain('min-h-');
  });
});
