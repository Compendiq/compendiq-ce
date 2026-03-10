import { useThemeStore, THEMES, THEME_CATEGORIES, type ThemeId } from '../../stores/theme-store';
import { useUiStore } from '../../stores/ui-store';

interface ThemeTabProps {
  onSave: (v: Record<string, unknown>) => void;
}

export function ThemeTab({ onSave }: ThemeTabProps) {
  const { theme: currentTheme, setTheme } = useThemeStore();
  const reduceEffects = useUiStore((s) => s.reduceEffects);
  const setReduceEffects = useUiStore((s) => s.setReduceEffects);

  function handleSelect(id: ThemeId) {
    setTheme(id);
    onSave({ theme: id });
  }

  return (
    <div className="space-y-6">
      <p className="text-sm text-muted-foreground">
        Choose a color theme for the interface. Changes apply immediately.
      </p>

      {/* Reduce Effects toggle */}
      <div className="flex items-center justify-between rounded-lg border border-border/50 p-4">
        <div>
          <p className="text-sm font-medium">Reduce Effects</p>
          <p className="text-xs text-muted-foreground">
            Disables aurora animation, noise overlay, and hover glow effects.
            Auto-enabled when your OS prefers reduced motion.
          </p>
        </div>
        <button
          role="switch"
          aria-checked={reduceEffects}
          data-testid="reduce-effects-toggle"
          onClick={() => setReduceEffects(!reduceEffects)}
          className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors ${
            reduceEffects ? 'bg-primary' : 'bg-muted'
          }`}
        >
          <span
            className={`pointer-events-none inline-block h-5 w-5 rounded-full bg-white shadow-sm transition-transform ${
              reduceEffects ? 'translate-x-5' : 'translate-x-0'
            }`}
          />
        </button>
      </div>

      {THEME_CATEGORIES.map((cat) => {
        const categoryThemes = THEMES.filter((t) => t.category === cat.key);
        return (
          <div key={cat.key} data-testid={`theme-category-${cat.key}`}>
            <h3 className="mb-3 text-sm font-semibold text-foreground/70 uppercase tracking-wider">
              {cat.label}
            </h3>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5" data-testid="theme-grid">
              {categoryThemes.map((t) => {
                const isActive = currentTheme === t.id;
                return (
                  <button
                    key={t.id}
                    onClick={() => handleSelect(t.id)}
                    data-testid={`theme-${t.id}`}
                    className={`group relative flex flex-col rounded-lg border p-3 text-left transition-all ${
                      isActive
                        ? 'border-primary bg-primary/10 ring-1 ring-primary'
                        : 'border-border/50 hover:border-border hover:bg-muted/50'
                    }`}
                  >
                    {/* Color preview swatches */}
                    <div className="mb-2.5 flex gap-1.5">
                      <div
                        className="h-6 w-6 rounded-full border border-border/50"
                        style={{ background: t.preview.bg }}
                        title="Background"
                      />
                      <div
                        className="h-6 w-6 rounded-full border border-border/50"
                        style={{ background: t.preview.card }}
                        title="Card"
                      />
                      <div
                        className="h-6 w-6 rounded-full border border-border/50"
                        style={{ background: t.preview.primary }}
                        title="Primary"
                      />
                      <div
                        className="h-6 w-6 rounded-full border border-border/50"
                        style={{ background: t.preview.accent }}
                        title="Accent"
                      />
                    </div>
                    <span className="text-sm font-medium">{t.label}</span>
                    <span className="mt-0.5 text-xs text-muted-foreground">{t.description}</span>
                    {isActive && (
                      <span className="absolute top-2 right-2 text-xs text-primary" data-testid="theme-active-badge">
                        Active
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}
