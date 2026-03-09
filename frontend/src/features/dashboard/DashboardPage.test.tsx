import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { DashboardPage } from './DashboardPage';

describe('DashboardPage (deprecated)', () => {
  it('renders null (merged into PagesPage)', () => {
    const { container } = render(<DashboardPage />);
    expect(container.innerHTML).toBe('');
  });
});
