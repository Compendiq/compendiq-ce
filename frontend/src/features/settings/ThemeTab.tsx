import { useThemeStore, THEMES, THEME_CATEGORIES, type ThemeId } from '../../stores/theme-store';
import { Check } from 'lucide-react';
import { PanelHeader } from './PanelHeader';
import { cn } from '../../shared/lib/cn';

interface ThemeTabProps {
  onSave: (v: Record<string, unknown>) => void;
}

/**
 * Theme picker. Each theme renders a mini chrome preview (sidebar slice,
 * action button, card) using the theme's own palette — far more useful than
 * four floating colour dots that don't tell you what the surfaces look like.
 *
 * Layout: a single 2-column grid across categories. Categories still get a
 * label row, but the grid spans the full panel width so themes don't sit in
 * a narrow column with empty space to the right.
 */
export function ThemeTab({ onSave }: ThemeTabProps) {
  const currentTheme = useThemeStore((s) => s.theme);
  const setTheme = useThemeStore((s) => s.setTheme);

  function handleSelect(id: ThemeId) {
    setTheme(id);
    onSave({ theme: id });
  }

  return (
    <div className="space-y-8">
      <PanelHeader
        title="Appearance"
        subtitle="Pick a theme. Changes apply immediately and are saved to your profile."
      />

      {THEME_CATEGORIES.map((cat) => {
        const categoryThemes = THEMES.filter((t) => t.category === cat.key);
        if (categoryThemes.length === 0) return null;
        return (
          <section key={cat.key} data-testid={`theme-category-${cat.key}`}>
            <h3 className="mb-3 text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground/80">
              {cat.label}
            </h3>
            <div
              data-testid="theme-grid"
              className={cn(
                'grid gap-4',
                // Single-theme categories take the full width so the chrome
                // preview reads at a useful size. Once a category has 2+
                // themes we switch to a 2-column grid.
                categoryThemes.length === 1 ? 'grid-cols-1' : 'grid-cols-1 sm:grid-cols-2',
              )}
            >
              {categoryThemes.map((t) => {
                const isActive = currentTheme === t.id;
                return (
                  <button
                    key={t.id}
                    onClick={() => handleSelect(t.id)}
                    data-testid={`theme-${t.id}`}
                    aria-pressed={isActive}
                    className={cn(
                      'group relative flex w-full flex-col overflow-hidden rounded-xl border text-left transition-all motion-safe:duration-150',
                      isActive
                        ? 'border-[var(--color-primary)] ring-2 ring-[var(--color-primary)]/35'
                        : 'border-border/60 hover:border-border hover:-translate-y-0.5',
                    )}
                  >
                    {/* Mini chrome preview — uses the theme's own colours via
                        inline styles so the preview accurately reflects what
                        the user will see after selecting. Three rows
                        approximate: top bar, sidebar item, primary CTA. */}
                    <div
                      className="flex h-32 items-stretch gap-1 p-2"
                      style={{ background: t.preview.bg }}
                    >
                      {/* Sidebar slice */}
                      <div
                        className="flex w-12 shrink-0 flex-col gap-1 rounded-md p-1.5"
                        style={{ background: t.preview.card }}
                      >
                        <span
                          className="block h-1.5 w-full rounded-full"
                          style={{ background: t.preview.primary, opacity: 0.85 }}
                        />
                        <span
                          className="block h-1.5 w-3/4 rounded-full"
                          style={{ background: t.preview.accent, opacity: 0.35 }}
                        />
                        <span
                          className="block h-1.5 w-2/3 rounded-full"
                          style={{ background: t.preview.accent, opacity: 0.25 }}
                        />
                      </div>
                      {/* Main content slice */}
                      <div
                        className="flex flex-1 flex-col gap-1.5 rounded-md p-2"
                        style={{ background: t.preview.card }}
                      >
                        <span
                          className="block h-2 w-1/3 rounded-full"
                          style={{ background: t.preview.accent, opacity: 0.6 }}
                        />
                        <span
                          className="block h-1.5 w-2/3 rounded-full"
                          style={{ background: t.preview.accent, opacity: 0.25 }}
                        />
                        <span
                          className="block h-1.5 w-1/2 rounded-full"
                          style={{ background: t.preview.accent, opacity: 0.25 }}
                        />
                        <div className="mt-auto flex items-center gap-1.5">
                          <span
                            className="inline-block h-4 w-12 rounded-md"
                            style={{ background: t.preview.primary }}
                          />
                          <span
                            className="inline-block h-4 w-8 rounded-md border"
                            style={{ borderColor: t.preview.accent, opacity: 0.4 }}
                          />
                        </div>
                      </div>
                    </div>

                    {/* Label strip */}
                    <div className="flex items-center justify-between gap-3 border-t border-border/40 px-3 py-2.5">
                      <div className="min-w-0">
                        <div className="text-sm font-medium">{t.label}</div>
                        <div className="truncate text-xs text-muted-foreground">{t.description}</div>
                      </div>
                      {isActive && (
                        <span
                          className="inline-flex h-6 items-center gap-1 rounded-full bg-[var(--color-primary)]/10 px-2 text-[11px] font-medium text-[var(--color-primary-ink)]"
                          data-testid="theme-active-badge"
                        >
                          <Check size={12} /> Active
                        </span>
                      )}
                    </div>
                  </button>
                );
              })}
            </div>
          </section>
        );
      })}
    </div>
  );
}
