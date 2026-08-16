# Environment API für Frameworks

:::info Release Candidate
Die Environment API befindet sich im Wesentlichen in der Release-Candidate-Phase. Wir halten die APIs zwischen Major-Releases stabil, damit das Ökosystem damit experimentieren und darauf aufbauen kann. Beachten Sie jedoch, dass [einige bestimmte APIs](/changes/#considering) weiterhin als experimentell gelten.

Wir planen, diese neuen APIs (mit möglichen Breaking Changes) in einem künftigen Major-Release zu stabilisieren, sobald nachgelagerte Projekte Zeit hatten, mit den neuen Funktionen zu experimentieren und sie zu validieren.

Ressourcen:

- [Feedback-Diskussion](https://github.com/vitejs/vite/discussions/16358), in der wir Rückmeldungen zu den neuen APIs sammeln.
- [Environment-API-PR](https://github.com/vitejs/vite/pull/16471), in dem die neuen APIs implementiert und begutachtet wurden.

Bitte teilen Sie uns Ihr Feedback mit.
:::

## Kommunikationsebenen von DevEnvironment

Da Environments in unterschiedlichen Runtimes laufen können, kann die Kommunikation mit dem Environment je nach Runtime Einschränkungen unterliegen. Damit Frameworks leicht runtime-agnostischen Code schreiben können, bietet die Environment API drei Arten von Kommunikationsebenen.

### `RunnableDevEnvironment`

`RunnableDevEnvironment` ist ein Environment, das beliebige JavaScript-Werte mit Ihrem Anwendungscode austauschen kann. Der Import eines Moduls liefert dessen echte, lebende Exporte (Funktionen, Klasseninstanzen und alle anderen Werte), sodass Frameworks ihre Server-Entries direkt ausführen können. Das implizite `ssr`-Environment und andere Nicht-Client-Environments verwenden während der Entwicklung standardmäßig ein `RunnableDevEnvironment`. Sie können den Zugriff auf den Runner mit der Funktion `isRunnableDevEnvironment` absichern.

Sein `runner` ist ein `ModuleRunner`. Module importieren Sie darüber mit `runner.import(url)`, das ein Modul aus dem Vite-Modulgraphen holt, transformiert und auswertet (die `url` akzeptiert einen Dateipfad, einen Server-Pfad oder eine ID relativ zum Root) und das instanziierte Modul mit voller HMR-Unterstützung zurückgibt. Es ist der moderne Ersatz für `server.ssrLoadModule`, sodass Frameworks darauf migrieren können, um HMR für ihre SSR-Entwicklung zu ermöglichen.

:::info Warum es beliebige Werte austauschen kann
Ein `RunnableDevEnvironment` wertet Module in derselben Runtime wie der Vite-Server aus, sodass Werte die Grenze im selben Prozess überqueren, statt serialisiert zu werden. Genau das unterscheidet es vom [`FetchableDevEnvironment`](#fetchabledevenvironment), das nur über serialisierte `Request`/`Response`-Objekte via Fetch API kommunizieren kann. Folglich setzt die Verwendung eines `RunnableDevEnvironment` voraus, dass die Runtime des Runners dieselbe ist, in der auch der Vite-Server läuft.
:::

```ts
export class RunnableDevEnvironment extends DevEnvironment {
  public readonly runner: ModuleRunner
}

class ModuleRunner {
  /**
   * URL to execute.
   * Accepts file path, server path, or id relative to the root.
   * Returns an instantiated module (same as in ssrLoadModule)
   */
  public async import(url: string): Promise<Record<string, any>>
  /**
   * Other ModuleRunner methods...
   */
}

if (isRunnableDevEnvironment(server.environments.ssr)) {
  await server.environments.ssr.runner.import('/entry-point.js')
}
```

:::warning
Der `runner` wird erst beim ersten Zugriff verzögert ausgewertet. Beachten Sie, dass Vite beim Erzeugen des `runner` die Source-Map-Unterstützung aktiviert, indem es `process.setSourceMapsEnabled` aufruft oder – falls nicht verfügbar – `Error.prepareStackTrace` überschreibt.
:::

Ausgehend von einem Vite-Server, der wie im [SSR-Setup-Leitfaden](/guide/ssr#setting-up-the-dev-server) beschrieben im Middleware-Modus konfiguriert ist, implementieren wir die SSR-Middleware mit der Environment API. Denken Sie daran, dass es nicht `ssr` heißen muss; wir nennen es in diesem Beispiel `server`. Die Fehlerbehandlung ist ausgelassen.

```js
import fs from 'node:fs'
import path from 'node:path'
import { createServer } from 'vite'

const viteServer = await createServer({
  server: { middlewareMode: true },
  appType: 'custom',
  environments: {
    server: {
      // by default, modules are run in the same process as the vite server
    },
  },
})

// You might need to cast this to RunnableDevEnvironment in TypeScript or
// use isRunnableDevEnvironment to guard the access to the runner
const serverEnvironment = viteServer.environments.server

app.use('*', async (req, res, next) => {
  const url = req.originalUrl

  // 1. Read index.html
  const indexHtmlPath = path.resolve(import.meta.dirname, 'index.html')
  let template = fs.readFileSync(indexHtmlPath, 'utf-8')

  // 2. Apply Vite HTML transforms. This injects the Vite HMR client,
  //    and also applies HTML transforms from Vite plugins, e.g. global
  //    preambles from @vitejs/plugin-react
  template = await viteServer.transformIndexHtml(url, template)

  // 3. Load the server entry. import(url) automatically transforms
  //    ESM source code to be usable in Node.js! There is no bundling
  //    required, and provides full HMR support.
  const { render } = await serverEnvironment.runner.import(
    '/src/entry-server.js',
  )

  // 4. render the app HTML. This assumes entry-server.js's exported
  //     `render` function calls appropriate framework SSR APIs,
  //    e.g. ReactDOMServer.renderToString()
  const appHtml = await render(url)

  // 5. Inject the app-rendered HTML into the template.
  const html = template.replace(`<!--ssr-outlet-->`, appHtml)

  // 6. Send the rendered HTML back.
  res.status(200).set({ 'Content-Type': 'text/html' }).end(html)
})
```

Bei Verwendung von Environments, die HMR unterstützen (etwa `RunnableDevEnvironment`), sollten Sie für optimales Verhalten `import.meta.hot.accept()` in Ihre Server-Entry-Datei aufnehmen. Ohne dies invalidieren Änderungen an Server-Dateien den gesamten Server-Modulgraphen:

```js
// src/entry-server.js
export function render(...) { ... }

if (import.meta.hot) {
  import.meta.hot.accept()
}
```

### `FetchableDevEnvironment`

:::info

Wir sind an Feedback zum [Vorschlag für `FetchableDevEnvironment`](https://github.com/vitejs/vite/discussions/18191) interessiert.

:::

`FetchableDevEnvironment` ist ein Environment, das über die Schnittstelle der [Fetch API](https://developer.mozilla.org/en-US/docs/Web/API/Window/fetch) mit seiner Runtime kommunizieren kann. Da sich das `RunnableDevEnvironment` nur in einer begrenzten Menge von Runtimes umsetzen lässt, empfehlen wir, das `FetchableDevEnvironment` anstelle des `RunnableDevEnvironment` zu verwenden.

Ein häufiger Grund, darauf zurückzugreifen, ist ein Framework, das eine Runtime unterstützen möchte, die Vite nicht direkt ausführen kann (z. B. Cloudflare Workers). Ein `RunnableDevEnvironment` lässt sich dort nicht verwenden, da es voraussetzt, dass der Runner die Runtime des Vite-Servers teilt, damit Werte die Grenze im selben Prozess überqueren können. Sich auf die Fetch API zu stützen erlaubt es dem Framework, über alle Ziel-Runtimes hinweg einen einzigen Pfad zur Request-Verarbeitung beizubehalten: Seine Dev-Middleware reicht jeden eingehenden Browser-Request als `Request` weiter und sendet die zurückgegebene `Response` an den Browser – genau so, wie die App Requests in der Produktion verarbeitet.

Dieses Environment bietet über die Methode `handleRequest` einen standardisierten Weg zur Request-Verarbeitung:

```ts
import {
  createServer,
  createFetchableDevEnvironment,
  isFetchableDevEnvironment,
} from 'vite'

const server = await createServer({
  server: { middlewareMode: true },
  appType: 'custom',
  environments: {
    custom: {
      dev: {
        createEnvironment(name, config) {
          return createFetchableDevEnvironment(name, config, {
            handleRequest(request: Request): Promise<Response> | Response {
              // handle Request and return a Response
            },
          })
        },
      },
    },
  },
})

// Any consumer of the environment API can now call `dispatchFetch`
if (isFetchableDevEnvironment(server.environments.custom)) {
  const response: Response = await server.environments.custom.dispatchFetch(
    new Request('http://example.com/request-to-handle'),
  )
}
```

:::warning
Vite validiert Ein- und Ausgabe der Methode `dispatchFetch`: Der Request muss eine Instanz der globalen Klasse `Request` sein und die Response eine Instanz der globalen Klasse `Response`. Ist das nicht der Fall, wirft Vite einen `TypeError`.

Beachten Sie: Obwohl `FetchableDevEnvironment` als Klasse implementiert ist, betrachtet das Vite-Team dies als Implementierungsdetail, das sich jederzeit ändern kann.
:::

### Rohes `DevEnvironment`

Wenn das Environment weder das `RunnableDevEnvironment`- noch das `FetchableDevEnvironment`-Interface implementiert, müssen Sie die Kommunikation manuell einrichten.

Wenn Ihr Code in derselben Runtime laufen kann wie die Nutzermodule (er also nicht auf Node.js-spezifische APIs angewiesen ist), können Sie ein virtuelles Modul verwenden. Dieser Ansatz macht es überflüssig, aus dem Code heraus über Vites APIs auf den Wert zuzugreifen.

```ts
// code using the Vite's APIs
import { createServer } from 'vite'

const server = createServer({
  plugins: [
    // a plugin that handles `virtual:entrypoint`
    {
      name: 'virtual-module',
      /* plugin implementation */
    },
  ],
})
const ssrEnvironment = server.environment.ssr
const input = {}

// use exposed functions by each environment factories that runs the code
// check for each environment factories what they provide
if (ssrEnvironment instanceof CustomDevEnvironment) {
  ssrEnvironment.runEntrypoint('virtual:entrypoint')
} else {
  throw new Error(`Unsupported runtime for ${ssrEnvironment.name}`)
}

// -------------------------------------
// virtual:entrypoint
const { createHandler } = await import('./entrypoint.js')
const handler = createHandler(input)
const response = handler(new Request('http://example.com/'))

// -------------------------------------
// ./entrypoint.js
export function createHandler(input) {
  return function handler(req) {
    return new Response('hello')
  }
}
```

Um beispielsweise `transformIndexHtml` auf dem Nutzermodul aufzurufen, lässt sich das folgende Plugin verwenden:

```ts {13-21}
function vitePluginVirtualIndexHtml(): Plugin {
  let server: ViteDevServer | undefined
  return {
    name: vitePluginVirtualIndexHtml.name,
    configureServer(server_) {
      server = server_
    },
    resolveId(source) {
      return source === 'virtual:index-html' ? '\0' + source : undefined
    },
    async load(id) {
      if (id === '\0' + 'virtual:index-html') {
        let html: string
        if (server) {
          this.addWatchFile('index.html')
          html = fs.readFileSync('index.html', 'utf-8')
          html = await server.transformIndexHtml('/', html)
        } else {
          html = fs.readFileSync('dist/client/index.html', 'utf-8')
        }
        return `export default ${JSON.stringify(html)}`
      }
      return
    },
  }
}
```

Wenn Ihr Code Node.js-APIs benötigt, können Sie `hot.send` verwenden, um aus den Nutzermodulen heraus mit dem Code zu kommunizieren, der Vites APIs verwendet. Beachten Sie jedoch, dass dieser Ansatz nach dem Build-Prozess möglicherweise nicht auf dieselbe Weise funktioniert.

```ts
// code using the Vite's APIs
import { createServer } from 'vite'

const server = createServer({
  plugins: [
    // a plugin that handles `virtual:entrypoint`
    {
      name: 'virtual-module',
      /* plugin implementation */
    },
  ],
})
const ssrEnvironment = server.environment.ssr
const input = {}

// use exposed functions by each environment factories that runs the code
// check for each environment factories what they provide
if (ssrEnvironment instanceof RunnableDevEnvironment) {
  ssrEnvironment.runner.import('virtual:entrypoint')
} else if (ssrEnvironment instanceof CustomDevEnvironment) {
  ssrEnvironment.runEntrypoint('virtual:entrypoint')
} else {
  throw new Error(`Unsupported runtime for ${ssrEnvironment.name}`)
}

const req = new Request('http://example.com/')

const uniqueId = 'a-unique-id'
ssrEnvironment.send('request', serialize({ req, uniqueId }))
const response = await new Promise((resolve) => {
  ssrEnvironment.on('response', (data) => {
    data = deserialize(data)
    if (data.uniqueId === uniqueId) {
      resolve(data.res)
    }
  })
})

// -------------------------------------
// virtual:entrypoint
const { createHandler } = await import('./entrypoint.js')
const handler = createHandler(input)

import.meta.hot.on('request', (data) => {
  const { req, uniqueId } = deserialize(data)
  const res = handler(req)
  import.meta.hot.send('response', serialize({ res: res, uniqueId }))
})

const response = handler(new Request('http://example.com/'))

// -------------------------------------
// ./entrypoint.js
export function createHandler(input) {
  return function handler(req) {
    return new Response('hello')
  }
}
```

## Environments während des Builds

Auf der CLI bauen `vite build` und `vite build --ssr` aus Gründen der Rückwärtskompatibilität weiterhin ausschließlich das Client- bzw. ausschließlich das SSR-Environment.

Ist die Option `builder` gesetzt (auch auf ein leeres Objekt `{}`, was `vite build --app` tut), entscheidet sich `vite build` stattdessen dafür, die gesamte App zu bauen. In einem künftigen Major wird das der Standard. In diesem Modus erzeugt Vite eine `ViteBuilder`-Instanz (das Build-Zeit-Gegenstück zu einem `ViteDevServer`) und baut damit alle konfigurierten Environments für die Produktion. Standardmäßig werden Environments nacheinander gebaut, in der Reihenfolge des `environments`-Records.

### Den App-Build mit `builder.buildApp` konfigurieren

Ein Framework oder Nutzende können über die Option `builder.buildApp` steuern, wie die Environments gebaut werden. Sie erhält die `ViteBuilder`-Instanz (im folgenden Beispiel `builder` genannt) und ist dafür zuständig, jedes Environment zu bauen – etwa um einige davon parallel zu bauen:

```js [vite.config.js]
import { defineConfig } from 'vite'

export default defineConfig({
  builder: {
    buildApp: async (builder) => {
      const environments = Object.values(builder.environments)
      await Promise.all(
        environments.map((environment) => builder.build(environment)),
      )
    },
  },
})
```

### Der Plugin-Hook `buildApp`

- **Typ:** `(this: MinimalPluginContextWithoutEnvironment, builder: ViteBuilder) => Promise<void>`
- **Art:** `async`, `sequential`
- **Geltungsbereich:** [Global](/guide/api-environment-plugins#per-environment-hooks-and-global-hooks)

Neben der Konfigurationsoption `builder.buildApp` können Plugins einen `buildApp`-Hook definieren, um sich am App-Build zu beteiligen. Die Konfigurationsoption und die Plugin-Hooks laufen in einer festgelegten Reihenfolge: Zuerst laufen Hooks mit der Order `'pre'` oder `null`, dann das konfigurierte `builder.buildApp`, danach Hooks mit der Order `'post'`. Innerhalb eines Hooks verrät `environment.isBuilt`, ob ein Environment bereits gebaut wurde, sodass ein Plugin vermeiden kann, es zweimal zu bauen.

### Programmatisch bauen mit `createBuilder`

Um einen App-Build aus Ihrem eigenen Code heraus auszulösen, verwenden Sie `createBuilder` statt der eigenständigen Funktion `build`. `createBuilder` ist das Build-Zeit-Gegenstück zu `createServer`: Es löst die Konfiguration auf und gibt einen `ViteBuilder` zurück, dessen Methode `buildApp` jedes konfigurierte Environment baut. Sie können mit `builder.build(environment)` auch ein einzelnes Environment bauen.

```js [build.js]
import { createBuilder } from 'vite'

const builder = await createBuilder()
await builder.buildApp()
```

`createBuilder` löst für environment-bewusste Builds die eigenständige Funktion `build` ab. `build` funktioniert weiterhin als einfacher Einstiegspunkt für die oben beschriebenen klassischen Client-only- und SSR-only-Builds, kann aber keine beliebigen Environments bauen. `builder.buildApp()` auszuführen ist das programmatische Gegenstück zu `vite build --app`.

## Environment-agnostischer Code

Meistens ist die aktuelle `environment`-Instanz als Teil des Kontexts des ausgeführten Codes verfügbar, sodass der Zugriff über `server.environments` selten nötig sein sollte. Innerhalb von Plugin-Hooks ist das Environment beispielsweise Teil des `PluginContext` und lässt sich über `this.environment` ansprechen. Wie Sie environment-bewusste Plugins bauen, erfahren Sie unter [Environment API für Plugins](./api-environment-plugins.md).
