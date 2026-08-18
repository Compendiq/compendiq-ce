import { useMemo, useRef, useState } from 'react';
import * as Popover from '@radix-ui/react-popover';
import type { Editor as EditorType } from '@tiptap/react';
import {
  Smile,
  Hand,
  Trees,
  Utensils,
  Trophy,
  Plane,
  Lightbulb,
  Heart,
  Flag,
  Search,
  X,
  Sparkles,
  Shapes,
} from 'lucide-react';
import { LucideIconGrid } from '../page-icon/LucideIconGrid';
import {
  EMOJI_CATEGORIES,
  EMOJI_DATA,
  POPULAR_EMOJIS,
  filterEmojis,
  type EmojiCategoryId,
  type EmojiItem,
} from './emoji-data';
import { TOOLBAR_ITEM_ATTR } from './use-toolbar-roving-focus';
import { absorbPortalEscape } from '../../lib/absorb-portal-escape';
import { cn } from '../../lib/cn';

interface EmojiPickerProps {
  editor: EditorType;
  /** Optional custom trigger class */
  className?: string;
}

const CATEGORY_ICONS: Record<
  EmojiCategoryId,
  React.ComponentType<{ size?: number; className?: string }>
> = {
  smileys: Smile,
  people: Hand,
  nature: Trees,
  food: Utensils,
  activity: Trophy,
  travel: Plane,
  objects: Lightbulb,
  symbols: Heart,
  flags: Flag,
};

