# reporters <CRoot />

- **Typ:**

```ts
interface UserConfig {
  reporters?: ConfigReporter | Array<ConfigReporter>
}

type ConfigReporter = string | Reporter | [string, object?]
```

- **Standard:** [`'default'`](/guide/reporters#default-reporter). Siehe [Standard-Reporter](/guide/reporters#default-reporters) für umgebungsspezifisches Verhalten.
- **CLI:**
  - `--reporter=tap` für einen einzelnen Reporter
  - `--reporter=verbose --reporter=github-actions` für mehrere Reporter

Diese Option legt einen einzelnen Reporter oder eine Liste von Reportern fest, die Vitest während des Testlaufs zur Verfügung stehen.

Neben den eingebauten Reportern können Sie auch eine eigene Implementierung des [`Reporter`-Interfaces](/api/advanced/reporters) übergeben oder einen Pfad zu einem Modul, das sie als Default-Export bereitstellt (z. B. `'./path/to/reporter.ts'`, `'@scope/reporter'`).

Sie können einen Reporter konfigurieren, indem Sie ein Tupel angeben: `[string, object]`, wobei die Zeichenkette der Name des Reporters und das Objekt dessen Optionen sind.

::: warning
Beachten Sie, dass die [Coverage](/guide/coverage)-Funktion statt dieser Option die separate Option [`coverage.reporter`](/config/coverage#reporter) verwendet.
:::

## Eingebaute Reporter

- [`default`](/guide/reporters#default-reporter)
- [`verbose`](/guide/reporters#verbose-reporter)
- [`tree`](/guide/reporters#tree-reporter)
- [`dot`](/guide/reporters#dot-reporter)
- [`junit`](/guide/reporters#junit-reporter)
- [`json`](/guide/reporters#json-reporter)
- [`html`](/guide/reporters#html-reporter)
- [`tap`](/guide/reporters#tap-reporter)
- [`tap-flat`](/guide/reporters#tap-flat-reporter)
- [`hanging-process`](/guide/reporters#hanging-process-reporter)
- [`github-actions`](/guide/reporters#github-actions-reporter)
- [`minimal`](/guide/reporters#minimal-reporter) (Alias `agent`)
- [`blob`](/guide/reporters#blob-reporter)

## Beispiel

::: code-group
```js [vitest.config.js]
import { configDefaults, defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    reporters: [
      ...configDefaults.reporters,
      // conditional reporter
      ...(process.env.CI ? ['html'] : []),
      // custom reporter from npm package
      // options are passed down as a tuple
      [
        'vitest-sonar-reporter',
        { outputFile: 'sonar-report.xml' }
      ],
    ]
  }
})
```
```bash [CLI]
vitest --reporter=github-actions --reporter=junit
```
:::
