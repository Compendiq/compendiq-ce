import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { X, Plus, Tag } from 'lucide-react';
import { cn } from '../lib/cn';
import { normalizeTag, MAX_TAG_LENGTH } from '../lib/tag-utils';

export interface TagEditorProps {
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
  /** Additional CSS classes */
  className?: string;
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
  className,
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
            className="inline-flex items-center gap-1.5 rounded-full border border-border/60 bg-background/45 px-3 py-1 text-xs font-medium text-muted-foreground transition-colors hover:border-border"
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
              className="w-full rounded-xl border border-border/60 bg-background/60 px-3 py-2 pl-8 text-sm text-foreground outline-none transition-colors placeholder:text-muted-foreground/50 focus:border-primary disabled:opacity-50"
              data-testid="tag-input"
              aria-label="New tag name"
              aria-autocomplete="list"
              aria-expanded={showSuggestions && filteredSuggestions.length > 0}
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
            className="inline-flex items-center gap-1.5 rounded-xl border border-border/60 bg-background/55 px-3 py-2 text-sm text-muted-foreground transition-colors hover:bg-background hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
            data-testid="add-tag-button"
          >
            <Plus size={14} />
            Add
          </button>
        </div>

        {/* Autocomplete dropdown */}
        {showSuggestions && filteredSuggestions.length > 0 && (
          <ul
            ref={suggestionsRef}
            role="listbox"
            data-testid="tag-suggestions"
            className="absolute z-20 mt-1 max-h-48 w-full overflow-y-auto rounded-xl border border-border/60 bg-card/95 shadow-lg backdrop-blur-xl"
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
                    ? 'bg-primary/12 text-foreground'
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
