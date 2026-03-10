import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Skeleton, SkeletonStatCard, SkeletonPageItem, SkeletonFormFields } from './Skeleton';

describe('Skeleton', () => {
  it('renders a single skeleton element by default', () => {
    render(<Skeleton />);
    expect(screen.getByTestId('skeleton')).toBeInTheDocument();
  });

  it('renders multiple skeleton elements with count', () => {
    render(<Skeleton count={3} />);
    expect(screen.getAllByTestId('skeleton')).toHaveLength(3);
  });

  it('applies text variant styles by default', () => {
    render(<Skeleton />);
    const el = screen.getByTestId('skeleton');
    expect(el.className).toContain('skeleton');
  });

  it('applies card variant styles', () => {
    render(<Skeleton variant="card" />);
    const el = screen.getByTestId('skeleton');
    expect(el.className).toContain('skeleton');
  });

  it('applies circle variant styles', () => {
    render(<Skeleton variant="circle" />);
    const el = screen.getByTestId('skeleton');
    expect(el.className).toContain('rounded-full');
  });

  it('applies custom className', () => {
    render(<Skeleton className="my-custom" />);
    const el = screen.getByTestId('skeleton');
    expect(el.className).toContain('my-custom');
  });

  it('applies custom width and height as style', () => {
    render(<Skeleton width={200} height={50} />);
    const el = screen.getByTestId('skeleton');
    expect(el.style.width).toBe('200px');
    expect(el.style.height).toBe('50px');
  });

  it('accepts string width/height', () => {
    render(<Skeleton width="100%" height="2rem" />);
    const el = screen.getByTestId('skeleton');
    expect(el.style.width).toBe('100%');
    expect(el.style.height).toBe('2rem');
  });
});

describe('SkeletonStatCard', () => {
  it('renders skeleton elements inside a glass-card', () => {
    const { container } = render(<SkeletonStatCard />);
    expect(container.querySelector('.glass-card')).toBeInTheDocument();
    expect(container.querySelectorAll('.skeleton').length).toBeGreaterThan(0);
  });
});

describe('SkeletonPageItem', () => {
  it('renders skeleton elements inside a glass-card', () => {
    const { container } = render(<SkeletonPageItem />);
    expect(container.querySelector('.glass-card')).toBeInTheDocument();
    expect(container.querySelectorAll('.skeleton').length).toBeGreaterThan(0);
  });
});

describe('SkeletonFormFields', () => {
  it('renders multiple skeleton form field groups', () => {
    const { container } = render(<SkeletonFormFields />);
    expect(container.querySelectorAll('.skeleton').length).toBeGreaterThanOrEqual(4);
  });
});
