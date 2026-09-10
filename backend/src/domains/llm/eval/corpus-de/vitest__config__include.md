# include

- **Typ:** `string[]`
- **Standard:** `['**/*.{test,spec}.?(c|m)[jt]s?(x)']`
- **CLI:** `vitest [...include]`, `vitest **/*.test.js`

Eine Liste von [Glob-Mustern](https://superchupu.dev/tinyglobby/comparison), die auf Ihre Testdateien passen. Diese Muster werden relativ zum [`root`](/config/root) aufgelöst (standardmäßig [`process.cwd()`](https://nodejs.org/api/process.html#processcwd)).

Vitest verwendet das Paket [`tinyglobby`](https://npmx.dev/package/tinyglobby), um die Globs aufzulösen.

::: tip HINWEIS
Bei aktivierter Coverage fügt Vitest die `include`-Muster der Testdateien automatisch zu den Standard-`exclude`-Mustern der Coverage hinzu. Siehe [`coverage.exclude`](/config/coverage#exclude).
:::

## Beispiel

```js
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: [
      './test',
      './**/*.{test,spec}.ts(x)?',
    ],
  },
})
```

Vitest liefert sinnvolle Standardwerte mit, sodass Sie sie normalerweise nicht überschreiben würden. Ein gutes Beispiel für die Definition von `include` sind [Testprojekte](/guide/projects):

```js{8,12} [vitest.config.js]
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          include: ['./test/unit/*.test.js'],
        },
      },
      {
        test: {
          name: 'e2e',
          include: ['./test/e2e/*.test.js'],
        },
      },
    ],
  },
})
```

::: warning
Diese Option überschreibt die Vitest-Standardwerte. Wenn Sie diese lediglich erweitern möchten, verwenden Sie `configDefaults` aus `vitest/config`:

```js{6}
import { configDefaults, defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: [
      ...configDefaults.include,
      './test',
      './**/*.{test,spec}.ts(x)?',
    ],
  },
})
```
:::
