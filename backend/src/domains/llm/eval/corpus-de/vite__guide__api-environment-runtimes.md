# Environment-API für Runtimes

:::info Release Candidate
Die Environment-API befindet sich weitgehend in der Release-Candidate-Phase. Wir halten die APIs zwischen Major-Releases stabil, damit das Ökosystem damit experimentieren und darauf aufbauen kann. Beachten Sie jedoch, dass [einige bestimmte APIs](/changes/#considering) weiterhin als experimentell gelten.

Wir planen, diese neuen APIs (mit möglichen Breaking Changes) in einem künftigen Major-Release zu stabilisieren, sobald nachgelagerte Projekte Zeit hatten, mit den neuen Funktionen zu experimentieren und sie zu validieren.

Ressourcen:

- [Feedback-Diskussion](https://github.com/vitejs/vite/discussions/16358), in der wir Rückmeldungen zu den neuen APIs sammeln.
- [Environment-API-PR](https://github.com/vitejs/vite/pull/16471), in dem die neuen APIs implementiert und reviewt wurden.

Bitte teilen Sie uns Ihr Feedback mit.
:::

Diese Seite richtet sich an Runtime-Anbieter, also an Autoren, die eine JavaScript-Runtime mit Vite integrieren. Eine Runtime ist hier die JavaScript-Engine, in der transformierter Code ausgeführt wird, etwa Node.js, der Browser, Cloudflares workerd oder ein Worker-Thread. Ein Runtime-Anbieter paketiert die Integration für eine dieser Runtimes, sodass Framework-Autoren und Endnutzer (die Entwickler, die eine App bauen) sie nicht selbst einrichten müssen.

## Environment-Factories

Environment-Factories sind dazu gedacht, von Runtime-Anbietern implementiert zu werden, nicht von Endnutzern. Environment-Factories liefern `EnvironmentOptions` für den häufigsten Fall, in dem die Ziel-Runtime sowohl für Dev- als auch für Build-Umgebungen verwendet wird. Die Standardoptionen der Umgebung können ebenfalls gesetzt werden, sodass der Nutzer das nicht tun muss.

```ts
function createWorkerdEnvironment(
  userConfig: EnvironmentOptions,
): EnvironmentOptions {
  return mergeConfig(
    {
      resolve: {
        conditions: [/*...*/],
      },
      dev: {
        createEnvironment(name, config) {
          return createWorkerdDevEnvironment(name, config, {
            hot: true,
            transport: customHotChannel(),
          })
        },
      },
      build: {
        createEnvironment(name, config) {
          return createWorkerdBuildEnvironment(name, config)
        },
      },
    },
    userConfig,
  )
}
```

Die Konfigurationsdatei kann dann so geschrieben werden:

```js
import { createWorkerdEnvironment } from 'vite-environment-workerd'

export default {
  environments: {
    ssr: createWorkerdEnvironment({
      build: {
        outDir: '/dist/ssr',
      },
    }),
    rsc: createWorkerdEnvironment({
      build: {
        outDir: '/dist/rsc',
      },
    }),
  },
}
```

und Frameworks können eine Umgebung mit der workerd-Runtime für SSR verwenden über:

```js
const ssrEnvironment = server.environments.ssr
```

## Eine neue Environment-Factory erstellen

Ein Vite-Dev-Server stellt standardmäßig zwei Umgebungen bereit: eine `client`-Umgebung und eine `ssr`-Umgebung. Die Client-Umgebung ist standardmäßig eine Browserumgebung, und der Module Runner wird umgesetzt, indem das virtuelle Modul `/@vite/client` in Client-Apps importiert wird. Die SSR-Umgebung läuft standardmäßig in derselben Node-Runtime wie der Vite-Server und erlaubt es, Anwendungsserver zum Rendern von Requests während der Entwicklung mit voller HMR-Unterstützung zu verwenden.

Der transformierte Quellcode wird Modul genannt, und die Beziehungen zwischen den in jeder Umgebung verarbeiteten Modulen werden in einem Modulgraphen festgehalten. Der transformierte Code dieser Module wird zur Ausführung an die Runtimes gesendet, die den jeweiligen Umgebungen zugeordnet sind. Wenn ein Modul in der Runtime ausgewertet wird, werden dessen importierte Module angefordert, was die Verarbeitung eines Ausschnitts des Modulgraphen auslöst.

Ein Vite Module Runner erlaubt es, beliebigen Code auszuführen, indem er ihn zuvor mit Vite-Plugins verarbeitet. Er unterscheidet sich von `server.ssrLoadModule`, weil die Runner-Implementierung vom Server entkoppelt ist. Dadurch können Bibliotheks- und Framework-Autoren ihre eigene Kommunikationsschicht zwischen dem Vite-Server und dem Runner umsetzen. Der Browser kommuniziert mit seiner zugehörigen Umgebung über den Server-WebSocket und über HTTP-Requests. Der Node Module Runner kann Module direkt per Funktionsaufruf verarbeiten, da er im selben Prozess läuft. Andere Umgebungen könnten Module ausführen, indem sie sich mit einer JS-Runtime wie workerd oder – wie bei Vitest – mit einem Worker-Thread verbinden.

```dot
digraph module_runner {
  rankdir=LR
  node [shape=box style="rounded,filled" fontname="Arial" fontsize=11 margin="0.2,0.1" fontcolor="${#3c3c43|#ffffff}" color="${#c2c2c4|#3c3f44}"]
  edge [color="${#67676c|#98989f}" fontname="Arial" fontsize=10 fontcolor="${#67676c|#98989f}"]
  bgcolor="transparent"
  compound=true

  subgraph cluster_server {
    label="Vite Dev Server (Node.js)" labeljust=l fontname="Arial" fontsize=12
    style="rounded,filled" fillcolor="${#f6f6f7|#1a1a1f}" color="${#c2c2c4|#3c3f44}"
    fontcolor="${#3c3c43|#ffffff}"

    subgraph cluster_env {
      label="DevEnvironment" labeljust=l fontname="Arial" fontsize=11
      style="rounded,filled" fillcolor="${#f2ecfc|#2c273e}" color="${#c2c2c4|#3c3f44}"
      fontcolor="${#3c3c43|#ffffff}"

      plugins [label="Plugin\nPipeline" fillcolor="${#e9eaff|#222541}"]
      mg [label="Module\nGraph" fillcolor="${#e9eaff|#222541}"]
      hot [label="HotChannel" fillcolor="${#fcf4dc|#38301a}"]

      plugins -> mg [dir=both]
      mg -> hot [style=invis]
    }
  }

  subgraph cluster_runtime {
    label="Target Runtime" labeljust=l fontname="Arial" fontsize=12
    style="rounded,filled" fillcolor="${#f0fdf4|#131b15}" color="${#c2c2c4|#3c3f44}"
    fontcolor="${#3c3c43|#ffffff}"

    subgraph cluster_runner {
      label="ModuleRunner" labeljust=l fontname="Arial" fontsize=11
      style="rounded,filled" fillcolor="${#def5ed|#15312d}" color="${#c2c2c4|#3c3f44}"
      fontcolor="${#3c3c43|#ffffff}"

      evaluator [label="Module\nEvaluator" fillcolor="${#def5ed|#15312d}"]
      transport [label="Transport" fillcolor="${#fcf4dc|#38301a}"]
    }
  }

  hot -> transport [label="HMR / Module\nfetch & invoke" dir=both style=bold color="${#6f42c1|#c8abfa}"]
}
```

Eines der Ziele dieses Features ist es, eine anpassbare API zum Verarbeiten und Ausführen von Code bereitzustellen. Nutzer können mit den bereitgestellten Primitiven neue Environment-Factories erstellen.

```ts
import { DevEnvironment, HotChannel } from 'vite'

function createWorkerdDevEnvironment(
  name: string,
  config: ResolvedConfig,
  context: DevEnvironmentContext
) {
  const connection = /* ... */
  const transport: HotChannel = {
    on: (listener) => { connection.on('message', listener) },
    send: (data) => connection.send(data),
  }

  const workerdDevEnvironment = new DevEnvironment(name, config, {
    options: {
      resolve: { conditions: ['custom'] },
      ...context.options,
    },
    hot: true,
    transport,
  })
  return workerdDevEnvironment
}
```

Standardmäßig gelten für `HotChannel`-Transporte die Einschränkungen aus `server.fs`, das heißt, es können nur Dateien innerhalb der erlaubten Verzeichnisse ausgeliefert werden. Wenn Ihr Transport nicht über das Netzwerk erreichbar ist (weil er zum Beispiel über Worker-Threads oder prozessinterne Aufrufe kommuniziert), können Sie `skipFsCheck: true` auf dem `HotChannel` setzen, um diese Einschränkungen zu umgehen.

Es gibt [mehrere Kommunikationsebenen für die `DevEnvironment`](/guide/api-environment-frameworks#devenvironment-communication-levels). Damit Frameworks leichter runtime-agnostischen Code schreiben können, empfehlen wir, die flexibelste mögliche Kommunikationsebene zu implementieren.

## `ModuleRunner`

Ein Module Runner wird in der Ziel-Runtime instanziiert. Alle APIs im nächsten Abschnitt werden aus `vite/module-runner` importiert, sofern nicht anders angegeben. Dieser Einstiegspunkt wird so leichtgewichtig wie möglich gehalten und exportiert nur das Nötigste, um Module Runner zu erstellen.

**Typsignatur:**

```ts
export class ModuleRunner {
  constructor(
    public options: ModuleRunnerOptions,
    public evaluator: ModuleEvaluator = new ESModulesEvaluator(),
    private debug?: ModuleRunnerDebugger,
  ) {}
  /**
   * URL to execute.
   * Accepts file path, server path, or id relative to the root.
   */
  public async import<T = any>(url: string): Promise<T>
  /**
   * Clear all caches including HMR listeners.
   */
  public clearCache(): void
  /**
   * Clear all caches, remove all HMR listeners, reset sourcemap support.
   * This method doesn't stop the HMR connection.
   */
  public async close(): Promise<void>
  /**
   * Returns `true` if the runner has been closed by calling `close()`.
   */
  public isClosed(): boolean
}
```

Der Module Evaluator im `ModuleRunner` ist für die Ausführung des Codes zuständig. Vite exportiert `ESModulesEvaluator` von Haus aus; er verwendet `new AsyncFunction`, um den Code auszuwerten. Sie können eine eigene Implementierung bereitstellen, wenn Ihre JavaScript-Runtime keine unsichere Auswertung unterstützt.

Der Module Runner stellt die Methode `import` bereit. Wenn der Vite-Server das HMR-Event `full-reload` auslöst, werden alle betroffenen Module erneut ausgeführt. Beachten Sie, dass der Module Runner dabei das `exports`-Objekt nicht aktualisiert (er überschreibt es); Sie müssten erneut `import` aufrufen oder das Modul erneut aus `evaluatedModules` holen, wenn Sie auf das aktuelle `exports`-Objekt angewiesen sind.

**Beispielverwendung:**

```js
import {
  ModuleRunner,
  ESModulesEvaluator,
  createNodeImportMeta,
} from 'vite/module-runner'
import { transport } from './rpc-implementation.js'

const moduleRunner = new ModuleRunner(
  {
    transport,
    createImportMeta: createNodeImportMeta, // if the module runner runs in Node.js
  },
  new ESModulesEvaluator(),
)

await moduleRunner.import('/src/entry-point.js')
```

## `ModuleRunnerOptions`

```ts twoslash
import type {
  InterceptorOptions as InterceptorOptionsRaw,
  ModuleRunnerHmr as ModuleRunnerHmrRaw,
  EvaluatedModules,
} from 'vite/module-runner'
import type { Debug } from '@type-challenges/utils'

type InterceptorOptions = Debug<InterceptorOptionsRaw>
type ModuleRunnerHmr = Debug<ModuleRunnerHmrRaw>
/** see below */
type ModuleRunnerTransport = unknown

// ---cut---
interface ModuleRunnerOptions {
  /**
   * A set of methods to communicate with the server.
   */
  transport: ModuleRunnerTransport
  /**
   * Configure how source maps are resolved.
   * Prefers `node` if `process.setSourceMapsEnabled` is available.
   * Otherwise it will use `prepareStackTrace` by default which overrides
   * `Error.prepareStackTrace` method.
   * You can provide an object to configure how file contents and
   * source maps are resolved for files that were not processed by Vite.
   */
  sourcemapInterceptor?:
    false | 'node' | 'prepareStackTrace' | InterceptorOptions
  /**
   * Disable HMR or configure HMR options.
   *
   * @default true
   */
  hmr?: boolean | ModuleRunnerHmr
  /**
   * Custom module cache. If not provided, it creates a separate module
   * cache for each module runner instance.
   */
  evaluatedModules?: EvaluatedModules
}
```

## `ModuleEvaluator`

**Typsignatur:**

```ts twoslash
import type { ModuleRunnerContext as ModuleRunnerContextRaw } from 'vite/module-runner'
import type { Debug } from '@type-challenges/utils'

type ModuleRunnerContext = Debug<ModuleRunnerContextRaw>

// ---cut---
export interface ModuleEvaluator {
  /**
   * Number of prefixed lines in the transformed code.
   */
  startOffset?: number
  /**
   * Evaluate code that was transformed by Vite.
   * @param context Function context
   * @param code Transformed code
   * @param id ID that was used to fetch the module
   */
  runInlinedModule(
    context: ModuleRunnerContext,
    code: string,
    id: string,
  ): Promise<any>
  /**
   * evaluate externalized module.
   * @param file File URL to the external module
   */
  runExternalModule(file: string): Promise<any>
}
```

Vite exportiert standardmäßig `ESModulesEvaluator`, der dieses Interface implementiert. Er verwendet `new AsyncFunction` zur Auswertung des Codes; enthält der Code also eine eingebettete Source Map, sollte diese einen [Offset von 2 Zeilen](https://tc39.es/ecma262/#sec-createdynamicfunction) enthalten, um die hinzugefügten Zeilen auszugleichen. Der `ESModulesEvaluator` erledigt das automatisch. Eigene Evaluatoren fügen keine zusätzlichen Zeilen hinzu.

## `ModuleRunnerTransport`

**Typsignatur:**

```ts twoslash
import type { ModuleRunnerTransportHandlers } from 'vite/module-runner'
/** an object */
type HotPayload = unknown
// ---cut---
interface ModuleRunnerTransport {
  connect?(handlers: ModuleRunnerTransportHandlers): Promise<void> | void
  disconnect?(): Promise<void> | void
  send?(data: HotPayload): Promise<void> | void
  invoke?(data: HotPayload): Promise<{ result: any } | { error: any }>
  timeout?: number
}
```

Ein Transportobjekt, das über RPC oder durch direkten Funktionsaufruf mit der Umgebung kommuniziert. Ist die Methode `invoke` nicht implementiert, müssen die Methoden `send` und `connect` implementiert sein. Vite konstruiert `invoke` dann intern.

Sie müssen es mit der `HotChannel`-Instanz auf dem Server koppeln, wie in diesem Beispiel, in dem der Module Runner im Worker-Thread erzeugt wird:

::: code-group

```js [worker.js]
import { parentPort } from 'node:worker_threads'
import { fileURLToPath } from 'node:url'
import {
  ESModulesEvaluator,
  ModuleRunner,
  createNodeImportMeta,
} from 'vite/module-runner'

/** @type {import('vite/module-runner').ModuleRunnerTransport} */
const transport = {
  connect({ onMessage, onDisconnection }) {
    parentPort.on('message', onMessage)
    parentPort.on('close', onDisconnection)
  },
  send(data) {
    parentPort.postMessage(data)
  },
}

const runner = new ModuleRunner(
  {
    transport,
    createImportMeta: createNodeImportMeta,
  },
  new ESModulesEvaluator(),
)
```

```js [server.js]
import { BroadcastChannel } from 'node:worker_threads'
import { createServer, DevEnvironment } from 'vite'

function createWorkerEnvironment(name, config, context) {
  const worker = new Worker('./worker.js')
  const handlerToWorkerListener = new WeakMap()
  const client = {
    send(payload: HotPayload) {
      worker.postMessage(payload)
    },
  }

  const workerHotChannel = {
    // Worker threads post messages are not exposed over the network, skip server.fs checks
    skipFsCheck: true,
    send: (data) => worker.postMessage(data),
    on: (event, handler) => {
      // client is already connected
      if (event === 'vite:client:connect') return
      if (event === 'vite:client:disconnect') {
        const listener = () => {
          handler(undefined, client)
        }
        handlerToWorkerListener.set(handler, listener)
        worker.on('exit', listener)
        return
      }

      const listener = (value) => {
        if (value.type === 'custom' && value.event === event) {
          handler(value.data, client)
        }
      }
      handlerToWorkerListener.set(handler, listener)
      worker.on('message', listener)
    },
    off: (event, handler) => {
      if (event === 'vite:client:connect') return
      if (event === 'vite:client:disconnect') {
        const listener = handlerToWorkerListener.get(handler)
        if (listener) {
          worker.off('exit', listener)
          handlerToWorkerListener.delete(handler)
        }
        return
      }

      const listener = handlerToWorkerListener.get(handler)
      if (listener) {
        worker.off('message', listener)
        handlerToWorkerListener.delete(handler)
      }
    },
  }

  return new DevEnvironment(name, config, {
    transport: workerHotChannel,
  })
}

await createServer({
  environments: {
    worker: {
      dev: {
        createEnvironment: createWorkerEnvironment,
      },
    },
  },
})
```

:::

Achten Sie darauf, die Events `vite:client:connect` / `vite:client:disconnect` in den Methoden `on` / `off` zu implementieren, sofern diese Methoden existieren. Das Event `vite:client:connect` sollte ausgelöst werden, wenn die Verbindung hergestellt ist, und das Event `vite:client:disconnect`, wenn die Verbindung geschlossen wird. Das an den Event-Handler übergebene `HotChannelClient`-Objekt muss für dieselbe Verbindung dieselbe Referenz besitzen.

Ein anderes Beispiel, das einen HTTP-Request zur Kommunikation zwischen Runner und Server verwendet:

```ts
import { ESModulesEvaluator, ModuleRunner } from 'vite/module-runner'

export const runner = new ModuleRunner(
  {
    transport: {
      async invoke(data) {
        const response = await fetch(`http://my-vite-server/invoke`, {
          method: 'POST',
          body: JSON.stringify(data),
        })
        return response.json()
      },
    },
    hmr: false, // disable HMR as HMR requires transport.connect
  },
  new ESModulesEvaluator(),
)

await runner.import('/entry.js')
```

In diesem Fall kann die Methode `handleInvoke` des `NormalizedHotChannel` verwendet werden:

```ts
const customEnvironment = new DevEnvironment(name, config, context)

server.onRequest((request: Request) => {
  const url = new URL(request.url)
  if (url.pathname === '/invoke') {
    const payload = (await request.json()) as HotPayload
    const result = customEnvironment.hot.handleInvoke(payload)
    return new Response(JSON.stringify(result))
  }
  return Response.error()
})
```

Beachten Sie jedoch, dass für HMR-Unterstützung die Methoden `send` und `connect` erforderlich sind. Die Methode `send` wird üblicherweise aufgerufen, wenn das benutzerdefinierte Event ausgelöst wird (etwa `import.meta.hot.send("my-event")`).

Für eine SSR-Umgebung, die im selben Node.js-Prozess wie der Vite-Server läuft, exportiert Vite `createServerHotChannel` als fertigen `HotChannel`:

```js
import { createServerHotChannel, DevEnvironment } from 'vite'

new DevEnvironment(name, config, {
  hot: true,
  transport: createServerHotChannel(),
})
```
