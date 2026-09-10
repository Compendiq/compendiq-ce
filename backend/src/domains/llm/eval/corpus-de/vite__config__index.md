# Vite konfigurieren

Wenn du `vite` von der Kommandozeile ausführst, versucht Vite automatisch, eine Konfigurationsdatei namens `vite.config.js` im [Projekt-Root](/guide/#index-html-and-project-root) aufzulösen (andere JS- und TS-Endungen werden ebenfalls unterstützt).

Die einfachste Konfigurationsdatei sieht so aus:

```js [vite.config.js]
export default {
  // config options
}
```

Beachte: Um ES-Modul-Syntax in der Konfigurationsdatei zu verwenden, muss sie in einer Datei liegen, die Node.js als ESM erkennt, also z. B. `.mjs` oder `.js` mit `"type": "module"` in der nächstgelegenen `package.json`.

Du kannst auch mit der CLI-Option `--config` explizit eine zu verwendende Konfigurationsdatei angeben (aufgelöst relativ zu `cwd`):

```bash
vite --config my-config.js
```

<ScrimbaLink href="https://scrimba.com/intro-to-vite-c03p6pbbdq/~05jg?via=vite" title="Configuring Vite">Sieh dir eine interaktive Lektion auf Scrimba an</ScrimbaLink>

::: tip LADEN DER KONFIGURATION
Standardmäßig verwendet Vite [Rolldown](https://rolldown.rs/), um die Konfiguration in eine temporäre Datei zu bündeln und diese zu laden. Wenn du eine Umgebung nutzt, die TypeScript unterstützt (z. B. Node 22.18+), oder wenn du ausschließlich reines JavaScript schreibst, kannst du `--configLoader native` angeben, um die native Runtime der Umgebung zum Laden der Konfigurationsdatei zu verwenden. Es ist geplant, dass `configLoader: 'native'` in einer künftigen Major-Version zum Standard wird.
:::

## Intellisense für die Konfiguration

Da Vite mit TypeScript-Typdefinitionen ausgeliefert wird, kannst du das Intellisense deiner IDE mit jsdoc-Typhinweisen nutzen:

```js
/** @type {import('vite').UserConfig} */
export default {
  // ...
}
```

Alternativ kannst du den `defineConfig`-Helper verwenden, der Intellisense ohne jsdoc-Annotationen bereitstellen sollte:

```js
import { defineConfig } from 'vite'

export default defineConfig({
  // ...
})
```

Vite unterstützt außerdem TypeScript-Konfigurationsdateien. Du kannst `vite.config.ts` mit der oben gezeigten Hilfsfunktion `defineConfig` oder mit dem Operator `satisfies` verwenden:

```ts
import type { UserConfig } from 'vite'

export default {
  // ...
} satisfies UserConfig
```

## Bedingte Konfiguration

Wenn die Konfiguration Optionen abhängig vom Kommando (`serve` oder `build`), vom verwendeten [Modus](/guide/env-and-mode#modes), davon, ob es sich um einen SSR-Build handelt (`isSsrBuild`), oder davon, ob der Build in der Vorschau läuft (`isPreview`), bestimmen muss, kann sie stattdessen eine Funktion exportieren:

```js twoslash
import { defineConfig } from 'vite'
// ---cut---
export default defineConfig(({ command, mode, isSsrBuild, isPreview }) => {
  if (command === 'serve') {
    return {
      // dev specific config
    }
  } else {
    // command === 'build'
    return {
      // build specific config
    }
  }
})
```

Wichtig zu wissen: In der API von Vite ist der Wert von `command` während der Entwicklung `serve` (in der CLI sind [`vite`](/guide/cli#vite), `vite dev` und `vite serve` Aliase) und `build` beim Bauen für die Produktion ([`vite build`](/guide/cli#vite-build)).

`isSsrBuild` und `isPreview` sind zusätzliche optionale Flags, um die Art des `build`- bzw. `serve`-Kommandos zu unterscheiden. Manche Werkzeuge, die die Vite-Konfiguration laden, unterstützen diese Flags möglicherweise nicht und übergeben stattdessen `undefined`. Daher ist es empfehlenswert, explizit gegen `true` und `false` zu vergleichen.

## Asynchrone Konfiguration

Wenn die Konfiguration asynchrone Funktionen aufrufen muss, kann sie stattdessen eine asynchrone Funktion exportieren. Auch diese asynchrone Funktion kann für besseres Intellisense durch `defineConfig` geleitet werden:

```js twoslash
import { defineConfig } from 'vite'
// ---cut---
export default defineConfig(async ({ command, mode }) => {
  const data = await asyncFunction()
  return {
    // vite config
  }
})
```

## Umgebungsvariablen in der Konfiguration verwenden

Während die Konfiguration selbst ausgewertet wird, stehen nur jene Umgebungsvariablen zur Verfügung, die bereits in der aktuellen Prozessumgebung (`process.env`) existieren. Vite verschiebt das Laden von `.env*`-Dateien bewusst auf einen Zeitpunkt _nach_ der Auflösung der Benutzerkonfiguration, weil die Menge der zu ladenden Dateien von Konfigurationsoptionen wie [`root`](/guide/#index-html-and-project-root) und [`envDir`](/config/shared-options.md#envdir) sowie vom endgültigen `mode` abhängt.

Das bedeutet: Variablen, die in `.env`, `.env.local`, `.env.[mode]` oder `.env.[mode].local` definiert sind, werden **nicht** automatisch in `process.env` injiziert, während deine `vite.config.*` läuft. Sie _werden_ später automatisch geladen und dem Anwendungscode über `import.meta.env` zur Verfügung gestellt (mit dem standardmäßigen `VITE_`-Präfixfilter), genau wie unter [Umgebungsvariablen und Modi](/guide/env-and-mode.html) beschrieben. Wenn du also nur Werte aus `.env*`-Dateien an die Anwendung weitergeben möchtest, musst du in der Konfiguration nichts aufrufen.

Sollen Werte aus `.env*`-Dateien jedoch die Konfiguration selbst beeinflussen (etwa um `server.port` zu setzen, Plugins bedingt zu aktivieren oder `define`-Ersetzungen zu berechnen), kannst du sie mit dem exportierten Helper [`loadEnv`](/guide/api-javascript.html#loadenv) manuell laden.

```js twoslash
import { defineConfig, loadEnv } from 'vite'

export default defineConfig(({ mode }) => {
  // Load env file based on `mode` in the current working directory.
  // Set the third parameter to '' to load all env regardless of the
  // `VITE_` prefix.
  const env = loadEnv(mode, process.cwd(), '')
  return {
    define: {
      // Provide an explicit app-level constant derived from an env var.
      __APP_ENV__: JSON.stringify(env.APP_ENV),
    },
    // Example: use an env var to set the dev server port conditionally.
    server: {
      port: env.APP_PORT ? Number(env.APP_PORT) : 5173,
    },
  }
})
```

## Die Konfigurationsdatei in VS Code debuggen

Für das zuverlässigste Debugging-Erlebnis verwendest du beim Start von Vite den nativen Config-Loader:

```bash
vite --configLoader native
```

Der native Loader führt die ursprüngliche Konfigurationsdatei direkt aus, sodass Breakpoints in der Konfigurationsdatei und in Plugin-Hooks wie `transform` auf die Originalquelle abgebildet werden. Er setzt eine Runtime voraus, die die von deiner Konfigurationsdatei verwendete Syntax unterstützt, etwa Node.js 22.18+ für TypeScript-Dateien.

Bei Verwendung von `--configLoader bundle` (dem aktuellen Standard, wobei `native` in einer künftigen Major-Version zum Standard werden soll) erzeugt Vite eine Inline-Source-Map und schreibt die gebündelte Konfiguration nach `node_modules/.vite-temp`, bevor sie geladen wird. Wenn du den Bundle-Loader verwenden musst, füge das temporäre Verzeichnis für das JavaScript Debug Terminal in `.vscode/settings.json` hinzu:

```json
{
  "debug.javascript.terminalOptions": {
    "resolveSourceMapLocations": [
      "${workspaceFolder}/**",
      "!**/node_modules/**",
      "**/node_modules/.vite-temp/**"
    ]
  }
}
```

Diese Einstellung gilt nur für das JavaScript Debug Terminal; sie wirkt sich nicht auf Launch-Konfigurationen aus, die aus der Ansicht "Run and Debug" gestartet werden. Um das auch dort zu unterstützen, füge das temporäre Verzeichnis in `.vscode/launch.json` hinzu:

```json
{
  "version": "0.2.0",
  "configurations": [
    {
      "type": "node",
      "request": "launch",
      "name": "Vite",
      "runtimeExecutable": "npm",
      "runtimeArgs": ["exec", "vite", "--configLoader", "bundle"],
      "console": "integratedTerminal",
      "sourceMaps": true,
      "resolveSourceMapLocations": [
        "${workspaceFolder}/**",
        "!**/node_modules/**",
        "**/node_modules/.vite-temp/**"
      ]
    }
  ]
}
```
