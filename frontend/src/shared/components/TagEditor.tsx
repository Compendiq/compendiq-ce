import { useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import type { Ref } from 'react';
import { X, Plus, Tag } from 'lucide-react';
import { cn } from '../lib/cn';
import { normalizeTag, MAX_TAG_LENGTH } from '../lib/tag-utils';

export interface TagEditorHandle {
  /**
   * Hide an open autocomplete list. Returns whether there was one to hide.
   *
   * This exists for `TagPopover`, which has to decide what a single Escape
   * means before the editor ever sees the key: Radix takes Escape at
   * `document` in the capture phase, so the layer either peels the list or
   * closes itself, and only it can tell which. The boolean is the whole
   * contract — the caller closes when it comes back false.
   */
  dismissSuggestions: () => boolean;
}

interface TagEditorProps {
  /** Current tags on the page */
  tags: string[];
  /** Called when a tag is added */
  onAddTag: (tag: string) => void;
  /** Called when a tag is removed */
  onRemoveTag: (tag: string) => void;
  /** All known tags for autocomplete suggestions */
  suggestions?: string[];
  /** Whether mutation is in-flight */
  isLoading?: boolean;
  /** Focus the input on mount — set by `TagPopover` so opening the chip lands the caret in the field */
  autoFocus?: boolean;
  /** Additional CSS classes */
  className?: string;
  /** Imperative handle — see `TagEditorHandle` */
  ref?: Ref<TagEditorHandle>;
}

/**
 * Inline tag editor for article edit mode.
 * - Displays current tags as removable badges
 * - Input with autocomplete from existing database tags
 * - Add on Enter or button click
 * - Validates: trim, max length, prevent duplicates
 */
export function TagEditor({
  tags,
  onAddTag,
  onRemoveTag,
  suggestions = [],
  isLoading = false,
  autoFocus = false,
  className,
  ref,
}: TagEditorProps) {
  const [input, setInput] = useState('');
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [highlightedIndex, setHighlightedIndex] = useState(-1);
  const inputRef = useRef<HTMLInputElement>(null);
  const suggestionsRef = useRef<HTMLUListElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const tagSet = useMemo(() => new Set(tags.map((t) => t.toLowerCase())), [tags]);

  const filteredSuggestions = useMemo(() => {
    const trimmed = input.trim().toLowerCase();
    if (!trimmed) return [];
    return suggestions
      .filter((s) => s.toLowerCase().includes(trimmed) && !tagSet.has(s.toLowerCase()))
      .slice(0, 8);
  }, [input, suggestions, tagSet]);

  // Close suggestions when clicking outside
  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setShowSuggestions(false);
      }
    }

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  // Reset highlight when suggestions change
  useEffect(() => {
    setHighlightedIndex(-1);
  }, [filteredSuggestions.length]);

  // An effect rather than the DOM `autoFocus` attribute, so the caller can see
  // it happen and so it re-runs if the flag flips on a live instance.
  //
  // This alone is not enough inside a Radix layer: child effects run before
  // parent effects, so `Popover.Content`'s FocusScope mounts *after* this and
  // would move focus to the content wrapper. `TagPopover` preventDefaults
  // `onOpenAutoFocus` for exactly that reason — the two halves are one
  // mechanism, and removing either leaves the caret off the input.
  useEffect(() => {
    if (autoFocus) inputRef.current?.focus();
  }, [autoFocus]);

  const suggestionsOpen = showSuggestions && filteredSuggestions.length > 0;

  useImperativeHandle(
    ref,
    () => ({
      dismissSuggestions: () => {
        if (!suggestionsOpen) return false;
        setShowSuggestions(false);
        setHighlightedIndex(-1);
        return true;
      },
    }),
    [suggestionsOpen],
  );

  const handleAddTag = useCallback(
    (raw: string) => {
      const normalized = normalizeTag(raw);
      if (!normalized) return;
      if (tagSet.has(normalized)) return;
      onAddTag(normalized);
      setInput('');
      setShowSuggestions(false);
      inputRef.current?.focus();
    },
    [onAddTag, tagSet],
  );

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLInputElement>) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        if (highlightedIndex >= 0 && highlightedIndex < filteredSuggestions.length) {
          handleAddTag(filteredSuggestions[highlightedIndex]!);
        } else {
          handleAddTag(input);
        }
      } else if (event.key === 'Escape') {
        // Standalone only. Inside `TagPopover` this never runs: Radix binds its
        // Escape listener with `capture: true`, so it sees the key at
        // `document` before React dispatches from its root container — and it
        // stops the key there. That layer peels the list through
        // `dismissSuggestions()` instead.
        setShowSuggestions(false);
        setHighlightedIndex(-1);
      } else if (event.key === 'ArrowDown') {
        event.preventDefault();
        setHighlightedIndex((prev) =>
          prev < filteredSuggestions.length - 1 ? prev + 1 : 0,
        );
        setShowSuggestions(true);
      } else if (event.key === 'ArrowUp') {
        event.preventDefault();
        setHighlightedIndex((prev) =>
          prev > 0 ? prev - 1 : filteredSuggestions.length - 1,
        );
        setShowSuggestions(true);
      }
    },
    [filteredSuggestions, handleAddTag, highlightedIndex, input],
  );

  const handleInputChange = useCallback((event: React.ChangeEvent<HTMLInputElement>) => {
    setInput(event.target.value);
    setShowSuggestions(true);
  }, []);

  return (
    <div
      ref={containerRef}
      className={cn('space-y-3', className)}
      data-testid="tag-editor"
    >
      {/* Current tags */}
      <div className="flex flex-wrap gap-2">
        {tags.map((tag) => (
          <span
            key={tag}
            className="inline-flex items-center gap-1.5 rounded-full border border-border bg-background/45 px-3 py-1 text-xs font-medium text-muted-foreground transition-colors hover:border-border"
          >
            <Tag size={10} className="opacity-60" />
            {tag}
            <button
              type="button"
              onClick={() => onRemoveTag(tag)}
              disabled={isLoading}
              className="ml-0.5 rounded-full p-0.5 text-muted-foreground/60 transition-colors hover:bg-destructive/12 hover:text-destructive disabled:opacity-40"
              aria-label={`Remove tag ${tag}`}
              data-testid={`remove-tag-${tag}`}
            >
              <X size={10} />
            </button>
          </span>
        ))}
        {tags.length === 0 && (
          <span className="text-xs text-muted-foreground/50 italic">No tags yet</span>
        )}
      </div>

      {/* Input row */}
      <div className="relative">
        <div className="flex items-center gap-2">
          <div className="relative flex-1">
            <input
              ref={inputRef}
              type="text"
              value={input}
              onChange={handleInputChange}
              onKeyDown={handleKeyDown}
              onFocus={() => input.trim() && setShowSuggestions(true)}
              placeholder="Add a tag..."
              maxLength={MAX_TAG_LENGTH}
              disabled={isLoading}
              className="w-full rounded-xl border border-border bg-background/60 px-3 py-2 pl-8 text-sm text-foreground outline-none transition-colors placeholder:text-muted-foreground/50 focus:border-primary disabled:opacity-50"
              data-testid="tag-input"
              aria-label="New tag name"
              aria-autocomplete="list"
              aria-expanded={suggestionsOpen}
              role="combobox"
            />
            <Tag
              size={14}
              className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground/40"
            />
          </div>
          <button
            type="button"
            onClick={() => handleAddTag(input)}
            disabled={isLoading || !input.trim()}
            className="inline-flex items-center gap-1.5 rounded-xl border border-border bg-background/55 px-3 py-2 text-sm text-muted-foreground transition-colors hover:bg-background hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
            data-testid="add-tag-button"
          >
            <Plus size={14} />
            Add
          </button>
        </div>

        {/* Autocomplete dropdown */}
        {suggestionsOpen && (
          <ul
            ref={suggestionsRef}
            role="listbox"
            data-testid="tag-suggestions"
            className="absolute z-20 mt-1 max-h-48 w-full overflow-y-auto nm-card-elevated"
          >
            {filteredSuggestions.map((suggestion, index) => (
              <li
                key={suggestion}
                role="option"
                aria-selected={index === highlightedIndex}
                data-testid={`tag-suggestion-${suggestion}`}
                className={cn(
                  'cursor-pointer px-3 py-2 text-sm transition-colors',
                  index === highlightedIndex
                    ? 'bg-action/12 text-foreground'
                    : 'text-muted-foreground hover:bg-background/60 hover:text-foreground',
                )}
                onMouseDown={(event) => {
                  event.preventDefault();
                  handleAddTag(suggestion);
                }}
                onMouseEnter={() => setHighlightedIndex(index)}
              >
                <span className="inline-flex items-center gap-2">
                  <Tag size={12} className="opacity-50" />
                  {suggestion}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
