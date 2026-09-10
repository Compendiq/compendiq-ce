# onUnhandledError <CRoot /> <Version>4.0.0</Version>

- **Typ:**

```ts
function onUnhandledError(
  error: (TestError | Error) & { type: string }
): boolean | void
```

Ein eigener Callback zum Filtern nicht behandelter Fehler, die nicht gemeldet werden sollen. Wird ein Fehler herausgefiltert, beeinflusst er das Ergebnis des Testlaufs nicht mehr.

Um nicht behandelte Fehler zu melden, ohne das Testergebnis zu beeinflussen, verwenden Sie stattdessen die Option [`dangerouslyIgnoreUnhandledErrors`](/config/dangerouslyignoreunhandlederrors).

::: tip
Dieser Callback wird im Haupt-Thread aufgerufen und hat keinen Zugriff auf Ihren Testkontext.
:::

## Beispiel

```ts
import type { ParsedStack } from 'vitest'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    onUnhandledError(error): boolean | void {
      // Ignore all errors with the name "MySpecialError".
      if (error.name === 'MySpecialError') {
        return false
      }
    },
  },
})
```
