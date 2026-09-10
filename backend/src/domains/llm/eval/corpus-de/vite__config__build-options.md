# Build-Optionen

Sofern nicht anders angegeben, gelten die Optionen in diesem Abschnitt nur für den Build.

## build.target

- **Typ:** `string | string[]`
- **Standard:** `'baseline-widely-available'`
- **Verwandt:** [Browser-Kompatibilität](/guide/build#browser-compatibility)

Ziel der Browser-Kompatibilität für das finale Bundle. Der Standardwert ist ein Vite-spezifischer Wert, `'baseline-widely-available'`, der die minimalen Browser-Versionen anvisiert, die zum Zeitpunkt eines für jedes Major-Release festgelegten Datums zu [Baseline](https://web-platform-dx.github.io/baseline/) Widely Available kompatibel sind ([2026-01-01 für dieses Major](https://web-platform-dx.github.io/supported-browsers/?widelyAvailableOnDate=2026-01-01)). Konkret ist das `['chrome111', 'edge111', 'firefox114', 'safari16.4', 'ios16.4']`.

Ein weiterer besonderer Wert ist `'esnext'` – er setzt native Unterstützung für dynamische Importe voraus und führt nur minimales Transpiling durch.

Die Transformation erfolgt mit dem Oxc Transformer, und der Wert sollte eine gültige [Target-Option des Oxc Transformer](https://oxc.rs/docs/guide/usage/transformer/lowering#target) sein. Eigene Targets können entweder eine ES-Version (z. B. `es2015`), ein Browser mit Version (z. B. `chrome58`) oder ein Array mehrerer Target-Strings sein.

Beachten Sie, dass der Build eine Warnung ausgibt, wenn der Code Features enthält, die Oxc nicht sicher transpilieren kann. Weitere Details finden Sie in den [Oxc-Docs](https://oxc.rs/docs/guide/usage/transformer/lowering#warnings).

## build.modulePreload

- **Typ:** `boolean | { polyfill?: boolean, resolveDependencies?: ResolveModulePreloadDependenciesFn }`
- **Standard:** `{ polyfill: true }`

Standardmäßig wird automatisch ein [Module-Preload-Polyfill](https://guybedford.com/es-module-preloading-integrity#modulepreload-polyfill) eingefügt. Das Polyfill wird automatisch in das Proxy-Modul jedes `index.html`-Entries injiziert. Ist der Build so konfiguriert, dass er über `build.rolldownOptions.input` einen eigenen Nicht-HTML-Entry verwendet, müssen Sie das Polyfill in Ihrem eigenen Entry manuell importieren:

```js
import 'vite/modulepreload-polyfill'
```

Hinweis: Das Polyfill gilt **nicht** für den [Library-Modus](/guide/build#library-mode). Wenn Sie Browser ohne nativen dynamischen Import unterstützen müssen, sollten Sie es in Ihrer Bibliothek vermutlich nicht verwenden.

Das Polyfill lässt sich über `{ polyfill: false }` deaktivieren.

Die Liste der für jeden dynamischen Import vorzuladenden Chunks berechnet Vite. Standardmäßig wird beim Laden dieser Abhängigkeiten ein absoluter Pfad einschließlich `base` verwendet. Ist `base` relativ (`''` oder `'./'`), wird zur Laufzeit `import.meta.url` verwendet, um absolute Pfade zu vermeiden, die von der finalen Deployment-Base abhängen.

Es gibt experimentelle Unterstützung für feingranulare Kontrolle über die Abhängigkeitsliste und deren Pfade mithilfe der Funktion `resolveDependencies`. [Feedback geben](https://github.com/vitejs/vite/discussions/13841). Sie erwartet eine Funktion vom Typ `ResolveModulePreloadDependenciesFn`:

```ts
type ResolveModulePreloadDependenciesFn = (
  url: string,
  deps: string[],
  context: {
    hostId: string
    hostType: 'html' | 'js'
  },
) => string[]
```

Die Funktion `resolveDependencies` wird für jeden dynamischen Import mit einer Liste der Chunks aufgerufen, von denen er abhängt, und ebenso für jeden in Entry-HTML-Dateien importierten Chunk. Es kann ein neues Abhängigkeits-Array zurückgegeben werden, in dem diese gefiltert oder weitere Abhängigkeiten eingefügt und deren Pfade verändert wurden. Die `deps`-Pfade sind relativ zu `build.outDir`. Der Rückgabewert sollte ein relativer Pfad zu `build.outDir` sein.

```js twoslash
/** @type {import('vite').UserConfig} */
const config = {
  // prettier-ignore
  build: {
// ---cut-before---
modulePreload: {
  resolveDependencies: (filename, deps, { hostId, hostType }) => {
    return deps.filter(condition)
  },
},
// ---cut-after---
  },
}
```

Die aufgelösten Abhängigkeitspfade lassen sich mit [`experimental.renderBuiltUrl`](../guide/build.md#advanced-base-options) weiter verändern.

## build.polyfillModulePreload

- **Typ:** `boolean`
- **Standard:** `true`
- **Deprecated** – verwenden Sie stattdessen `build.modulePreload.polyfill`

Ob automatisch ein [Module-Preload-Polyfill](https://guybedford.com/es-module-preloading-integrity#modulepreload-polyfill) eingefügt wird.

## build.outDir

- **Typ:** `string`
- **Standard:** `dist`

Gibt das Ausgabeverzeichnis an (relativ zum [Projekt-Root](/guide/#index-html-and-project-root)).

## build.assetsDir

- **Typ:** `string`
- **Standard:** `assets`

Gibt das Verzeichnis an, unter dem erzeugte Assets abgelegt werden (relativ zu `build.outDir`. Im [Library-Modus](/guide/build#library-mode) wird das nicht verwendet).

## build.assetsInlineLimit

- **Typ:** `number` | `((filePath: string, content: Buffer) => boolean | undefined)`
- **Standard:** `4096` (4 KiB)

Importierte oder referenzierte Assets, die kleiner als dieser Schwellwert sind, werden als Base64-URLs eingebettet, um zusätzliche HTTP-Requests zu vermeiden. Setzen Sie den Wert auf `0`, um das Einbetten vollständig zu deaktivieren.

Wird ein Callback übergeben, kann ein Boolean zurückgegeben werden, um das Einbetten zu erzwingen oder auszuschließen. Wird nichts zurückgegeben, greift die Standardlogik.

Git-LFS-Platzhalter werden automatisch vom Einbetten ausgenommen, da sie nicht den Inhalt der Datei enthalten, für die sie stehen.

::: tip Hinweis
Wenn Sie `build.lib` angeben, wird `build.assetsInlineLimit` ignoriert und Assets werden stets eingebettet, unabhängig von der Dateigröße oder davon, ob es sich um einen Git-LFS-Platzhalter handelt.
:::

## build.cssCodeSplit

- **Typ:** `boolean`
- **Standard:** `true`

Aktiviert/deaktiviert das Code-Splitting für CSS. Wenn aktiviert, bleibt CSS, das in asynchronen JS-Chunks importiert wird, als Chunk erhalten und wird zusammen mit dem Chunk geladen.

Wenn deaktiviert, wird sämtliches CSS des gesamten Projekts in eine einzige CSS-Datei extrahiert.

::: tip Hinweis
Wenn Sie `build.lib` angeben, ist `build.cssCodeSplit` standardmäßig `false`.
:::

## build.cssTarget

- **Typ:** `string | string[]`
- **Standard:** dasselbe wie [`build.target`](#build-target)

Diese Option erlaubt es, für die CSS-Minifizierung ein anderes Browser-Target zu setzen als für die JavaScript-Transpilierung.

Sie sollte nur verwendet werden, wenn Sie einen weniger verbreiteten Browser anvisieren.
Ein Beispiel ist die WeChat-WebView unter Android, die die meisten modernen JavaScript-Features unterstützt, nicht aber die [hexadezimale Farbnotation `#RGBA` in CSS](https://developer.mozilla.org/en-US/docs/Web/CSS/color_value#rgb_colors).
In diesem Fall müssen Sie `build.cssTarget` auf `chrome61` setzen, damit Vite `rgba()`-Farben nicht in hexadezimale `#RGBA`-Notation umwandelt.

## build.cssMinify

- **Typ:** `boolean | 'lightningcss' | 'esbuild'`
- **Standard:** `'lightningcss'`, jedoch `false`, wenn [`build.minify`](#build-minify) für den Client-Build deaktiviert ist

Diese Option erlaubt es, die CSS-Minifizierung gezielt zu überschreiben, statt auf `build.minify` zurückzufallen, sodass Sie die Minifizierung für JS und CSS getrennt konfigurieren können. Vite verwendet standardmäßig [Lightning CSS](https://lightningcss.dev/minification.html), um CSS zu minifizieren. Es lässt sich über [`css.lightningcss`](./shared-options.md#css-lightningcss) konfigurieren. Setzen Sie die Option auf `'esbuild'`, um stattdessen esbuild zu verwenden.

Bei der Einstellung `'esbuild'` muss esbuild installiert sein.

```sh
npm add -D esbuild
```

## build.sourcemap

- **Typ:** `boolean | 'inline' | 'hidden'`
- **Standard:** `false`

Erzeugt Source Maps für die Produktion. Bei `true` wird eine separate Sourcemap-Datei angelegt. Bei `'inline'` wird die Sourcemap als Data-URI an die resultierende Ausgabedatei angehängt. `'hidden'` verhält sich wie `true`, allerdings werden die zugehörigen Sourcemap-Kommentare in den gebündelten Dateien unterdrückt.

## build.chunkImportMap

- **Typ:** `boolean`
- **Standard:** `false`
- **Experimentell**
- **Verwandt:** [Optimierung der Chunk-Import-Map](/guide/features#chunk-import-map-optimization)

Ob die Import-Maps-Funktion genutzt wird, um die Effizienz des Chunk-Cachings zu optimieren.

Beachten Sie, dass diese Option [Unterstützung für `import.meta.resolve`](https://caniuse.com/mdn-javascript_operators_import_meta_resolve) voraussetzt. Wenn Sie ältere Browser unterstützen müssen, sehen Sie sich [`@vitejs/plugin-legacy`](https://github.com/vitejs/vite/tree/main/packages/plugin-legacy) an.

## build.rolldownOptions

- **Typ:** [`RolldownOptions`](https://rolldown.rs/reference/)

Passt das zugrunde liegende Rolldown-Bundle direkt an. Das entspricht den Optionen, die sich aus einer Rolldown-Konfigurationsdatei exportieren lassen, und wird mit Vites internen Rolldown-Optionen gemergt. Weitere Details finden Sie in der [Dokumentation zu den Rolldown-Optionen](https://rolldown.rs/reference/).

Statt `build.rolldownOptions.input` wird empfohlen, die Option [`input`](/config/shared-options#input) auf oberster Ebene zu setzen, weil sie auch in der Entwicklung verwendet wird. Ist `build.rolldownOptions.input` gesetzt, überschreibt es die Option `input` auf oberster Ebene ausschließlich für den Build.

## build.rollupOptions

- **Typ:** `RolldownOptions`
- **Deprecated**

Diese Option ist ein Alias der Option `build.rolldownOptions`. Verwenden Sie stattdessen die Option `build.rolldownOptions`.

## build.dynamicImportVarsOptions

- **Typ:** `{ include?: string | RegExp | (string | RegExp)[], exclude?: string | RegExp | (string | RegExp)[] }`
- **Verwandt:** [Dynamischer Import](/guide/features#dynamic-import)

Ob dynamische Importe mit Variablen transformiert werden.

## build.lib

- **Typ:** `{ entry?: string | string[] | { [entryAlias: string]: string }, name?: string, formats?: ('es' | 'cjs' | 'umd' | 'iife')[], fileName?: string | ((format: ModuleFormat, entryName: string) => string), cssFileName?: string }`
- **Verwandt:** [Library-Modus](/guide/build#library-mode)

Baut als Bibliothek. `entry` fällt standardmäßig auf die Option [`input`](/config/shared-options#input) auf oberster Ebene zurück, und eine der beiden ist erforderlich, da die Bibliothek kein HTML als Entry verwenden kann. `name` ist die exponierte globale Variable und ist erforderlich, wenn `formats` `'umd'` oder `'iife'` enthält. Die Standard-`formats` sind `['es', 'umd']` bzw. `['es', 'cjs']`, wenn mehrere Entries verwendet werden.

`fileName` ist der Name der ausgegebenen Paketdatei, standardmäßig der `"name"` aus der `package.json`. Er kann auch als Funktion definiert werden, die `format` und `entryName` als Argumente erhält und den Dateinamen zurückgibt.

Wenn Ihr Paket CSS importiert, lässt sich mit `cssFileName` der Name der ausgegebenen CSS-Datei festlegen. Standardmäßig entspricht er `fileName`, sofern dieses als String gesetzt ist; andernfalls fällt er ebenfalls auf den `"name"` aus der `package.json` zurück.

```js twoslash [vite.config.js]
import { defineConfig } from 'vite'

export default defineConfig({
  build: {
    lib: {
      entry: ['src/main.js'],
      fileName: (format, entryName) => `my-lib-${entryName}.${format}.js`,
      cssFileName: 'my-lib-style',
    },
  },
})
```

## build.license

- **Typ:** `boolean | { fileName?: string }`
- **Standard:** `false`
- **Verwandt:** [Lizenz](/guide/features#license)

Bei `true` erzeugt der Build eine Datei `.vite/license.md`, die die Lizenzen aller gebündelten Abhängigkeiten enthält.

Wird `fileName` übergeben, dient es als Name der Lizenzdatei relativ zum `outDir`. Endet er auf `.json`, werden stattdessen die rohen JSON-Metadaten erzeugt, die sich weiterverarbeiten lassen. Zum Beispiel:

```json
[
  {
    "name": "dep-1",
    "version": "1.2.3",
    "identifier": "CC0-1.0",
    "text": "CC0 1.0 Universal\n\n..."
  },
  {
    "name": "dep-2",
    "version": "4.5.6",
    "identifier": "MIT",
    "text": "MIT License\n\n..."
  }
]
```

::: tip

Wenn Sie die Lizenzdatei im gebauten Code referenzieren möchten, können Sie mit [`build.rolldownOptions.output.postBanner`](https://rolldown.rs/reference/OutputOptions.postBanner#postbanner) einen Kommentar am Anfang der Dateien einfügen. Zum Beispiel:

```js twoslash [vite.config.js]
import { defineConfig } from 'vite'

export default defineConfig({
  build: {
    license: true,
    rolldownOptions: {
      output: {
        postBanner:
          '/* See licenses of bundled dependencies at https://example.com/license.md */',
      },
    },
  },
})
```

:::

## build.manifest

- **Typ:** `boolean | string`
- **Standard:** `false`
- **Verwandt:** [Backend-Integration](/guide/backend-integration)

Ob eine Manifest-Datei erzeugt wird, die eine Zuordnung von nicht gehashten Asset-Dateinamen zu ihren gehashten Varianten enthält, die ein Server-Framework dann nutzen kann, um die korrekten Asset-Links zu rendern.

Ist der Wert ein String, dient er als Pfad zur Manifest-Datei relativ zu `build.outDir`. Bei `true` lautet der Pfad `.vite/manifest.json`.

Wenn Sie ein Plugin schreiben und während des Builds das zugehörige CSS und die statischen Assets jedes ausgegebenen Chunks oder Assets untersuchen müssen, können Sie auch die [`viteMetadata`-API für Output-Bundle-Metadaten](/guide/api-plugin#output-bundle-metadata) verwenden.

## build.ssrManifest

- **Typ:** `boolean | string`
- **Standard:** `false`
- **Verwandt:** [Server-Side Rendering](/guide/ssr)

Ob eine SSR-Manifest-Datei erzeugt wird, um Style-Links und Asset-Preload-Direktiven in der Produktion zu bestimmen.

Ist der Wert ein String, dient er als Pfad zur Manifest-Datei relativ zu `build.outDir`. Bei `true` lautet der Pfad `.vite/ssr-manifest.json`.

## build.ssr

- **Typ:** `boolean | string`
- **Standard:** `false`
- **Verwandt:** [Server-Side Rendering](/guide/ssr)

Erzeugt einen SSR-orientierten Build. Der Wert kann ein String sein, der den SSR-Entry direkt angibt, oder `true`, was voraussetzt, dass der SSR-Entry über [`input`](/config/shared-options#input) oder `build.rolldownOptions.input` angegeben wird.

## build.emitAssets

- **Typ:** `boolean`
- **Standard:** `false`

Bei Nicht-Client-Builds werden statische Assets nicht ausgegeben, da angenommen wird, dass sie als Teil des Client-Builds ausgegeben werden. Diese Option erlaubt es Frameworks, ihre Ausgabe auch im Build anderer Environments zu erzwingen. Es liegt in der Verantwortung des Frameworks, die Assets in einem Post-Build-Schritt zusammenzuführen.

## build.ssrEmitAssets

- **Typ:** `boolean`
- **Standard:** `false`

Während des SSR-Builds werden statische Assets nicht ausgegeben, da angenommen wird, dass sie als Teil des Client-Builds ausgegeben werden. Diese Option erlaubt es Frameworks, ihre Ausgabe sowohl im Client- als auch im SSR-Build zu erzwingen. Es liegt in der Verantwortung des Frameworks, die Assets in einem Post-Build-Schritt zusammenzuführen. Diese Option wird durch `build.emitAssets` ersetzt, sobald die Environment API stabil ist.

## build.minify

- **Typ:** `boolean | 'oxc' | 'terser' | 'esbuild'`
- **Standard:** `'oxc'` für den Client-Build, `false` für den SSR-Build

Setzen Sie den Wert auf `false`, um die Minifizierung zu deaktivieren, oder geben Sie den zu verwendenden Minifier an. Standard ist der [Oxc Minifier](https://oxc.rs/docs/guide/usage/minifier), der 30- bis 90-mal schneller als Terser ist und dabei nur 0,5 bis 2 % schlechter komprimiert. [Benchmarks](https://github.com/privatenumber/minification-benchmarks)

`build.minify: 'esbuild'` ist deprecated und wird künftig entfernt.

Beachten Sie, dass die Option `build.minify` im Lib-Modus beim Format `'es'` keine Leerzeichen minifiziert, da sie Pure-Annotations entfernt und Tree-Shaking zerstört.

Bei der Einstellung `'esbuild'` bzw. `'terser'` muss esbuild bzw. Terser installiert sein.

```sh
npm add -D esbuild
npm add -D terser
```

## build.terserOptions

- **Typ:** `TerserOptions`

Zusätzliche [Minify-Optionen](https://terser.org/docs/api-reference#minify-options), die an Terser weitergereicht werden.

Zusätzlich können Sie eine Option `maxWorkers: number` übergeben, um die maximale Zahl zu startender Worker festzulegen. Standard ist die Anzahl der CPUs minus 1.

## build.write

- **Typ:** `boolean`
- **Standard:** `true`

Setzen Sie den Wert auf `false`, um das Schreiben des Bundles auf die Festplatte zu deaktivieren. Das wird vor allem bei [programmatischen `build()`-Aufrufen](/guide/api-javascript#build) verwendet, bei denen das Bundle vor dem Schreiben noch weiterverarbeitet werden muss.

## build.emptyOutDir

- **Typ:** `boolean`
- **Standard:** `true`, wenn `outDir` innerhalb von `root` liegt

Standardmäßig leert Vite beim Build das `outDir`, sofern es innerhalb des Projekt-Roots liegt. Liegt `outDir` außerhalb des Roots, gibt Vite eine Warnung aus, um das versehentliche Löschen wichtiger Dateien zu vermeiden. Sie können diese Option explizit setzen, um die Warnung zu unterdrücken. Auf der Kommandozeile steht sie ebenfalls als `--emptyOutDir` zur Verfügung.

## build.copyPublicDir

- **Typ:** `boolean`
- **Standard:** `true`

Standardmäßig kopiert Vite beim Build Dateien aus dem `publicDir` in das `outDir`. Setzen Sie den Wert auf `false`, um das zu deaktivieren.

## build.reportCompressedSize

- **Typ:** `boolean`
- **Standard:** `true`

Aktiviert/deaktiviert die Meldung der gzip-komprimierten Größe. Das Komprimieren großer Ausgabedateien kann langsam sein, sodass ein Deaktivieren die Build-Performance bei großen Projekten steigern kann.

## build.chunkSizeWarningLimit

- **Typ:** `number`
- **Standard:** `500`

Grenze für Warnungen zur Chunk-Größe (in kB). Verglichen wird die unkomprimierte Chunk-Größe, da [die JavaScript-Größe selbst mit der Ausführungszeit zusammenhängt](https://v8.dev/blog/cost-of-javascript-2019).

## build.watch

- **Typ:** [`WatcherOptions`](https://rolldown.rs/reference/InputOptions.watch)`| null`
- **Standard:** `null`

Setzen Sie den Wert auf `{}`, um den Rollup-Watcher zu aktivieren. Das wird vor allem in Fällen mit reinen Build-Plugins oder Integrationsprozessen verwendet.

::: warning Vite unter Windows Subsystem for Linux (WSL) 2 verwenden

Es gibt Fälle, in denen die Dateisystemüberwachung unter WSL2 nicht funktioniert.
Weitere Details finden Sie unter [`server.watch`](./server-options.md#server-watch).

:::
