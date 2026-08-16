# clearMocks

- **Typ:** `boolean`
- **Standard:** `true`

Legt fest, ob Vitest vor jedem Test automatisch [`vi.clearAllMocks()`](/api/vi#vi-clearallmocks) aufrufen soll.

Dadurch wird die Aufrufhistorie der Mocks geleert, ohne die Mock-Implementierungen zu beeinflussen.

```js [vitest.config.js]
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    clearMocks: false,
  },
})
```

::: warning
Beachte, dass diese Option Probleme mit asynchronen [nebenläufigen Tests](/api/test#test-concurrent) verursachen kann. Ist sie aktiviert, leert der Abschluss eines Tests die Aufrufhistorie aller Mocks – einschließlich derer, die gerade von anderen laufenden Tests verwendet werden.
:::
