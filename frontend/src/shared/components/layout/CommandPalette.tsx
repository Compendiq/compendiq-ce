import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import * as Dialog from '@radix-ui/react-dialog';
import { m } from 'framer-motion';
import {
  Search, FileText, Plus, Settings, Bot,
  Clock, ArrowRight, Sparkles,
} from 'lucide-react';
import { useCommandPaletteStore } from '../../../stores/command-palette-store';
import { apiFetch } from '../../lib/api';
import { cn } from '../../lib/cn';

interface SearchResult {
  id: string;
  title: string;
  spaceKey: string;
}

interface QuickAction {
  id: string;
  label: string;
  icon: typeof FileText;
  path: string;
}

const QUICK_ACTIONS: QuickAction[] = [
  { id: 'new-page', label: 'New Page', icon: Plus, path: '/pages/new' },
  { id: 'settings', label: 'Settings', icon: Settings, path: '/settings' },
  { id: 'ai-assistant', label: 'AI Assistant', icon: Bot, path: '/ai' },
];

const RECENT_SEARCHES_KEY = 'kb-recent-searches';
const MAX_RECENT = 5;

function getRecentSearches(): string[] {
  try {
    const stored = localStorage.getItem(RECENT_SEARCHES_KEY);
    return stored ? JSON.parse(stored) : [];
  } catch {
    return [];
  }
}

function addRecentSearch(term: string) {
  const recent = getRecentSearches().filter((s) => s !== term);
  recent.unshift(term);
  localStorage.setItem(RECENT_SEARCHES_KEY, JSON.stringify(recent.slice(0, MAX_RECENT)));
}

