# restoreMocks

- **Typ:** `boolean`
- **Standard:** `false`

Legt fest, ob Vitest vor jedem Test automatisch [`vi.restoreAllMocks()`](/api/vi#vi-restoreallmocks) aufrufen soll.

Damit werden alle ursprünglichen Implementierungen von Spies wiederhergestellt, die manuell mit [`vi.spyOn`](/api/vi#vi-spyon) erstellt wurden.

```js [vitest.config.js]
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    restoreMocks: true,
  },
})
```

::: warning
Beachten Sie, dass diese Option zu Problemen mit asynchronen [nebenläufigen Tests](/api/test#test-concurrent) führen kann. Ist sie aktiviert, stellt der Abschluss eines Tests die Implementierung aller Spies wieder her – einschließlich derjenigen, die gerade von anderen laufenden Tests verwendet werden.
:::
