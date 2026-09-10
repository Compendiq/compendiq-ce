# Für die Produktion bauen

Wenn es Zeit ist, deine App für die Produktion auszuliefern, führe einfach den Befehl `vite build` aus. Standardmäßig verwendet er `<root>/index.html` als Build-Einstiegspunkt und erzeugt ein Anwendungs-Bundle, das sich für die Auslieferung über einen statischen Hosting-Dienst eignet. Leitfäden zu verbreiteten Diensten findest du unter [Deploying a Static Site](./static-deploy).

<ScrimbaLink href="https://scrimba.com/intro-to-vite-c03p6pbbdq/~037q?via=vite" title="Building for Production">Sieh dir eine interaktive Lektion auf Scrimba an</ScrimbaLink>

## Browser-Kompatibilität

Standardmäßig zielt das Produktions-Bundle auf die minimalen Browser-Versionen, die zu einem für jedes Major-Release festgelegten Stichtag mit [Baseline](https://web-platform-dx.github.io/baseline/) Widely Available kompatibel sind. Der standardmäßige Browser-Support-Bereich für diese Major ist:

<!-- Search for the `ESBUILD_BASELINE_WIDELY_AVAILABLE_TARGET` constant for more information -->

- Chrome >=111
- Edge >=111
- Firefox >=114
- Safari >=16.4

Du kannst eigene Targets über die [Konfigurationsoption `build.target`](/config/build-options.md#build-target) angeben, wobei das niedrigste Target `es2015` ist. Wird ein niedrigeres Target gesetzt, benötigt Vite trotzdem diese minimalen Browser-Support-Bereiche, da es sich auf [nativen dynamischen ESM-Import](https://caniuse.com/es6-module-dynamic-import) und [`import.meta`](https://caniuse.com/mdn-javascript_operators_import_meta) stützt:

<!-- Search for the `defaultEsbuildSupported` constant for more information -->

- Chrome >=64
- Firefox >=67
- Safari >=11.1
- Edge >=79

Beachte, dass Vite standardmäßig nur Syntax-Transformationen übernimmt und **keine Polyfills abdeckt**. Du kannst dir https://cdnjs.cloudflare.com/polyfill/ ansehen, das automatisch Polyfill-Bundles anhand des UserAgent-Strings des Browsers erzeugt.

Ältere Browser lassen sich über [@vitejs/plugin-legacy](https://github.com/vitejs/vite/tree/main/packages/plugin-legacy) unterstützen, das automatisch Legacy-Chunks und passende Polyfills für ES-Sprachfeatures erzeugt. Die Legacy-Chunks werden bedingt nur in Browsern geladen, die keine native ESM-Unterstützung haben.

## Öffentlicher Basispfad

- Verwandt: [Asset Handling](./assets)

Wenn du dein Projekt unter einem verschachtelten öffentlichen Pfad ausrollst, gib einfach die [Konfigurationsoption `base`](/config/shared-options.md#base) an, und alle Asset-Pfade werden entsprechend umgeschrieben. Diese Option kann auch als Kommandozeilen-Flag angegeben werden, z. B. `vite build --base=/my/public/path/`.

Aus JS importierte Asset-URLs, CSS-`url()`-Referenzen und Asset-Referenzen in deinen `.html`-Dateien werden beim Build alle automatisch angepasst, um diese Option zu berücksichtigen.

Die Ausnahme ist, wenn du URLs dynamisch zur Laufzeit zusammensetzen musst. In diesem Fall kannst du die global injizierte Variable `import.meta.env.BASE_URL` verwenden, die dem öffentlichen Basispfad entspricht. Beachte, dass diese Variable beim Build statisch ersetzt wird, sie muss also exakt so erscheinen (d. h. `import.meta.env['BASE_URL']` funktioniert nicht).

Für fortgeschrittene Kontrolle über den Basispfad siehe [Erweiterte Base-Optionen](#advanced-base-options).

### Relative Base

Wenn du den Basispfad nicht im Voraus kennst, kannst du mit `"base": "./"` oder `"base": ""` einen relativen Basispfad setzen. Dadurch werden alle erzeugten URLs relativ zu jeder Datei.

:::warning Unterstützung älterer Browser bei Verwendung relativer Bases

Für relative Bases ist Unterstützung für `import.meta` erforderlich. Wenn du [Browser unterstützen musst, die `import.meta` nicht unterstützen](https://caniuse.com/mdn-javascript_operators_import_meta), kannst du [das `legacy`-Plugin](https://github.com/vitejs/vite/tree/main/packages/plugin-legacy) verwenden.

:::

## Den Build anpassen

Der Build kann über verschiedene [Build-Konfigurationsoptionen](/config/build-options.md) angepasst werden. Insbesondere kannst du die zugrunde liegenden [Rolldown-Optionen](https://rolldown.rs/reference/) direkt über `build.rolldownOptions` anpassen:

```js [vite.config.js]
export default defineConfig({
  build: {
    rolldownOptions: {
      // https://rolldown.rs/reference/
    },
  },
})
```

Du kannst zum Beispiel mehrere Rolldown-Outputs mit Plugins angeben, die nur während des Builds angewendet werden.

## Chunking-Strategie

Du kannst über [`build.rolldownOptions.output.codeSplitting`](https://rolldown.rs/reference/OutputOptions.codeSplitting) konfigurieren, wie Chunks aufgeteilt werden (siehe [Rolldown-Dokumentation](https://rolldown.rs/in-depth/manual-code-splitting)). Wenn du ein Framework verwendest, sieh in dessen Dokumentation nach, wie die Aufteilung der Chunks konfiguriert wird.

## Behandlung von Ladefehlern

Vite löst das Event `vite:preloadError` aus, wenn das Laden dynamischer Imports fehlschlägt. `event.payload` enthält den ursprünglichen Import-Fehler. Wenn du `event.preventDefault()` aufrufst, wird der Fehler nicht geworfen.

```js twoslash
window.addEventListener('vite:preloadError', (event) => {
  window.location.reload() // for example, refresh the page
})
```

Bei einem neuen Deployment löscht der Hosting-Dienst möglicherweise die Assets vorheriger Deployments. Dadurch kann ein Nutzer, der deine Seite vor dem neuen Deployment besucht hat, auf einen Import-Fehler stoßen. Dieser Fehler tritt auf, weil die auf dem Gerät dieses Nutzers laufenden Assets veraltet sind und versuchen, den zugehörigen alten Chunk zu importieren, der gelöscht wurde. Dieses Event ist nützlich, um diese Situation zu behandeln. Achte in diesem Fall darauf, `Cache-Control: no-cache` auf der HTML-Datei zu setzen, sonst werden weiterhin die alten Assets referenziert.

## Neu bauen bei Dateiänderungen

Du kannst den Rollup-Watcher mit `vite build --watch` aktivieren. Oder du passt die zugrunde liegenden [`WatcherOptions`](https://rolldown.rs/reference/InputOptions.watch) direkt über `build.watch` an:

```js [vite.config.js]
export default defineConfig({
  build: {
    watch: {
      // https://rolldown.rs/reference/InputOptions.watch
    },
  },
})
```

Mit aktiviertem `--watch`-Flag lösen Änderungen an zu bündelnden Dateien einen erneuten Build aus. Beachte, dass Änderungen an der Konfiguration und ihren Abhängigkeiten einen Neustart des Build-Befehls erfordern.

## Multi-Page-App

Angenommen, du hast folgende Quellcode-Struktur:

```
├── package.json
├── vite.config.js
├── index.html
├── main.js
└── nested
    ├── index.html
    └── nested.js
```

Im Dev-Modus navigierst oder verlinkst du einfach zu `/nested/` – es funktioniert wie erwartet, genau wie bei einem normalen statischen Dateiserver.

Beim Build musst du lediglich mehrere `.html`-Dateien als Einstiegspunkte angeben:

```js twoslash [vite.config.js]
import { resolve } from 'node:path'
import { defineConfig } from 'vite'

export default defineConfig({
  input: {
    main: resolve(import.meta.dirname, 'index.html'),
    nested: resolve(import.meta.dirname, 'nested/index.html'),
  },
})
```

Wenn du ein anderes Root angibst, denk daran, dass `import.meta.dirname` beim Auflösen der Input-Pfade weiterhin das Verzeichnis deiner `vite.config.js`-Datei ist. Du musst deinen `root`-Eintrag daher den Argumenten von `resolve` hinzufügen.

Beachte, dass Vite bei HTML-Dateien den Namen ignoriert, der dem Eintrag im Objekt `rolldownOptions.input` gegeben wurde, und beim Erzeugen des HTML-Assets im dist-Ordner stattdessen die aufgelöste ID der Datei berücksichtigt. Das sorgt für eine konsistente Struktur mit der Arbeitsweise des Dev-Servers.

## Library-Modus

Wenn du eine browser-orientierte Bibliothek entwickelst, verbringst du wahrscheinlich die meiste Zeit auf einer Test-/Demo-Seite, die deine eigentliche Bibliothek importiert. Mit Vite kannst du dafür deine `index.html` verwenden, um eine reibungslose Entwicklungserfahrung zu bekommen.

Wenn es Zeit ist, deine Bibliothek für die Verteilung zu bündeln, verwende die [Konfigurationsoption `build.lib`](/config/build-options.md#build-lib). Achte darauf, auch alle Abhängigkeiten zu externalisieren, die du nicht in deine Bibliothek bündeln möchtest, z. B. `vue` oder `react`:

::: code-group

```js twoslash [vite.config.js (single entry)]
import { resolve } from 'node:path'
import { defineConfig } from 'vite'

export default defineConfig({
  build: {
    lib: {
      entry: resolve(import.meta.dirname, 'lib/main.js'),
      name: 'MyLib',
      // the proper extensions will be added
      fileName: 'my-lib',
    },
    rolldownOptions: {
      // make sure to externalize deps that shouldn't be bundled
      // into your library
      external: ['vue'],
      output: {
        // Provide global variables to use in the UMD build
        // for externalized deps
        globals: {
          vue: 'Vue',
        },
      },
    },
  },
})
```

```js twoslash [vite.config.js (multiple entries)]
import { resolve } from 'node:path'
import { defineConfig } from 'vite'

export default defineConfig({
  build: {
    lib: {
      entry: {
        'my-lib': resolve(import.meta.dirname, 'lib/main.js'),
        secondary: resolve(import.meta.dirname, 'lib/secondary.js'),
      },
      name: 'MyLib',
    },
    rolldownOptions: {
      // make sure to externalize deps that shouldn't be bundled
      // into your library
      external: ['vue'],
      output: {
        // Provide global variables to use in the UMD build
        // for externalized deps
        globals: {
          vue: 'Vue',
        },
      },
    },
  },
})
```

:::

Die Einstiegsdatei würde Exporte enthalten, die von Nutzern deines Pakets importiert werden können:

```js [lib/main.js]
import Foo from './Foo.vue'
import Bar from './Bar.vue'
export { Foo, Bar }
```

`vite build` mit dieser Konfiguration auszuführen verwendet ein Rollup-Preset, das auf die Auslieferung von Bibliotheken ausgerichtet ist, und erzeugt zwei Bundle-Formate:

- `es` und `umd` (bei einem einzelnen Einstiegspunkt)
- `es` und `cjs` (bei mehreren Einstiegspunkten)

Die Formate lassen sich mit der Option [`build.lib.formats`](/config/build-options.md#build-lib) konfigurieren.

```
$ vite build
building for production...
dist/my-lib.js      0.08 kB / gzip: 0.07 kB
dist/my-lib.umd.cjs 0.30 kB / gzip: 0.16 kB
```

Empfohlene `package.json` für deine Bibliothek:

::: code-group

```json [package.json (single entry)]
{
  "name": "my-lib",
  "type": "module",
  "files": ["dist"],
  "main": "./dist/my-lib.umd.cjs",
  "module": "./dist/my-lib.js",
  "exports": {
    ".": {
      "import": "./dist/my-lib.js",
      "require": "./dist/my-lib.umd.cjs"
    }
  }
}
```

```json [package.json (multiple entries)]
{
  "name": "my-lib",
  "type": "module",
  "files": ["dist"],
  "main": "./dist/my-lib.cjs",
  "module": "./dist/my-lib.js",
  "exports": {
    ".": {
      "import": "./dist/my-lib.js",
      "require": "./dist/my-lib.cjs"
    },
    "./secondary": {
      "import": "./dist/secondary.js",
      "require": "./dist/secondary.cjs"
    }
  }
}
```

:::

### CSS-Unterstützung

Wenn deine Bibliothek CSS importiert, wird es als einzelne CSS-Datei neben den gebauten JS-Dateien gebündelt, z. B. `dist/my-lib.css`. Der Name entspricht standardmäßig `build.lib.fileName`, kann aber auch mit [`build.lib.cssFileName`](/config/build-options.md#build-lib) geändert werden.

Du kannst die CSS-Datei in deiner `package.json` exportieren, damit Nutzer sie importieren können:

```json {12}
{
  "name": "my-lib",
  "type": "module",
  "files": ["dist"],
  "main": "./dist/my-lib.umd.cjs",
  "module": "./dist/my-lib.js",
  "exports": {
    ".": {
      "import": "./dist/my-lib.js",
      "require": "./dist/my-lib.umd.cjs"
    },
    "./style.css": "./dist/my-lib.css"
  }
}
```

::: tip Dateiendungen
Wenn die `package.json` kein `"type": "module"` enthält, erzeugt Vite aus Gründen der Node.js-Kompatibilität andere Dateiendungen. Aus `.js` wird `.mjs` und aus `.cjs` wird `.js`.
:::

::: tip Umgebungsvariablen
Im Library-Modus werden alle Verwendungen von [`import.meta.env.*`](./env-and-mode.md) beim Build für die Produktion statisch ersetzt. Verwendungen von `process.env.*` jedoch nicht, damit Nutzer deiner Bibliothek sie dynamisch ändern können. Falls das unerwünscht ist, kannst du zum Beispiel `define: { 'process.env.NODE_ENV': '"production"' }` verwenden, um sie statisch zu ersetzen, oder [`esm-env`](https://github.com/benmccann/esm-env) für bessere Kompatibilität mit Bundlern und Runtimes einsetzen.
:::

::: warning Fortgeschrittene Nutzung
Der Library-Modus bringt eine einfache und meinungsstarke Konfiguration für browser-orientierte Bibliotheken und JS-Framework-Bibliotheken mit. Wenn du Bibliotheken baust, die nicht für den Browser gedacht sind, oder fortgeschrittene Build-Abläufe benötigst, kannst du [tsdown](https://tsdown.dev/) oder [Rolldown](https://rolldown.rs/) direkt verwenden.
:::

## Erweiterte Base-Optionen

::: warning
Diese Funktion ist experimentell. [Gib Feedback](https://github.com/vitejs/vite/discussions/13834).
:::

Für fortgeschrittene Anwendungsfälle können die ausgerollten Assets und die öffentlichen Dateien in unterschiedlichen Pfaden liegen, zum Beispiel um verschiedene Cache-Strategien zu nutzen. Ein Nutzer kann sich entscheiden, in drei verschiedenen Pfaden auszurollen:

- Die erzeugten Einstiegs-HTML-Dateien (die während SSR verarbeitet werden können)
- Die erzeugten gehashten Assets (JS, CSS und andere Dateitypen wie Bilder)
- Die kopierten [öffentlichen Dateien](assets.md#the-public-directory)

Eine einzelne statische [Base](#public-base-path) reicht in diesen Szenarien nicht aus. Vite bietet experimentelle Unterstützung für erweiterte Base-Optionen während des Builds über `experimental.renderBuiltUrl`.

```ts twoslash
import type { UserConfig } from 'vite'
// prettier-ignore
const config: UserConfig = {
// ---cut-before---
experimental: {
  renderBuiltUrl(filename, { hostType }) {
    if (hostType === 'js') {
      return { runtime: `window.__toCdnUrl(${JSON.stringify(filename)})` }
    } else {
      return { relative: true }
    }
  },
},
// ---cut-after---
}
```

Wenn die gehashten Assets und die öffentlichen Dateien nicht zusammen ausgerollt werden, lassen sich Optionen für jede Gruppe unabhängig definieren, indem der Asset-`type` aus dem zweiten `context`-Parameter der Funktion genutzt wird.

```ts twoslash
import type { UserConfig } from 'vite'
import path from 'node:path'
// prettier-ignore
const config: UserConfig = {
// ---cut-before---
experimental: {
  renderBuiltUrl(filename, { hostId, hostType, type }) {
    if (type === 'public') {
      return 'https://www.domain.com/' + filename
    } else if (path.extname(hostId) === '.js') {
      return {
        runtime: `window.__assetsPath(${JSON.stringify(filename)})`
      }
    } else {
      return 'https://cdn.domain.com/assets/' + filename
    }
  },
},
// ---cut-after---
}
```

Beachte, dass der übergebene `filename` eine dekodierte URL ist, und wenn die Funktion einen URL-String zurückgibt, sollte dieser ebenfalls dekodiert sein. Vite übernimmt die Kodierung beim Rendern der URLs automatisch. Wird ein Objekt mit `runtime` zurückgegeben, musst du die Kodierung dort, wo nötig, selbst übernehmen, da der Runtime-Code unverändert gerendert wird.