export function CommandPalette() {
  const isOpen = useCommandPaletteStore((s) => s.isOpen);
  const close = useCommandPaletteStore((s) => s.close);
  const navigate = useNavigate();
  const inputRef = useRef<HTMLInputElement>(null);
  // The element focused before the palette opened, so focus can be restored on
  // close. Radix Dialog only restores to a <Dialog.Trigger>, but this palette
  // opens programmatically (Cmd+K) with no trigger, so we track it ourselves.
  const restoreFocusRef = useRef<HTMLElement | null>(null);

  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [recentSearches, setRecentSearches] = useState<string[]>([]);
  const searchSequenceRef = useRef(0);

  // AI mode: activated when query starts with "/ai"
  const isAiMode = query.trimStart().toLowerCase().startsWith('/ai');
  const aiQuery = isAiMode ? query.trimStart().slice(3).trim() : '';

  // Reset transient state when opened (focus is handled by Radix onOpenAutoFocus)
  useEffect(() => {
    if (isOpen) {
      setRecentSearches(getRecentSearches());
      setQuery('');
      setResults([]);
      setSelectedIndex(0);
    }
  }, [isOpen]);

  // Search pages with debounce (skip in AI mode)
  useEffect(() => {
    const searchSequence = searchSequenceRef.current + 1;
    searchSequenceRef.current = searchSequence;

    if (!query.trim() || isAiMode) {
      setResults([]);
      setSelectedIndex(0);
      setIsSearching(false);
      return;
    }

    const controller = new AbortController();

    const timeoutId = setTimeout(async () => {
      setIsSearching(true);
      try {
        const data = await apiFetch<{ items: SearchResult[] }>(
          `/pages?search=${encodeURIComponent(query)}&limit=8`,
          { signal: controller.signal },
        );
        if (searchSequenceRef.current !== searchSequence) return;
        setResults(data.items);
        setSelectedIndex(0);
      } catch {
        if (controller.signal.aborted || searchSequenceRef.current !== searchSequence) return;
        setResults([]);
      } finally {
        if (searchSequenceRef.current === searchSequence) {
          setIsSearching(false);
        }
      }
    }, 250);

    return () => {
      clearTimeout(timeoutId);
      controller.abort();
    };
  }, [query, isAiMode]);

  // Title search missed. Offer the two tools that can actually answer a
  // question: the Pages list (hybrid) and the AI composer. Not shown while
  // a request is in flight — that would flash recovery under "Searching...".
  const recoveryItems = useMemo(() => {
    if (!query.trim() || isAiMode || isSearching || results.length > 0) return [];
    const q = query.trim();
    return [
      {
        id: 'search-in-pages',
        type: 'action' as const,
        label: 'Search in Pages',
        path: `/?search=${encodeURIComponent(q)}&mode=hybrid`,
      },
      {
        id: 'ask-ai',
        type: 'ai' as const,
        label: `Ask AI: ${q}`,
        path: `/ai?q=${encodeURIComponent(q)}`,
      },
    ];
  }, [query, isAiMode, isSearching, results.length]);

  // Build combined items list for keyboard navigation
  const allItems = useMemo(() => {
    const items: Array<{ id: string; type: 'result' | 'action' | 'recent' | 'ai'; label: string; path?: string }> = [];

    if (isAiMode) {
      // In AI mode, show "Ask AI" as the prominent first result
      items.push({
        id: 'ai-ask',
        type: 'ai',
        label: aiQuery ? `Ask AI: ${aiQuery}` : 'Ask AI',
        // Carry the typed question through so the AI page can prefill its
        // composer (#957) instead of dropping it.
        path: aiQuery ? `/ai?q=${encodeURIComponent(aiQuery)}` : '/ai',
      });
      return items;
    }

    if (query.trim()) {
      results.forEach((r) => {
        items.push({ id: `result-${r.id}`, type: 'result', label: r.title, path: `/pages/${r.id}` });
      });
      recoveryItems.forEach((item) => items.push(item));
    } else {
      recentSearches.forEach((term, i) => {
        items.push({ id: `recent-${i}`, type: 'recent', label: term });
      });
    }

    QUICK_ACTIONS.forEach((a) => {
      items.push({ id: a.id, type: 'action', label: a.label, path: a.path });
    });

    return items;
  }, [query, results, recentSearches, isAiMode, aiQuery, recoveryItems]);

  const handleSelect = useCallback((index: number) => {
    const item = allItems[index];
    if (!item) return;

    if (item.type === 'recent') {
      setQuery(item.label);
      return;
    }

    if (item.path) {
      if (item.type === 'result') {
        addRecentSearch(query);
      }
      navigate(item.path);
      close();
    }
  }, [allItems, close, navigate, query]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelectedIndex((prev) => Math.min(prev + 1, allItems.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelectedIndex((prev) => Math.max(prev - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      handleSelect(selectedIndex);
    } else if (e.key === 'Escape') {
      close();
    }
  }, [allItems.length, close, handleSelect, selectedIndex]);

  // aria-activedescendant/option ids share a stable index space with `allItems`
  // (and with the selectedIndex / handleSelect indices used below).
  const activeOptionId = allItems.length > 0 ? `cmdk-opt-${selectedIndex}` : undefined;

  return (
    <Dialog.Root open={isOpen} onOpenChange={(open) => { if (!open) close(); }}>
      <Dialog.Portal>
        {/* Backdrop — Radix owns focus trap/restore + Escape; keep click-to-close */}
        <Dialog.Overlay asChild>
          <m.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 0.15 }}
            className="fixed inset-0 z-50 bg-black/50 backdrop-blur-sm"
            onClick={close}
            data-testid="command-palette-backdrop"
          />
        </Dialog.Overlay>

        {/* Palette — handleKeyDown lives here so arrows/Enter/Escape work
            regardless of which child (input or an option button) holds focus */}
        <Dialog.Content
          asChild
          aria-describedby={undefined}
          onOpenAutoFocus={(e) => {
            e.preventDefault();
            restoreFocusRef.current = document.activeElement as HTMLElement | null;
            inputRef.current?.focus();
          }}
          onCloseAutoFocus={(e) => {
            // Radix would focus the (nonexistent) trigger; restore the opener.
            e.preventDefault();
            restoreFocusRef.current?.focus();
          }}
          onKeyDown={handleKeyDown}
        >
          <m.div
            initial={{ opacity: 0, scale: 0.95, y: -20 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            transition={{ duration: 0.15 }}
            className="fixed inset-x-0 top-[15%] z-50 mx-auto w-full max-w-xl outline-none"
          >
            <Dialog.Title className="sr-only">Command palette</Dialog.Title>
            <div className={cn(
              'nm-card-elevated overflow-hidden',
              // The glow went with the rest of them: a 30px coloured bloom is
              // the retired world's way of saying "this mode is special", and
              // `nm-card-elevated` already carries the one overlay shadow the
              // system has. The ring stays — that is the AI signal, and a ring
              // is a border, not an effect.
              isAiMode && 'ring-1 ring-status-ai/30',
            )}>
              {/* Search input */}
              <div className={cn(
                'flex items-center gap-3 border-b border-border px-4 py-3',
                isAiMode && 'border-status-ai/30',
              )}>
                {isAiMode ? (
                  <Sparkles size={18} className="text-status-ai" />
                ) : (
                  <Search size={18} className="text-muted-foreground" />
                )}
                <input
                  ref={inputRef}
                  type="text"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder={isAiMode ? 'Ask AI anything...' : 'Jump to page or command...'}
                  className={cn(
                    'flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground',
                    isAiMode && 'text-foreground placeholder:text-status-ai/50',
                  )}
                  aria-label="Jump to page or command"
                  role="combobox"
                  aria-expanded={allItems.length > 0}
                  aria-controls="cmdk-listbox"
                  aria-activedescendant={activeOptionId}
                  autoComplete="off"
                />
                <kbd className="rounded border border-border px-1.5 py-0.5 text-[11px] text-muted-foreground">
                  ESC
                </kbd>
              </div>

              {/* Results */}
              <div
                className="max-h-80 overflow-y-auto p-2"
                role="listbox"
                id="cmdk-listbox"
                aria-label="Results"
              >
                {/* AI mode result */}
                {isAiMode && (
                  <div className="mb-2">
                    <p className="mb-1 px-2 text-[12px] font-medium uppercase tracking-wider text-status-ai">
                      AI Assistant
                    </p>
                    <button
                      id="cmdk-opt-0"
                      role="option"
                      aria-selected={selectedIndex === 0}
                      onClick={() => handleSelect(0)}
                      onMouseEnter={() => setSelectedIndex(0)}
                      data-testid="ai-mode-ask-button"
                      className={cn(
                        'flex w-full items-center gap-3 rounded-md px-3 py-2.5 text-sm transition-colors',
                        selectedIndex === 0
                          ? 'bg-status-ai/20 text-status-ai'
                          : 'text-foreground hover:bg-status-ai/10',
                      )}
                    >
                      <Sparkles size={14} className="shrink-0 text-status-ai" />
                      <span className="font-medium">{aiQuery ? `Ask AI: ${aiQuery}` : 'Ask AI'}</span>
                      <kbd className="ml-auto rounded border border-border px-1.5 py-0.5 text-[11px] text-muted-foreground">
                        Enter
                      </kbd>
                    </button>
                  </div>
                )}

                {/* Search results */}
                {query.trim() && !isAiMode && results.length > 0 && (
                  <div className="mb-2">
                    <p className="mb-1 px-2 text-[12px] font-medium uppercase tracking-wider text-muted-foreground">
                      Pages
                    </p>
                    {results.map((result, i) => {
                      const idx = i;
                      return (
                        <button
                          key={result.id}
                          id={`cmdk-opt-${idx}`}
                          role="option"
                          aria-selected={selectedIndex === idx}
                          onClick={() => handleSelect(idx)}
                          onMouseEnter={() => setSelectedIndex(idx)}
                          className={cn(
                            'flex w-full items-center gap-3 rounded-md px-3 py-2 text-sm transition-colors',
                            selectedIndex === idx
                              ? 'bg-action/15 text-action'
                              : 'text-foreground hover:bg-foreground/5',
                          )}
                        >
                          <FileText size={14} className="shrink-0" />
                          <span className="truncate">{result.title}</span>
                          <span className="ml-auto text-xs text-muted-foreground">{result.spaceKey}</span>
                        </button>
                      );
                    })}
                  </div>
                )}

                {/* Loading indicator */}
                {isSearching && !isAiMode && (
                  <div className="flex items-center justify-center py-4 text-sm text-muted-foreground">
                    Searching...
                  </div>
                )}

                {/* Title search missed — offer the corpus search and Ask AI. */}
                {recoveryItems.length > 0 && (
                  <div className="mb-2">
                    <p className="mb-1 px-2 text-[12px] font-medium uppercase tracking-wider text-muted-foreground">
                      No matching titles
                    </p>
                    {recoveryItems.map((item, i) => (
                      <button
                        key={item.id}
                        id={`cmdk-opt-${i}`}
                        role="option"
                        aria-selected={selectedIndex === i}
                        onClick={() => handleSelect(i)}
                        onMouseEnter={() => setSelectedIndex(i)}
                        data-testid={item.id}
                        className={cn(
                          'flex w-full items-center gap-3 rounded-md px-3 py-2 text-sm transition-colors',
                          selectedIndex === i
                            ? 'bg-action/15 text-action'
                            : 'text-foreground hover:bg-foreground/5',
                        )}
                      >
                        {item.id === 'ask-ai'
                          ? <Sparkles size={14} className="shrink-0 text-status-ai" />
                          : <Search size={14} className="shrink-0" />}
                        <span className="truncate">{item.label}</span>
                      </button>
                    ))}
                  </div>
                )}

                {/* Recent searches */}
                {!query.trim() && recentSearches.length > 0 && (
                  <div className="mb-2">
                    <p className="mb-1 px-2 text-[12px] font-medium uppercase tracking-wider text-muted-foreground">
                      Recent Searches
                    </p>
                    {recentSearches.map((term, i) => {
                      const idx = i;
                      return (
                        <button
                          key={`recent-${i}`}
                          id={`cmdk-opt-${idx}`}
                          role="option"
                          aria-selected={selectedIndex === idx}
                          onClick={() => handleSelect(idx)}
                          onMouseEnter={() => setSelectedIndex(idx)}
                          className={cn(
                            'flex w-full items-center gap-3 rounded-md px-3 py-2 text-sm transition-colors',
                            selectedIndex === idx
                              ? 'bg-action/15 text-action'
                              : 'text-foreground hover:bg-foreground/5',
                          )}
                        >
                          <Clock size={14} className="shrink-0 text-muted-foreground" />
                          <span className="truncate">{term}</span>
                          <ArrowRight size={12} className="ml-auto text-muted-foreground" />
                        </button>
                      );
                    })}
                  </div>
                )}

                {/* Quick actions (hidden in AI mode) */}
                {!isAiMode && (
                  <div>
                    <p className="mb-1 px-2 text-[12px] font-medium uppercase tracking-wider text-muted-foreground">
                      Quick Actions
                    </p>
                    {QUICK_ACTIONS.map((action, i) => {
                      const baseIdx = query.trim()
                        ? results.length + recoveryItems.length + i
                        : recentSearches.length + i;
                      const Icon = action.icon;
                      return (
                        <button
                          key={action.id}
                          id={`cmdk-opt-${baseIdx}`}
                          role="option"
                          aria-selected={selectedIndex === baseIdx}
                          onClick={() => handleSelect(baseIdx)}
                          onMouseEnter={() => setSelectedIndex(baseIdx)}
                          className={cn(
                            'flex w-full items-center gap-3 rounded-md px-3 py-2 text-sm transition-colors',
                            selectedIndex === baseIdx
                              ? 'bg-action/15 text-action'
                              : 'text-foreground hover:bg-foreground/5',
                          )}
                        >
                          <Icon size={14} className="shrink-0" />
                          <span>{action.label}</span>
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>

              {/* Footer */}
              <div className={cn(
                'flex items-center gap-4 border-t border-border px-4 py-2 text-[11px] text-muted-foreground',
                isAiMode && 'border-status-ai/30',
              )}>
                <span><kbd className="rounded border border-border px-1 py-0.5">↑↓</kbd> Navigate</span>
                <span><kbd className="rounded border border-border px-1 py-0.5">↵</kbd> Select</span>
                <span><kbd className="rounded border border-border px-1 py-0.5">esc</kbd> Close</span>
                {!isAiMode && (
                  <span className="ml-auto"><kbd className="rounded border border-border px-1 py-0.5">/ai</kbd> AI mode</span>
                )}
              </div>
            </div>
          </m.div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
