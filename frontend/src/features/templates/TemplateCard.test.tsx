import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { TemplateCard, type Template } from './TemplateCard';

// Mock framer-motion to avoid animation issues in tests
vi.mock('framer-motion', () => ({
  m: {
    div: ({ children, ...props }: React.HTMLAttributes<HTMLDivElement>) => <div {...props}>{children}</div>,
  },
  AnimatePresence: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

const mockTemplate: Template = {
  id: 'tpl-1',
  title: 'Daily Standup Notes',
  description: 'Template for recording daily standup meeting notes',
  category: 'Meetings',
  useCount: 12,
  bodyHtml: '<h1>Daily Standup</h1><p>Notes here</p>',
  createdAt: '2025-01-01T00:00:00Z',
};

describe('TemplateCard', () => {
  it('renders template title and description', () => {
    render(
      <TemplateCard template={mockTemplate} index={0} onUse={vi.fn()} onPreview={vi.fn()} />,
    );
    expect(screen.getByText('Daily Standup Notes')).toBeInTheDocument();
    expect(screen.getByText('Template for recording daily standup meeting notes')).toBeInTheDocument();
  });

  it('renders category badge', () => {
    render(
      <TemplateCard template={mockTemplate} index={0} onUse={vi.fn()} onPreview={vi.fn()} />,
    );
    expect(screen.getByText('Meetings')).toBeInTheDocument();
  });

  it('renders use count', () => {
    render(
      <TemplateCard template={mockTemplate} index={0} onUse={vi.fn()} onPreview={vi.fn()} />,
    );
    expect(screen.getByText('Used 12 times')).toBeInTheDocument();
  });

  it('does not render use count when zero', () => {
    const noUseTemplate = { ...mockTemplate, useCount: 0 };
    render(
      <TemplateCard template={noUseTemplate} index={0} onUse={vi.fn()} onPreview={vi.fn()} />,
    );
    expect(screen.queryByText(/Used/)).not.toBeInTheDocument();
  });

  it('renders singular use count', () => {
    const singleUse = { ...mockTemplate, useCount: 1 };
    render(
      <TemplateCard template={singleUse} index={0} onUse={vi.fn()} onPreview={vi.fn()} />,
    );
    expect(screen.getByText('Used 1 time')).toBeInTheDocument();
  });

  it('calls onUse when Use button is clicked', () => {
    const onUse = vi.fn();
    render(
      <TemplateCard template={mockTemplate} index={0} onUse={onUse} onPreview={vi.fn()} />,
    );
    fireEvent.click(screen.getByTestId('template-use-tpl-1'));
    expect(onUse).toHaveBeenCalledWith(mockTemplate);
  });

  it('calls onPreview when Preview button is clicked', () => {
    const onPreview = vi.fn();
    render(
      <TemplateCard template={mockTemplate} index={0} onUse={vi.fn()} onPreview={onPreview} />,
    );
    fireEvent.click(screen.getByTestId('template-preview-tpl-1'));
    expect(onPreview).toHaveBeenCalledWith(mockTemplate);
  });

  it('has correct test id', () => {
    render(
      <TemplateCard template={mockTemplate} index={0} onUse={vi.fn()} onPreview={vi.fn()} />,
    );
    expect(screen.getByTestId('template-card-tpl-1')).toBeInTheDocument();
  });
});
