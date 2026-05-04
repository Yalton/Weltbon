import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ImportProgressBar } from '../ImportProgressBar';

function getInnerFill(): HTMLDivElement {
  const bar = screen.getByRole('progressbar');
  const fill = bar.firstElementChild as HTMLDivElement | null;
  if (!fill) throw new Error('Inner fill not found');
  return fill;
}

describe('ImportProgressBar', () => {
  it('renders with default aria-label "Upload progress"', () => {
    render(<ImportProgressBar pct={0} done={false} />);
    expect(screen.getByRole('progressbar')).toHaveAttribute(
      'aria-label',
      'Upload progress',
    );
  });

  it('uses a custom ariaLabel when provided', () => {
    render(<ImportProgressBar pct={0} done={false} ariaLabel="Commit progress" />);
    expect(screen.getByRole('progressbar')).toHaveAttribute(
      'aria-label',
      'Commit progress',
    );
  });

  it('renders inner fill width 0% when pct=0 and done=false', () => {
    render(<ImportProgressBar pct={0} done={false} />);
    expect(getInnerFill().style.width).toBe('0%');
  });

  it('renders inner fill width 50% when pct=50 and done=false', () => {
    render(<ImportProgressBar pct={50} done={false} />);
    expect(getInnerFill().style.width).toBe('50%');
  });

  it('renders inner fill width 100% when pct=100 and done=false', () => {
    render(<ImportProgressBar pct={100} done={false} />);
    expect(getInnerFill().style.width).toBe('100%');
  });

  it('forces inner fill width to 100% when done=true regardless of pct', () => {
    render(<ImportProgressBar pct={50} done={true} />);
    expect(getInnerFill().style.width).toBe('100%');
  });

  it('clamps negative pct values to 0%', () => {
    render(<ImportProgressBar pct={-10} done={false} />);
    expect(getInnerFill().style.width).toBe('0%');
  });

  it('clamps overshoot pct values to 100%', () => {
    render(<ImportProgressBar pct={150} done={false} />);
    expect(getInnerFill().style.width).toBe('100%');
  });

  it('reports the rendered width in aria-valuenow', () => {
    render(<ImportProgressBar pct={50} done={false} />);
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '50');
  });

  it('exposes aria-valuemin=0 and aria-valuemax=100', () => {
    render(<ImportProgressBar pct={25} done={false} />);
    const bar = screen.getByRole('progressbar');
    expect(bar).toHaveAttribute('aria-valuemin', '0');
    expect(bar).toHaveAttribute('aria-valuemax', '100');
  });
});
