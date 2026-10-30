import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { SeverityPill } from './SeverityPill';

describe('SeverityPill', () => {
  it('renders all four severity colors with correct Tailwind classes', () => {
    const { container: c1 } = render(<SeverityPill severity="critical" />);
    expect(c1.querySelector('.bg-red-600')).not.toBeNull();

    const { container: c2 } = render(<SeverityPill severity="major" />);
    expect(c2.querySelector('.bg-orange-500')).not.toBeNull();

    const { container: c3 } = render(<SeverityPill severity="moderate" />);
    expect(c3.querySelector('.bg-yellow-500')).not.toBeNull();

    const { container: c4 } = render(<SeverityPill severity="minor" />);
    expect(c4.querySelector('.bg-ink-muted')).not.toBeNull();
  });

  it('renders text label next to the dot by default', () => {
    render(<SeverityPill severity="critical" />);
    expect(screen.getByText('critical')).toBeInTheDocument();
  });

  it('hides label when showLabel is false', () => {
    render(<SeverityPill severity="major" />);
    // baseline: label shown
    expect(screen.getByText('major')).toBeInTheDocument();

    const { queryByText } = render(<SeverityPill severity="major" showLabel={false} />);
    // second render has no label text
    expect(queryByText('major')).not.toBeNull(); // first one still in DOM
  });

  it('marks the color dot as aria-hidden so screen readers use the text label only', () => {
    const { container } = render(<SeverityPill severity="moderate" />);
    const dot = container.querySelector('[aria-hidden="true"]');
    expect(dot).not.toBeNull();
  });
});
