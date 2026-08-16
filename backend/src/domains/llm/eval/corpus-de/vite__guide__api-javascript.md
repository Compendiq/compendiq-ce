# JavaScript-API

Die JavaScript-APIs von Vite sind vollständig typisiert; es empfiehlt sich, TypeScript zu verwenden oder die JS-Typprüfung in VS Code zu aktivieren, um IntelliSense und Validierung zu nutzen.

## `createServer`

**Typsignatur:**

```ts
async function createServer(inlineConfig?: InlineConfig): Promise<ViteDevServer>
```

**Beispielverwendung:**

```ts twoslash
import { createServer } from 'vite'

const server = await createServer({
  // any valid user config options, plus `mode` and `configFile`
  configFile: false,
  root: import.meta.dirname,
  server: {
    port: 1337,
  },
})
await server.listen()

server.printUrls()
server.bindCLIShortcuts({ print: true })
```

::: tip HINWEIS
Wenn Sie `createServer` und `build` im selben Node.js-Prozess verwenden, sind beide Funktionen für ihre korrekte Arbeitsweise auf `process.env.NODE_ENV` angewiesen, was wiederum von der Konfigurationsoption `mode` abhängt. Um widersprüchliches Verhalten zu vermeiden, setzen Sie `process.env.NODE_ENV` oder den `mode` beider APIs auf `development`. Andernfalls können Sie einen Kindprozess starten, um die APIs getrennt auszuführen.
:::

