import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { CategoryIcon } from './CategoryIcon';

describe('CategoryIcon', () => {
  it('draws a hidden SVG icon beside a visible category name, not an emoji', () => {
    const { container } = render(<CategoryIcon category="contradiction" withLabel />);
    expect(container.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
    expect(container.textContent).toBe('Contradiction');
  });

  it('renders the icon alone when the name is shown elsewhere', () => {
    const { container } = render(<CategoryIcon category="missing-link" />);
    expect(container.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
    expect(container.textContent).toBe('');
  });
});
