import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { Button, IconButton } from './Button';
import { Plus, Trash2, ArrowRight } from 'lucide-react';

describe('Button component', () => {
  it('renders children with default secondary variant and md size', () => {
    render(<Button>Click me</Button>);
    const button = screen.getByRole('button', { name: 'Click me' });
    expect(button).toBeInTheDocument();
    expect(button.getAttribute('type')).toBe('button');
    expect(button.className).toContain('border-transparent');
    expect(button.className).toContain('h-8');
  });

  it('renders primary variant', () => {
    render(<Button variant="primary">Save</Button>);
    const button = screen.getByRole('button', { name: 'Save' });
    expect(button.className).toContain('bg-primary');
    expect(button.className).toContain('text-primary-foreground');
  });

  it('renders ghost variant', () => {
    render(<Button variant="ghost">Cancel</Button>);
    const button = screen.getByRole('button', { name: 'Cancel' });
    expect(button.className).toContain('border-transparent');
    expect(button.className).toContain('text-muted-foreground');
  });

  it('renders destructive variant', () => {
    render(<Button variant="destructive">Delete space</Button>);
    const button = screen.getByRole('button', { name: 'Delete space' });
    expect(button.className).toContain('bg-destructive');
    expect(button.className).toContain('text-destructive-foreground');
  });

  it('renders destructive-ghost variant', () => {
    render(<Button variant="destructive-ghost">Remove</Button>);
    const button = screen.getByRole('button', { name: 'Remove' });
    expect(button.className).toContain('text-destructive');
    expect(button.className).toContain('border-transparent');
  });

  it('renders ai variant', () => {
    render(<Button variant="ai">Generate</Button>);
    const button = screen.getByRole('button', { name: 'Generate' });
    expect(button.className).toContain('bg-status-ai/10');
    expect(button.className).toContain('border-transparent');
  });

  it('supports sm, md, and lg sizes', () => {
    const { rerender } = render(<Button size="sm">Small</Button>);
    let button = screen.getByRole('button', { name: 'Small' });
    expect(button.className).toContain('h-7');
    expect(button.className).toContain('text-xs');

    rerender(<Button size="md">Medium</Button>);
    button = screen.getByRole('button', { name: 'Medium' });
    expect(button.className).toContain('h-8');
    expect(button.className).toContain('text-[13px]');

    rerender(<Button size="lg">Large</Button>);
    button = screen.getByRole('button', { name: 'Large' });
    expect(button.className).toContain('h-10');
    expect(button.className).toContain('text-sm');
  });

  it('renders left and right icons', () => {
    render(
      <Button
        leftIcon={<Plus data-testid="left-icon" size={14} />}
        rightIcon={<ArrowRight data-testid="right-icon" size={14} />}
      >
        Create Page
      </Button>,
    );
    expect(screen.getByTestId('left-icon')).toBeInTheDocument();
    expect(screen.getByTestId('right-icon')).toBeInTheDocument();
    expect(screen.getByText('Create Page')).toBeInTheDocument();
  });

  it('handles loading state properly', () => {
    render(
      <Button
        isLoading
        leftIcon={<Plus data-testid="left-icon" size={14} />}
        rightIcon={<ArrowRight data-testid="right-icon" size={14} />}
      >
        Saving
      </Button>,
    );
    const button = screen.getByRole('button', { name: 'Saving' });
    expect(button).toBeDisabled();
    expect(button.getAttribute('aria-busy')).toBe('true');
    // Icons should be replaced by loader
    expect(screen.queryByTestId('left-icon')).not.toBeInTheDocument();
    expect(screen.queryByTestId('right-icon')).not.toBeInTheDocument();
    expect(button.querySelector('.animate-spin')).toBeInTheDocument();
  });

  it('fires onClick when clicked', () => {
    const handleClick = vi.fn();
    render(<Button onClick={handleClick}>Action</Button>);
    fireEvent.click(screen.getByRole('button', { name: 'Action' }));
    expect(handleClick).toHaveBeenCalledTimes(1);
  });

  it('does not fire onClick when disabled', () => {
    const handleClick = vi.fn();
    render(
      <Button disabled onClick={handleClick}>
        Disabled
      </Button>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Disabled' }));
    expect(handleClick).not.toHaveBeenCalled();
  });

  it('forwards ref properly', () => {
    const ref = React.createRef<HTMLButtonElement>();
    render(<Button ref={ref}>Ref Button</Button>);
    expect(ref.current).toBeInstanceOf(HTMLButtonElement);
    expect(ref.current?.textContent).toBe('Ref Button');
  });
});

describe('IconButton component', () => {
  it('renders icon with aria-label', () => {
    render(
      <IconButton
        icon={<Trash2 data-testid="trash-icon" size={14} />}
        aria-label="Delete item"
      />,
    );
    const button = screen.getByRole('button', { name: 'Delete item' });
    expect(button).toBeInTheDocument();
    expect(screen.getByTestId('trash-icon')).toBeInTheDocument();
    expect(button.className).toContain('w-8');
    expect(button.className).toContain('h-8');
  });

  it('renders compact sm icon button', () => {
    render(
      <IconButton
        size="sm"
        icon={<Trash2 data-testid="trash-icon" size={14} />}
        aria-label="Delete item"
      />,
    );
    const button = screen.getByRole('button', { name: 'Delete item' });
    expect(button.className).toContain('w-7');
    expect(button.className).toContain('h-7');
  });
});
