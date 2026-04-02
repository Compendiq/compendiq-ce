import { useState, useEffect, useRef, useCallback } from 'react';
import {
  Search,
  Replace,
  ChevronUp,
  ChevronDown,
  X,
  CaseSensitive,
  WholeWord,
  Regex,
} from 'lucide-react';
import { cn } from '../../lib/cn';
import { SearchQuery } from './search-extension';
import type { Editor as EditorType } from '@tiptap/react';

interface SearchAndReplaceProps {
  editor: EditorType;
}

export function SearchAndReplace({ editor }: SearchAndReplaceProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [showReplace, setShowReplace] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');
  const [replaceTerm, setReplaceTerm] = useState('');
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [wholeWord, setWholeWord] = useState(false);
  const [useRegex, setUseRegex] = useState(false);
  const [matchInfo, setMatchInfo] = useState<{ current: number; total: number }>({ current: 0, total: 0 });

  const searchInputRef = useRef<HTMLInputElement>(null);

  // Listen for the open-search custom event from keyboard shortcuts
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<{ replace: boolean }>).detail;
      setIsOpen(true);
      setShowReplace(detail.replace);
      // Focus the search input after render
      setTimeout(() => searchInputRef.current?.focus(), 0);
    };
    document.addEventListener('editor:open-search', handler);
    return () => document.removeEventListener('editor:open-search', handler);
  }, []);

  // Focus input when opening
  useEffect(() => {
    if (isOpen) {
      setTimeout(() => {
        searchInputRef.current?.focus();
        searchInputRef.current?.select();
      }, 0);
    }
  }, [isOpen]);

  const close = useCallback(() => {
    setIsOpen(false);
    setSearchTerm('');
    setReplaceTerm('');
    setMatchInfo({ current: 0, total: 0 });
    editor.commands.clearSearch();
    editor.commands.focus();
  }, [editor]);

  // Count matches whenever the search query or document changes.
  // Capped at 10 000 to avoid UI jank on high-frequency patterns (e.g. \b).
  const MAX_MATCHES = 10_000;
  const countMatches = useCallback(
    (term: string, cs: boolean, ww: boolean, re: boolean) => {
      if (!term) {
        setMatchInfo({ current: 0, total: 0 });
        return;
      }
      const query = new SearchQuery({
        search: term,
        caseSensitive: cs,
        wholeWord: ww,
        regexp: re,
      });

      // Single pass: count all matches and find which one the cursor is at
      const { from } = editor.state.selection;
      let count = 0;
      let currentIndex = 0;
      let result = query.findNext(editor.state, 0);
      while (result && count < MAX_MATCHES) {
        count++;
        if (result.from <= from && result.to >= from) {
          currentIndex = count;
        }
        if (result.to >= editor.state.doc.content.size) break;
        result = query.findNext(editor.state, Math.max(result.to, result.from + 1));
      }

      setMatchInfo({ current: currentIndex, total: count });
    },
    [editor],
  );

  // Update search query when search term or options change
  useEffect(() => {
    if (!isOpen) return;

    const query = new SearchQuery({
      search: searchTerm,
      replace: replaceTerm,
      caseSensitive,
      wholeWord,
      regexp: useRegex,
    });
    editor.commands.setSearchQuery(query);
    countMatches(searchTerm, caseSensitive, wholeWord, useRegex);
  }, [searchTerm, replaceTerm, caseSensitive, wholeWord, useRegex, isOpen, editor, countMatches]);

  // Recount on document changes
  useEffect(() => {
    if (!isOpen || !searchTerm) return;
    const handler = () => {
      countMatches(searchTerm, caseSensitive, wholeWord, useRegex);
    };
    editor.on('update', handler);
    editor.on('selectionUpdate', handler);
    return () => {
      editor.off('update', handler);
      editor.off('selectionUpdate', handler);
    };
  }, [isOpen, searchTerm, caseSensitive, wholeWord, useRegex, editor, countMatches]);

  // Close on Escape
  useEffect(() => {
    if (!isOpen) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        close();
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [isOpen, close]);

  const handleFindNext = useCallback(() => {
    editor.commands.findNext();
    // Defer recount to after selection moves
    setTimeout(() => countMatches(searchTerm, caseSensitive, wholeWord, useRegex), 0);
  }, [editor, searchTerm, caseSensitive, wholeWord, useRegex, countMatches]);

  const handleFindPrev = useCallback(() => {
    editor.commands.findPrev();
    setTimeout(() => countMatches(searchTerm, caseSensitive, wholeWord, useRegex), 0);
  }, [editor, searchTerm, caseSensitive, wholeWord, useRegex, countMatches]);

  const handleReplaceNext = useCallback(() => {
    editor.commands.replaceNext();
    setTimeout(() => countMatches(searchTerm, caseSensitive, wholeWord, useRegex), 0);
  }, [editor, searchTerm, caseSensitive, wholeWord, useRegex, countMatches]);

  const handleReplaceAll = useCallback(() => {
    editor.commands.replaceAll();
    setTimeout(() => countMatches(searchTerm, caseSensitive, wholeWord, useRegex), 0);
  }, [editor, searchTerm, caseSensitive, wholeWord, useRegex, countMatches]);

  const handleSearchKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        if (e.shiftKey) {
          handleFindPrev();
        } else {
          handleFindNext();
        }
      }
    },
    [handleFindNext, handleFindPrev],
  );

  const handleReplaceKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        handleReplaceNext();
      }
    },
    [handleReplaceNext],
  );

  if (!isOpen) return null;

  return (
    <div
      data-testid="search-and-replace"
      className={cn(
        'absolute right-4 top-1 z-40',
        'rounded-lg border border-border/50 bg-card/95 backdrop-blur-sm shadow-lg',
        'flex flex-col gap-1.5 p-2',
        'min-w-[320px]',
      )}
    >
      {/* Search row */}
      <div className="flex items-center gap-1">
        <Search size={14} className="shrink-0 text-muted-foreground" />
        <input
          ref={searchInputRef}
          type="text"
          value={searchTerm}
          onChange={(e) => setSearchTerm(e.target.value)}
          onKeyDown={handleSearchKeyDown}
          placeholder="Search..."
          className="min-w-0 flex-1 rounded-md border border-border/50 bg-background px-2 py-1 text-xs text-foreground placeholder:text-muted-foreground focus:border-primary/50 focus:outline-none focus:ring-1 focus:ring-primary/30"
          autoFocus
        />

        {/* Match count */}
        <span className="shrink-0 text-xs text-muted-foreground tabular-nums min-w-[48px] text-center">
          {searchTerm
            ? matchInfo.total > 0
              ? `${matchInfo.current} of ${matchInfo.total}`
              : 'No results'
            : ''}
        </span>

        {/* Toggle buttons */}
        <ToggleButton
          active={caseSensitive}
          onClick={() => setCaseSensitive((v) => !v)}
          title="Match Case"
        >
          <CaseSensitive size={14} />
        </ToggleButton>
        <ToggleButton
          active={wholeWord}
          onClick={() => setWholeWord((v) => !v)}
          title="Match Whole Word"
        >
          <WholeWord size={14} />
        </ToggleButton>
        <ToggleButton
          active={useRegex}
          onClick={() => setUseRegex((v) => !v)}
          title="Use Regular Expression"
        >
          <Regex size={14} />
        </ToggleButton>

        {/* Navigation */}
        <button
          onClick={handleFindPrev}
          disabled={matchInfo.total === 0}
          title="Previous Match (Shift+Enter)"
          className="rounded p-0.5 text-muted-foreground hover:bg-foreground/5 hover:text-foreground disabled:opacity-30 disabled:cursor-not-allowed"
        >
          <ChevronUp size={16} />
        </button>
        <button
          onClick={handleFindNext}
          disabled={matchInfo.total === 0}
          title="Next Match (Enter)"
          className="rounded p-0.5 text-muted-foreground hover:bg-foreground/5 hover:text-foreground disabled:opacity-30 disabled:cursor-not-allowed"
        >
          <ChevronDown size={16} />
        </button>

        {/* Expand/collapse replace */}
        <button
          onClick={() => setShowReplace((v) => !v)}
          title={showReplace ? 'Hide Replace' : 'Show Replace (Ctrl+H)'}
          className={cn(
            'rounded p-0.5 transition-colors',
            showReplace
              ? 'bg-primary/20 text-primary'
              : 'text-muted-foreground hover:bg-foreground/5 hover:text-foreground',
          )}
        >
          <Replace size={16} />
        </button>

        {/* Close */}
        <button
          onClick={close}
          title="Close (Escape)"
          className="rounded p-0.5 text-muted-foreground hover:bg-foreground/5 hover:text-foreground"
        >
          <X size={16} />
        </button>
      </div>

      {/* Replace row */}
      {showReplace && (
        <div className="flex items-center gap-1">
          <Replace size={14} className="shrink-0 text-muted-foreground" />
          <input
            type="text"
            value={replaceTerm}
            onChange={(e) => setReplaceTerm(e.target.value)}
            onKeyDown={handleReplaceKeyDown}
            placeholder="Replace..."
            className="min-w-0 flex-1 rounded-md border border-border/50 bg-background px-2 py-1 text-xs text-foreground placeholder:text-muted-foreground focus:border-primary/50 focus:outline-none focus:ring-1 focus:ring-primary/30"
          />
          <button
            onClick={handleReplaceNext}
            disabled={matchInfo.total === 0}
            title="Replace (Enter)"
            className="shrink-0 rounded-md border border-border/50 px-2 py-1 text-xs text-muted-foreground hover:bg-foreground/5 hover:text-foreground disabled:opacity-30 disabled:cursor-not-allowed"
          >
            Replace
          </button>
          <button
            onClick={handleReplaceAll}
            disabled={matchInfo.total === 0}
            title="Replace All"
            className="shrink-0 rounded-md border border-border/50 px-2 py-1 text-xs text-muted-foreground hover:bg-foreground/5 hover:text-foreground disabled:opacity-30 disabled:cursor-not-allowed"
          >
            All
          </button>
        </div>
      )}
    </div>
  );
}

function ToggleButton({
  active,
  onClick,
  title,
  children,
}: {
  active: boolean;
  onClick: () => void;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      className={cn(
        'rounded p-0.5 transition-colors',
        active
          ? 'bg-primary/20 text-primary ring-1 ring-primary/30'
          : 'text-muted-foreground hover:bg-foreground/5 hover:text-foreground',
      )}
    >
      {children}
    </button>
  );
}
