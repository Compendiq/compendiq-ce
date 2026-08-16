import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useEditorState } from '@tiptap/react';
import type { Editor as EditorType } from '@tiptap/react';
import { posToDOMRect } from '@tiptap/core';
import {
  SLASH_COMMAND_ITEMS,
  filterSlashCommands,
  type SlashCategory,
  type SlashCommandItem,
} from './slash-command-types';
import {
  slashCommandPluginKey,
  registerSlashKeyHandler,
} from './slash-command-extension';
import { cn } from '../../lib/cn';

const MENU_LABEL =
  'px-2.5 pb-1 pt-2 text-[12px] font-medium uppercase tracking-wider text-muted-foreground select-none';

interface EditorSlashMenuProps {
  editor: EditorType;
}

export function EditorSlashMenu({ editor }: EditorSlashMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [coords, setCoords] = useState<{ top: number; left: number } | null>(null);

  const { isOpen, query, range } = useEditorState({
    editor,
    selector: ({ editor: e }) => {
      const state = slashCommandPluginKey.getState(e.state);
      return {
        isOpen: state?.isOpen ?? false,
        query: state?.query ?? '',
        range: state?.range ?? null,
      };
    },
  });

  const filteredItems = useMemo(
    () => filterSlashCommands(SLASH_COMMAND_ITEMS, query),
    [query],
  );

  // Group filtered items by category while preserving category order
  const groupedCategories = useMemo(() => {
    const categories: Array<{ category: SlashCategory; items: SlashCommandItem[] }> = [];
    const categoryMap = new Map<SlashCategory, SlashCommandItem[]>();

    for (const item of filteredItems) {
      let list = categoryMap.get(item.category);
      if (!list) {
        list = [];
        categoryMap.set(item.category, list);
        categories.push({ category: item.category, items: list });
      }
      list.push(item);
    }

    return categories;
  }, [filteredItems]);

  // Reset selectedIndex whenever query changes
  useEffect(() => {
    setSelectedIndex(0);
  }, [query]);

  // Clamp selectedIndex if filtered list shrinks
  useEffect(() => {
    if (selectedIndex >= filteredItems.length && filteredItems.length > 0) {
      setSelectedIndex(0);
    }
  }, [filteredItems.length, selectedIndex]);

  const closeMenu = useCallback(() => {
    if (!editor.isDestroyed) {
      editor.view.dispatch(editor.state.tr.setMeta(slashCommandPluginKey, { close: true }));
    }
  }, [editor]);

  const executeItem = useCallback(
    (item: SlashCommandItem) => {
      if (!range || editor.isDestroyed) return;
      closeMenu();
      item.run(editor, range);
    },
    [editor, range, closeMenu],
  );

  // Calculate coordinates whenever menu opens or selection/range updates
  useLayoutEffect(() => {
    if (!isOpen || !range || editor.isDestroyed) {
      setCoords(null);
      return;
    }

    try {
      const domRect = posToDOMRect(editor.view, range.from, range.to);
      const menuWidth = 320;
      const menuHeight = 320;

      let top = domRect.bottom + 6;
      let left = domRect.left;

      // Flip above if not enough room below and enough room above
      if (top + menuHeight > window.innerHeight && domRect.top - menuHeight > 0) {
        top = domRect.top - menuHeight - 6;
      }

      // Clamp left within viewport
      if (left + menuWidth > window.innerWidth - 12) {
        left = Math.max(12, window.innerWidth - menuWidth - 12);
      }
      left = Math.max(12, left);

      setCoords({ top, left });
    } catch {
      // Fallback in jsdom / test environments
      setCoords({ top: 100, left: 100 });
    }
  }, [isOpen, range, editor]);

  // Auto-scroll the highlighted item into view
  useEffect(() => {
    if (!isOpen) return;
    const activeItem = filteredItems[selectedIndex];
    if (!activeItem) return;
    const el = document.getElementById(`slash-cmd-item-${activeItem.id}`);
    if (typeof el?.scrollIntoView === 'function') {
      el.scrollIntoView({ block: 'nearest' });
    }
  }, [selectedIndex, isOpen, filteredItems]);

  // Keyboard navigation handler connected to the ProseMirror plugin
  useEffect(() => {
    if (!isOpen) return;

    const keyHandler = (e: KeyboardEvent): boolean => {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        e.stopPropagation();
        setSelectedIndex((prev) => (filteredItems.length === 0 ? 0 : (prev + 1) % filteredItems.length));
        return true;
      }

      if (e.key === 'ArrowUp') {
        e.preventDefault();
        e.stopPropagation();
        setSelectedIndex((prev) =>
          filteredItems.length === 0 ? 0 : (prev - 1 + filteredItems.length) % filteredItems.length,
        );
        return true;
      }

      if (e.key === 'Enter' || e.key === 'Tab') {
        if (filteredItems.length > 0 && filteredItems[selectedIndex]) {
          e.preventDefault();
          e.stopPropagation();
          executeItem(filteredItems[selectedIndex]);
          return true;
        }
      }

      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        closeMenu();
        return true;
      }

      return false;
    };

    return registerSlashKeyHandler(keyHandler);
  }, [isOpen, filteredItems, selectedIndex, executeItem, closeMenu]);

  // Dismiss on pointerdown outside
  useEffect(() => {
    if (!isOpen) return;

    const onPointerDown = (e: PointerEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        closeMenu();
      }
    };

    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [isOpen, closeMenu]);

  if (!isOpen || !coords) return null;

  let flatItemIndex = 0;

  const content = (
    <div
      ref={menuRef}
      role="listbox"
      id="slash-command-menu"
      aria-label="Insert blocks"
      data-testid="slash-command-menu"
      style={{
        position: 'fixed',
        top: `${coords.top}px`,
        left: `${coords.left}px`,
      }}
      className={cn(
        'z-50 w-80 max-h-[340px] nm-card-elevated p-1 flex flex-col',
        'motion-safe:animate-in motion-safe:fade-in-0 motion-safe:zoom-in-95',
      )}
    >
      <div className="flex items-center justify-between px-2.5 py-1.5 border-b border-border/50 text-[11px] text-muted-foreground select-none">
        <span className="font-medium text-foreground">Insert block</span>
        <span>
          {query ? (
            <>
              Filter: <span className="font-semibold text-primary">{query}</span>
            </>
          ) : (
            'Type to filter'
          )}
        </span>
      </div>

      <div
        tabIndex={-1}
        className="overflow-y-auto max-h-[280px] scrollbar-thin py-1 outline-none space-y-1"
      >
        {filteredItems.length === 0 ? (
          <div className="py-6 px-4 text-center text-xs text-muted-foreground select-none">
            No matching blocks for &quot;{query}&quot;
          </div>
        ) : (
          groupedCategories.map(({ category, items }) => (
            <div key={category} role="group" aria-label={category} className="space-y-0.5">
              <div className={MENU_LABEL}>{category}</div>
              {items.map((item) => {
                const currentIndex = flatItemIndex++;
                const isSelected = currentIndex === selectedIndex;
                const ItemIcon = item.Icon;

                return (
                  <button
                    key={item.id}
                    type="button"
                    role="option"
                    id={`slash-cmd-item-${item.id}`}
                    aria-selected={isSelected}
                    data-highlighted={isSelected ? '' : undefined}
                    data-testid={`slash-cmd-item-${item.id}`}
                    onClick={() => executeItem(item)}
                    onMouseEnter={() => setSelectedIndex(currentIndex)}
                    className={cn(
                      'flex w-full cursor-pointer select-none items-center gap-2.5 rounded-md px-2.5 py-1.5 text-left transition-colors outline-none',
                      isSelected
                        ? 'bg-accent text-foreground'
                        : 'text-muted-foreground hover:bg-accent/60 hover:text-foreground',
                    )}
                  >
                    <div
                      className={cn(
                        'flex h-7 w-7 shrink-0 items-center justify-center rounded-md border text-foreground',
                        isSelected
                          ? 'border-border-interactive bg-background shadow-xs'
                          : 'border-border/60 bg-muted/40',
                      )}
                    >
                      <ItemIcon
                        size={15}
                        className="shrink-0"
                        style={item.iconColor ? { color: item.iconColor } : undefined}
                      />
                    </div>
                    <div className="flex min-w-0 flex-1 items-center justify-between">
                      <span className="truncate text-[13px] font-medium text-foreground">
                        {item.title}
                      </span>
                      {item.shortcut && (
                        <kbd className="ml-2 shrink-0 rounded border border-border/30 bg-muted/40 px-1 py-0.5 font-mono text-[11px] text-muted-foreground/70">
                          {item.shortcut}
                        </kbd>
                      )}
                    </div>
                  </button>
                );
              })}
            </div>
          ))
        )}
      </div>
    </div>
  );

  return createPortal(content, document.body);
}
