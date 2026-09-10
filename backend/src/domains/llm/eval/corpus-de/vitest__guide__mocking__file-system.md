# Das Dateisystem mocken

Das Mocken des Dateisystems stellt sicher, dass die Tests nicht vom tatsächlichen Dateisystem abhängen, was sie zuverlässiger und vorhersagbarer macht. Diese Isolation hilft dabei, Seiteneffekte aus vorherigen Tests zu vermeiden. Sie ermöglicht außerdem das Testen von Fehlerfällen und Randfällen, die mit einem echten Dateisystem schwer oder gar nicht reproduzierbar wären, etwa Berechtigungsprobleme, volle Festplatten oder Lese-/Schreibfehler.

Vitest bringt von Haus aus keine API zum Mocken des Dateisystems mit. Du kannst das Modul `fs` mit `vi.mock` manuell mocken, das ist jedoch schwer zu pflegen. Stattdessen empfehlen wir [`memfs`](https://npmx.dev/package/memfs), das dir diese Arbeit abnimmt. `memfs` erzeugt ein Dateisystem im Arbeitsspeicher, das Dateisystemoperationen simuliert, ohne die tatsächliche Festplatte anzufassen. Dieser Ansatz ist schnell und sicher und vermeidet mögliche Seiteneffekte auf dem echten Dateisystem.

## Beispiel

Um automatisch jeden `fs`-Aufruf an `memfs` umzuleiten, kannst du im Wurzelverzeichnis deines Projekts die Dateien `__mocks__/fs.cjs` und `__mocks__/fs/promises.cjs` anlegen:

::: code-group
```ts [__mocks__/fs.cjs]
// we can also use `import`, but then
// every export should be explicitly defined

const { fs } = require('memfs')
module.exports = fs
```

```ts [__mocks__/fs/promises.cjs]
// we can also use `import`, but then
// every export should be explicitly defined

const { fs } = require('memfs')
module.exports = fs.promises
```
:::

```ts [read-hello-world.js]
import { readFileSync } from 'node:fs'

export function readHelloWorld(path) {
  return readFileSync(path, 'utf-8')
}
```

```ts [hello-world.test.js]
import { beforeEach, expect, it, vi } from 'vitest'
import { fs, vol } from 'memfs'
import { readHelloWorld } from './read-hello-world.js'

// tell vitest to use fs mock from __mocks__ folder
// this can be done in a setup file if fs should always be mocked
vi.mock('node:fs')
vi.mock('node:fs/promises')

beforeEach(() => {
  // reset the state of in-memory fs
  vol.reset()
})

it('should return correct text', () => {
  const path = '/hello-world.txt'
  fs.writeFileSync(path, 'hello world')

  const text = readHelloWorld(path)
  expect(text).toBe('hello world')
})

it('can return a value multiple times', () => {
  // you can use vol.fromJSON to define several files
  vol.fromJSON(
    {
      './dir1/hw.txt': 'hello dir1',
      './dir2/hw.txt': 'hello dir2',
    },
    // default cwd
    '/tmp',
  )

  expect(readHelloWorld('/tmp/dir1/hw.txt')).toBe('hello dir1')
  expect(readHelloWorld('/tmp/dir2/hw.txt')).toBe('hello dir2')
})
```
