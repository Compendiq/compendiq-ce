# injectCjsGlobals

- **Typ:** `boolean`
- **Standard:** `true`
- **CLI:** `--no-inject-cjs-globals`, `--injectCjsGlobals=false`

Injiziert die CommonJS-Modulvariablen (`module`, `exports`, `require`, `__filename`, `__dirname`) in jedes Modul, das Vitest verarbeitet.

Standardmäßig hat jede von Vitest transformierte Datei Zugriff auf diese Variablen, selbst wenn sie in ESM-Syntax geschrieben ist. Das entspricht nicht der Funktionsweise von Modulen in freier Wildbahn: Browser unterstützen keine CommonJS-Variablen, und Node.js stellt sie in ES-Modulen nicht bereit.

Um die Modulumgebung strenger und näher an der Ziel-Laufzeitumgebung zu gestalten, können Sie dieses Verhalten deaktivieren:

```js
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    injectCjsGlobals: false,
  },
})
```

Ist diese Option deaktiviert, erhalten nur solche Module diese Variablen, die als CommonJS erkannt werden. CommonJS-Module behalten sie immer, weil sie Teil des Modul-Scopes sind; ohne sie lässt sich das Modul überhaupt nicht auswerten. Der Modultyp wird auf dieselbe Weise erkannt wie in Node.js:

1. Die Dateiendung: `.cjs`- und `.cts`-Dateien sind immer CommonJS, `.mjs`- und `.mts`-Dateien sind immer ES-Module.
2. Das Feld `type` in der nächstgelegenen `package.json`: `"module"` bedeutet ES-Modul, `"commonjs"` bedeutet CommonJS. Wie in Node.js endet die Suche bei der ersten `package.json` und überschreitet niemals eine `node_modules`-Grenze, sodass Abhängigkeiten den `type` Ihres Projekts nicht erben.
3. Das Vorhandensein von ESM-Syntax in der Datei: Enthält die Datei keine statischen `import`/`export`-Deklarationen und verweist sie nicht auf `import.meta`, wird sie als CommonJS behandelt. Syntax innerhalb von Kommentaren und Zeichenketten beeinflusst die Erkennung nicht. Dynamische Importe sind in CommonJS-Modulen erlaubt und zählen daher nicht als ESM-Syntax; reine Typ-Importe in TypeScript werden bei der Transformation entfernt und zählen ebenfalls nicht.

Die Syntaxerkennung ist immer aktiv: Vitest berücksichtigt keine Node.js-CLI-Flags, die die Auflösung des Modultyps verändern, wie `--no-experimental-detect-module`, `--input-type` (das in Node.js nur für die Eingabe als Zeichenkette gilt) oder das in Node.js 23 entfernte Flag `--experimental-default-type`.

Der Verweis auf eine CommonJS-Variable in einem ES-Modul wirft einen `ReferenceError`, genau wie außerhalb von Vitest:

```
ReferenceError: __dirname is not defined

"__dirname" is a CommonJS variable that is not available in ES modules, and "injectCjsGlobals" is disabled. If this module is meant to be an ES module, use "import.meta.dirname" instead of "__dirname". If it is meant to be a CommonJS module, use the ".cjs" file extension, set "type": "commonjs" in the nearest package.json, or externalize it with "server.deps.external".
```

::: warning
Diese Option wirkt sich nicht auf externalisierte Module aus, die immer von der nativen Laufzeitumgebung ausgeführt werden. Node.js stellt externalisierten CommonJS-Modulen die CommonJS-Variablen von sich aus bereit.

Beachten Sie, dass inline eingebundene CommonJS-Module auch bei aktivierter Option nicht von Vite-Plugins verarbeitet werden: `require`-Aufrufe verlassen stets den Module Runner, sodass Funktionen wie Mocking für sie nicht greifen.
:::
