import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { TagEditor } from './TagEditor';
import { normalizeTag } from '../lib/tag-utils';

describe('normalizeTag', () => {
  it('trims whitespace', () => {
    expect(normalizeTag('  hello  ')).toBe('hello');
  });

  it('lowercases input', () => {
    expect(normalizeTag('MyTag')).toBe('mytag');
  });

  it('replaces spaces with hyphens', () => {
    expect(normalizeTag('my tag name')).toBe('my-tag-name');
  });

  it('strips invalid characters', () => {
    expect(normalizeTag('tag!@#$%^&*()+')).toBe('tag');
  });

  it('allows hyphens, underscores, colons, and dots', () => {
    expect(normalizeTag('my-tag_v2:latest.1')).toBe('my-tag_v2:latest.1');
  });

  it('truncates to 100 characters', () => {
    const long = 'a'.repeat(150);
    expect(normalizeTag(long)).toHaveLength(100);
  });

  it('returns empty string for whitespace-only input', () => {
    expect(normalizeTag('   ')).toBe('');
  });

  it('handles multiple consecutive spaces by collapsing to single hyphen', () => {
    expect(normalizeTag('my   tag')).toBe('my-tag');
  });
});

describe('TagEditor', () => {
  const defaultProps = {
    tags: ['react', 'typescript'],
    onAddTag: vi.fn(),
    onRemoveTag: vi.fn(),
    suggestions: ['react', 'typescript', 'javascript', 'nodejs', 'tailwind'],
  };

  it('renders the component with data-testid', () => {
    render(<TagEditor {...defaultProps} />);
    expect(screen.getByTestId('tag-editor')).toBeInTheDocument();
  });

  it('displays existing tags', () => {
    render(<TagEditor {...defaultProps} />);
    expect(screen.getByText('react')).toBeInTheDocument();
    expect(screen.getByText('typescript')).toBeInTheDocument();
  });

  it('shows "No tags yet" when tags array is empty', () => {
    render(<TagEditor {...defaultProps} tags={[]} />);
    expect(screen.getByText('No tags yet')).toBeInTheDocument();
  });

  it('renders remove button for each tag', () => {
    render(<TagEditor {...defaultProps} />);
    expect(screen.getByTestId('remove-tag-react')).toBeInTheDocument();
    expect(screen.getByTestId('remove-tag-typescript')).toBeInTheDocument();
  });

  it('calls onRemoveTag when remove button clicked', () => {
    const onRemoveTag = vi.fn();
    render(<TagEditor {...defaultProps} onRemoveTag={onRemoveTag} />);
    fireEvent.click(screen.getByTestId('remove-tag-react'));
    expect(onRemoveTag).toHaveBeenCalledWith('react');
  });

  it('renders input field and add button', () => {
    render(<TagEditor {...defaultProps} />);
    expect(screen.getByTestId('tag-input')).toBeInTheDocument();
    expect(screen.getByTestId('add-tag-button')).toBeInTheDocument();
  });

  it('add button is disabled when input is empty', () => {
    render(<TagEditor {...defaultProps} />);
    const addButton = screen.getByTestId('add-tag-button');
    expect(addButton).toBeDisabled();
  });

  it('calls onAddTag when Enter is pressed with valid input', () => {
    const onAddTag = vi.fn();
    render(<TagEditor {...defaultProps} onAddTag={onAddTag} />);

    const input = screen.getByTestId('tag-input');
    fireEvent.change(input, { target: { value: 'newtag' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(onAddTag).toHaveBeenCalledWith('newtag');
  });

  it('calls onAddTag when Add button is clicked', () => {
    const onAddTag = vi.fn();
    render(<TagEditor {...defaultProps} onAddTag={onAddTag} />);

    const input = screen.getByTestId('tag-input');
    fireEvent.change(input, { target: { value: 'newtag' } });
    fireEvent.click(screen.getByTestId('add-tag-button'));

    expect(onAddTag).toHaveBeenCalledWith('newtag');
  });

  it('clears input after adding a tag', () => {
    render(<TagEditor {...defaultProps} />);

    const input = screen.getByTestId('tag-input') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'newtag' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(input.value).toBe('');
  });

  it('does not add duplicate tags (case-insensitive)', () => {
    const onAddTag = vi.fn();
    render(<TagEditor {...defaultProps} onAddTag={onAddTag} />);

    const input = screen.getByTestId('tag-input');
    // 'React' normalizes to 'react', which already exists
    fireEvent.change(input, { target: { value: 'React' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(onAddTag).not.toHaveBeenCalled();
  });

  it('does not add empty tags', () => {
    const onAddTag = vi.fn();
    render(<TagEditor {...defaultProps} onAddTag={onAddTag} />);

    const input = screen.getByTestId('tag-input');
    fireEvent.change(input, { target: { value: '   ' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(onAddTag).not.toHaveBeenCalled();
  });

  it('shows autocomplete suggestions when typing', () => {
    render(<TagEditor {...defaultProps} />);

    const input = screen.getByTestId('tag-input');
    fireEvent.change(input, { target: { value: 'java' } });

    expect(screen.getByTestId('tag-suggestions')).toBeInTheDocument();
    expect(screen.getByTestId('tag-suggestion-javascript')).toBeInTheDocument();
  });

  it('filters out already-applied tags from suggestions', () => {
    render(<TagEditor {...defaultProps} />);

    const input = screen.getByTestId('tag-input');
    // 'react' is already a tag, so it should not appear in suggestions
    fireEvent.change(input, { target: { value: 'rea' } });

    expect(screen.queryByTestId('tag-suggestion-react')).not.toBeInTheDocument();
  });

  it('adds suggestion on mouseDown', () => {
    const onAddTag = vi.fn();
    render(<TagEditor {...defaultProps} onAddTag={onAddTag} />);

    const input = screen.getByTestId('tag-input');
    fireEvent.change(input, { target: { value: 'java' } });

    fireEvent.mouseDown(screen.getByTestId('tag-suggestion-javascript'));
    expect(onAddTag).toHaveBeenCalledWith('javascript');
  });

  it('navigates suggestions with arrow keys', () => {
    render(<TagEditor {...defaultProps} />);

    const input = screen.getByTestId('tag-input');
    fireEvent.change(input, { target: { value: 'java' } });

    fireEvent.keyDown(input, { key: 'ArrowDown' });

    const suggestion = screen.getByTestId('tag-suggestion-javascript');
    expect(suggestion.getAttribute('aria-selected')).toBe('true');
  });

  it('closes suggestions on Escape', () => {
    render(<TagEditor {...defaultProps} />);

    const input = screen.getByTestId('tag-input');
    fireEvent.change(input, { target: { value: 'java' } });

    expect(screen.getByTestId('tag-suggestions')).toBeInTheDocument();

    fireEvent.keyDown(input, { key: 'Escape' });

    expect(screen.queryByTestId('tag-suggestions')).not.toBeInTheDocument();
  });

  it('disables input and remove buttons when isLoading', () => {
    render(<TagEditor {...defaultProps} isLoading />);

    const input = screen.getByTestId('tag-input');
    expect(input).toBeDisabled();

    const addButton = screen.getByTestId('add-tag-button');
    expect(addButton).toBeDisabled();

    const removeButton = screen.getByTestId('remove-tag-react');
    expect(removeButton).toBeDisabled();
  });

  it('has correct aria attributes on input', () => {
    render(<TagEditor {...defaultProps} />);
    const input = screen.getByTestId('tag-input');
    expect(input.getAttribute('role')).toBe('combobox');
    expect(input.getAttribute('aria-autocomplete')).toBe('list');
    expect(input.getAttribute('aria-label')).toBe('New tag name');
  });

  it('normalizes input before adding', () => {
    const onAddTag = vi.fn();
    render(<TagEditor {...defaultProps} onAddTag={onAddTag} />);

    const input = screen.getByTestId('tag-input');
    fireEvent.change(input, { target: { value: '  My New Tag  ' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(onAddTag).toHaveBeenCalledWith('my-new-tag');
  });

  it('shows no suggestions for empty input', () => {
    render(<TagEditor {...defaultProps} />);
    expect(screen.queryByTestId('tag-suggestions')).not.toBeInTheDocument();
  });

  it('applies custom className', () => {
    render(<TagEditor {...defaultProps} className="custom-class" />);
    const editor = screen.getByTestId('tag-editor');
    expect(editor.className).toContain('custom-class');
  });

  it('selects highlighted suggestion on Enter', () => {
    const onAddTag = vi.fn();
    render(<TagEditor {...defaultProps} onAddTag={onAddTag} />);

    const input = screen.getByTestId('tag-input');
    fireEvent.change(input, { target: { value: 'java' } });
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(onAddTag).toHaveBeenCalledWith('javascript');
  });

  it('wraps highlight around when pressing ArrowDown at end', () => {
    render(<TagEditor {...defaultProps} />);

    const input = screen.getByTestId('tag-input');
    fireEvent.change(input, { target: { value: 'java' } });

    // Only 'javascript' matches (nodejs too since it has 'a')
    // Press ArrowDown past all items should wrap to 0
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'ArrowDown' });

    // Should wrap around — first item should be highlighted again
    const suggestion = screen.getByTestId('tag-suggestion-javascript');
    expect(suggestion.getAttribute('aria-selected')).toBe('true');
  });
});
