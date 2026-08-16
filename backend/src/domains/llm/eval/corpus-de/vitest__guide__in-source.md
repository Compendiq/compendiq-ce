# In-Source-Testing

Vitest bietet eine Möglichkeit, Tests direkt im Quellcode neben der Implementierung auszuführen, ähnlich wie [Rusts Modul-Tests](https://doc.rust-lang.org/book/ch11-03-test-organization.html#the-tests-module-and-cfgtest).

Dadurch teilen sich die Tests denselben Closure wie die Implementierungen und können gegen private Zustände testen, ohne diese zu exportieren. Gleichzeitig entsteht so eine engere Feedback-Schleife während der Entwicklung.

::: warning
Dieser Leitfaden erklärt, wie du Tests innerhalb deines Quellcodes schreibst. Wenn du Tests in separaten Testdateien schreiben möchtest, folge dem [Leitfaden "Tests schreiben"](/guide/#writing-tests).
:::

## Einrichtung

Füge zunächst einen `if (import.meta.vitest)`-Block am Ende deiner Quelldatei ein und schreibe darin einige Tests. Zum Beispiel:

```ts [src/index.ts]
// the implementation
export function add(...args: number[]) {
  return args.reduce((a, b) => a + b, 0)
}

// in-source test suites
if (import.meta.vitest) {
  const { it, expect } = import.meta.vitest
  it('add', () => {
    expect(add()).toBe(0)
    expect(add(1)).toBe(1)
    expect(add(1, 2, 3)).toBe(6)
  })
}
```

Passe die `includeSource`-Konfiguration von Vitest an, damit die Dateien unter `src/` erfasst werden:

```ts [vitest.config.ts]
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    includeSource: ['src/**/*.{js,ts}'], // [!code ++]
  },
})
```

Danach kannst du mit dem Testen beginnen!

```bash
$ npx vitest
```

## Produktions-Build

Für den Produktions-Build musst du die `define`-Optionen in deiner Konfigurationsdatei setzen, damit der Bundler die Dead-Code-Elimination durchführen kann. Zum Beispiel in Vite:

```ts [vite.config.ts]
/// <reference types="vitest/config" />

import { defineConfig } from 'vite'

export default defineConfig({
  test: {
    includeSource: ['src/**/*.{js,ts}'],
  },
  define: { // [!code ++]
    'import.meta.vitest': 'undefined', // [!code ++]
  }, // [!code ++]
})
```

### Andere Bundler

::: details Rolldown
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

Mehr dazu: [Rolldown](https://rolldown.rs/)
:::

::: details Rollup
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

Mehr dazu: [Rollup](https://rollupjs.org/)
:::

::: details unbuild
```js [build.config.js]
import { defineBuildConfig } from 'unbuild'

export default defineBuildConfig({
  replace: { // [!code ++]
    'import.meta.vitest': 'undefined', // [!code ++]
  }, // [!code ++]
  // other options
})
```

Mehr dazu: [unbuild](https://github.com/unjs/unbuild)
:::

::: details webpack
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

Mehr dazu: [webpack](https://webpack.js.org/plugins/define-plugin/)
:::

## TypeScript

Um TypeScript-Unterstützung für `import.meta.vitest` zu erhalten, füge `vitest/importMeta` zu deiner `tsconfig.json` hinzu:

```json [tsconfig.json]
{
  "compilerOptions": {
    "types": [
      "vitest/importMeta" // [!code ++]
    ]
  }
}
```

Das vollständige Beispiel findest du unter [`examples/in-source-test`](https://github.com/vitest-dev/vitest/tree/main/examples/in-source-test).

::: warning
Bei der Verwendung von [Assertion-Funktionen](https://www.typescriptlang.org/docs/handbook/release-notes/typescript-3-7.html#assertion-functions) wie `assert` in In-Source-Tests gibt es eine Einschränkung. Details und Workarounds findest du unter [`assert`](/api/assert#in-source-testing).
:::

## Hinweise

Dieses Feature kann nützlich sein für:

- Unit-Tests für kleine, eng umgrenzte Funktionen oder Utilities
- Prototyping
- Inline-Assertions

Für komplexere Tests wie Komponenten- oder E2E-Tests wird empfohlen, **stattdessen separate Testdateien zu verwenden**.
