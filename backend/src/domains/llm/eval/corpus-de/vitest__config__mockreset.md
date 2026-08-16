# mockReset

- **Typ:** `boolean`
- **Standard:** `false`

Soll Vitest vor jedem Test automatisch [`vi.resetAllMocks()`](/api/vi#vi-resetallmocks) aufrufen.

Dadurch wird die Mock-Historie gelöscht und jede Implementierung zurückgesetzt.

```js [vitest.config.js]
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    mockReset: true,
  },
})
```

::: warning
Beachte, dass diese Option Probleme mit asynchronen [nebenläufigen Tests](/api/test#test-concurrent) verursachen kann. Wenn sie aktiviert ist, löscht der Abschluss eines Tests die Mock-Historie und die Implementierung aller Mocks – auch jener, die gerade von anderen laufenden Tests verwendet werden.
:::
