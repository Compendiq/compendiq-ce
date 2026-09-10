# onStackTrace <CRoot />

- **Typ:** `(error: Error, frame: ParsedStack) => boolean | void`

Wendet beim Behandeln von Fehlern eine Filterfunktion auf jeden Frame jedes Stacktrace an. Dies gilt nicht für Stacktraces, die von [`printConsoleTrace`](/config/printconsoletrace#printconsoletrace) ausgegeben werden. Das erste Argument, `error`, ist ein `TestError`.

Das kann nützlich sein, um Stacktrace-Frames aus Drittanbieter-Bibliotheken herauszufiltern.

::: tip
Die Gesamtgröße des Stacktrace wird üblicherweise zusätzlich durch V8s [`Error.stackTraceLimit`](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Error/stackTraceLimit) begrenzt. Sie können diesen Wert in Ihrer Test-Setup-Funktion hochsetzen, damit Stacks nicht abgeschnitten werden.
:::

```ts
import type { ParsedStack, TestError } from 'vitest'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    onStackTrace(error: TestError, { file }: ParsedStack): boolean | void {
      // If we've encountered a ReferenceError, show the whole stack.
      if (error.name === 'ReferenceError') {
        return
      }

      // Reject all frames from third party libraries.
      if (file.includes('node_modules')) {
        return false
      }
    },
  },
})
```
