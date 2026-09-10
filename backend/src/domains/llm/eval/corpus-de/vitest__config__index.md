# Vitest konfigurieren

Wenn du Vite verwendest und eine `vite.config`-Datei hast, liest Vitest sie ein, um dieselben Plugins und dasselbe Setup wie deine Vite-Anwendung zu verwenden. Möchtest du eine abweichende Konfiguration für Tests, oder setzt deine Hauptanwendung nicht speziell auf Vite auf, hast du folgende Möglichkeiten:

- Lege eine `vitest.config.ts` an. Sie hat die höhere Priorität und **überschreibt** die Konfiguration aus `vite.config.ts` (Vitest unterstützt alle üblichen JS- und TS-Endungen, aber kein `json`) – das bedeutet, dass alle Optionen in deiner `vite.config` **ignoriert** werden
- Übergib der CLI die Option `--config`, z. B. `vitest --config ./path/to/vitest.config.ts`
- Verwende `process.env.VITEST` oder die Eigenschaft `mode` von `defineConfig` (die auf `test` gesetzt wird, sofern sie nicht mit `--mode` überschrieben wird), um in der `vite.config.ts` bedingt eine andere Konfiguration anzuwenden. Beachte, dass `VITEST` wie jede andere Umgebungsvariable in deinen Tests auch über `import.meta.env` verfügbar ist

Wird keine explizite Option `--config` angegeben, sucht Vitest im [`root`](/config/root) des Projekts zuerst nach `vitest.config.{ts,mts,cts,js,mjs,cjs}` und danach nach `vite.config.{ts,mts,cts,js,mjs,cjs}`. Wird keine Konfigurationsdatei gefunden, läuft Vitest ohne eine solche.

Um `vitest` selbst zu konfigurieren, füge deiner Vite-Konfiguration die Eigenschaft `test` hinzu. Wenn du `defineConfig` aus `vite` selbst importierst, musst du am Anfang deiner Konfigurationsdatei außerdem über ein [Triple-Slash-Kommando](https://www.typescriptlang.org/docs/handbook/triple-slash-directives.html#-reference-types-) eine Referenz auf die Vitest-Typen ergänzen.

Wenn du `vite` nicht verwendest, füge deiner Konfigurationsdatei das aus `vitest/config` importierte `defineConfig` hinzu:

```js [vitest.config.js]
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // ... Specify options here.
  },
})
```

Wenn du bereits eine `vite`-Konfiguration hast, kannst du `/// <reference types="vitest/config" />` ergänzen, um die `test`-Typen einzubinden:

```js [vite.config.js]
/// <reference types="vitest/config" />
import { defineConfig } from 'vite'

export default defineConfig({
  test: {
    // ... Specify options here.
  },
})
```

Bei Bedarf kannst du die Standardoptionen von Vitest abrufen und erweitern:

```js [vitest.config.js]
import { configDefaults, defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, 'packages/template/*'],
  },
})
```

Wenn du eine separate `vitest.config.js` verwendest, kannst du bei Bedarf auch Vites Optionen aus einer anderen Konfigurationsdatei erweitern:

```js [vitest.config.js]
import { defineConfig, mergeConfig } from 'vitest/config'
import viteConfig from './vite.config'

export default mergeConfig(viteConfig, defineConfig({
  test: {
    exclude: ['packages/template/*'],
  },
}))
```

Ist deine Vite-Konfiguration als Funktion definiert, kannst du die Konfiguration so definieren:

```js [vitest.config.js]
import { defineConfig, mergeConfig } from 'vitest/config'
import viteConfig from './vite.config'

export default defineConfig(configEnv => mergeConfig(
  viteConfig(configEnv),
  defineConfig({
    test: {
      exclude: ['packages/template/*'],
    },
  })
))
```

Da Vitest die Vite-Konfiguration verwendet, kannst du auch jede Konfigurationsoption von [Vite](https://vitejs.dev/config/) nutzen. Zum Beispiel `define`, um globale Variablen zu definieren, oder `resolve.alias`, um Aliase festzulegen – diese Optionen sollten auf oberster Ebene definiert werden, _nicht_ innerhalb einer `test`-Eigenschaft.

## Automatische Installation von Abhängigkeiten

Vitest fordert dich auf, bestimmte Abhängigkeiten zu installieren, falls sie noch nicht installiert sind. Du kannst dieses Verhalten deaktivieren, indem du die Umgebungsvariable `VITEST_SKIP_INSTALL_CHECKS=1` setzt.

## Konfigurationsoptionen

Konfigurationsoptionen, die innerhalb einer [Projekt](/guide/projects)-Konfiguration nicht unterstützt werden, sind mit dem Symbol <CRoot /> gekennzeichnet. Das bedeutet, dass sie nur in der Root-Konfiguration von Vitest gesetzt werden können.
