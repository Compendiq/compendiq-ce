import { useEffect } from 'react';
import { applyThemeToDocument, useThemeStore } from '../../stores/theme-store';

/**
 * Subscribes <html> to store-driven theme changes. The actual mutation is
 * delegated to the store's `applyThemeToDocument` so there is exactly one
 * writer for `data-theme`, `data-theme-type`, and the `dark` class.
 *
 * `setTheme` already calls `applyThemeToDocument` directly, so this hook is
 * the safety net that keeps the DOM in sync with externally-driven state
 * changes (Zustand rehydration, devtools, tests, etc.).
 */
export function useThemeEffect() {
  const theme = useThemeStore((s) => s.theme);

  useEffect(() => {
    applyThemeToDocument(theme);
  }, [theme]);
}
