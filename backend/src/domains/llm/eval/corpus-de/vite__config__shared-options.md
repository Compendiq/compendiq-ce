# Gemeinsame Optionen

Sofern nicht anders vermerkt, gelten die Optionen in diesem Abschnitt für Dev, Build und Preview gleichermaßen.

## root

- **Typ:** `string`
- **Standard:** `process.cwd()`

Wurzelverzeichnis des Projekts (dort, wo `index.html` liegt). Kann ein absoluter Pfad oder ein Pfad relativ zum aktuellen Arbeitsverzeichnis sein.

Weitere Details unter [Project Root](/guide/#index-html-and-project-root).

## base

- **Typ:** `string`
- **Standard:** `/`
- **Verwandt:** [`server.origin`](/config/server-options.md#server-origin)

Öffentlicher Basispfad beim Ausliefern in Entwicklung oder Produktion. Gültige Werte sind:

- Absoluter URL-Pfadname, z. B. `/foo/`
- Vollständige URL, z. B. `https://bar.com/foo/` (der Origin-Teil wird in der Entwicklung nicht verwendet, der Wert entspricht dort also `/foo/`)
- Leerer String oder `./` (für eingebettetes Deployment)

Weitere Details unter [Public Base Path](/guide/build#public-base-path).

## mode

- **Typ:** `string`
- **Standard:** `'development'` für serve, `'production'` für build

Wird das in der Konfiguration angegeben, überschreibt es den Standardmodus für **serve und build gleichermaßen**. Dieser Wert lässt sich außerdem über die Kommandozeilenoption `--mode` überschreiben.

Weitere Details unter [Env Variables and Modes](/guide/env-and-mode).

## input <NonInheritBadge />

- **Typ:** `string | string[] | { [entryAlias: string]: string }`

Einstiegspunkte Ihrer Anwendung, aufgelöst relativ zum Projektwurzelverzeichnis. Das dient als Standardwert für [`build.rolldownOptions.input`](/config/build-options#build-rolldownoptions), [`build.lib.entry`](/config/build-options#build-lib), [`build.ssr`](/config/build-options#build-ssr) (falls `true`) und [`optimizeDeps.entries`](/config/dep-optimization-options#optimizedeps-entries), sofern diese nicht ausdrücklich gesetzt sind.

Das ist nützlich, wenn Ihre Anwendung keinen `index.html`-Einstiegspunkt verwendet: Sie deklarieren den Einstiegspunkt dann nur einmal, statt ihn über die obigen Optionen hinweg zu wiederholen.

```js twoslash [vite.config.js]
import { defineConfig } from 'vite'

export default defineConfig({
  input: 'src/main.ts',
})
```

## define

- **Typ:** `Record<string, any>`

Definiert Ersetzungen für globale Konstanten. Einträge werden während der Entwicklung als Globals definiert und beim Build statisch ersetzt.

Vite verwendet für die Ersetzungen [Oxcs Define-Funktion](https://oxc.rs/docs/guide/usage/transformer/global-variable-replacement#define); Wertausdrücke müssen daher ein String sein, der einen JSON-serialisierbaren Wert (null, boolean, number, string, array oder object) oder einen einzelnen Bezeichner enthält. Nicht-String-Werte wandelt Vite automatisch mit `JSON.stringify` in einen String um.

**Beispiel:**

```js
export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify('v1.0.0'),
    __API_URL__: 'window.__backend_api_url',
  },
})
```

::: tip HINWEIS
Für TypeScript-Nutzer: Ergänzen Sie die Typdeklarationen in der Datei `vite-env.d.ts`, um Typprüfungen und IntelliSense zu erhalten.

Beispiel:

```ts
// vite-env.d.ts
declare const __APP_VERSION__: string
```

:::

## plugins

- **Typ:** `(Plugin | Plugin[] | Promise<Plugin | Plugin[]>)[]`

Array der zu verwendenden Plugins. Falsy-Werte werden ignoriert, und Arrays von Plugins werden flachgeklopft. Wird ein Promise zurückgegeben, wird es vor dem Ausführen aufgelöst. Weitere Details zu Vite-Plugins finden Sie unter [Plugin API](/guide/api-plugin).

## publicDir

- **Typ:** `string | false`
- **Standard:** `"public"`

Verzeichnis, das als reine statische Assets ausgeliefert wird. Dateien in diesem Verzeichnis werden während der Entwicklung unter `/` ausgeliefert und beim Build in das Wurzelverzeichnis von `outDir` kopiert; sie werden stets unverändert ausgeliefert bzw. kopiert. Der Wert kann entweder ein absoluter Dateisystempfad oder ein Pfad relativ zum Projektwurzelverzeichnis sein.

`publicDir` auf `false` zu setzen, deaktiviert diese Funktion.

Weitere Details unter [The `public` Directory](/guide/assets#the-public-directory).

## cacheDir

- **Typ:** `string`
- **Standard:** `"node_modules/.vite"`

Verzeichnis zum Ablegen von Cache-Dateien. Dateien in diesem Verzeichnis sind vorgebündelte Abhängigkeiten oder andere von Vite erzeugte Cache-Dateien, die die Performance verbessern können. Mit dem Flag `--force` oder durch manuelles Löschen des Verzeichnisses erzeugen Sie die Cache-Dateien neu. Der Wert kann entweder ein absoluter Dateisystempfad oder ein Pfad relativ zum Projektwurzelverzeichnis sein. Standard ist `.vite`, wenn keine `package.json` gefunden wird.

## resolve.alias

- **Typ:**
  `Record<string, string> | Array<{ find: string | RegExp, replacement: string }>`

Definiert Aliase, die Werte in `import`- oder `require`-Anweisungen ersetzen. Das funktioniert ähnlich wie [`@rollup/plugin-alias`](https://github.com/rollup/plugins/tree/master/packages/alias).

Die Reihenfolge der Einträge ist wichtig: Die zuerst definierten Regeln werden zuerst angewendet.

Wenn Sie auf Dateisystempfade aliasieren, verwenden Sie stets absolute Pfade. Relative Aliaswerte werden unverändert übernommen und nicht zu Dateisystempfaden aufgelöst.

Fortgeschrittenere eigene Auflösungen lassen sich über [Plugins](/guide/api-plugin) erreichen.

::: warning Verwendung mit SSR
Wenn Sie Aliase für [SSR-externalisierte Abhängigkeiten](/guide/ssr.md#ssr-externals) konfiguriert haben, möchten Sie möglicherweise die tatsächlichen `node_modules`-Pakete aliasieren. Sowohl [Yarn](https://classic.yarnpkg.com/en/docs/cli/add/#toc-yarn-add-alias) als auch [pnpm](https://pnpm.io/aliases/) unterstützen Aliasing über das Präfix `npm:`.
:::

### Objektform (`Record<string, string>`)

Die Objektform erlaubt es, Aliase als Schlüssel und den zugehörigen Wert als tatsächlichen Importwert anzugeben. Zum Beispiel:

```js
resolve: {
  alias: {
    utils: '../../../utils',
    'batman-1.0.0': './joker-1.5.0'
  }
}
```

### Arrayform (`Array<{ find: string | RegExp, replacement: string }>`)

Die Arrayform erlaubt es, Aliase als Objekte anzugeben, was bei komplexen Schlüssel-Wert-Paaren nützlich sein kann.

```js
resolve: {
  alias: [
    { find: 'utils', replacement: '../../../utils' },
    { find: 'batman-1.0.0', replacement: './joker-1.5.0' },
  ]
}
```

Ist `find` ein regulärer Ausdruck, kann `replacement` [Ersetzungsmuster](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/String/replace#specifying_a_string_as_the_replacement) wie `$1` verwenden. Um beispielsweise eine Erweiterung durch eine andere zu ersetzen, könnte ein Muster wie das folgende verwendet werden:

```js
{ find:/^(.*)\.js$/, replacement: '$1.alias' }
```

## resolve.dedupe

- **Typ:** `string[]`

Wenn Sie mehrere Kopien derselben Abhängigkeit in Ihrer Anwendung haben (wahrscheinlich durch Hoisting oder verlinkte Pakete in Monorepos), zwingen Sie Vite mit dieser Option dazu, die aufgeführten Abhängigkeiten stets auf dieselbe Kopie (ausgehend vom Projektwurzelverzeichnis) aufzulösen.

:::warning SSR + ESM
Bei SSR-Builds funktioniert die Deduplizierung nicht für ESM-Build-Ausgaben, die über `build.rolldownOptions.output` konfiguriert sind. Als Workaround können Sie CJS-Build-Ausgaben verwenden, bis ESM eine bessere Plugin-Unterstützung für das Laden von Modulen bietet.
:::

## resolve.conditions <NonInheritBadge />

- **Typ:** `string[]`
- **Standard:** `['module', 'browser', 'development|production']` (`defaultClientConditions`)

Zusätzlich erlaubte Bedingungen beim Auflösen von [Conditional Exports](https://nodejs.org/api/packages.html#packages_conditional_exports) eines Pakets.

Ein Paket mit Conditional Exports kann in seiner `package.json` folgendes `exports`-Feld haben:

```json
{
  "exports": {
    ".": {
      "import": "./index.mjs",
      "require": "./index.js"
    }
  }
}
```

Hier sind `import` und `require` „Bedingungen“. Bedingungen können verschachtelt werden und sollten von der spezifischsten zur allgemeinsten angegeben werden.

`development|production` ist ein Sonderwert, der je nach Wert von `process.env.NODE_ENV` durch `production` oder `development` ersetzt wird. Er wird durch `production` ersetzt, wenn `process.env.NODE_ENV === 'production'` gilt, andernfalls durch `development`.

Beachten Sie, dass die Bedingungen `import`, `require` und `default` stets angewendet werden, sofern die Voraussetzungen erfüllt sind.

Darüber hinaus wird beim Auflösen von Style-Imports die Bedingung `style` angewendet, z. B. bei `@import 'my-library'`. Für einige CSS-Präprozessoren werden zusätzlich deren jeweilige Bedingungen angewendet, also `sass` für Sass und `less` für Less.

## resolve.mainFields <NonInheritBadge />

- **Typ:** `string[]`
- **Standard:** `['browser', 'module', 'jsnext:main', 'jsnext']` (`defaultClientMainFields`)

Liste der Felder in der `package.json`, die beim Auflösen des Einstiegspunkts eines Pakets ausprobiert werden. Beachten Sie, dass sie eine geringere Priorität haben als Conditional Exports, die aus dem `exports`-Feld aufgelöst werden: Wird ein Einstiegspunkt erfolgreich aus `exports` aufgelöst, wird das Main-Feld ignoriert.

## resolve.extensions

- **Typ:** `string[]`
- **Standard:** `['.mjs', '.js', '.mts', '.ts', '.jsx', '.tsx', '.json']`

Liste der Dateiendungen, die bei Imports ohne Endung ausprobiert werden. Beachten Sie, dass es **NICHT** empfohlen wird, Endungen für eigene Importtypen (z. B. `.vue`) wegzulassen, da das die IDE- und Typunterstützung beeinträchtigen kann.

## resolve.preserveSymlinks

- **Typ:** `boolean`
- **Standard:** `false`

Diese Einstellung zu aktivieren führt dazu, dass Vite die Dateiidentität anhand des ursprünglichen Dateipfads bestimmt (also des Pfads ohne Auflösen von Symlinks) statt anhand des tatsächlichen Dateipfads (also des Pfads nach dem Auflösen von Symlinks).

- **Verwandt:** [esbuild#preserve-symlinks](https://esbuild.github.io/api/#preserve-symlinks), [webpack#resolve.symlinks
  ](https://webpack.js.org/configuration/resolve/#resolvesymlinks)

## resolve.tsconfigPaths

- **Typ:** `boolean`
- **Standard:** `false`

Aktiviert die Auflösung von tsconfig-Pfaden. Die Option `paths` in der `tsconfig.json` wird dann zum Auflösen von Imports verwendet. Weitere Details unter [Features](/guide/features.md#paths).

`paths` gilt nur für eine Datei, die über `files` oder `include` von einer `tsconfig.json` erfasst wird. Dateien mit Nicht-JS-Endungen müssen dort ausdrücklich aufgeführt werden, da ein bloßes `"src"` oder `"**/*"` in `include` nur TS/JS-Endungen erfasst — entsprechend dem Verhalten von TypeScript. Um beispielsweise einen `paths`-Alias in einer CSS-Datei zu nutzen (etwa `@import '@/foo.css'`), führen Sie diese Dateien in `files` auf oder ergänzen Sie in `include` eine explizite Endung:

```json [tsconfig.json]
{
  "include": ["src", "src/**/*.css", "src/**/*.scss"]
}
```

::: warning Less wird nicht unterstützt
`resolve.tsconfigPaths` gilt nicht innerhalb von `.less`-Dateien. Less übergibt Vite nur das Verzeichnis der importierenden Datei, nicht die Datei selbst, sodass Vite die passende `tsconfig.json` nicht finden kann. Verwenden Sie für `@import` in Less einen relativen Pfad oder [`resolve.alias`](#resolve-alias).
:::

## html.cspNonce

- **Typ:** `string`
- **Verwandt:** [Content Security Policy (CSP)](/guide/features#content-security-policy-csp)

Ein Platzhalter für einen Nonce-Wert, der beim Erzeugen von Script-/Style-Tags verwendet wird. Diesen Wert zu setzen erzeugt außerdem ein Meta-Tag mit dem Nonce-Wert.

## html.additionalAssetSources

- **Typ:** `Record<string, HtmlAssetSource>`

```ts
interface HtmlAssetSource {
  srcAttributes?: string[]
  srcsetAttributes?: string[]
  filter?: (data: {
    key: string
    value: string
    attributes: Record<string, string>
  }) => boolean
}
```

Definiert zusätzliche HTML-Elemente und -Attribute, die als Asset-Quellen behandelt werden sollen. Das erweitert die eingebaute Liste, die Standardelemente wie `<img src>`, `<video src>`, `<link href>` usw. enthält.

Das ist nützlich, wenn Sie eigene Web Components oder nicht standardisierte Attribute (wie `data-*`) verwenden, die auf Assets verweisen.

**Beispiel:**

```js
export default defineConfig({
  html: {
    additionalAssetSources: {
      // Custom web component
      'html-import': { srcAttributes: ['src'] },
      // Add data-* attributes to existing element
      img: { srcAttributes: ['data-src-dark', 'data-src-light'] },
      // With srcset format
      'my-picture': { srcsetAttributes: ['data-srcset'] },
      // With filter function
      'my-component': {
        srcAttributes: ['asset'],
        filter: ({ attributes }) => attributes.type === 'image',
      },
    },
  },
})
```

## css.modules

- **Typ:**
  ```ts
  interface CSSModulesOptions {
    getJSON?: (
      cssFileName: string,
      json: Record<string, string>,
      outputFileName: string,
    ) => void
    scopeBehaviour?: 'global' | 'local'
    globalModulePaths?: RegExp[]
    exportGlobals?: boolean
    generateScopedName?:
      string | ((name: string, filename: string, css: string) => string)
    hashPrefix?: string
    /**
     * default: undefined
     */
    localsConvention?:
      | 'camelCase'
      | 'camelCaseOnly'
      | 'dashes'
      | 'dashesOnly'
      | ((
          originalClassName: string,
          generatedClassName: string,
          inputFile: string,
        ) => string)
  }
  ```

Konfiguriert das Verhalten von CSS Modules. Die Optionen werden an [postcss-modules](https://github.com/css-modules/postcss-modules) weitergereicht.

Diese Option hat keine Wirkung, wenn [Lightning CSS](../guide/features.md#lightning-css) verwendet wird. Ist es aktiviert, sollte stattdessen [`css.lightningcss.cssModules`](https://lightningcss.dev/css-modules.html) verwendet werden.

## css.postcss

- **Typ:** `string | (postcss.ProcessOptions & { plugins?: postcss.AcceptedPlugin[] })`

Inline notierte PostCSS-Konfiguration oder ein eigenes Verzeichnis, in dem nach der PostCSS-Konfiguration gesucht wird (Standard ist das Projektwurzelverzeichnis).

Für die inline notierte PostCSS-Konfiguration wird dasselbe Format erwartet wie bei `postcss.config.js`. Für die Eigenschaft `plugins` kann allerdings nur das [Arrayformat](https://github.com/postcss/postcss-load-config/blob/main/README.md#array) verwendet werden.

Die Suche erfolgt über [postcss-load-config](https://github.com/postcss/postcss-load-config), und es werden nur die unterstützten Konfigurationsdateinamen geladen. Konfigurationsdateien außerhalb des Workspace-Wurzelverzeichnisses (bzw. des [Projektwurzelverzeichnisses](/guide/#index-html-and-project-root), wenn kein Workspace gefunden wird) werden standardmäßig nicht durchsucht. Bei Bedarf können Sie einen eigenen Pfad außerhalb des Wurzelverzeichnisses angeben, um stattdessen die betreffende Konfigurationsdatei zu laden.

Beachten Sie: Wird eine Inline-Konfiguration angegeben, sucht Vite nicht nach weiteren PostCSS-Konfigurationsquellen.

## css.preprocessorOptions

- **Typ:** `Record<string, object>`

Gibt Optionen an, die an CSS-Präprozessoren übergeben werden. Die Dateiendungen dienen als Schlüssel für die Optionen. Die unterstützten Optionen des jeweiligen Präprozessors finden Sie in dessen Dokumentation:

- `sass`/`scss`:
  - Verwendet `sass-embedded`, sofern installiert, andernfalls `sass`. Für beste Performance empfiehlt es sich, das Paket `sass-embedded` zu installieren.
  - [Optionen](https://sass-lang.com/documentation/js-api/interfaces/stringoptions/)
- `less`: [Optionen](https://lesscss.org/usage/#less-options).
- `styl`/`stylus`: Nur [`define`](https://stylus-lang.com/docs/js.html#define-name-node) wird unterstützt und kann als Objekt übergeben werden.

**Beispiel:**

```js
export default defineConfig({
  css: {
    preprocessorOptions: {
      less: {
        math: 'parens-division',
      },
      styl: {
        define: {
          $specialColor: new stylus.nodes.RGBA(51, 197, 255, 1),
        },
      },
      scss: {
        importers: [
          // ...
        ],
      },
    },
  },
})
```

### css.preprocessorOptions[extension].additionalData

- **Typ:** `string | ((source: string, filename: string) => (string | { content: string; map?: SourceMap }))`

Mit dieser Option lässt sich zusätzlicher Code in jeden Style-Inhalt injizieren. Beachten Sie: Wenn Sie tatsächliche Styles einfügen und nicht nur Variablen, werden diese Styles im finalen Bundle dupliziert.

**Beispiel:**

```js
export default defineConfig({
  css: {
    preprocessorOptions: {
      scss: {
        additionalData: `$injectedColor: orange;`,
      },
    },
  },
})
```

::: tip Dateien importieren
Da derselbe Code Dateien in unterschiedlichen Verzeichnissen vorangestellt wird, lassen sich relative Pfade nicht korrekt auflösen. Verwenden Sie stattdessen absolute Pfade oder [Aliase](#resolve-alias).
:::

## css.preprocessorMaxWorkers

- **Typ:** `number | true`
- **Standard:** `true`

Gibt die maximale Anzahl an Threads an, die CSS-Präprozessoren nutzen dürfen. `true` bedeutet bis zur Anzahl der CPUs minus 1. Bei `0` erzeugt Vite keine Worker und führt die Präprozessoren im Hauptthread aus.

Je nach Präprozessoroptionen kann Vite die Präprozessoren auch dann im Hauptthread ausführen, wenn diese Option nicht auf `0` gesetzt ist.

## css.devSourcemap

- **Experimentell:** [Feedback geben](https://github.com/vitejs/vite/discussions/13845)
- **Typ:** `boolean`
- **Standard:** `false`

Ob während der Entwicklung Sourcemaps aktiviert werden sollen.

## css.transformer

- **Experimentell:** [Feedback geben](https://github.com/vitejs/vite/discussions/13835)
- **Typ:** `'postcss' | 'lightningcss'`
- **Standard:** `'postcss'`

Wählt die Engine für die CSS-Verarbeitung aus. Weitere Informationen unter [Lightning CSS](../guide/features.md#lightning-css).

::: info Doppelte `@import`s
Beachten Sie, dass sich postcss (postcss-import) bei doppelten `@import`s anders verhält als Browser. Siehe [postcss/postcss-import#462](https://github.com/postcss/postcss-import/issues/462).
:::

## css.lightningcss

- **Experimentell:** [Feedback geben](https://github.com/vitejs/vite/discussions/13835)
- **Typ:**

```js
import type {
  CSSModulesConfig,
  Drafts,
  Features,
  NonStandard,
  PseudoClasses,
  Targets,
} from 'lightningcss'
```

```js
{
  targets?: Targets
  include?: Features
  exclude?: Features
  drafts?: Drafts
  nonStandard?: NonStandard
  pseudoClasses?: PseudoClasses
  unusedSymbols?: string[]
  cssModules?: CSSModulesConfig,
  // ...
}
```

Konfiguriert Lightning CSS. Die vollständigen Transformationsoptionen finden Sie im [Lightning-CSS-Repository](https://github.com/parcel-bundler/lightningcss/blob/master/node/index.d.ts).

## json.namedExports

- **Typ:** `boolean`
- **Standard:** `true`

Ob benannte Imports aus `.json`-Dateien unterstützt werden sollen.

## json.stringify

- **Typ:** `boolean | 'auto'`
- **Standard:** `'auto'`

Ist die Option auf `true` gesetzt, wird importiertes JSON in `export default JSON.parse("...")` umgewandelt, was deutlich performanter ist als Objektliterale, besonders bei großen JSON-Dateien.

Ist sie auf `'auto'` gesetzt, werden die Daten nur dann als String kodiert, wenn [sie größer als 10 kB sind](https://v8.dev/blog/cost-of-javascript-2019#json:~:text=A%20good%20rule%20of%20thumb%20is%20to%20apply%20this%20technique%20for%20objects%20of%2010%20kB%20or%20larger).

## oxc

- **Typ:** `OxcOptions | false`

`OxcOptions` erweitert die [Optionen des Oxc-Transformers](https://oxc.rs/docs/guide/usage/transformer). Der häufigste Anwendungsfall ist das Anpassen von JSX:

```js
export default defineConfig({
  oxc: {
    jsx: {
      runtime: 'classic',
      pragma: 'h',
      pragmaFrag: 'Fragment',
    },
  },
})
```

Standardmäßig wird die Transformation durch Oxc auf `ts`-, `jsx`- und `tsx`-Dateien angewendet. Sie können das mit `oxc.include` und `oxc.exclude` anpassen; beides kann ein Regex, ein [picomatch](https://github.com/micromatch/picomatch#globbing-features)-Muster oder ein Array aus beidem sein.

Zusätzlich können Sie mit `oxc.jsxInject` automatisch JSX-Hilfsimports in jede von Oxc transformierte Datei injizieren:

```js
export default defineConfig({
  oxc: {
    jsxInject: `import React from 'react'`,
  },
})
```

Setzen Sie die Option auf `false`, um die Transformation durch Oxc zu deaktivieren.

## esbuild

- **Typ:** `ESBuildOptions | false`
- **Veraltet**

Diese Option wird intern in die Option `oxc` überführt. Verwenden Sie stattdessen die Option `oxc`.

## assetsInclude

- **Typ:** `string | RegExp | (string | RegExp)[]`
- **Verwandt:** [Static Asset Handling](/guide/assets)

Gibt zusätzliche [picomatch-Muster](https://github.com/micromatch/picomatch#globbing-features) an, die als statische Assets behandelt werden sollen, sodass:

- sie von der Transformationspipeline der Plugins ausgenommen werden, wenn sie aus HTML referenziert oder direkt über `fetch` oder XHR angefragt werden.

- ihr Import aus JS den aufgelösten URL-String zurückgibt (das lässt sich überschreiben, wenn Sie ein Plugin mit `enforce: 'pre'` haben, das den Asset-Typ anders behandelt).

Die eingebaute Liste der Asset-Typen finden Sie [hier](https://github.com/vitejs/vite/blob/main/packages/vite/src/node/constants.ts).

**Beispiel:**

```js
export default defineConfig({
  assetsInclude: ['**/*.gltf'],
})
```

## logLevel

- **Typ:** `'info' | 'warn' | 'error' | 'silent'`

Passt die Ausführlichkeit der Konsolenausgabe an. Standard ist `'info'`.

## customLogger

- **Typ:**
  ```ts
  interface Logger {
    info(msg: string, options?: LogOptions): void
    warn(msg: string, options?: LogOptions): void
    warnOnce(msg: string, options?: LogOptions): void
    error(msg: string, options?: LogErrorOptions): void
    clearScreen(type: LogType): void
    hasErrorLogged(error: Error | RollupError): boolean
    hasWarned: boolean
  }
  ```

Verwendet einen eigenen Logger für Ausgaben. Sie können Vites `createLogger`-API nutzen, um den Standard-Logger zu holen und ihn anzupassen, etwa um die Meldung zu verändern oder bestimmte Warnungen herauszufiltern.

```ts twoslash
import { createLogger, defineConfig } from 'vite'

const logger = createLogger()
const loggerWarn = logger.warn

logger.warn = (msg, options) => {
  // Ignore empty CSS files warning
  if (msg.includes('vite:css') && msg.includes(' is empty')) return
  loggerWarn(msg, options)
}

export default defineConfig({
  customLogger: logger,
})
```

## clearScreen

- **Typ:** `boolean`
- **Standard:** `true`

Auf `false` setzen, damit Vite bei bestimmten Meldungen den Terminalbildschirm nicht leert. Über die Kommandozeile verwenden Sie `--clearScreen false`.

## envDir

- **Typ:** `string | false`
- **Standard:** `root`

Das Verzeichnis, aus dem `.env`-Dateien geladen werden. Kann ein absoluter Pfad oder ein Pfad relativ zum Projektwurzelverzeichnis sein. `false` deaktiviert das Laden der `.env`-Datei.

Mehr zu Umgebungsdateien finden Sie [hier](/guide/env-and-mode#env-files).

## envPrefix

- **Typ:** `string | string[]`
- **Standard:** `VITE_`

Umgebungsvariablen, die mit `envPrefix` beginnen, werden Ihrem Client-Quellcode über `import.meta.env` zugänglich gemacht.

:::warning SICHERHEITSHINWEISE
`envPrefix` sollte nicht auf `''` gesetzt werden, da damit alle Ihre Umgebungsvariablen offengelegt werden und sensible Informationen unbeabsichtigt nach außen gelangen. Vite wirft einen Fehler, wenn es `''` erkennt.

Wenn Sie eine Variable ohne Präfix offenlegen möchten, können Sie das über [define](#define) tun:

```js
define: {
  'import.meta.env.ENV_VARIABLE': JSON.stringify(process.env.ENV_VARIABLE)
}
```

:::

## appType

- **Typ:** `'spa' | 'mpa' | 'custom'`
- **Standard:** `'spa'`

Ob Ihre Anwendung eine Single Page Application (SPA), eine [Multi Page Application (MPA)](../guide/build#multi-page-app) oder eine benutzerdefinierte Anwendung ist (SSR und Frameworks mit eigener HTML-Behandlung):

- `'spa'`: HTML-Middlewares einbinden und SPA-Fallback verwenden. Konfigurieren Sie [sirv](https://github.com/lukeed/sirv) in der Preview mit `single: true`
- `'mpa'`: HTML-Middlewares einbinden
- `'custom'`: keine HTML-Middlewares einbinden

Mehr dazu in Vites [SSR-Leitfaden](/guide/ssr#vite-cli). Verwandt: [`server.middlewareMode`](./server-options#server-middlewaremode).

## devtools

- **Experimentell:** [Feedback geben](https://github.com/vitejs/devtools/discussions)
- **Typ:** `boolean` | `DevToolsConfig`
- **Standard:** `false`

Aktiviert die Devtools-Integration zur Visualisierung des internen Zustands und zur Build-Analyse.
Stellen Sie sicher, dass `@vitejs/devtools` als Abhängigkeit installiert ist. Diese Funktion wird derzeit nur im Build-Modus unterstützt.

Weitere Details unter [Vite DevTools](https://github.com/vitejs/devtools).

## future

- **Typ:** `Record<string, 'warn' | undefined>`
- **Verwandt:** [Breaking Changes](/changes/)

Aktiviert künftige Breaking Changes, um eine reibungslose Migration auf die nächste Hauptversion von Vite vorzubereiten. Die Liste kann jederzeit aktualisiert, erweitert oder gekürzt werden, während neue Funktionen entwickelt werden.

Details zu den möglichen Optionen finden Sie auf der Seite [Breaking Changes](/changes/).
