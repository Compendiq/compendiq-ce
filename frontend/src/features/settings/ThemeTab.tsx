import { useThemeStore, THEMES, type ThemeId } from '../../stores/theme-store';

interface ThemeTabProps {
  onSave: (v: Record<string, unknown>) => void;
}

export function ThemeTab({ onSave }: ThemeTabProps) {
  const { theme: currentTheme, setTheme } = useThemeStore();

  function handleSelect(id: ThemeId) {
    setTheme(id);
    onSave({ theme: id });
  }

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        Choose a color theme for the interface. Changes apply immediately.
      </p>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5" data-testid="theme-grid">
        {THEMES.map((t) => {
          const isActive = currentTheme === t.id;
          return (
            <button
              key={t.id}
              onClick={() => handleSelect(t.id)}
              data-testid={`theme-${t.id}`}
              className={`group relative flex flex-col rounded-lg border p-3 text-left transition-all ${
                isActive
                  ? 'border-primary bg-primary/10 ring-1 ring-primary'
                  : 'border-white/10 hover:border-white/20 hover:bg-white/5'
              }`}
            >
              {/* Color preview swatches */}
              <div className="mb-2.5 flex gap-1.5">
                <div
                  className="h-6 w-6 rounded-full border border-white/10"
                  style={{ background: t.preview.bg }}
                  title="Background"
                />
                <div
                  className="h-6 w-6 rounded-full border border-white/10"
                  style={{ background: t.preview.card }}
                  title="Card"
                />
                <div
                  className="h-6 w-6 rounded-full border border-white/10"
                  style={{ background: t.preview.primary }}
                  title="Primary"
                />
                <div
                  className="h-6 w-6 rounded-full border border-white/10"
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
}
