import * as Switch from '@radix-ui/react-switch';
import {
  useThemeStore,
  THEMES,
  THEME_CATEGORIES,
  FONT_FAMILY_OPTIONS,
  FONT_SCOPES,
  type ThemeId,
  type FontScope,
} from '../../stores/theme-store';
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
  const fontFamily = useThemeStore((s) => s.fontFamily);
  const fontScope = useThemeStore((s) => s.fontScope);
  const dyslexiaSpacing = useThemeStore((s) => s.dyslexiaSpacing);
  const setFontFamily = useThemeStore((s) => s.setFontFamily);
  const setFontScope = useThemeStore((s) => s.setFontScope);
  const setDyslexiaSpacing = useThemeStore((s) => s.setDyslexiaSpacing);

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
            <h3 className="mb-3 text-[12px] font-semibold uppercase tracking-[0.08em] text-muted-foreground/80">
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
                        : 'border-border hover:border-border',
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
                    <div className="flex items-center justify-between gap-3 border-t border-border px-3 py-2.5">
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

      <section data-testid="typography-section">
        <div className="mb-4">
          <h3 className="text-[12px] font-semibold uppercase tracking-[0.08em] text-muted-foreground/80">
            Typography &amp; accessibility
          </h3>
          <p className="mt-1 text-sm text-muted-foreground">
            Choose a reading voice. Typography preferences are saved on this browser.
          </p>
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          {FONT_FAMILY_OPTIONS.map((option) => {
            const isActive = fontFamily === option.id;
            return (
              <button
                key={option.id}
                type="button"
                onClick={() => setFontFamily(option.id)}
                data-testid={`font-${option.id}`}
                aria-pressed={isActive}
                className={cn(
                  'rounded-xl border px-4 py-3 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                  isActive
                    ? 'border-[var(--color-primary)] bg-[var(--color-primary)]/8 ring-2 ring-[var(--color-primary)]/25'
                    : 'border-border hover:border-border-interactive',
                )}
              >
                <span className="flex items-center justify-between gap-2">
                  <span className="text-sm font-medium">{option.label}</span>
                  {isActive && <Check size={15} className="text-[var(--color-primary)]" aria-hidden="true" />}
                </span>
                <span
                  className="mt-2 block text-base leading-6 text-foreground"
                  style={{ fontFamily: option.cssFamily }}
                >
                  Aa Gg 0 O 1 l I
                </span>
                <span className="mt-1 block text-xs text-muted-foreground">{option.description}</span>
              </button>
            );
          })}
        </div>

        <fieldset className="mt-6">
          <legend className="mb-2 text-sm font-medium">Apply font to</legend>
          <div className="grid gap-2 sm:grid-cols-2" role="radiogroup" aria-label="Font scope">
            {FONT_SCOPES.map((scope) => {
              const isActive = fontScope === scope;
              const label: Record<FontScope, string> = {
                application: 'Entire application',
                'reading-pane': 'Document reading pane only',
              };
              const description: Record<FontScope, string> = {
                application: 'Navigation, controls, and documents',
                'reading-pane': 'Keep the compact UI in Inter',
              };
              return (
                <button
                  key={scope}
                  type="button"
                  role="radio"
                  aria-checked={isActive}
                  onClick={() => setFontScope(scope)}
                  data-testid={`font-scope-${scope}`}
                  className={cn(
                    'rounded-lg border px-3 py-2 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                    isActive
                      ? 'border-[var(--color-primary)] bg-[var(--color-primary)]/8'
                      : 'border-border hover:border-border-interactive',
                  )}
                >
                  <span className="block text-sm font-medium">{label[scope]}</span>
                  <span className="mt-0.5 block text-xs text-muted-foreground">{description[scope]}</span>
                </button>
              );
            })}
          </div>
        </fieldset>

        <div className="mt-6 flex items-center justify-between gap-3 rounded-xl border border-border px-4 py-3">
          <div className="min-w-0">
            <label htmlFor="dyslexia-spacing-toggle" className="cursor-pointer text-sm font-medium">
              Enhanced reading spacing
            </label>
            <p id="dyslexia-spacing-help" className="mt-0.5 text-xs text-muted-foreground">
              Adds relaxed leading, letter spacing, and word spacing for easier reading.
            </p>
          </div>
          <Switch.Root
            id="dyslexia-spacing-toggle"
            checked={dyslexiaSpacing}
            onCheckedChange={setDyslexiaSpacing}
            aria-describedby="dyslexia-spacing-help"
            aria-label="Enhanced reading spacing"
            data-testid="dyslexia-spacing-toggle"
            className="relative h-5 w-9 shrink-0 rounded-full bg-foreground/10 transition-colors data-[state=checked]:bg-action outline-none"
          >
            <Switch.Thumb className="block h-4 w-4 translate-x-0.5 rounded-full bg-white transition-transform data-[state=checked]:translate-x-4" />
          </Switch.Root>
        </div>
      </section>

    </div>
  );
}
