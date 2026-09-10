# server <Deprecated />

Vor Vitest 4 wurde diese Option verwendet, um die Konfiguration des `vite-node`-Servers festzulegen.

Derzeit erlaubt Ihnen diese Option, die Mechanismen für Inlining und Externalisierung zu konfigurieren, zusammen mit der Debugging-Konfiguration des Module Runners.

::: warning
Diese Optionen sollten nur als letztes Mittel eingesetzt werden, um die Performance durch Externalisierung automatisch eingebundener Abhängigkeiten zu verbessern oder um Probleme durch das Inlining ungültiger externer Abhängigkeiten zu beheben.

Normalerweise sollte Vitest das automatisch erledigen.
:::

## server.deps

### server.deps.external

- **Typ:** `(string | RegExp)[]`
- **Standard:** Dateien innerhalb von [`moduleDirectories`](/config/deps#moduledirectories)

Legt Module fest, die nicht von Vite transformiert, sondern direkt von der Engine verarbeitet werden sollen. Diese Module werden über einen nativen dynamischen `import` eingebunden und umgehen sowohl die Transformations- als auch die Auflösungsphase.

```js [vitest.config.js]
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    server: {
      deps: {
        external: ['react'],
      },
    },
  },
})
```

Externe Module und ihre Abhängigkeiten sind nicht im Modulgraphen enthalten und lösen bei Änderungen keinen Neustart der Tests aus.

Typischerweise werden Pakete unter `node_modules` externalisiert.

::: tip
Wird eine Zeichenkette angegeben, wird sie zunächst normalisiert, indem ihr die Segmente `/node_modules/` oder andere [`moduleDirectories`](/config/deps#moduledirectories) vorangestellt werden (aus `'react'` wird zum Beispiel `/node_modules/react/`); die resultierende Zeichenkette wird dann gegen den vollständigen Dateipfad abgeglichen. Das Paket `@company/some-name`, das unter `packages/some-name` liegt, sollte beispielsweise als `some-name` angegeben werden, und `packages` sollte in `deps.moduleDirectories` aufgeführt sein.

Wird ein `RegExp` angegeben, wird er gegen den vollständigen Dateipfad abgeglichen.
:::

### server.deps.inline

- **Typ:** `(string | RegExp)[] | true`
- **Standard:** alles, was nicht externalisiert ist

Legt Module fest, die von Vite transformiert und aufgelöst werden sollen. Diese Module werden von Vites [Module Runner](https://vite.dev/guide/api-environment-runtimes#modulerunner) ausgeführt.

Typischerweise werden Ihre Quelldateien inline eingebunden.

::: tip
Wird eine Zeichenkette angegeben, wird sie zunächst normalisiert, indem ihr die Segmente `/node_modules/` oder andere [`moduleDirectories`](/config/deps#moduledirectories) vorangestellt werden (aus `'react'` wird zum Beispiel `/node_modules/react/`); die resultierende Zeichenkette wird dann gegen den vollständigen Dateipfad abgeglichen. Das Paket `@company/some-name`, das unter `packages/some-name` liegt, sollte beispielsweise als `some-name` angegeben werden, und `packages` sollte in `deps.moduleDirectories` aufgeführt sein.

Wird ein `RegExp` angegeben, wird er gegen den vollständigen Dateipfad abgeglichen.
:::

### server.deps.fallbackCJS

- **Typ:** `boolean`
- **Standard:** `false`

Wenn aktiviert, versucht Vitest, zu einem ESM-Einstiegspunkt einen CommonJS-Build zu erraten, indem es einige gängige CJS/UMD-Muster für Dateinamen und Ordner prüft (etwa `.mjs`, `.umd.js`, `.cjs.js`, `umd/`, `cjs/`, `lib/`).

Das ist eine Best-Effort-Heuristik, um verwirrendes oder fehlerhaftes ESM/CJS-Packaging zu umgehen, und funktioniert möglicherweise nicht bei allen Abhängigkeiten.
