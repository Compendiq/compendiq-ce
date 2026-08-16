# onConsoleLog <CRoot />

```ts
function onConsoleLog(
  log: string,
  type: 'stdout' | 'stderr',
  entity: TestModule | TestSuite | TestCase | undefined,
): boolean | void
```

Eigener Handler für `console`-Methoden in Tests. Wenn Sie `false` zurückgeben, gibt Vitest das Log nicht auf der Konsole aus. Beachten Sie, dass Vitest alle anderen falsy-Werte ignoriert.

Kann nützlich sein, um Logs von Drittanbieter-Bibliotheken herauszufiltern.

```ts
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    onConsoleLog(log: string, type: 'stdout' | 'stderr'): boolean | void {
      return !(log === 'message from third party library' && type === 'stdout')
    },
  },
})
```