::: tip HINWEIS
Wenn Sie den [Middleware-Modus](/config/server-options.html#server-middlewaremode) zusammen mit der [Proxy-Konfiguration für WebSocket](/config/server-options.html#server-proxy) verwenden, sollte der übergeordnete HTTP-Server in `middlewareMode` angegeben werden, damit der Proxy korrekt gebunden wird.

<details>
<summary>Beispiel</summary>

```ts twoslash
import http from 'http'
import { createServer } from 'vite'

const parentServer = http.createServer() // or express, koa, etc.

const vite = await createServer({
  server: {
    // Enable middleware mode
    middlewareMode: {
      // Provide the parent http server for proxy WebSocket
      server: parentServer,
    },
    proxy: {
      '/ws': {
        target: 'ws://localhost:3000',
        // Proxying WebSocket
        ws: true,
      },
    },
  },
})

// @noErrors: 2339
parentServer.use(vite.middlewares)
```

</details>
:::

## `InlineConfig`

Das Interface `InlineConfig` erweitert `UserConfig` um zusätzliche Eigenschaften:

- `configFile`: gibt die zu verwendende Konfigurationsdatei an. Ist sie nicht gesetzt, versucht Vite, automatisch eine ausgehend vom Projekt-Root aufzulösen. Setzen Sie sie auf `false`, um die automatische Auflösung zu deaktivieren.

## `ResolvedConfig`

Das Interface `ResolvedConfig` hat dieselben Eigenschaften wie eine `UserConfig`, mit dem Unterschied, dass die meisten Eigenschaften aufgelöst und nicht undefined sind. Es enthält außerdem Hilfsmittel wie:

- `config.assetsInclude`: eine Funktion, um zu prüfen, ob eine `id` als Asset gilt.
- `config.logger`: das interne Logger-Objekt von Vite.

## `ViteDevServer`

```ts
interface ViteDevServer {
  /**
   * The resolved Vite config object.
   */
  config: ResolvedConfig
  /**
   * A connect app instance
   * - Can be used to attach custom middlewares to the dev server.
   * - Can also be used as the handler function of a custom http server
   *   or as a middleware in any connect-style Node.js frameworks.
   *
   * https://github.com/senchalabs/connect#use-middleware
   */
  middlewares: Connect.Server
  /**
   * Native Node http server instance.
   * Will be null in middleware mode.
   */
  httpServer: http.Server | null
  /**
   * Chokidar watcher instance. If `config.server.watch` is set to `null`,
   * it will not watch any files and calling `add` or `unwatch` will have no effect.
   * https://github.com/paulmillr/chokidar/tree/3.6.0#api
   */
  watcher: FSWatcher
  /**
   * WebSocket server with `send(payload)` method.
   */
  ws: WebSocketServer
  /**
   * Rollup plugin container that can run plugin hooks on a given file.
   */
  pluginContainer: PluginContainer
  /**
   * Module graph that tracks the import relationships, url to file mapping
   * and hmr state.
   */
  moduleGraph: ModuleGraph
  /**
   * The resolved urls Vite prints on the CLI (URL-encoded). Returns `null`
   * in middleware mode or if the server is not listening on any port.
   */
  resolvedUrls: ResolvedServerUrls | null
  /**
   * Programmatically resolve, load and transform a URL and get the result
   * without going through the http request pipeline.
   */
  transformRequest(
    url: string,
    options?: TransformOptions,
  ): Promise<TransformResult | null>
  /**
   * Apply Vite built-in HTML transforms and any plugin HTML transforms.
   */
  transformIndexHtml(
    url: string,
    html: string,
    originalUrl?: string,
  ): Promise<string>
  /**
   * Load a given URL as an instantiated module for SSR.
   */
  ssrLoadModule(
    url: string,
    options?: { fixStacktrace?: boolean },
  ): Promise<Record<string, any>>
  /**
   * Fix ssr error stacktrace.
   */
  ssrFixStacktrace(e: Error): void
  /**
   * Triggers HMR for a module in the module graph. You can use the `server.moduleGraph`
   * API to retrieve the module to be reloaded. If `hmr` is false, this is a no-op.
   */
  reloadModule(module: ModuleNode): Promise<void>
  /**
   * Start the server.
   */
  listen(port?: number, isRestart?: boolean): Promise<ViteDevServer>
  /**
   * Restart the server.
   *
   * @param forceOptimize - force the optimizer to re-bundle, same as --force cli flag
   */
  restart(forceOptimize?: boolean): Promise<void>
  /**
   * Stop the server.
   */
  close(): Promise<void>
  /**
   * Bind CLI shortcuts
   */
  bindCLIShortcuts(options?: BindCLIShortcutsOptions<ViteDevServer>): void
  /**
   * Calling `await server.waitForRequestsIdle(id)` will wait until all static imports
   * are processed. If called from a load or transform plugin hook, the id needs to be
   * passed as a parameter to avoid deadlocks. Calling this function after the first
   * static imports section of the module graph has been processed will resolve immediately.
   * @experimental
   */
  waitForRequestsIdle: (ignoredId?: string) => Promise<void>
}
```

:::info
`waitForRequestsIdle` ist als Notausgang gedacht, um die DX für Features zu verbessern, die sich nicht im Sinne der bedarfsgesteuerten Natur des Vite-Dev-Servers umsetzen lassen. Es kann beim Start von Werkzeugen wie Tailwind genutzt werden, um das Erzeugen der CSS-Klassen der Anwendung zu verzögern, bis der Anwendungscode gesehen wurde, und so aufblitzende Stiländerungen zu vermeiden. Wird diese Funktion in einem load- oder transform-Hook verwendet und kommt der standardmäßige HTTP1-Server zum Einsatz, ist einer der sechs HTTP-Kanäle blockiert, bis der Server alle statischen Importe verarbeitet hat. Vites Dependency-Optimizer nutzt diese Funktion derzeit, um vollständige Seiten-Reloads bei fehlenden Abhängigkeiten zu vermeiden, indem das Laden vorgebündelter Abhängigkeiten verzögert wird, bis alle importierten Abhängigkeiten aus statisch importierten Quellen gesammelt wurden. Vite könnte in einem künftigen Major-Release auf eine andere Strategie umstellen und `optimizeDeps.holdUntilCrawlEnd: false` als Standard setzen, um die Performance-Einbußen in großen Anwendungen beim Kaltstart zu vermeiden.
:::

## `build`

**Typsignatur:**

```ts
async function build(
  inlineConfig?: InlineConfig,
): Promise<RolldownOutput | RolldownOutput[] | RolldownWatcher>
```

**Beispielverwendung:**

```ts twoslash [vite.config.js]
import path from 'node:path'
import { build } from 'vite'

await build({
  root: path.resolve(import.meta.dirname, './project'),
  base: '/foo/',
  build: {
    rolldownOptions: {
      // ...
    },
  },
})
```

## `preview`

**Typsignatur:**

```ts
async function preview(inlineConfig?: InlineConfig): Promise<PreviewServer>
```

**Beispielverwendung:**

```ts twoslash
import { preview } from 'vite'

const previewServer = await preview({
  // any valid user config options, plus `mode` and `configFile`
  preview: {
    port: 8080,
    open: true,
  },
})

previewServer.printUrls()
previewServer.bindCLIShortcuts({ print: true })
```

## `PreviewServer`

```ts
interface PreviewServer {
  /**
   * The resolved vite config object
   */
  config: ResolvedConfig
  /**
   * A connect app instance.
   * - Can be used to attach custom middlewares to the preview server.
   * - Can also be used as the handler function of a custom http server
   *   or as a middleware in any connect-style Node.js frameworks
   *
   * https://github.com/senchalabs/connect#use-middleware
   */
  middlewares: Connect.Server
  /**
   * native Node http server instance
   */
  httpServer: http.Server
  /**
   * The resolved urls Vite prints on the CLI (URL-encoded). Returns `null`
   * if the server is not listening on any port.
   */
  resolvedUrls: ResolvedServerUrls | null
  /**
   * Print server urls
   */
  printUrls(): void
  /**
   * Bind CLI shortcuts
   */
  bindCLIShortcuts(options?: BindCLIShortcutsOptions<PreviewServer>): void
}
```

## `resolveConfig`

**Typsignatur:**

```ts
async function resolveConfig(
  inlineConfig: InlineConfig,
  command: 'build' | 'serve',
  defaultMode = 'development',
  defaultNodeEnv = 'development',
  isPreview = false,
): Promise<ResolvedConfig>
```

Der Wert von `command` ist `serve` in Dev und Preview und `build` beim Build.

## `mergeConfig`

**Typsignatur:**

```ts
function mergeConfig(
  defaults: Record<string, any>,
  overrides: Record<string, any>,
  isRoot = true,
): Record<string, any>
```

Führt zwei Vite-Konfigurationen tief zusammen. `isRoot` steht für die Ebene innerhalb der Vite-Konfiguration, die zusammengeführt wird. Setzen Sie es zum Beispiel auf `false`, wenn Sie zwei `build`-Optionen zusammenführen.

Beachten Sie, dass Werte `null` und `undefined` in `overrides` übersprungen und nicht zusammengeführt werden. Wenn Sie einen Wert aus `defaults` explizit löschen müssen, ändern Sie das Ergebnis von `mergeConfig` direkt.

::: tip HINWEIS
`mergeConfig` akzeptiert Konfigurationen nur in Objektform. Liegt Ihre Konfiguration in Callback-Form vor, sollten Sie sie aufrufen, bevor Sie sie an `mergeConfig` übergeben.

Sie können den Helfer `defineConfig` verwenden, um eine Konfiguration in Callback-Form mit einer anderen Konfiguration zusammenzuführen:

```ts twoslash
import {
  defineConfig,
  mergeConfig,
  type UserConfigFnObject,
  type UserConfig,
} from 'vite'
declare const configAsCallback: UserConfigFnObject
declare const configAsObject: UserConfig

// ---cut---
export default defineConfig((configEnv) =>
  mergeConfig(configAsCallback(configEnv), configAsObject),
)
```

:::

## `searchForWorkspaceRoot`

**Typsignatur:**

```ts
function searchForWorkspaceRoot(
  current: string,
  root = searchForPackageRoot(current),
): string
```

**Verwandt:** [server.fs.allow](/config/server-options.md#server-fs-allow)

Sucht das Wurzelverzeichnis des potenziellen Workspace, sofern die folgenden Bedingungen erfüllt sind; andernfalls wird auf `root` zurückgefallen:

- enthält das Feld `workspaces` in der `package.json`
- enthält eine der folgenden Dateien
  - `lerna.json`
  - `pnpm-workspace.yaml`

## `loadEnv`

**Typsignatur:**

```ts
function loadEnv(
  mode: string,
  envDir: string,
  prefixes: string | string[] = 'VITE_',
): Record<string, string>
```

**Verwandt:** [`.env`-Dateien](./env-and-mode.md#env-files)

Lädt `.env`-Dateien innerhalb von `envDir` und führt sie mit den passenden, bereits in `process.env` vorhandenen Variablen zusammen. Standardmäßig werden nur Umgebungsvariablen mit dem Präfix `VITE_` geladen, sofern `prefixes` nicht geändert wird.

## `normalizePath`

**Typsignatur:**

```ts
function normalizePath(id: string): string
```

**Verwandt:** [Pfadnormalisierung](./api-plugin.md#path-normalization)

Normalisiert einen Pfad, damit Vite-Plugins zusammenarbeiten können.

## `transformWithOxc`

**Typsignatur:**

```ts
async function transformWithOxc(
  code: string,
  filename: string,
  options?: OxcTransformOptions,
  inMap?: object,
): Promise<Omit<OxcTransformResult, 'errors'> & { warnings: string[] }>
```

Transformiert JavaScript oder TypeScript mit dem [Oxc Transformer](https://oxc.rs/docs/guide/usage/transformer). Nützlich für Plugins, die sich an Vites interne Oxc-Transformer-Transformation halten möchten.

## `transformWithEsbuild`

**Typsignatur:**

```ts
async function transformWithEsbuild(
  code: string,
  filename: string,
  options?: EsbuildTransformOptions,
  inMap?: object,
): Promise<ESBuildTransformResult>
```

**Veraltet:** Verwenden Sie stattdessen `transformWithOxc`.

Transformiert JavaScript oder TypeScript mit esbuild. Nützlich für Plugins, die sich an Vites interne esbuild-Transformation halten möchten.

## `loadConfigFromFile`

**Typsignatur:**

```ts
async function loadConfigFromFile(
  configEnv: ConfigEnv,
  configFile?: string,
  configRoot: string = process.cwd(),
  logLevel?: LogLevel,
  customLogger?: Logger,
): Promise<{
  path: string
  config: UserConfig
  dependencies: string[]
} | null>
```

Lädt eine Vite-Konfigurationsdatei manuell mit Rolldown.

## `preprocessCSS`

- **Experimentell:** [Feedback geben](https://github.com/vitejs/vite/discussions/13815)

**Typsignatur:**

```ts
async function preprocessCSS(
  code: string,
  filename: string,
  config: ResolvedConfig,
): Promise<PreprocessCSSResult>

interface PreprocessCSSResult {
  code: string
  map?: SourceMapInput
  modules?: Record<string, string>
  deps?: Set<string>
}
```

Verarbeitet `.css`-, `.scss`-, `.sass`-, `.less`-, `.styl`- und `.stylus`-Dateien zu reinem CSS vor, damit es in Browsern verwendet oder von anderen Werkzeugen geparst werden kann. Ähnlich wie bei der [eingebauten Unterstützung für CSS-Präprozessoren](/guide/features#css-pre-processors) muss der entsprechende Präprozessor installiert sein, wenn er verwendet wird.

Der verwendete Präprozessor wird aus der Erweiterung von `filename` abgeleitet. Endet `filename` auf `.module.{ext}`, wird es als [CSS-Modul](https://github.com/css-modules/css-modules) erkannt, und das zurückgegebene Ergebnis enthält ein Objekt `modules`, das die ursprünglichen Klassennamen auf die transformierten abbildet.

Beachten Sie, dass die Vorverarbeitung URLs in `url()` oder `image-set()` nicht auflöst.

## `version`

**Typ:** `string`

Die aktuelle Version von Vite als Zeichenkette (z. B. `"8.0.0"`).

## `rolldownVersion`

**Typ:** `string`

Die von Vite verwendete Version von Rolldown als Zeichenkette (z. B. `"1.0.0"`). Ein Re-Export von [`VERSION`](https://rolldown.rs/reference/Variable.VERSION) aus `rolldown`.

## `esbuildVersion`

**Typ:** `string`

Nur aus Gründen der Rückwärtskompatibilität erhalten.

## `rollupVersion`

**Typ:** `string`

Nur aus Gründen der Rückwärtskompatibilität erhalten.
