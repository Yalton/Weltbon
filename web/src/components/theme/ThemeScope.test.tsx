import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ThemeScope } from './ThemeScope';

describe('ThemeScope', () => {
  it('renders children and passes className through', () => {
    render(<ThemeScope theme={null} className="h-full"><p>inside</p></ThemeScope>);
    expect(screen.getByText('inside')).toBeInTheDocument();
  });

  it('sets CSS variables from the theme', () => {
    render(<ThemeScope theme={{ palette: 'ember' }} data-testid="scope">x</ThemeScope>);
    const el = screen.getByTestId('scope');
    expect(el.style.getPropertyValue('--color-accent')).not.toBe('');
  });

  it('renders a themed canvas layer when a theme is set and no backdrop', () => {
    render(<ThemeScope theme={{ palette: 'verdant' }}>x</ThemeScope>);
    expect(screen.getByTestId('theme-canvas')).toBeInTheDocument();
    expect(screen.queryByTestId('theme-backdrop')).not.toBeInTheDocument();
  });

  it('renders backdrop image + scrim instead of canvas when backdropUrl set', () => {
    render(<ThemeScope theme={{}} backdropUrl="/api/x/raw?e=1&s=2">x</ThemeScope>);
    const img = screen.getByTestId('theme-backdrop') as HTMLImageElement;
    expect(img.src).toContain('/api/x/raw');
    expect(screen.getByTestId('theme-scrim')).toBeInTheDocument();
    expect(screen.queryByTestId('theme-canvas')).not.toBeInTheDocument();
  });

  it('contained mode uses absolute positioning inside a clip container', () => {
    render(
      <ThemeScope theme={{}} backdropUrl="/t.png" backdropMode="contained">x</ThemeScope>,
    );
    const img = screen.getByTestId('theme-backdrop');
    expect(img).toHaveClass('absolute');
    // The clip container (not the host) carries overflow-hidden so sibling
    // focus rings outside ThemeScope aren't clipped.
    expect(img.parentElement).toHaveClass('overflow-hidden');
  });

  it('suppresses the canvas layer when showCanvas is false', () => {
    render(
      <ThemeScope theme={{ palette: 'verdant' }} showCanvas={false}>x</ThemeScope>,
    );
    expect(screen.queryByTestId('theme-canvas')).not.toBeInTheDocument();
  });

  it('renders no extra layers for a null theme without backdrop', () => {
    render(<ThemeScope theme={null}>x</ThemeScope>);
    expect(screen.queryByTestId('theme-canvas')).not.toBeInTheDocument();
    expect(screen.queryByTestId('theme-backdrop')).not.toBeInTheDocument();
  });
});
