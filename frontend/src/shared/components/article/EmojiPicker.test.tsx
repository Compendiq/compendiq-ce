import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import type { Editor as EditorType } from '@tiptap/react';
import { EmojiPicker } from './EmojiPicker';

function createMockEditor(overrides: Partial<Record<string, unknown>> = {}): EditorType {
  const chainProxy: Record<string, unknown> = new Proxy({} as Record<string, unknown>, {
    get(_t, prop: string) {
      if (prop === 'run') return vi.fn();
      return () => chainProxy;
    },
  });
  return {
    chain: () => chainProxy,
    can: () => new Proxy({}, { get: () => () => true }),
    isActive: () => false,
    getAttributes: () => ({}),
    state: { selection: { from: 0 }, doc: { nodeAt: () => null } },
    on: vi.fn(),
    off: vi.fn(),
    commands: { focus: vi.fn() },
    ...overrides,
  } as unknown as EditorType;
}

function openPicker() {
  const trigger = screen.getByTestId('emoji-picker-trigger');
  fireEvent.pointerDown(trigger, { button: 0, pointerType: 'mouse' });
  fireEvent.click(trigger);
}

describe('EmojiPicker', () => {
  it('renders the trigger button with proper accessible attributes', () => {
    render(<EmojiPicker editor={createMockEditor()} />);
    const trigger = screen.getByTestId('emoji-picker-trigger');
    expect(trigger).toBeInTheDocument();
    expect(trigger).toHaveAttribute('aria-label', 'Insert Emoji');
    expect(trigger).toHaveAttribute('title', 'Insert Emoji');
    expect(trigger).toHaveAttribute('aria-haspopup', 'dialog');
    expect(trigger).toHaveAttribute('aria-pressed', 'false');
  });

  it('opens popover dialog on click', () => {
    render(<EmojiPicker editor={createMockEditor()} />);
    openPicker();
    expect(screen.getByRole('dialog', { name: 'Emoji Picker' })).toBeInTheDocument();
    expect(screen.getByTestId('emoji-search-input')).toBeInTheDocument();
  });

  it('displays popular emojis and category tabs when opened', () => {
    render(<EmojiPicker editor={createMockEditor()} />);
    openPicker();

    expect(screen.getByText('Popular')).toBeInTheDocument();
    expect(screen.getByTestId('popular-emoji-👍')).toBeInTheDocument();
    expect(screen.getByTestId('popular-emoji-❤️')).toBeInTheDocument();
    expect(screen.getByTestId('popular-emoji-🎉')).toBeInTheDocument();
    expect(screen.getByTestId('popular-emoji-🔥')).toBeInTheDocument();

    expect(screen.getByRole('tablist', { name: 'Emoji categories' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'All Categories' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Smileys & Emotion' })).toBeInTheDocument();
  });

  it('inserts clicked emoji into the editor and closes popover', () => {
    const insertContent = vi.fn(() => chain);
    const chain: Record<string, unknown> = new Proxy({ insertContent } as Record<string, unknown>, {
      get(target, prop: string) {
        if (prop === 'insertContent') return target.insertContent;
        if (prop === 'run') return vi.fn();
        return () => chain;
      },
    });
    const editor = createMockEditor({ chain: () => chain });
    render(<EmojiPicker editor={editor} />);
    openPicker();

    fireEvent.click(screen.getByTestId('popular-emoji-🔥'));
    expect(insertContent).toHaveBeenCalledWith('🔥');
    expect(screen.queryByRole('dialog', { name: 'Emoji Picker' })).not.toBeInTheDocument();
  });

  it('filters emojis when typing in search input', () => {
    render(<EmojiPicker editor={createMockEditor()} />);
    openPicker();

    const searchInput = screen.getByTestId('emoji-search-input');
    fireEvent.change(searchInput, { target: { value: 'rocket' } });

    expect(screen.getByTestId('emoji-item-🚀')).toBeInTheDocument();
    expect(screen.queryByText('Popular')).not.toBeInTheDocument();
    expect(screen.queryByRole('tablist', { name: 'Emoji categories' })).not.toBeInTheDocument();
  });

  it('shows no results message for non-matching query', () => {
    render(<EmojiPicker editor={createMockEditor()} />);
    openPicker();

    const searchInput = screen.getByTestId('emoji-search-input');
    fireEvent.change(searchInput, { target: { value: 'xyznonexistentemoji' } });

    expect(screen.getByText(/No emojis found for "xyznonexistentemoji"/i)).toBeInTheDocument();
  });

  it('clears search query and restores full view when clear button is clicked', () => {
    render(<EmojiPicker editor={createMockEditor()} />);
    openPicker();

    const searchInput = screen.getByTestId('emoji-search-input');
    fireEvent.change(searchInput, { target: { value: 'sparkles' } });
    expect(screen.getByTestId('emoji-item-✨')).toBeInTheDocument();

    const clearButton = screen.getByRole('button', { name: 'Clear search' });
    fireEvent.click(clearButton);

    expect(searchInput).toHaveValue('');
    expect(screen.getByText('Popular')).toBeInTheDocument();
  });

  it('inserts the first matching emoji on Enter in the search input', () => {
    const insertContent = vi.fn(() => chain);
    const chain: Record<string, unknown> = new Proxy({ insertContent } as Record<string, unknown>, {
      get(target, prop: string) {
        if (prop === 'insertContent') return target.insertContent;
        if (prop === 'run') return vi.fn();
        return () => chain;
      },
    });
    const editor = createMockEditor({ chain: () => chain });
    render(<EmojiPicker editor={editor} />);
    openPicker();

    const searchInput = screen.getByTestId('emoji-search-input');
    fireEvent.change(searchInput, { target: { value: 'thumbs up' } });
    fireEvent.keyDown(searchInput, { key: 'Enter', code: 'Enter' });

    expect(insertContent).toHaveBeenCalledWith('👍');
    expect(screen.queryByRole('dialog', { name: 'Emoji Picker' })).not.toBeInTheDocument();
  });

  it('filters by category tab when clicked', () => {
    render(<EmojiPicker editor={createMockEditor()} />);
    openPicker();

    const foodTab = screen.getByRole('tab', { name: 'Food & Drink' });
    fireEvent.click(foodTab);
    expect(foodTab).toHaveAttribute('aria-selected', 'true');

    expect(screen.getByText('Food & Drink')).toBeInTheDocument();
    expect(screen.getByTestId('emoji-item-🍕')).toBeInTheDocument();
    expect(screen.queryByText('Popular')).not.toBeInTheDocument();
  });

  it('updates preview footer when hovering over an emoji', () => {
    render(<EmojiPicker editor={createMockEditor()} />);
    openPicker();

    expect(screen.getByText('Select an emoji to insert')).toBeInTheDocument();

    const heartEmoji = screen.getByTestId('popular-emoji-❤️');
    fireEvent.mouseEnter(heartEmoji);

    expect(screen.getByText('red heart')).toBeInTheDocument();
  });
});
