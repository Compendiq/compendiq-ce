# `Environment`-Instanzen verwenden

:::info Release Candidate
Die Environment-API befindet sich im Wesentlichen in der Release-Candidate-Phase. Wir halten die APIs zwischen Major-Releases stabil, damit das Ökosystem damit experimentieren und darauf aufbauen kann. Beachte jedoch, dass [einige bestimmte APIs](/changes/#considering) weiterhin als experimentell gelten.

Wir planen, diese neuen APIs in einem künftigen Major-Release zu stabilisieren (mit möglichen Breaking Changes), sobald nachgelagerte Projekte Zeit hatten, mit den neuen Features zu experimentieren und sie zu validieren.

Ressourcen:

- [Feedback-Diskussion](https://github.com/vitejs/vite/discussions/16358), in der wir Rückmeldungen zu den neuen APIs sammeln.
- [Environment-API-PR](https://github.com/vitejs/vite/pull/16471), in dem die neuen APIs implementiert und überprüft wurden.

Bitte teile uns dein Feedback mit.
:::

## Auf die Environments zugreifen

Während der Entwicklung kannst du über `server.environments` auf die verfügbaren Environments eines Dev-Servers zugreifen:

```js
// create the server, or get it from the configureServer hook
const server = await createServer(/* options */)

const clientEnvironment = server.environments.client
clientEnvironment.transformRequest(url)
console.log(server.environments.ssr.moduleGraph)
```

Du kannst auf das aktuelle Environment auch aus Plugins heraus zugreifen. Weitere Details findest du unter [Environment-API für Plugins](./api-environment-plugins.md#accessing-the-current-environment-in-hooks).

## Die Klasse `DevEnvironment`

Während der Entwicklung ist jedes Environment eine Instanz der Klasse `DevEnvironment`:

```ts
class DevEnvironment {
  /**
   * Unique identifier for the environment in a Vite server.
   * By default Vite exposes 'client' and 'ssr' environments.
   */
  name: string
  /**
   * Communication channel to send and receive messages from the
   * associated module runner in the target runtime.
   */
  hot: NormalizedHotChannel
  /**
   * Graph of module nodes, with the imported relationship between
   * processed modules and the cached result of the processed code.
   */
  moduleGraph: EnvironmentModuleGraph
  /**
   * Resolved plugins for this environment, including the ones
   * created using the per-environment `create` hook
   */
  plugins: Plugin[]
  /**
   * Allows to resolve, load, and transform code through the
   * environment plugins pipeline
   */
  pluginContainer: EnvironmentPluginContainer
  /**
   * Resolved config options for this environment. Options at the server
   * global scope are taken as defaults for all environments, and can
   * be overridden (resolve conditions, external, optimizedDeps)
   */
  config: ResolvedConfig & ResolvedDevEnvironmentOptions

  constructor(
    name: string,
    config: ResolvedConfig,
    context: DevEnvironmentContext,
  )

  /**
   * Resolve the URL to an id, load it, and process the code using the
   * plugins pipeline. The module graph is also updated.
   */
  async transformRequest(url: string): Promise<TransformResult | null>

  /**
   * Register a request to be processed with low priority. This is useful
   * to avoid waterfalls. The Vite server has information about the
   * imported modules by other requests, so it can warmup the module graph
   * so the modules are already processed when they are requested.
   */
  async warmupRequest(url: string): Promise<void>

  /**
   * Called by the module runner to retrieve information about the specified
   * module. Internally calls `transformRequest` and wraps the result in the
   * format that the module runner understands.
   * This method is not meant to be called manually.
   */
  async fetchModule(
    id: string,
    importer?: string,
    options?: FetchFunctionOptions,
  ): Promise<FetchResult>
}
```

Dabei ist `DevEnvironmentContext`:

```ts
interface DevEnvironmentContext {
  hot: boolean
  transport?: HotChannel | WebSocketServer
  options?: EnvironmentOptions
  remoteRunner?: {
    inlineSourceMap?: boolean
  }
  depsOptimizer?: DepsOptimizer
}
```

und `TransformResult`:

```ts
interface TransformResult {
  code: string
  map: SourceMap | { mappings: '' } | null
  etag?: string
  deps?: string[]
  dynamicDeps?: string[]
}
```

Eine Environment-Instanz im Vite-Server erlaubt es dir, eine URL mit der Methode `environment.transformRequest(url)` zu verarbeiten. Diese Funktion nutzt die Plugin-Pipeline, um die `url` zu einer Modul-`id` aufzulösen, sie zu laden (indem sie die Datei aus dem Dateisystem liest oder über ein Plugin, das ein virtuelles Modul bereitstellt) und anschließend den Code zu transformieren. Während der Transformation des Moduls werden Imports und weitere Metadaten im Modulgraphen des Environments festgehalten, indem der entsprechende Modulknoten erzeugt oder aktualisiert wird. Ist die Verarbeitung abgeschlossen, wird auch das Transformationsergebnis im Modul gespeichert.

:::info Benennung von transformRequest
Wir verwenden in der aktuellen Fassung dieses Vorschlags `transformRequest(url)` und `warmupRequest(url)`, damit die Diskussion und das Verständnis für Nutzer, die die heutige API von Vite gewohnt sind, einfacher fällt. Vor der Veröffentlichung können wir die Gelegenheit nutzen, auch diese Namen zu überprüfen. Sie könnten zum Beispiel `environment.processModule(url)` oder `environment.loadModule(url)` heißen, angelehnt an Rollups `context.load(id)` in Plugin-Hooks. Im Moment halten wir es für besser, die aktuellen Namen beizubehalten und diese Diskussion zu vertagen.
:::

## Getrennte Modulgraphen

Jedes Environment hat einen isolierten Modulgraphen. Alle Modulgraphen haben dieselbe Signatur, sodass generische Algorithmen implementiert werden können, die den Graphen durchlaufen oder abfragen, ohne vom Environment abzuhängen. `hotUpdate` ist ein gutes Beispiel dafür. Wird eine Datei geändert, dient der Modulgraph jedes Environments dazu, die betroffenen Module zu ermitteln und HMR für jedes Environment unabhängig durchzuführen.

::: info
Vite v5 hatte einen gemischten Modulgraphen für Client und SSR. Bei einem unverarbeiteten oder invalidierten Knoten lässt sich nicht feststellen, ob er zum Client, zu SSR oder zu beiden Environments gehört. Modulknoten haben einige Eigenschaften mit Präfix, etwa `clientImportedModules` und `ssrImportedModules` (sowie `importedModules`, das die Vereinigung beider zurückgibt). `importers` enthält für jeden Modulknoten alle Importeure sowohl aus dem Client- als auch aus dem SSR-Environment. Ein Modulknoten hat außerdem `transformResult` und `ssrTransformResult`. Eine Kompatibilitätsschicht erlaubt es dem Ökosystem, vom veralteten `server.moduleGraph` zu migrieren.
:::

Jedes Modul wird durch eine Instanz von `EnvironmentModuleNode` repräsentiert. Module können im Graphen registriert sein, ohne bereits verarbeitet worden zu sein (`transformResult` wäre in diesem Fall `null`). Auch `importers` und `importedModules` werden erst nach der Verarbeitung des Moduls aktualisiert.

```ts
class EnvironmentModuleNode {
  environment: string

  url: string
  id: string | null = null
  file: string | null = null

  type: 'js' | 'css'

  importers = new Set<EnvironmentModuleNode>()
  importedModules = new Set<EnvironmentModuleNode>()
  importedBindings: Map<string, Set<string>> | null = null

  info?: ModuleInfo
  meta?: Record<string, any>
  transformResult: TransformResult | null = null

  acceptedHmrDeps = new Set<EnvironmentModuleNode>()
  acceptedHmrExports: Set<string> | null = null
  isSelfAccepting?: boolean
  lastHMRTimestamp = 0
  lastInvalidationTimestamp = 0
}
```

`environment.moduleGraph` ist eine Instanz von `EnvironmentModuleGraph`:

```ts
export class EnvironmentModuleGraph {
  environment: string

  urlToModuleMap = new Map<string, EnvironmentModuleNode>()
  idToModuleMap = new Map<string, EnvironmentModuleNode>()
  etagToModuleMap = new Map<string, EnvironmentModuleNode>()
  fileToModulesMap = new Map<string, Set<EnvironmentModuleNode>>()

  constructor(
    environment: string,
    resolveId: (url: string) => Promise<PartialResolvedId | null>,
  )

  async getModuleByUrl(
    rawUrl: string,
  ): Promise<EnvironmentModuleNode | undefined>

  getModuleById(id: string): EnvironmentModuleNode | undefined

  getModulesByFile(file: string): Set<EnvironmentModuleNode> | undefined

  onFileChange(file: string): void

  onFileDelete(file: string): void

  invalidateModule(
    mod: EnvironmentModuleNode,
    seen: Set<EnvironmentModuleNode> = new Set(),
    timestamp: number = monotonicDateNow(),
    isHmr: boolean = false,
  ): void

  invalidateAll(): void

  async ensureEntryFromUrl(
    rawUrl: string,
    setIsSelfAccepting = true,
  ): Promise<EnvironmentModuleNode>

  createFileOnlyEntry(file: string): EnvironmentModuleNode

  async resolveUrl(url: string): Promise<ResolvedUrl>

  updateModuleTransformResult(
    mod: EnvironmentModuleNode,
    result: TransformResult | null,
  ): void

  getModuleByEtag(etag: string): EnvironmentModuleNode | undefined
}
```

## `FetchResult`

Die Methode `environment.fetchModule` gibt ein `FetchResult` zurück, das vom Module Runner konsumiert werden soll. `FetchResult` ist eine Union aus `CachedFetchResult`, `ExternalFetchResult` und `ViteFetchResult`.

`CachedFetchResult` entspricht dem HTTP-Statuscode `304` (Not Modified).

```ts
export interface CachedFetchResult {
  /**
   * If the module is cached in the runner, this confirms
   * it was not invalidated on the server side.
   */
  cache: true
}
```

`ExternalFetchResult` weist den Module Runner an, das Modul über die Methode `runExternalModule` des [`ModuleEvaluator`](/guide/api-environment-runtimes#moduleevaluator) zu importieren. In diesem Fall verwendet der standardmäßige Module Evaluator das native `import` der Runtime, anstatt die Datei durch Vite zu verarbeiten.

```ts
export interface ExternalFetchResult {
  /**
   * The path to the externalized module starting with file://.
   * By default this will be imported via a dynamic "import"
   * instead of being transformed by Vite and loaded with the Vite runner.
   */
  externalize: string
  /**
   * Type of the module. Used to determine if the import statement is correct.
   * For example, if Vite needs to throw an error if a variable is not actually exported.
   */
  type: 'module' | 'commonjs' | 'builtin' | 'network'
}
```

`ViteFetchResult` liefert Informationen über das aktuelle Modul, darunter den auszuführenden `code` sowie die `id`, `file` und `url` des Moduls.

Das Feld `invalidate` weist den Module Runner an, das Modul vor der erneuten Ausführung zu invalidieren, statt es aus dem Cache auszuliefern. Das ist üblicherweise `true`, wenn ein HMR-Update ausgelöst wurde.

```ts
export interface ViteFetchResult {
  /**
   * Code that will be evaluated by the Vite runner.
   * By default this will be wrapped in an async function.
   */
  code: string
  /**
   * File path of the module on disk.
   * This will be resolved as import.meta.url/filename.
   * Will be `null` for virtual modules.
   */
  file: string | null
  /**
   * Module ID in the server module graph.
   */
  id: string
  /**
   * Module URL used in the import.
   */
  url: string
  /**
   * Invalidate module on the client side.
   */
  invalidate: boolean
}
```
