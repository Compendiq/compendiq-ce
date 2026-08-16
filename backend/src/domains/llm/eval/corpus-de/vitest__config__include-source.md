# includeSource

- **Typ:** `string[]`
- **Standard:** `[]`

Eine Liste von [Glob-Patterns](https://superchupu.dev/tinyglobby/comparison), die auf deine [In-Source-Testdateien](/guide/in-source) passen. Diese Patterns werden relativ zum [`root`](/config/root) aufgelöst (standardmäßig [`process.cwd()`](https://nodejs.org/api/process.html#processcwd)).

Ist die Option definiert, führt Vitest alle passenden Dateien aus, die `import.meta.vitest` enthalten.

::: warning
Vitest führt für Quelldateien lediglich eine einfache textbasierte Prüfung durch. Enthält eine Datei `import.meta.vitest` – auch nur in einem Kommentar –, wird sie als In-Source-Testdatei erkannt.
:::

Vitest verwendet das Paket [`tinyglobby`](https://npmx.dev/package/tinyglobby), um die Globs aufzulösen.

## Beispiel

```js
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    includeSource: ['src/**/*.{js,ts}'],
  },
})
```

Anschließend kannst du Tests direkt in deinen Quelldateien schreiben:

```ts [src/index.ts]
export function add(...args: number[]) {
  return args.reduce((a, b) => a + b, 0)
}

// #region in-source test suites
if (import.meta.vitest) {
  const { it, expect } = import.meta.vitest
  it('add', () => {
    expect(add()).toBe(0)
    expect(add(1)).toBe(1)
    expect(add(1, 2, 3)).toBe(6)
  })
}
// #endregion
```

Für deinen Produktions-Build musst du `import.meta.vitest` durch `undefined` ersetzen, damit der Bundler die Dead-Code-Elimination durchführen kann.

::: code-group
```js [vite.config.ts]
import { defineConfig } from 'vite'

export default defineConfig({
  define: { // [!code ++]
    'import.meta.vitest': 'undefined', // [!code ++]
  }, // [!code ++]
})
```
```js [rolldown.config.js]
import { defineConfig } from 'rolldown/config'

export default defineConfig({
  transform: {
    define: { // [!code ++]
      'import.meta.vitest': 'undefined', // [!code ++]
    }, // [!code ++]
  },
})
```
```js [rollup.config.js]
import replace from '@rollup/plugin-replace' // [!code ++]

export default {
  plugins: [
    replace({ // [!code ++]
      'import.meta.vitest': 'undefined', // [!code ++]
    }) // [!code ++]
  ],
  // other options
}
```
```js [build.config.js]
import { defineBuildConfig } from 'unbuild'

export default defineBuildConfig({
  replace: { // [!code ++]
    'import.meta.vitest': 'undefined', // [!code ++]
  }, // [!code ++]
  // other options
})
```
```js [webpack.config.js]
const webpack = require('webpack')

module.exports = {
  plugins: [
    new webpack.DefinePlugin({ // [!code ++]
      'import.meta.vitest': 'undefined', // [!code ++]
    })// [!code ++]
  ],
}
```
:::

::: tip
Um TypeScript-Unterstützung für `import.meta.vitest` zu erhalten, füge `vitest/importMeta` zu deiner `tsconfig.json` hinzu:

```json [tsconfig.json]
{
  "compilerOptions": {
    "types": ["vitest/importMeta"]
  }
}
```
:::
