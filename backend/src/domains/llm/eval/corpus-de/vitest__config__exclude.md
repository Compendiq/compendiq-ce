# exclude

- **Typ:** `string[]`
- **Standard:** `['**/node_modules/**', '**/.git/**']`
- **CLI:** `vitest --exclude "**/excluded-file" --exclude "*/other-files/*.js"`

Eine Liste von [Glob-Mustern](https://superchupu.dev/tinyglobby/comparison), die von Ihren Testdateien ausgeschlossen werden sollen. Diese Muster werden relativ zum [`root`](/config/root) aufgelöst (standardmäßig [`process.cwd()`](https://nodejs.org/api/process.html#processcwd)).

Vitest verwendet das Paket [`tinyglobby`](https://npmx.dev/package/tinyglobby), um die Globs aufzulösen.

::: warning
Diese Option wirkt sich nicht auf die Coverage aus. Wenn Sie bestimmte Dateien aus dem Coverage-Bericht entfernen müssen, verwenden Sie [`coverage.exclude`](/config/coverage#exclude).

Dies ist die einzige Option, die Ihre Konfiguration nicht überschreibt, wenn Sie sie per CLI-Flag angeben. Alle über das Flag `--exclude` hinzugefügten Glob-Muster werden dem `exclude` der Konfiguration hinzugefügt.
:::

## Beispiel

```js
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      './temp/**',
    ],
  },
})
```

::: tip
Obwohl die CLI-Option `exclude` additiv ist, ersetzt ein manuell gesetztes `exclude` in Ihrer Konfiguration den Standardwert. Um die voreingestellten `exclude`-Muster zu erweitern, verwenden Sie `configDefaults` aus `vitest/config`:

```js{6}
import { configDefaults, defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    exclude: [
      ...configDefaults.exclude,
      'packages/template/*',
      './temp/**',
    ],
  },
})
```
:::