export function EmojiPickerContent({
  editor,
  onPick,
  onClose,
}: {
  editor?: EditorType;
  onPick?: (emoji: string) => void;
  onClose: () => void;
}) {
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedCategory, setSelectedCategory] = useState<EmojiCategoryId | 'all'>('all');
  const [hoveredEmoji, setHoveredEmoji] = useState<EmojiItem | null>(null);
  const [kind, setKind] = useState<'emoji' | 'icons'>('emoji');
  const showLucide = Boolean(editor) && !onPick;

  const searchInputRef = useRef<HTMLInputElement>(null);

  const filteredEmojis = useMemo(() => {
    if (searchQuery.trim()) {
      return filterEmojis(searchQuery);
    }
    if (selectedCategory === 'all') {
      return EMOJI_DATA;
    }
    return EMOJI_DATA.filter((e) => e.category === selectedCategory);
  }, [searchQuery, selectedCategory]);

  // Group emojis by category when browsing all without search query
  const groupedCategories = useMemo(() => {
    if (searchQuery.trim() || selectedCategory !== 'all') return null;
    return EMOJI_CATEGORIES.map((cat) => ({
      ...cat,
      emojis: EMOJI_DATA.filter((e) => e.category === cat.id),
    }));
  }, [searchQuery, selectedCategory]);

  const handleSelectEmoji = (emojiChar: string) => {
    if (onPick) onPick(emojiChar);
    else editor?.chain().focus().insertContent(emojiChar).run();
    onClose();
  };

  const handleKeyDownSearch = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' && filteredEmojis.length > 0) {
      e.preventDefault();
      handleSelectEmoji(filteredEmojis[0]!.emoji);
    }
  };

  return (
    <>
      {showLucide && (
        <div className="mb-2 flex items-center gap-1" role="tablist" aria-label="Icon type">
          <button
            type="button"
            role="tab"
            aria-selected={kind === 'icons'}
            className={cn(
              'nm-focus-ring flex h-7 items-center gap-1 rounded-md px-2 text-xs',
              kind === 'icons' ? 'bg-foreground/10 text-foreground' : 'text-muted-foreground hover:bg-foreground/5',
            )}
            onClick={() => setKind('icons')}
          >
            <Shapes size={13} />
            Icons
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={kind === 'emoji'}
            className={cn(
              'nm-focus-ring flex h-7 items-center gap-1 rounded-md px-2 text-xs',
              kind === 'emoji' ? 'bg-foreground/10 text-foreground' : 'text-muted-foreground hover:bg-foreground/5',
            )}
            onClick={() => setKind('emoji')}
          >
            <Smile size={13} />
            Emoji
          </button>
        </div>
      )}

      {showLucide && kind === 'icons' && editor && (
        <LucideIconGrid
          onPick={(value) => {
            editor.chain().focus().insertContent({ type: 'inlineLucideIcon', attrs: { name: value } }).run();
            onClose();
          }}
        />
      )}

      {(!showLucide || kind === 'emoji') && (
      <>
      {/* Search bar */}
      <div className="relative mb-2 flex items-center">
        <Search
          size={14}
          className="absolute left-2.5 text-muted-foreground pointer-events-none"
        />
        <input
          ref={searchInputRef}
          type="text"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          onKeyDown={handleKeyDownSearch}
          placeholder="Search emojis..."
          aria-label="Search emojis"
          data-testid="emoji-search-input"
          className="nm-input w-full pl-8 pr-7 py-1 text-[13px]"
        />
        {searchQuery && (
          <button
            type="button"
            onClick={() => {
              setSearchQuery('');
              searchInputRef.current?.focus();
            }}
            aria-label="Clear search"
            className="absolute right-2 text-muted-foreground hover:text-foreground transition-colors"
          >
            <X size={13} />
          </button>
        )}
      </div>

      {/* Category navigation bar */}
      {!searchQuery.trim() && (
        <div
          role="tablist"
          aria-label="Emoji categories"
          className="mb-2 flex items-center justify-between border-b border-border pb-1.5 px-0.5"
        >
          <button
            type="button"
            role="tab"
            aria-selected={selectedCategory === 'all'}
            aria-label="All Categories"
            title="All Categories"
            onClick={() => setSelectedCategory('all')}
            className={cn(
              'flex h-6 w-6 items-center justify-center rounded transition-colors',
              selectedCategory === 'all'
                ? 'bg-foreground/15 text-foreground font-medium'
                : 'text-muted-foreground hover:bg-foreground/5 hover:text-foreground',
            )}
          >
            <Sparkles size={13} />
          </button>
          {EMOJI_CATEGORIES.map((cat) => {
            const IconComponent = CATEGORY_ICONS[cat.id];
            return (
              <button
                key={cat.id}
                type="button"
                role="tab"
                aria-selected={selectedCategory === cat.id}
                aria-label={cat.label}
                title={cat.label}
                onClick={() => setSelectedCategory(cat.id)}
                className={cn(
                  'flex h-6 w-6 items-center justify-center rounded transition-colors',
                  selectedCategory === cat.id
                    ? 'bg-foreground/15 text-foreground font-medium'
                    : 'text-muted-foreground hover:bg-foreground/5 hover:text-foreground',
                )}
              >
                <IconComponent size={13} />
              </button>
            );
          })}
        </div>
      )}

      {/* Emoji list area */}
      <div
        className="max-h-56 overflow-y-auto scrollbar-thin pr-0.5"
        data-testid="emoji-scroll-container"
      >
        {/* Quick picks / popular emojis when starting at All without search query */}
        {!searchQuery.trim() && selectedCategory === 'all' && (
          <div className="mb-2">
            <div className="px-1 pb-1 text-[12px] font-medium uppercase tracking-wider text-muted-foreground">
              Popular
            </div>
            <div className="grid grid-cols-8 gap-0.5">
              {POPULAR_EMOJIS.map((char) => {
                const item = EMOJI_DATA.find((e) => e.emoji === char) || {
                  emoji: char,
                  name: 'popular emoji',
                  category: 'smileys' as const,
                };
                return (
                  <button
                    key={char}
                    type="button"
                    title={item.name}
                    aria-label={item.name}
                    data-testid={`popular-emoji-${char}`}
                    onClick={() => handleSelectEmoji(char)}
                    onMouseEnter={() => setHoveredEmoji(item)}
                    onFocus={() => setHoveredEmoji(item)}
                    className="flex h-8 w-8 items-center justify-center rounded-md text-base transition-colors hover:bg-foreground/10 active:bg-foreground/15"
                  >
                    {char}
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {/* Filtered search results */}
        {searchQuery.trim() ? (
          filteredEmojis.length > 0 ? (
            <div>
              <div className="px-1 pb-1 text-[12px] font-medium text-muted-foreground">
                {filteredEmojis.length} results
              </div>
              <div className="grid grid-cols-8 gap-0.5">
                {filteredEmojis.map((item) => (
                  <button
                    key={`${item.category}-${item.emoji}`}
                    type="button"
                    title={item.name}
                    aria-label={item.name}
                    data-testid={`emoji-item-${item.emoji}`}
                    onClick={() => handleSelectEmoji(item.emoji)}
                    onMouseEnter={() => setHoveredEmoji(item)}
                    onFocus={() => setHoveredEmoji(item)}
                    className="flex h-8 w-8 items-center justify-center rounded-md text-base transition-colors hover:bg-foreground/10 active:bg-foreground/15"
                  >
                    {item.emoji}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <div className="py-6 text-center text-[13px] text-muted-foreground">
              No emojis found for "{searchQuery}"
            </div>
          )
        ) : groupedCategories ? (
          /* All categories grouped */
          groupedCategories.map((group) => (
            <div key={group.id} className="mb-2">
              <div className="px-1 pb-1 pt-1 text-[12px] font-medium uppercase tracking-wider text-muted-foreground">
                {group.label}
              </div>
              <div className="grid grid-cols-8 gap-0.5">
                {group.emojis.map((item) => (
                  <button
                    key={`${item.category}-${item.emoji}`}
                    type="button"
                    title={item.name}
                    aria-label={item.name}
                    data-testid={`emoji-item-${item.emoji}`}
                    onClick={() => handleSelectEmoji(item.emoji)}
                    onMouseEnter={() => setHoveredEmoji(item)}
                    onFocus={() => setHoveredEmoji(item)}
                    className="flex h-8 w-8 items-center justify-center rounded-md text-base transition-colors hover:bg-foreground/10 active:bg-foreground/15"
                  >
                    {item.emoji}
                  </button>
                ))}
              </div>
            </div>
          ))
        ) : (
          /* Single selected category */
          <div>
            <div className="px-1 pb-1 text-[12px] font-medium uppercase tracking-wider text-muted-foreground">
              {EMOJI_CATEGORIES.find((c) => c.id === selectedCategory)?.label}
            </div>
            <div className="grid grid-cols-8 gap-0.5">
              {filteredEmojis.map((item) => (
                <button
                  key={`${item.category}-${item.emoji}`}
                  type="button"
                  title={item.name}
                  aria-label={item.name}
                  data-testid={`emoji-item-${item.emoji}`}
                  onClick={() => handleSelectEmoji(item.emoji)}
                  onMouseEnter={() => setHoveredEmoji(item)}
                  onFocus={() => setHoveredEmoji(item)}
                  className="flex h-8 w-8 items-center justify-center rounded-md text-base transition-colors hover:bg-foreground/10 active:bg-foreground/15"
                >
                  {item.emoji}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Footer preview */}
      <div className="mt-2 flex h-7 items-center gap-2 border-t border-border pt-1.5 px-1 text-xs text-muted-foreground">
        {hoveredEmoji ? (
          <>
            <span className="text-lg leading-none">{hoveredEmoji.emoji}</span>
            <span className="truncate capitalize font-medium text-foreground text-[12px]">
              {hoveredEmoji.name}
            </span>
          </>
        ) : (
          <span className="text-[12px] text-muted-foreground">
            Select an emoji to insert
          </span>
        )}
      </div>
      </>
      )}
    </>
  );
}

export function EmojiPicker({ editor, className }: EmojiPickerProps) {
  const [open, setOpen] = useState(false);

  const handleClose = () => {
    setOpen(false);
    editor.commands?.focus?.();
  };

  return (
    <Popover.Root
      open={open}
      onOpenChange={(next) => {
        if (!next) handleClose();
        else setOpen(true);
      }}
    >
      <Popover.Trigger asChild>
        <button
          type="button"
          {...{ [TOOLBAR_ITEM_ATTR]: '' }}
          title="Insert Emoji"
          aria-label="Insert Emoji"
          aria-haspopup="dialog"
          aria-pressed={open}
          data-testid="emoji-picker-trigger"
          className={cn('nm-icon-button', className)}
        >
          <Smile size={15} />
        </button>
      </Popover.Trigger>

      <Popover.Portal>
        <Popover.Content
          align="start"
          sideOffset={6}
          aria-label="Emoji Picker"
          data-testid="emoji-picker-content"
          className="z-50 w-80 nm-card-elevated p-2.5 outline-none rounded-lg border border-border"
          onOpenAutoFocus={(e) => {
            e.preventDefault();
            const el = e.currentTarget as HTMLElement;
            el.querySelector<HTMLInputElement>('input')?.focus();
          }}
          onEscapeKeyDown={(e) => absorbPortalEscape(e, handleClose)}
        >
          <EmojiPickerContent editor={editor} onClose={handleClose} />
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
