# unstubEnvs

- **Typ:** `boolean`
- **Standard:** `false`

Soll Vitest vor jedem Test automatisch [`vi.unstubAllEnvs()`](/api/vi#vi-unstuballenvs) aufrufen.

```js [vitest.config.js]
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    unstubEnvs: true,
  },
})
```

::: warning
Beachte, dass diese Option Probleme mit asynchronen [nebenläufigen Tests](/api/test#test-concurrent) verursachen kann. Wenn sie aktiviert ist, stellt der Abschluss eines Tests alle mit [`vi.stubEnv`](/api/vi#vi-stubenv) geänderten Werte wieder her – auch jene, die gerade von anderen laufenden Tests verwendet werden.
:::
