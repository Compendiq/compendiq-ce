# unstubGlobals

- **Typ:** `boolean`
- **Standard:** `false`

Legt fest, ob Vitest vor jedem Test automatisch [`vi.unstubAllGlobals()`](/api/vi#vi-unstuballglobals) aufrufen soll.

```js [vitest.config.js]
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    unstubGlobals: true,
  },
})
```

::: warning
Beachten Sie, dass diese Option zu Problemen mit asynchronen [nebenläufigen Tests](/api/test#test-concurrent) führen kann. Ist sie aktiviert, stellt der Abschluss eines Tests alle globalen Werte wieder her, die mit [`vi.stubGlobal`](/api/vi#vi-stubglobal) geändert wurden – einschließlich derjenigen, die gerade von anderen laufenden Tests verwendet werden.
:::
