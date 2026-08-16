# Plugin-API

Vite-Plugins erweitern die Plugin-Schnittstelle von Rolldown um einige zusätzliche, Vite-spezifische Optionen. Dadurch können Sie ein Vite-Plugin einmal schreiben und es funktioniert sowohl im Dev- als auch im Build-Modus.

**Es empfiehlt sich, zunächst die [Plugin-Dokumentation von Rolldown](https://rolldown.rs/apis/plugin-api) durchzuarbeiten, bevor Sie die folgenden Abschnitte lesen.**

## Ein Plugin schreiben

Vite ist bestrebt, etablierte Muster von Haus aus anzubieten. Bevor Sie ein neues Plugin erstellen, prüfen Sie deshalb im [Features-Leitfaden](/guide/features), ob Ihr Bedarf bereits abgedeckt ist. Sehen Sie sich außerdem die verfügbaren Community-Plugins an, sowohl in Form eines [kompatiblen Rollup-Plugins](https://github.com/rollup/awesome) als auch als [Vite-spezifische Plugins](https://github.com/vitejs/awesome-vite#plugins).

Beim Erstellen eines Plugins können Sie es direkt in Ihrer `vite.config.js` notieren. Sie müssen dafür kein neues Paket anlegen. Sobald sich zeigt, dass ein Plugin in Ihren Projekten nützlich ist, überlegen Sie, es zu teilen, um anderen [im Ökosystem](https://chat.vite.dev) zu helfen.

::: tip
Beim Lernen, Debuggen oder Entwickeln von Plugins empfehlen wir, [vite-plugin-inspect](https://github.com/antfu/vite-plugin-inspect) in Ihr Projekt aufzunehmen. Damit können Sie den Zwischenzustand von Vite-Plugins inspizieren. Nach der Installation können Sie unter `localhost:5173/__inspect/` die Module und den Transformationsstapel Ihres Projekts betrachten. Die Installationsanleitung finden Sie in der [Dokumentation zu vite-plugin-inspect](https://github.com/antfu/vite-plugin-inspect).
![vite-plugin-inspect](../images/vite-plugin-inspect.webp)
:::

## Konventionen

Wenn das Plugin keine Vite-spezifischen Hooks verwendet und sich als [kompatibles Rolldown-Plugin](#rolldown-plugin-compatibility) umsetzen lässt, empfiehlt es sich, die [Namenskonventionen für Rolldown-Plugins](https://rolldown.rs/apis/plugin-api#conventions) zu verwenden.

- Rolldown-Plugins sollten einen klaren Namen mit dem Präfix `rolldown-plugin-` tragen.
- Nehmen Sie die Schlüsselwörter `rolldown-plugin` und `vite-plugin` in das Feld `keywords` der package.json auf.

Damit lässt sich das Plugin auch in reinen Rolldown- oder Rollup-basierten Projekten verwenden.

Für reine Vite-Plugins

- Vite-Plugins sollten einen klaren Namen mit dem Präfix `vite-plugin-` tragen.
- Nehmen Sie das Schlüsselwort `vite-plugin` in das Feld `keywords` der package.json auf.
- Nehmen Sie in die Plugin-Dokumentation einen Abschnitt auf, der erläutert, warum es sich um ein reines Vite-Plugin handelt (z. B. weil es Vite-spezifische Plugin-Hooks verwendet).

Wenn Ihr Plugin nur für ein bestimmtes Framework funktioniert, sollte dessen Name Teil des Präfixes sein.

- Präfix `vite-plugin-vue-` für Vue-Plugins
- Präfix `vite-plugin-react-` für React-Plugins
- Präfix `vite-plugin-svelte-` für Svelte-Plugins

Siehe auch [Virtual Modules Convention](https://rolldown.rs/apis/plugin-api#virtual-modules).

## Plugin-Konfiguration

Nutzer fügen Plugins den `devDependencies` des Projekts hinzu und konfigurieren sie über die Array-Option `plugins`.

```js [vite.config.js]
import vitePlugin from 'vite-plugin-feature'
import rollupPlugin from 'rollup-plugin-feature'

export default defineConfig({
  plugins: [vitePlugin(), rollupPlugin()],
})
```

Falsy-Plugins werden ignoriert; darüber lassen sich Plugins bequem aktivieren oder deaktivieren.

`plugins` akzeptiert außerdem Presets, die mehrere Plugins als ein einzelnes Element enthalten. Das ist nützlich für komplexe Funktionen (etwa Framework-Integrationen), die mit mehreren Plugins umgesetzt werden. Das Array wird intern flachgeklopft.

```js
// framework-plugin
import frameworkRefresh from 'vite-plugin-framework-refresh'
import frameworkDevtools from 'vite-plugin-framework-devtools'

export default function framework(config) {
  return [frameworkRefresh(config), frameworkDevTools(config)]
}
```

```js [vite.config.js]
import { defineConfig } from 'vite'
import framework from 'vite-plugin-framework'

export default defineConfig({
  plugins: [framework()],
})
```

## Einfache Beispiele

:::tip
Es ist gängige Konvention, ein Vite-/Rolldown-/Rollup-Plugin als Factory-Funktion zu schreiben, die das eigentliche Plugin-Objekt zurückgibt. Die Funktion kann Optionen entgegennehmen, mit denen Nutzer das Verhalten des Plugins anpassen können.
:::

### Eigene Dateitypen transformieren

```js
const fileRegex = /\.(my-file-ext)$/

export default function myPlugin() {
  return {
    name: 'transform-file',

    transform: {
      filter: {
        id: fileRegex,
      },
      handler(src, id) {
        return {
          code: compileFileToJS(src),
          map: null, // provide source map if available
        }
      },
    },
  }
}
```

### Eine virtuelle Datei importieren

Virtuelle Module erlauben es Ihnen, Informationen aus der Build-Zeit über die normale ESM-Import-Syntax an die Quelldateien zu übergeben. Die vollständige Konvention finden Sie unter [Virtual Modules Convention](https://rolldown.rs/apis/plugin-api#virtual-modules).

```js
import { exactRegex } from '@rolldown/pluginutils'

export default function myPlugin() {
  const virtualModuleId = 'virtual:my-module'
  const resolvedVirtualModuleId = '\0' + virtualModuleId

  return {
    name: 'my-plugin', // required, will show up in warnings and errors
    resolveId: {
      filter: { id: exactRegex(virtualModuleId) },
      handler() {
        return resolvedVirtualModuleId
      },
    },
    load: {
      filter: { id: exactRegex(resolvedVirtualModuleId) },
      handler() {
        return `export const msg = "from virtual module"`
      },
    },
  }
}
```

Damit lässt sich das Modul in JavaScript importieren:

```js
import { msg } from 'virtual:my-module'

console.log(msg)
```

Da `\0` in Vite kein zulässiges Zeichen in Import-URLs ist, wird eine virtuelle ID der Form `\0{id}` während der Entwicklung im Browser als `/@id/__x00__{id}` kodiert. Die ID wird vor dem Eintritt in die Plugin-Pipeline wieder dekodiert, sodass der Code der Plugin-Hooks davon nichts mitbekommt.

## Rolldown-Hooks

Während der Entwicklung erzeugt der Vite-Dev-Server einen Plugin-Container, der die [Rolldown-Build-Hooks](https://rolldown.rs/apis/plugin-api#build-hooks) genauso aufruft, wie Rolldown es tut.

Alle Rolldown-Hooks sind [Hooks pro Umgebung](/guide/api-environment-plugins#per-environment-hooks-and-global-hooks).

Die folgenden Hooks werden einmal beim Serverstart aufgerufen:

- [`options`](https://rolldown.rs/reference/Interface.Plugin#options)
- [`buildStart`](https://rolldown.rs/reference/Interface.Plugin#buildstart)

Die folgenden Hooks werden bei jeder eingehenden Modulanfrage aufgerufen:

- [`resolveId`](https://rolldown.rs/reference/Interface.Plugin#resolveid)
- [`load`](https://rolldown.rs/reference/Interface.Plugin#load)
- [`transform`](https://rolldown.rs/reference/Interface.Plugin#transform)

Diese Hooks haben außerdem einen erweiterten `options`-Parameter mit zusätzlichen, Vite-spezifischen Eigenschaften. Mehr dazu in der [SSR-Dokumentation](/guide/ssr#ssr-specific-plugin-logic).

Bei manchen `resolveId`-Aufrufen kann der Wert von `importer` ein absoluter Pfad zu einer generischen `index.html` im Wurzelverzeichnis sein, da sich der tatsächliche Importeur wegen Vites unbebündeltem Dev-Server-Muster nicht immer ableiten lässt. Für Imports, die innerhalb von Vites Auflösungspipeline behandelt werden, lässt sich der Importeur während der Import-Analysephase nachverfolgen, sodass der korrekte `importer`-Wert bereitsteht.

Die folgenden Hooks werden aufgerufen, wenn der Server geschlossen wird:

- [`buildEnd`](https://rolldown.rs/reference/Interface.Plugin#buildend)
- [`closeBundle`](https://rolldown.rs/reference/Interface.Plugin#closebundle)

Beachten Sie, dass der Hook [`moduleParsed`](https://rolldown.rs/reference/Interface.Plugin#moduleparsed) während der Entwicklung **nicht** aufgerufen wird, weil Vite aus Performancegründen auf vollständige AST-Parsings verzichtet.

[Output Generation Hooks](https://rolldown.rs/apis/plugin-api#output-generation-hooks) (außer `closeBundle`) werden während der Entwicklung **nicht** aufgerufen.

## Vite-spezifische Hooks

Vite-Plugins können außerdem Hooks bereitstellen, die Vite-spezifischen Zwecken dienen. Diese Hooks werden von Rollup ignoriert.

### `config`

- **Typ:** `(config: UserConfig, env: { mode: 'build' | 'serve', command: string, isSsrBuild?: boolean, isPreview?: boolean }) => UserConfig | null | void`
- **Art:** `async`, `sequential`
- **Geltungsbereich:** [Global](/guide/api-environment-plugins#per-environment-hooks-and-global-hooks)

  Verändert die Vite-Konfiguration, bevor sie aufgelöst wird. Der Hook erhält die rohe Nutzerkonfiguration (CLI-Optionen zusammengeführt mit der Konfigurationsdatei) sowie die aktuelle Konfigurationsumgebung, die den verwendeten `mode` und `command` offenlegt. Er kann ein Teilkonfigurationsobjekt zurückgeben, das tief in die bestehende Konfiguration eingemischt wird, oder die Konfiguration direkt verändern (falls das standardmäßige Zusammenführen nicht das gewünschte Ergebnis erzielt).

  **Beispiel:**

  ```js
  // return partial config (recommended)
  const partialConfigPlugin = () => ({
    name: 'return-partial',
    config: () => ({
      resolve: {
        alias: {
          foo: 'bar',
        },
      },
    }),
  })

  // mutate the config directly (use only when merging doesn't work)
  const mutateConfigPlugin = () => ({
    name: 'mutate-config',
    config(config, { command }) {
      if (command === 'build') {
        config.root = 'foo'
      }
    },
  })
  ```

  ::: warning Hinweis
  Nutzer-Plugins werden aufgelöst, bevor dieser Hook läuft; andere Plugins innerhalb des `config`-Hooks einzuschleusen hat daher keine Wirkung.
  :::

### `configResolved`

- **Typ:** `(config: ResolvedConfig) => void | Promise<void>`
- **Art:** `async`, `parallel`
- **Geltungsbereich:** [Global](/guide/api-environment-plugins#per-environment-hooks-and-global-hooks)

  Wird aufgerufen, nachdem die Vite-Konfiguration aufgelöst wurde. Verwenden Sie diesen Hook, um die endgültige aufgelöste Konfiguration zu lesen und zu speichern. Er ist außerdem nützlich, wenn das Plugin je nach ausgeführtem Befehl etwas anderes tun muss.

  **Beispiel:**

  ```js
  const examplePlugin = () => {
    let config

    return {
      name: 'read-config',

      configResolved(resolvedConfig) {
        // store the resolved config
        config = resolvedConfig
      },

      // use stored config in other hooks
      transform(code, id) {
        if (config.command === 'serve') {
          // dev: plugin invoked by dev server
        } else {
          // build: plugin invoked by Rollup
        }
      },
    }
  }
  ```

  Beachten Sie, dass der Wert von `command` in der Entwicklung `serve` lautet (in der CLI sind `vite`, `vite dev` und `vite serve` Aliase).

### `configureServer`

- **Typ:** `(server: ViteDevServer) => (() => void) | void | Promise<(() => void) | void>`
- **Art:** `async`, `sequential`
- **Siehe auch:** [ViteDevServer](./api-javascript#vitedevserver)
- **Geltungsbereich:** [Global](/guide/api-environment-plugins#per-environment-hooks-and-global-hooks)

  Hook zum Konfigurieren des Dev-Servers. Der häufigste Anwendungsfall ist das Hinzufügen eigener Middlewares zur internen [connect](https://github.com/senchalabs/connect)-App:

  ```js
  const myPlugin = () => ({
    name: 'configure-server',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        // custom handle request...
      })
    },
  })
  ```

  **Post-Middleware einschleusen**

  Der Hook `configureServer` wird aufgerufen, bevor die internen Middlewares installiert werden; eigene Middlewares laufen daher standardmäßig vor den internen. Wenn Sie eine Middleware **nach** den internen Middlewares einschleusen möchten, können Sie aus `configureServer` eine Funktion zurückgeben, die nach der Installation der internen Middlewares aufgerufen wird:

  ```js
  const myPlugin = () => ({
    name: 'configure-server',
    configureServer(server) {
      // return a post hook that is called after internal middlewares are
      // installed
      return () => {
        server.middlewares.use((req, res, next) => {
          // custom handle request...
        })
      }
    },
  })
  ```

  **Zugriff auf den Server speichern**

  In manchen Fällen benötigen andere Plugin-Hooks Zugriff auf die Dev-Server-Instanz (etwa auf den WebSocket-Server, den Dateisystem-Watcher oder den Modulgraphen). Dieser Hook lässt sich auch nutzen, um die Serverinstanz für den Zugriff in anderen Hooks zu speichern:

  ```js
  const myPlugin = () => {
    let server
    return {
      name: 'configure-server',
      configureServer(_server) {
        server = _server
      },
      transform(code, id) {
        if (server) {
          // use server...
        }
      },
    }
  }
  ```

  Beachten Sie, dass `configureServer` beim Produktions-Build nicht aufgerufen wird; Ihre anderen Hooks müssen daher gegen sein Fehlen abgesichert sein.

### `configurePreviewServer`

- **Typ:** `(server: PreviewServer) => (() => void) | void | Promise<(() => void) | void>`
- **Art:** `async`, `sequential`
- **Siehe auch:** [PreviewServer](./api-javascript#previewserver)
- **Geltungsbereich:** [Global](/guide/api-environment-plugins#per-environment-hooks-and-global-hooks)

  Wie [`configureServer`](/guide/api-plugin.html#configureserver), aber für den Preview-Server. Ähnlich wie `configureServer` wird auch der Hook `configurePreviewServer` aufgerufen, bevor andere Middlewares installiert werden. Wenn Sie eine Middleware **nach** den anderen Middlewares einschleusen möchten, können Sie aus `configurePreviewServer` eine Funktion zurückgeben, die nach der Installation der internen Middlewares aufgerufen wird:

  ```js
  const myPlugin = () => ({
    name: 'configure-preview-server',
    configurePreviewServer(server) {
      // return a post hook that is called after other middlewares are
      // installed
      return () => {
        server.middlewares.use((req, res, next) => {
          // custom handle request...
        })
      }
    },
  })
  ```

### `transformIndexHtml`

- **Typ:** `IndexHtmlTransformHook | { order?: 'pre' | 'post', handler: IndexHtmlTransformHook }`
- **Art:** `async`, `sequential`
- **Geltungsbereich:** [Pro Umgebung](/guide/api-environment-plugins#per-environment-hooks-and-global-hooks)

  Dedizierter Hook zum Transformieren von HTML-Einstiegsdateien wie `index.html`. Der Hook erhält den aktuellen HTML-String und einen Transformationskontext. Der Kontext legt während der Entwicklung die [`ViteDevServer`](./api-javascript#vitedevserver)-Instanz offen und beim Build das Rollup-Output-Bundle.

  Der Hook kann asynchron sein und eines der folgenden Ergebnisse zurückgeben:
  - Transformierter HTML-String
  - Ein Array von Tag-Deskriptor-Objekten (`{ tag, attrs, children }`), die in das bestehende HTML eingefügt werden. Jedes Tag kann außerdem angeben, wohin es eingefügt werden soll (Standard ist das Voranstellen in `<head>`)
  - Ein Objekt, das beides als `{ html, tags }` enthält

  Standardmäßig ist `order` `undefined`, wobei dieser Hook angewendet wird, nachdem das HTML transformiert wurde. Um ein Skript einzufügen, das die Vite-Plugin-Pipeline durchlaufen soll, wendet `order: 'pre'` den Hook vor der HTML-Verarbeitung an. `order: 'post'` wendet den Hook an, nachdem alle Hooks mit `order` gleich `undefined` angewendet wurden.

  **Einfaches Beispiel:**

  ```js
  const htmlPlugin = () => {
    return {
      name: 'html-transform',
      transformIndexHtml(html) {
        return html.replace(
          /<title>(.*?)<\/title>/,
          `<title>Title replaced!</title>`,
        )
      },
    }
  }
  ```

  **Vollständige Hook-Signatur:**

  ```ts
  type IndexHtmlTransformHook = (
    html: string,
    ctx: {
      path: string
      filename: string
      server?: ViteDevServer
      bundle?: import('rolldown').OutputBundle
      chunk?: import('rolldown').OutputChunk
      originalUrl?: string
    },
  ) =>
    IndexHtmlTransformResult | void | Promise<IndexHtmlTransformResult | void>

  type IndexHtmlTransformResult =
    | string
    | HtmlTagDescriptor[]
    | {
        html: string
        tags: HtmlTagDescriptor[]
      }

  interface HtmlTagDescriptor {
    tag: string
    /**
     * attribute values will be escaped automatically if needed
     */
    attrs?: Record<string, string | boolean>
    children?: string | HtmlTagDescriptor[]
    /**
     * default: 'head-prepend'
     */
    injectTo?: 'head' | 'body' | 'head-prepend' | 'body-prepend'
  }
  ```

  ::: warning Hinweis
  Dieser Hook wird nicht aufgerufen, wenn Sie ein Framework verwenden, das Einstiegsdateien eigenständig behandelt (zum Beispiel [SvelteKit](https://github.com/sveltejs/kit/discussions/8269#discussioncomment-4509145)).
  :::

### `handleHotUpdate`

- **Typ:** `(ctx: HmrContext) => Array<ModuleNode> | void | Promise<Array<ModuleNode> | void>`
- **Art:** `async`, `sequential`
- **Siehe auch:** [HMR-API](./api-hmr)
- **Geltungsbereich:** [Pro Umgebung](/guide/api-environment-plugins#per-environment-hooks-and-global-hooks)

  Führt eine eigene HMR-Update-Behandlung durch. Der Hook erhält ein Kontextobjekt mit folgender Signatur:

  ```ts
  interface HmrContext {
    file: string
    timestamp: number
    modules: Array<ModuleNode>
    read: () => string | Promise<string>
    server: ViteDevServer
  }
  ```

  - `modules` ist ein Array der Module, die von der geänderten Datei betroffen sind. Es ist ein Array, weil eine einzelne Datei auf mehrere ausgelieferte Module abgebildet werden kann (z. B. Vue-SFCs).

  - `read` ist eine asynchrone Lesefunktion, die den Inhalt der Datei zurückgibt. Sie wird bereitgestellt, weil auf manchen Systemen der Callback für Dateiänderungen zu früh feuert, bevor der Editor die Datei fertig geschrieben hat, sodass ein direktes `fs.readFile` leeren Inhalt zurückgeben würde. Die übergebene Lesefunktion normalisiert dieses Verhalten.

  Der Hook kann sich entscheiden:
  - Die Liste der betroffenen Module zu filtern und einzugrenzen, damit das HMR präziser wird.

  - Ein leeres Array zurückzugeben und einen vollständigen Reload durchzuführen:

    ```js
    handleHotUpdate({ server, modules, timestamp }) {
      // Invalidate modules manually
      const invalidatedModules = new Set()
      for (const mod of modules) {
        server.moduleGraph.invalidateModule(
          mod,
          invalidatedModules,
          timestamp,
          true
        )
      }
      server.ws.send({ type: 'full-reload' })
      return []
    }
    ```

  - Ein leeres Array zurückzugeben und die HMR-Behandlung vollständig selbst zu übernehmen, indem eigene Events an den Client gesendet werden:

    ```js
    handleHotUpdate({ server }) {
      server.ws.send({
        type: 'custom',
        event: 'special-update',
        data: {}
      })
      return []
    }
    ```

    Der Client-Code sollte über die [HMR-API](./api-hmr) einen passenden Handler registrieren (das könnte der `transform`-Hook desselben Plugins einschleusen):

    ```js
    if (import.meta.hot) {
      import.meta.hot.on('special-update', (data) => {
        // perform custom update
      })
    }
    ```

## Plugin-Kontext-Metadaten

Für Plugin-Hooks mit Zugriff auf den Plugin-Kontext legt Vite zusätzliche Eigenschaften auf `this.meta` offen:

- `this.meta.viteVersion`: Der aktuelle Vite-Versionsstring (z. B. `"8.0.0"`).

::: tip Rolldown-basiertes Vite erkennen

[`this.meta.rolldownVersion`](https://rolldown.rs/reference/Interface.PluginContextMeta#rolldownversion) ist nur bei Rolldown-basiertem Vite verfügbar (also Vite 8+). Damit können Sie erkennen, ob die aktuelle Vite-Instanz auf Rolldown basiert:

```ts
function versionCheckPlugin(): Plugin {
  return {
    name: 'version-check',
    buildStart() {
      if (this.meta.rolldownVersion) {
        // only do something if running on a Rolldown powered Vite
      } else {
        // do something else if running on a Rollup powered Vite
      }
    },
  }
}
```

:::

## Metadaten des Output-Bundles

Beim Build erweitert Vite die Build-Output-Objekte von Rolldown um ein Vite-spezifisches Feld `viteMetadata`.

Es ist verfügbar über:

- `RenderedChunk` (zum Beispiel in `renderChunk` und `augmentChunkHash`)
- `OutputChunk` und `OutputAsset` (zum Beispiel in `generateBundle` und `writeBundle`)

`viteMetadata` stellt bereit:

- `viteMetadata.importedCss: Set<string>`
- `viteMetadata.importedAssets: Set<string>`

Das ist nützlich beim Schreiben von Plugins, die ausgegebenes CSS und statische Assets inspizieren müssen, ohne auf [`build.manifest`](/config/build-options#build-manifest) angewiesen zu sein.

Beispiel:

```ts [vite.config.ts]
function outputMetadataPlugin(): Plugin {
  return {
    name: 'output-metadata-plugin',
    enforce: 'post',
    generateBundle(_, bundle) {
      for (const output of Object.values(bundle)) {
        const css = output.viteMetadata?.importedCss
        const assets = output.viteMetadata?.importedAssets
        if (!css?.size && !assets?.size) continue

        console.log(output.fileName, {
          css: css ? [...css] : [],
          assets: assets ? [...assets] : [],
        })
      }
    },
  }
}
```

## Reihenfolge der Plugins

Ein Vite-Plugin kann zusätzlich eine Eigenschaft `enforce` angeben (ähnlich wie webpack-Loader), um seine Anwendungsreihenfolge zu steuern. Der Wert von `enforce` kann entweder `"pre"` oder `"post"` sein. Die aufgelösten Plugins liegen dann in folgender Reihenfolge vor:

- Alias
- Nutzer-Plugins mit `enforce: 'pre'`
- Vite-Core-Plugins
- Nutzer-Plugins ohne enforce-Wert
- Vite-Build-Plugins
- Nutzer-Plugins mit `enforce: 'post'`
- Vite-Post-Build-Plugins (Minify, Manifest, Reporting)

Beachten Sie, dass dies unabhängig von der Reihenfolge der Hooks ist; diese unterliegen weiterhin ihrem [`order`-Attribut](https://rolldown.rs/reference/TypeAlias.ObjectHook#order), wie bei Rolldown-Hooks üblich.

## Bedingte Anwendung

Standardmäßig werden Plugins sowohl bei serve als auch bei build aufgerufen. Soll ein Plugin nur bedingt während serve oder build angewendet werden, nutzen Sie die Eigenschaft `apply`, um es nur bei `'build'` oder `'serve'` aufzurufen:

```js
function myPlugin() {
  return {
    name: 'build-only',
    apply: 'build', // or 'serve'
  }
}
```

Für eine feinere Steuerung lässt sich auch eine Funktion verwenden:

```js
apply(config, { command }) {
  // apply only on build but not for SSR
  return command === 'build' && !config.build.ssr
}
```

## Kompatibilität mit Rolldown-Plugins

Eine ganze Reihe von Rolldown-/Rollup-Plugins funktioniert unmittelbar als Vite-Plugin (z. B. `@rollup/plugin-alias` oder `@rollup/plugin-json`), aber nicht alle, da manche Plugin-Hooks im Kontext eines unbebündelten Dev-Servers keinen Sinn ergeben.

Grundsätzlich sollte ein Rolldown-/Rollup-Plugin als Vite-Plugin funktionieren, solange es die folgenden Kriterien erfüllt:

- Es verwendet nicht den Hook [`moduleParsed`](https://rolldown.rs/reference/Interface.Plugin#moduleparsed).
- Es verlässt sich nicht auf Rolldown-spezifische Optionen wie [`transform.inject`](https://rolldown.rs/reference/InputOptions.transform#inject)
- Es weist keine starke Kopplung zwischen Bundle-Phase-Hooks und Output-Phase-Hooks auf.

Ergibt ein Rolldown-/Rollup-Plugin nur für die Build-Phase Sinn, kann es stattdessen unter `build.rolldownOptions.plugins` angegeben werden. Es funktioniert dann genauso wie ein Vite-Plugin mit `enforce: 'post'` und `apply: 'build'`.

Sie können ein bestehendes Rolldown-/Rollup-Plugin auch um Vite-spezifische Eigenschaften erweitern:

```js [vite.config.js]
import example from 'rolldown-plugin-example'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [
    {
      ...example(),
      enforce: 'post',
      apply: 'build',
    },
  ],
})
```

## Pfadnormalisierung

Vite normalisiert Pfade beim Auflösen von IDs auf POSIX-Trennzeichen ( / ) und behält unter Windows das Laufwerk bei. Rollup hingegen lässt aufgelöste Pfade standardmäßig unangetastet, sodass aufgelöste IDs unter Windows win32-Trennzeichen ( \\ ) enthalten. Rollup-Plugins verwenden intern jedoch eine [`normalizePath`-Hilfsfunktion](https://github.com/rollup/plugins/tree/master/packages/pluginutils#normalizepath) aus `@rollup/pluginutils`, die Trennzeichen vor Vergleichen in POSIX umwandelt. Das bedeutet: Werden diese Plugins in Vite verwendet, funktionieren die Konfigurationsmuster `include` und `exclude` sowie andere ähnliche Pfadvergleiche gegen aufgelöste IDs korrekt.

Für Vite-Plugins ist es daher wichtig, Pfade vor dem Vergleich mit aufgelösten IDs zunächst auf POSIX-Trennzeichen zu normalisieren. Eine gleichwertige `normalizePath`-Hilfsfunktion wird aus dem Modul `vite` exportiert.

```js
import { normalizePath } from 'vite'

normalizePath('foo\\bar') // 'foo/bar'
normalizePath('foo/bar') // 'foo/bar'
```

## Filtern, include/exclude-Muster

Vite stellt die Funktion [`createFilter` aus `@rollup/pluginutils`](https://github.com/rollup/plugins/tree/master/packages/pluginutils#createfilter) bereit, um Vite-spezifische Plugins und Integrationen zu ermutigen, das standardisierte include/exclude-Filtermuster zu verwenden, das auch in Vite selbst zum Einsatz kommt.

### Hook-Filter

Rolldown hat eine [Hook-Filter-Funktion](https://rolldown.rs/apis/plugin-api/hook-filters) eingeführt, um den Kommunikationsaufwand zwischen der Rust- und der JavaScript-Laufzeit zu reduzieren. Damit können Plugins Muster angeben, die bestimmen, wann Hooks aufgerufen werden sollen; das verbessert die Performance, weil unnötige Hook-Aufrufe entfallen.

Das wird auch von Rollup ab 4.38.0 und Vite ab 6.3.0 unterstützt. Damit Ihr Plugin abwärtskompatibel zu älteren Versionen bleibt, führen Sie den Filter zusätzlich innerhalb der Hook-Handler aus.

```js
export default function myPlugin() {
  const jsFileRegex = /\.js$/

  return {
    name: 'my-plugin',
    // Example: only call transform for .js files
    transform: {
      filter: {
        id: jsFileRegex,
      },
      handler(code, id) {
        // Additional check for backward compatibility
        if (!jsFileRegex.test(id)) return null

        return {
          code: transformCode(code),
          map: null,
        }
      },
    },
  }
}
```

::: tip
[`@rolldown/pluginutils`](https://www.npmjs.com/package/@rolldown/pluginutils) exportiert einige Hilfsfunktionen für Hook-Filter, etwa `exactRegex` und `prefixRegex`. Sie werden der Bequemlichkeit halber auch aus `rolldown/filter` re-exportiert.
:::

## Informationen zur Chunk-Import-Map

:::info Experimentell

Diese Funktion ist experimentell und kann sich in Zukunft ändern.

:::

Wenn die Option [`build.chunkImportMap`](/config/build-options#build-chunkimportmap) aktiviert ist, verwenden die Import-Anweisungen in den erzeugten Chunks statt des Dateipfads eine eindeutige ID pro Chunk.

Um die Zuordnung von Chunk-ID zu Dateipfad zu erhalten, können Sie im Hook `generateBundle` oder `writeBundle` auf die ins Bundle ausgegebene Import-Map zugreifen. Die Import-Map trägt den Namen, der über [`build.rolldownOptions.experimental.chunkImportMap.fileName`](https://rolldown.rs/reference/InputOptions.experimental#chunkimportmap) angegeben ist (Standard ist `importmap.json`).

```ts
function accessImportMap() {
  let config: ResolvedConfig
  return {
    name: 'access-import-map',
    configResolved(resolvedConfig) {
      config = resolvedConfig
    },
    generateBundle(options, bundle) {
      const chunkImportMap =
        config.build.rolldownOptions.experimental?.chunkImportMap
      if (chunkImportMap) {
        const importMapFilename =
          typeof chunkImportMap === 'object' && chunkImportMap.fileName
            ? chunkImportMap.fileName
            : 'importmap.json'
        const importMap = bundle[importMapFilename]! as OutputAsset
        const mapping = JSON.parse(importMap.source).imports
        console.log(mapping)
        // { "./entry.hash1.js": "./entry.hash2.js" }
      }
    },
  }
}
```

## Kommunikation zwischen Client und Server

Seit Vite 2.9 stellen wir Plugins einige Hilfsmittel bereit, die die Kommunikation mit Clients erleichtern.

### Vom Server zum Client

Auf Plugin-Seite können wir mit `server.ws.send` Events an den Client senden:

```js [vite.config.js]
export default defineConfig({
  plugins: [
    {
      // ...
      configureServer(server) {
        server.ws.on('connection', () => {
          server.ws.send('my:greetings', { msg: 'hello' })
        })
      },
    },
  ],
})
```

::: tip HINWEIS
Wir empfehlen, Ihren Event-Namen **stets ein Präfix** voranzustellen, um Kollisionen mit anderen Plugins zu vermeiden.
:::

Auf Client-Seite lauschen Sie mit [`hot.on`](/guide/api-hmr.html#hot-on-event-cb) auf die Events:

```ts twoslash
import 'vite/client'
// ---cut---
// client side
if (import.meta.hot) {
  import.meta.hot.on('my:greetings', (data) => {
    console.log(data.msg) // hello
  })
}
```

### Vom Client zum Server

Um Events vom Client an den Server zu senden, können wir [`hot.send`](/guide/api-hmr.html#hot-send-event-data) verwenden:

```ts
// client side
if (import.meta.hot) {
  import.meta.hot.send('my:from-client', { msg: 'Hey!' })
}
```

Anschließend lauschen Sie serverseitig mit `server.ws.on` auf die Events:

```js [vite.config.js]
export default defineConfig({
  plugins: [
    {
      // ...
      configureServer(server) {
        server.ws.on('my:from-client', (data, client) => {
          console.log('Message from client:', data.msg) // Hey!
          // reply only to the client (if needed)
          client.send('my:ack', { msg: 'Hi! I got your message!' })
        })
      },
    },
  ],
})
```

### TypeScript für eigene Events

Intern leitet Vite den Typ eines Payloads aus dem Interface `CustomEventMap` ab; eigene Events lassen sich typisieren, indem Sie dieses Interface erweitern:

:::tip Hinweis
Achten Sie darauf, bei der Angabe von TypeScript-Deklarationsdateien die Endung `.d.ts` mit anzugeben. Andernfalls weiß TypeScript möglicherweise nicht, welche Datei das Modul erweitern soll.
:::

```ts [events.d.ts]
import 'vite/types/customEvent.d.ts'

declare module 'vite/types/customEvent.d.ts' {
  interface CustomEventMap {
    'custom:foo': { msg: string }
    // 'event-key': payload
  }
}
```

Diese Interface-Erweiterung wird von `InferCustomEventPayload<T>` genutzt, um den Payload-Typ für das Event `T` abzuleiten. Weitere Informationen dazu, wie dieses Interface verwendet wird, finden Sie in der [HMR-API-Dokumentation](./api-hmr#hmr-api).

```ts twoslash
import 'vite/client'
import type { InferCustomEventPayload } from 'vite/types/customEvent.d.ts'
declare module 'vite/types/customEvent.d.ts' {
  interface CustomEventMap {
    'custom:foo': { msg: string }
  }
}
// ---cut---
type CustomFooPayload = InferCustomEventPayload<'custom:foo'>
import.meta.hot?.on('custom:foo', (payload) => {
  // The type of payload will be { msg: string }
})
import.meta.hot?.on('unknown:event', (payload) => {
  // The type of payload will be any
})
```
