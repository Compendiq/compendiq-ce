# dangerouslyIgnoreUnhandledErrors <CRoot />

- **Typ:** `boolean`
- **Standard:** `false`
- **CLI:**
  - `--dangerouslyIgnoreUnhandledErrors`
  - `--dangerouslyIgnoreUnhandledErrors=false`

Wenn diese Option auf `true` gesetzt ist, lässt Vitest den Testlauf nicht fehlschlagen, falls unbehandelte Fehler auftreten. Beachten Sie, dass die eingebauten Reporter sie dennoch melden.

Wenn Sie bestimmte Fehler bedingt herausfiltern möchten, verwenden Sie stattdessen den Callback [`onUnhandledError`](/config/onunhandlederror).

## Beispiel

```js [vitest.config.js]
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    dangerouslyIgnoreUnhandledErrors: true,
  },
})
```
