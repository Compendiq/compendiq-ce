import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { m, AnimatePresence } from 'framer-motion';
import {
  Search, FileText, Plus, Settings, Bot, RefreshCw,
  Clock, ArrowRight, Sparkles,
} from 'lucide-react';
import { useCommandPaletteStore } from '../../stores/command-palette-store';
import { apiFetch } from '../lib/api';
import { cn } from '../lib/cn';

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
  { id: 'sync', label: 'Sync Pages', icon: RefreshCw, path: '/pages' },
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
  const { isOpen, close } = useCommandPaletteStore();
  const navigate = useNavigate();
  const inputRef = useRef<HTMLInputElement>(null);

  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [recentSearches, setRecentSearches] = useState<string[]>([]);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // AI mode: activated when query starts with "/ai"
  const isAiMode = query.trimStart().toLowerCase().startsWith('/ai');
  const aiQuery = isAiMode ? query.trimStart().slice(3).trim() : '';

  // Load recent searches when opened
  useEffect(() => {
    if (isOpen) {
      setRecentSearches(getRecentSearches());
      setQuery('');
      setResults([]);
      setSelectedIndex(0);
      // Focus input on next tick after mount
      requestAnimationFrame(() => {
        inputRef.current?.focus();
      });
    }
  }, [isOpen]);

  // Search pages with debounce
  useEffect(() => {
    if (!query.trim()) {
      setResults([]);
      setSelectedIndex(0);
      return;
    }

    if (debounceRef.current) clearTimeout(debounceRef.current);

    debounceRef.current = setTimeout(async () => {
      setIsSearching(true);
      try {
        const data = await apiFetch<{ items: SearchResult[] }>(`/pages?search=${encodeURIComponent(query)}&limit=8`);
        setResults(data.items);
        setSelectedIndex(0);
      } catch {
        setResults([]);
      } finally {
        setIsSearching(false);
      }
    }, 250);

    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [query]);

  // Build combined items list for keyboard navigation
  const allItems = useMemo(() => {
    const items: Array<{ id: string; type: 'result' | 'action' | 'recent' | 'ai'; label: string; path?: string }> = [];

    if (isAiMode) {
      // In AI mode, show "Ask AI" as the prominent first result
      items.push({
        id: 'ai-ask',
        type: 'ai',
        label: aiQuery ? `Ask AI: ${aiQuery}` : 'Ask AI',
        path: '/ai',
      });
    } else if (query.trim()) {
      results.forEach((r) => {
        items.push({ id: `result-${r.id}`, type: 'result', label: r.title, path: `/pages/${r.id}` });
      });
    }

    if (!query.trim()) {
      recentSearches.forEach((term, i) => {
        items.push({ id: `recent-${i}`, type: 'recent', label: term });
      });
    }

    if (!isAiMode) {
      QUICK_ACTIONS.forEach((a) => {
        items.push({ id: a.id, type: 'action', label: a.label, path: a.path });
      });
    }

    return items;
  }, [query, results, recentSearches, isAiMode, aiQuery]);

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

  if (!isOpen) return null;

  return (
    <AnimatePresence>
      {isOpen && (
        <>
          {/* Backdrop */}
          <m.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.15 }}
            className="fixed inset-0 z-50 bg-black/50 backdrop-blur-sm"
            onClick={close}
            data-testid="command-palette-backdrop"
          />

          {/* Palette */}
          <m.div
            initial={{ opacity: 0, scale: 0.95, y: -20 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.95, y: -20 }}
            transition={{ duration: 0.15 }}
            className="fixed inset-x-0 top-[15%] z-50 mx-auto w-full max-w-xl"
            role="dialog"
            aria-label="Command palette"
          >
            <div className={cn(
              'glass-card overflow-hidden shadow-2xl transition-shadow duration-200',
              isAiMode && 'shadow-[0_0_30px_-5px_rgba(168,85,247,0.4)] ring-1 ring-purple-500/30',
            )}>
              {/* Search input */}
              <div className={cn(
                'flex items-center gap-3 border-b border-border/50 px-4 py-3',
                isAiMode && 'border-purple-500/30',
              )}>
                {isAiMode ? (
                  <Sparkles size={18} className="text-purple-400" />
                ) : (
                  <Search size={18} className="text-muted-foreground" />
                )}
                <input
                  ref={inputRef}
                  type="text"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  onKeyDown={handleKeyDown}
                  placeholder={isAiMode ? 'Ask AI anything...' : 'Search pages or type a command...'}
                  className={cn(
                    'flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground',
                    isAiMode && 'text-purple-100 placeholder:text-purple-300/50',
                  )}
                  aria-label="Search"
                />
                <kbd className="rounded border border-border/50 px-1.5 py-0.5 text-[10px] text-muted-foreground">
                  ESC
                </kbd>
              </div>

              {/* Results */}
              <div className="max-h-80 overflow-y-auto p-2">
                {/* AI mode result */}
                {isAiMode && (
                  <div className="mb-2">
                    <p className="mb-1 px-2 text-[11px] font-medium uppercase tracking-wider text-purple-400">
                      AI Assistant
                    </p>
                    <button
                      onClick={() => handleSelect(0)}
                      onMouseEnter={() => setSelectedIndex(0)}
                      data-testid="ai-mode-ask-button"
                      className={cn(
                        'flex w-full items-center gap-3 rounded-md px-3 py-2.5 text-sm transition-colors',
                        selectedIndex === 0
                          ? 'bg-purple-500/20 text-purple-300'
                          : 'text-foreground hover:bg-purple-500/10',
                      )}
                    >
                      <Sparkles size={14} className="shrink-0 text-purple-400" />
                      <span className="font-medium">{aiQuery ? `Ask AI: ${aiQuery}` : 'Ask AI'}</span>
                      <kbd className="ml-auto rounded border border-border/50 px-1.5 py-0.5 text-[10px] text-muted-foreground">
                        Enter
                      </kbd>
                    </button>
                  </div>
                )}

                {/* Search results */}
                {query.trim() && !isAiMode && results.length > 0 && (
                  <div className="mb-2">
                    <p className="mb-1 px-2 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                      Pages
                    </p>
                    {results.map((result, i) => {
                      const idx = i;
                      return (
                        <button
                          key={result.id}
                          onClick={() => handleSelect(idx)}
                          onMouseEnter={() => setSelectedIndex(idx)}
                          className={cn(
                            'flex w-full items-center gap-3 rounded-md px-3 py-2 text-sm transition-colors',
                            selectedIndex === idx
                              ? 'bg-primary/15 text-primary'
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

                {/* No results */}
                {query.trim() && !isAiMode && !isSearching && results.length === 0 && (
                  <div className="py-4 text-center text-sm text-muted-foreground">
                    No pages found
                  </div>
                )}

                {/* Recent searches */}
                {!query.trim() && recentSearches.length > 0 && (
                  <div className="mb-2">
                    <p className="mb-1 px-2 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                      Recent Searches
                    </p>
                    {recentSearches.map((term, i) => {
                      const idx = i;
                      return (
                        <button
                          key={`recent-${i}`}
                          onClick={() => handleSelect(idx)}
                          onMouseEnter={() => setSelectedIndex(idx)}
                          className={cn(
                            'flex w-full items-center gap-3 rounded-md px-3 py-2 text-sm transition-colors',
                            selectedIndex === idx
                              ? 'bg-primary/15 text-primary'
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
                    <p className="mb-1 px-2 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                      Quick Actions
                    </p>
                    {QUICK_ACTIONS.map((action, i) => {
                      const baseIdx = query.trim()
                        ? results.length + i
                        : recentSearches.length + i;
                      const Icon = action.icon;
                      return (
                        <button
                          key={action.id}
                          onClick={() => handleSelect(baseIdx)}
                          onMouseEnter={() => setSelectedIndex(baseIdx)}
                          className={cn(
                            'flex w-full items-center gap-3 rounded-md px-3 py-2 text-sm transition-colors',
                            selectedIndex === baseIdx
                              ? 'bg-primary/15 text-primary'
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
                'flex items-center gap-4 border-t border-border/50 px-4 py-2 text-[11px] text-muted-foreground',
                isAiMode && 'border-purple-500/30',
              )}>
                <span><kbd className="rounded border border-border/50 px-1 py-0.5">↑↓</kbd> Navigate</span>
                <span><kbd className="rounded border border-border/50 px-1 py-0.5">↵</kbd> Select</span>
                <span><kbd className="rounded border border-border/50 px-1 py-0.5">esc</kbd> Close</span>
                {!isAiMode && (
                  <span className="ml-auto"><kbd className="rounded border border-border/50 px-1 py-0.5">/ai</kbd> AI mode</span>
                )}
              </div>
            </div>
          </m.div>
        </>
      )}
    </AnimatePresence>
  );
}
