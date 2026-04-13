import { useThemeStore, THEMES, THEME_CATEGORIES, type ThemeId } from '../../stores/theme-store';

interface ThemeTabProps {
  onSave: (v: Record<string, unknown>) => void;
}

export function ThemeTab({ onSave }: ThemeTabProps) {
  const currentTheme = useThemeStore((s) => s.theme);
  const setTheme = useThemeStore((s) => s.setTheme);

  function handleSelect(id: ThemeId) {
    setTheme(id);
    onSave({ theme: id });
  }

  return (
    <div className="space-y-6">
      <p className="text-sm text-muted-foreground">
        Choose a color theme for the interface. Changes apply immediately.
      </p>

      {THEME_CATEGORIES.map((cat) => {
        const categoryThemes = THEMES.filter((t) => t.category === cat.key);
        return (
          <div key={cat.key} data-testid={`theme-category-${cat.key}`}>
            <h3 className="mb-3 text-sm font-semibold text-foreground/70 uppercase tracking-wider">
              {cat.label}
            </h3>
            <div className="grid grid-cols-2 gap-4" data-testid="theme-grid">
              {categoryThemes.map((t) => {
                const isActive = currentTheme === t.id;
                return (
                  <button
                    key={t.id}
                    onClick={() => handleSelect(t.id)}
                    data-testid={`theme-${t.id}`}
                    className={`group relative flex flex-col rounded-lg border p-4 text-left transition-all ${
                      isActive
                        ? 'border-primary bg-primary/10 ring-1 ring-primary'
                        : 'border-border/50 hover:border-border hover:bg-muted/50'
                    }`}
                  >
                    {/* Color preview swatches */}
                    <div className="mb-3 flex gap-2">
                      <div
                        className="h-8 w-8 rounded-full border border-border/50"
                        style={{ background: t.preview.bg }}
                        title="Background"
                      />
                      <div
                        className="h-8 w-8 rounded-full border border-border/50"
                        style={{ background: t.preview.card }}
                        title="Card"
                      />
                      <div
                        className="h-8 w-8 rounded-full border border-border/50"
                        style={{ background: t.preview.primary }}
                        title="Primary"
                      />
                      <div
                        className="h-8 w-8 rounded-full border border-border/50"
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
