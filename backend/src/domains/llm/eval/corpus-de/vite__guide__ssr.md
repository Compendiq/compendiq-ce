# Server-Side Rendering (SSR)

:::tip Hinweis
SSR bezieht sich hier speziell auf Frontend-Frameworks (zum Beispiel React, Preact, Vue und Svelte), die es unterstützen, dieselbe Anwendung in Node.js auszuführen, sie zu HTML vorzurendern und sie schließlich auf dem Client zu hydrieren. Wenn du eine Integration mit klassischen serverseitigen Frameworks suchst, sieh dir stattdessen den [Leitfaden zur Backend-Integration](./backend-integration) an.

Der folgende Leitfaden setzt außerdem voraus, dass du bereits Erfahrung mit SSR in deinem gewählten Framework hast, und konzentriert sich ausschließlich auf die Vite-spezifischen Integrationsdetails.
:::

:::warning Low-Level-API
Dies ist eine Low-Level-API, die sich an Autoren von Bibliotheken und Frameworks richtet. Wenn dein Ziel eine Anwendung ist, sieh dir zuerst die höherstufigen SSR-Plugins und -Werkzeuge im [Awesome-Vite-SSR-Abschnitt](https://github.com/vitejs/awesome-vite#ssr) an. Dennoch werden viele Anwendungen erfolgreich direkt auf der nativen Low-Level-API von Vite gebaut.

Derzeit arbeitet Vite an einer verbesserten SSR-API mit der [Environment-API](https://github.com/vitejs/vite/discussions/16358). Weitere Details findest du unter diesem Link.
:::

## Beispielprojekte

Vite bietet eingebaute Unterstützung für Server-Side Rendering (SSR). [`create-vite-extra`](https://github.com/bluwy/create-vite-extra) enthält beispielhafte SSR-Setups, die du als Referenz für diesen Leitfaden verwenden kannst:

- [Vanilla](https://github.com/bluwy/create-vite-extra/tree/master/template-ssr-vanilla)
- [Vue](https://github.com/bluwy/create-vite-extra/tree/master/template-ssr-vue)
- [React](https://github.com/bluwy/create-vite-extra/tree/master/template-ssr-react)
- [Preact](https://github.com/bluwy/create-vite-extra/tree/master/template-ssr-preact)
- [Svelte](https://github.com/bluwy/create-vite-extra/tree/master/template-ssr-svelte)
- [Solid](https://github.com/bluwy/create-vite-extra/tree/master/template-ssr-solid)

Du kannst diese Projekte auch lokal aufsetzen, indem du [`create-vite` ausführst](./index.md#scaffolding-your-first-vite-project) und unter der Framework-Option `Others > create-vite-extra` wählst.

## Struktur der Quelldateien

Eine typische SSR-Anwendung hat die folgende Quelldateistruktur:

```
- index.html
- server.js # main application server
- src/
  - main.js          # exports env-agnostic (universal) app code
  - entry-client.js  # mounts the app to a DOM element
  - entry-server.js  # renders the app using the framework's SSR API
```

Die `index.html` muss `entry-client.js` referenzieren und einen Platzhalter enthalten, an dem das servergerenderte Markup eingefügt wird:

```html [index.html]
<div id="app"><!--ssr-outlet--></div>
<script type="module" src="/src/entry-client.js"></script>
```

Du kannst statt `<!--ssr-outlet-->` jeden beliebigen Platzhalter verwenden, solange er sich präzise ersetzen lässt.

## Bedingte Logik

Wenn du bedingte Logik abhängig von SSR und Client ausführen musst, kannst du Folgendes verwenden:

```js twoslash
import 'vite/client'
// ---cut---
if (import.meta.env.SSR) {
  // ... server only logic
}
```

Das wird während des Builds statisch ersetzt und erlaubt so das Tree-Shaking ungenutzter Zweige.

## Den Dev-Server aufsetzen

Beim Bau einer SSR-App möchtest du vermutlich die volle Kontrolle über deinen Hauptserver haben und Vite von der Produktionsumgebung entkoppeln. Daher empfiehlt es sich, Vite im Middleware-Modus zu verwenden. Hier ein Beispiel mit [express](https://expressjs.com/):

```js{15-18} twoslash [server.js]
import fs from 'node:fs'
import path from 'node:path'
import express from 'express'
import { createServer as createViteServer } from 'vite'

async function createServer() {
  const app = express()

  // Create Vite server in middleware mode and configure the app type as
  // 'custom', disabling Vite's own HTML serving logic so parent server
  // can take control
  const vite = await createViteServer({
    server: { middlewareMode: true },
    appType: 'custom'
  })

  // Use vite's connect instance as middleware. If you use your own
  // express router (express.Router()), you should use router.use
  // When the server restarts (for example after the user modifies
  // vite.config.js), `vite.middlewares` is still going to be the same
  // reference (with a new internal stack of Vite and plugin-injected
  // middlewares). The following is valid even after restarts.
  app.use(vite.middlewares)

  app.use('*all', async (req, res) => {
    // serve index.html - we will tackle this next
  })

  app.listen(5173)
}

createServer()
```

Hier ist `vite` eine Instanz von [ViteDevServer](./api-javascript#vitedevserver). `vite.middlewares` ist eine [Connect](https://github.com/senchalabs/connect)-Instanz, die sich in jedem Connect-kompatiblen Node.js-Framework als Middleware einsetzen lässt.

Der nächste Schritt ist die Implementierung des `*`-Handlers, der servergerendertes HTML ausliefert:

```js twoslash [server.js]
// @noErrors
import fs from 'node:fs'
import path from 'node:path'

/** @type {import('express').Express} */
var app
/** @type {import('vite').ViteDevServer}  */
var vite

// ---cut---
app.use('*all', async (req, res, next) => {
  const url = req.originalUrl

  try {
    // 1. Read index.html
    let template = fs.readFileSync(
      path.resolve(import.meta.dirname, 'index.html'),
      'utf-8',
    )

    // 2. Apply Vite HTML transforms. This injects the Vite HMR client,
    //    and also applies HTML transforms from Vite plugins, e.g. global
    //    preambles from @vitejs/plugin-react
    template = await vite.transformIndexHtml(url, template)

    // 3. Load the server entry. ssrLoadModule automatically transforms
    //    ESM source code to be usable in Node.js! There is no bundling
    //    required, and provides efficient invalidation similar to HMR.
    const { render } = await vite.ssrLoadModule('/src/entry-server.js')

    // 4. render the app HTML. This assumes entry-server.js's exported
    //     `render` function calls appropriate framework SSR APIs,
    //    e.g. ReactDOMServer.renderToString()
    const appHtml = await render(url)

    // 5. Inject the app-rendered HTML into the template.
    const html = template.replace(`<!--ssr-outlet-->`, () => appHtml)

    // 6. Send the rendered HTML back.
    res.status(200).set({ 'Content-Type': 'text/html' }).end(html)
  } catch (e) {
    // If an error is caught, let Vite fix the stack trace so it maps back
    // to your actual source code.
    vite.ssrFixStacktrace(e)
    next(e)
  }
})
```

Auch das `dev`-Skript in `package.json` sollte so geändert werden, dass es stattdessen das Server-Skript verwendet:

```diff [package.json]
  "scripts": {
-   "dev": "vite"
+   "dev": "node server"
  }
```

## Für die Produktion bauen

Um ein SSR-Projekt für die Produktion auszuliefern, müssen wir:

1. wie gewohnt einen Client-Build erzeugen;
2. einen SSR-Build erzeugen, der sich direkt per `import()` laden lässt, sodass wir nicht den Umweg über Vites `ssrLoadModule` gehen müssen;

Unsere Skripte in `package.json` sehen dann so aus:

```json [package.json]
{
  "scripts": {
    "dev": "node server",
    "build:client": "vite build --outDir dist/client",
    "build:server": "vite build --outDir dist/server --ssr src/entry-server.js"
  }
}
```

Beachte das Flag `--ssr`, das anzeigt, dass es sich um einen SSR-Build handelt. Es sollte außerdem den SSR-Einstiegspunkt angeben.

Anschließend müssen wir in `server.js` etwas produktionsspezifische Logik ergänzen, indem wir `process.env.NODE_ENV` prüfen:

- Statt die `index.html` im Root zu lesen, verwende `dist/client/index.html` als Template, da sie die korrekten Asset-Links zum Client-Build enthält.

- Statt `await vite.ssrLoadModule('/src/entry-server.js')` verwende `import('./dist/server/entry-server.js')` (diese Datei ist das Ergebnis des SSR-Builds).

- Verschiebe die Erstellung und sämtliche Nutzung des `vite`-Dev-Servers hinter Bedingungen, die nur in der Entwicklung greifen, und ergänze dann Middlewares für statische Dateien, die Dateien aus `dist/client` ausliefern.

Ein funktionierendes Setup findest du in den [Beispielprojekten](#example-projects).

## Preload-Direktiven erzeugen

`vite build` unterstützt das Flag `--ssrManifest`, das im Build-Ausgabeverzeichnis eine `.vite/ssr-manifest.json` erzeugt:

```diff
- "build:client": "vite build --outDir dist/client",
+ "build:client": "vite build --outDir dist/client --ssrManifest",
```

Das obige Skript erzeugt nun `dist/client/.vite/ssr-manifest.json` für den Client-Build (ja, das SSR-Manifest wird aus dem Client-Build erzeugt, weil wir Modul-IDs auf Client-Dateien abbilden wollen). Das Manifest enthält Zuordnungen von Modul-IDs zu ihren zugehörigen Chunks und Asset-Dateien.

Um das Manifest zu nutzen, müssen Frameworks eine Möglichkeit bieten, die Modul-IDs der Komponenten zu sammeln, die während eines Server-Render-Aufrufs verwendet wurden.

`@vitejs/plugin-vue` unterstützt das von Haus aus und registriert die Modul-IDs der verwendeten Komponenten automatisch im zugehörigen Vue-SSR-Kontext:

```js [src/entry-server.js]
const ctx = {}
const html = await vueServerRenderer.renderToString(app, ctx)
// ctx.modules is now a Set of module IDs that were used during the render
```

Im Produktionszweig von `server.js` müssen wir das Manifest lesen und an die von `src/entry-server.js` exportierte `render`-Funktion übergeben. Damit hätten wir genug Informationen, um Preload-Direktiven für Dateien zu rendern, die von asynchronen Routen verwendet werden! Ein vollständiges Beispiel findest du im [Demo-Quellcode](https://github.com/vitejs/vite-plugin-vue/blob/main/playground/ssr-vue/src/entry-server.js). Du kannst diese Informationen auch für [103 Early Hints](https://developer.mozilla.org/en-US/docs/Web/HTTP/Status/103) nutzen.

## Pre-Rendering / SSG

Wenn die Routen und die für bestimmte Routen benötigten Daten im Voraus bekannt sind, können wir diese Routen mit derselben Logik wie beim Produktions-SSR zu statischem HTML vorrendern. Das kann auch als eine Form der Static-Site-Generation (SSG) betrachtet werden. Ein funktionierendes Beispiel findest du im [Demo-Prerender-Skript](https://github.com/vitejs/vite-plugin-vue/blob/main/playground/ssr-vue/prerender.js).

## SSR-Externals

Abhängigkeiten werden beim SSR-Betrieb standardmäßig aus dem Modulsystem der SSR-Transformation von Vite "externalisiert". Das beschleunigt sowohl Entwicklung als auch Build.

Wenn eine Abhängigkeit durch Vites Pipeline transformiert werden muss, etwa weil darin Vite-Features untranspiliert verwendet werden, kann sie zu [`ssr.noExternal`](../config/ssr-options.md#ssr-noexternal) hinzugefügt werden.

Verlinkte Abhängigkeiten werden standardmäßig nicht externalisiert, um Vites HMR nutzen zu können. Ist das nicht gewünscht, etwa um Abhängigkeiten so zu testen, als wären sie nicht verlinkt, kannst du sie zu [`ssr.external`](../config/ssr-options.md#ssr-external) hinzufügen.

:::warning Umgang mit Aliassen
Wenn du Aliasse konfiguriert hast, die ein Paket auf ein anderes umleiten, solltest du möglicherweise stattdessen die tatsächlichen `node_modules`-Pakete aliasieren, damit es auch für SSR-externalisierte Abhängigkeiten funktioniert. Sowohl [Yarn](https://classic.yarnpkg.com/en/docs/cli/add/#toc-yarn-add-alias) als auch [pnpm](https://pnpm.io/aliases/) unterstützen Aliasing über das Präfix `npm:`.
:::

## SSR-spezifische Plugin-Logik

Manche Frameworks wie Vue oder Svelte kompilieren Komponenten je nach Client oder SSR in unterschiedliche Formate. Um bedingte Transformationen zu unterstützen, übergibt Vite eine zusätzliche Eigenschaft `ssr` im `options`-Objekt der folgenden Plugin-Hooks:

- `resolveId`
- `load`
- `transform`

**Beispiel:**

```js twoslash
/** @type {() => import('vite').Plugin} */
// ---cut---
export function mySSRPlugin() {
  return {
    name: 'my-ssr',
    transform(code, id, options) {
      if (options?.ssr) {
        // perform ssr-specific transform...
      }
    },
  }
}
```

Das Options-Objekt in `load` und `transform` ist optional; Rollup nutzt dieses Objekt derzeit nicht, könnte diese Hooks aber künftig um zusätzliche Metadaten erweitern.

:::tip Hinweis
Vor Vite 2.7 wurde das den Plugin-Hooks über einen positionalen `ssr`-Parameter mitgeteilt statt über das `options`-Objekt. Alle wichtigen Frameworks und Plugins sind aktualisiert, du findest aber möglicherweise veraltete Beiträge, die die frühere API verwenden.
:::

## SSR-Target

Das Standard-Target für den SSR-Build ist eine Node-Umgebung, du kannst den Server aber auch in einem Web Worker betreiben. Die Auflösung von Paket-Einstiegspunkten unterscheidet sich je nach Plattform. Du kannst das Target auf Web Worker setzen, indem du `ssr.target` auf `'webworker'` setzt.

## SSR-Bundle

In manchen Fällen, etwa bei `webworker`-Runtimes, möchtest du deinen SSR-Build vielleicht in eine einzige JavaScript-Datei bündeln. Dieses Verhalten aktivierst du, indem du `ssr.noExternal` auf `true` setzt. Das bewirkt zweierlei:

- Alle Abhängigkeiten werden als `noExternal` behandelt
- Es wird ein Fehler geworfen, wenn Node.js-Builtins importiert werden

## SSR-Resolve-Conditions

Standardmäßig verwendet die Auflösung von Paket-Einstiegspunkten für den SSR-Build die in [`resolve.conditions`](../config/shared-options.md#resolve-conditions) gesetzten Conditions. Mit [`ssr.resolve.conditions`](../config/ssr-options.md#ssr-resolve-conditions) und [`ssr.resolve.externalConditions`](../config/ssr-options.md#ssr-resolve-externalconditions) kannst du dieses Verhalten anpassen.

## Vite-CLI

Die CLI-Kommandos `$ vite dev` und `$ vite preview` lassen sich auch für SSR-Apps verwenden. Du kannst deine SSR-Middlewares mit [`configureServer`](/guide/api-plugin#configureserver) zum Entwicklungsserver und mit [`configurePreviewServer`](/guide/api-plugin#configurepreviewserver) zum Preview-Server hinzufügen.

:::tip Hinweis
Verwende einen Post-Hook, damit deine SSR-Middleware _nach_ den Middlewares von Vite läuft.
:::
