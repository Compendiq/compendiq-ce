# Server-Optionen

Sofern nicht anders vermerkt, gelten die Optionen in diesem Abschnitt nur für die Entwicklung.

## server.host

- **Typ:** `string | boolean`
- **Standard:** `'localhost'`

Gibt an, auf welchen IP-Adressen der Server lauschen soll.
Setzen Sie dies auf `0.0.0.0` oder `true`, um auf allen Adressen zu lauschen, einschließlich LAN- und öffentlicher Adressen.

Über die CLI lässt sich das mit `--host 0.0.0.0` oder `--host` setzen.

::: tip HINWEIS

Es gibt Fälle, in denen andere Server statt Vite antworten.

Der erste Fall tritt bei Verwendung von `localhost` auf. Node.js' [`dns.setDefaultResultOrder`](https://nodejs.org/docs/latest-v24.x/api/dns.html#dnssetdefaultresultorderorder) ändert die Reihenfolge der per DNS aufgelösten Adressen, und Browser verwenden möglicherweise eine andere aufgelöste Adresse als die, auf der Vite lauscht. Vite gibt die aufgelöste Adresse aus, wenn sie abweicht.

Der zweite Fall tritt bei Verwendung von Wildcard-Hosts (z. B. `0.0.0.0`) auf. Der Grund ist, dass Server, die auf Nicht-Wildcard-Hosts lauschen, Vorrang vor solchen haben, die auf Wildcard-Hosts lauschen.

:::

::: tip Zugriff auf den Server unter WSL2 aus Ihrem LAN

Wenn Sie Vite unter WSL2 ausführen, genügt `host: true` nicht, um aus Ihrem LAN auf den Server zuzugreifen.
Weitere Details finden Sie in [der WSL-Dokumentation](https://learn.microsoft.com/en-us/windows/wsl/networking#accessing-a-wsl-2-distribution-from-your-local-area-network-lan).

:::

## server.allowedHosts

- **Typ:** `string[] | true`
- **Standard:** `[]`

Die Hostnamen, auf die Vite antworten darf.
`localhost`, Domains unterhalb von `.localhost` sowie alle IP-Adressen sind standardmäßig erlaubt.
Bei Verwendung von HTTPS wird diese Prüfung übersprungen.

Beginnt eine Zeichenkette mit `.`, erlaubt sie diesen Hostnamen ohne den `.` sowie alle Subdomains darunter. `.example.com` erlaubt zum Beispiel `example.com`, `foo.example.com` und `foo.bar.example.com`. Bei `true` darf der Server auf Anfragen für beliebige Hosts antworten.

::: details Welche Hosts können gefahrlos hinzugefügt werden?

Hosts, bei denen Sie kontrollieren, auf welche IP-Adressen sie auflösen, können gefahrlos in die Liste der erlaubten Hosts aufgenommen werden.

Wenn Ihnen zum Beispiel die Domain `vite.dev` gehört, können Sie `vite.dev` und `.vite.dev` in die Liste aufnehmen. Wenn Ihnen diese Domain nicht gehört und Sie deren Inhaber nicht vertrauen können, sollten Sie sie nicht aufnehmen.

Insbesondere sollten Sie niemals Top-Level-Domains wie `.com` in die Liste aufnehmen. Denn jeder kann eine Domain wie `example.com` kaufen und kontrollieren, auf welche IP-Adresse sie auflöst.

:::

::: danger

`server.allowedHosts` auf `true` zu setzen erlaubt es jeder Website, über DNS-Rebinding-Angriffe Anfragen an Ihren Dev-Server zu senden und so Ihren Quellcode und Ihre Inhalte herunterzuladen. Wir empfehlen, immer eine explizite Liste erlaubter Hosts zu verwenden. Details finden Sie unter [GHSA-vg6x-rcgg-rjx6](https://github.com/vitejs/vite/security/advisories/GHSA-vg6x-rcgg-rjx6).

:::

::: details Konfiguration über eine Umgebungsvariable
Sie können die Umgebungsvariable `__VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS` setzen, um zusätzliche erlaubte Hosts zu ergänzen. Trennen Sie mehrere Hosts mit Kommas (z. B. `host1.example.com,host2.example.com`).
:::

## server.port

- **Typ:** `number`
- **Standard:** `5173`

Gibt den Serverport an. Beachten Sie: Ist der Port bereits belegt, versucht Vite automatisch den nächsten freien Port, sodass dies möglicherweise nicht der Port ist, auf dem der Server letztlich lauscht.

## server.strictPort

- **Typ:** `boolean`

Auf `true` setzen, um bei bereits belegtem Port abzubrechen, statt automatisch den nächsten freien Port zu versuchen.

## server.https

- **Typ:** `https.ServerOptions`

Aktiviert TLS + HTTP/2. Der Wert ist ein [Options-Objekt](https://nodejs.org/api/https.html#https_https_createserver_options_requestlistener), das an `https.createServer()` übergeben wird.

Ein gültiges Zertifikat ist erforderlich. Für ein einfaches Setup können Sie [@vitejs/plugin-basic-ssl](https://github.com/vitejs/vite-plugin-basic-ssl) zu den Plugins des Projekts hinzufügen, das automatisch ein selbstsigniertes Zertifikat erzeugt und cacht. Wir empfehlen jedoch, eigene Zertifikate zu erstellen.

## server.open

- **Typ:** `boolean | string`

Öffnet die App beim Serverstart automatisch im Browser. Ist der Wert eine Zeichenkette, wird sie als Pfadname der URL verwendet. Wenn Sie den Server in einem bestimmten Browser öffnen möchten, können Sie die Umgebungsvariable `process.env.BROWSER` setzen (z. B. `firefox`). Sie können außerdem `process.env.BROWSER_ARGS` setzen, um zusätzliche Argumente zu übergeben (z. B. `--incognito`).

`BROWSER` und `BROWSER_ARGS` sind ebenfalls spezielle Umgebungsvariablen, die Sie zur Konfiguration in der `.env`-Datei setzen können. Details finden Sie beim [Paket `open`](https://github.com/sindresorhus/open#app).

**Beispiel:**

```js
export default defineConfig({
  server: {
    open: '/docs/index.html',
  },
})
```

## server.proxy

- **Typ:** `Record<string, string | ProxyOptions>`

Konfiguriert eigene Proxy-Regeln für den Dev-Server. Erwartet ein Objekt aus `{ key: options }`-Paaren. Alle Anfragen, deren Pfad mit diesem Schlüssel beginnt, werden an das angegebene Ziel weitergeleitet. Beginnt der Schlüssel mit `^`, wird er als `RegExp` interpretiert. Über die Option `configure` lässt sich auf die Proxy-Instanz zugreifen. Passt eine Anfrage auf eine der konfigurierten Proxy-Regeln, wird sie nicht von Vite transformiert.

Beachten Sie: Wenn Sie eine nicht relative [`base`](/config/shared-options.md#base) verwenden, müssen Sie jedem Schlüssel diese `base` voranstellen.

Erweitert [`http-proxy-3`](https://github.com/sagemathinc/http-proxy-3#options). Zusätzliche Optionen finden Sie [hier](https://github.com/vitejs/vite/blob/main/packages/vite/src/node/server/middlewares/proxy.ts#L13).

In manchen Fällen möchten Sie vielleicht auch den zugrundeliegenden Dev-Server konfigurieren (z. B. um eigene Middlewares zur internen [connect](https://github.com/senchalabs/connect)-App hinzuzufügen). Dazu müssen Sie ein eigenes [Plugin](/guide/using-plugins.html) schreiben und die Funktion [configureServer](/guide/api-plugin.html#configureserver) verwenden.

**Beispiel:**

```js
export default defineConfig({
  server: {
    proxy: {
      // string shorthand:
      // http://localhost:5173/foo
      //   -> http://localhost:4567/foo
      '/foo': 'http://localhost:4567',
      // with options:
      // http://localhost:5173/api/bar
      //   -> http://jsonplaceholder.typicode.com/bar
      '/api': {
        target: 'http://jsonplaceholder.typicode.com',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, ''),
      },
      // with RegExp:
      // http://localhost:5173/fallback/
      //   -> http://jsonplaceholder.typicode.com/
      '^/fallback/.*': {
        target: 'http://jsonplaceholder.typicode.com',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/fallback/, ''),
      },
      // Using the proxy instance
      '/api': {
        target: 'http://jsonplaceholder.typicode.com',
        changeOrigin: true,
        configure: (proxy, options) => {
          // proxy will be an instance of 'http-proxy-3'
        },
      },
      // Proxying websockets or socket.io:
      // ws://localhost:5173/socket.io
      //   -> ws://localhost:5174/socket.io
      // Exercise caution using `rewriteWsOrigin` as it can leave the
      // proxying open to CSRF attacks.
      '/socket.io': {
        target: 'ws://localhost:5174',
        ws: true,
        rewriteWsOrigin: true,
      },
    },
  },
})
```

## server.cors

- **Typ:** `boolean | CorsOptions`
- **Standard:** `{ origin: /^https?:\/\/(?:(?:[^:]+\.)?localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/ }` (erlaubt localhost, `127.0.0.1` und `::1`)

Konfiguriert CORS für den Dev-Server. Übergeben Sie ein [Options-Objekt](https://github.com/expressjs/cors#configuration-options), um das Verhalten feinzujustieren, oder `true`, um jede Origin zu erlauben.

::: danger

`server.cors` auf `true` zu setzen erlaubt es jeder Website, Anfragen an Ihren Dev-Server zu senden und Ihren Quellcode und Ihre Inhalte herunterzuladen. Wir empfehlen, immer eine explizite Liste erlaubter Origins zu verwenden.

:::

## server.headers

- **Typ:** `OutgoingHttpHeaders`

Gibt die Response-Header des Servers an.

## server.hmr

- **Typ:** `boolean | { overlay?: boolean }`

Deaktiviert oder konfiguriert das HMR-Verhalten.

Setzen Sie `server.hmr.overlay` auf `false`, um das Fehler-Overlay des Servers zu deaktivieren.

::: warning Veraltete Optionen

Die WebSocket-bezogenen Optionen (`protocol`, `host`, `port`, `path`, `clientPort`, `timeout`, `server`) sind veraltet. Verwenden Sie stattdessen [`server.ws`](#server-ws). Diese Optionen werden automatisch synchronisiert, sodass bestehende Konfigurationen weiterhin funktionieren.

:::

## server.ws

- **Typ:** `false | { protocol?: string, host?: string, port?: number, path?: string, timeout?: number, clientPort?: number, server?: Server }`

Konfiguriert die Optionen der WebSocket-Verbindung. Auf `false` setzen, um die WebSocket-Verbindung vollständig zu deaktivieren.

- `protocol` - WebSocket-Protokoll (`ws` oder `wss`)
- `host` - Host des WebSocket-Servers
- `port` - Port des WebSocket-Servers
- `path` - WebSocket-Pfad
- `clientPort` - Überschreibt den Port auf Clientseite, sodass Sie den WebSocket auf einem anderen Port ausliefern können als dem, auf dem der Client-Code ihn sucht
- `timeout` - Verbindungs-Timeout in Millisekunden (Standard: 30000)
- `server` - Einen eigenen HTTP-Server für WebSocket-Verbindungen verwenden

Ist `server.ws.server` definiert, verarbeitet Vite die WebSocket-Verbindungsanfragen über den angegebenen Server. Läuft Vite nicht im Middleware-Modus, versucht es, WebSocket-Verbindungsanfragen über den vorhandenen Server zu verarbeiten. Das kann hilfreich sein, wenn Sie selbstsignierte Zertifikate verwenden oder Vite über ein Netzwerk auf einem einzigen Port bereitstellen möchten.

```js
export default defineConfig({
  server: {
    ws: {
      protocol: 'wss',
      host: 'localhost',
      port: 3001,
    },
  },
})
```

Einige Beispiele finden Sie im [`vite-setup-catalogue`](https://github.com/sapphi-red/vite-setup-catalogue).

::: tip HINWEIS

Bei der Standardkonfiguration wird erwartet, dass Reverse Proxies vor Vite das Weiterleiten von WebSocket unterstützen. Kann der Vite-HMR-Client keine WebSocket-Verbindung aufbauen, fällt der Client darauf zurück, den WebSocket unter Umgehung der Reverse Proxies direkt mit dem Vite-HMR-Server zu verbinden:

```
Direct websocket connection fallback. Check out https://vite.dev/config/server-options.html#server-ws to remove the previous connection error.
```

Der Fehler, der beim Fallback im Browser erscheint, kann ignoriert werden. Um den Fehler durch direktes Umgehen der Reverse Proxies zu vermeiden, können Sie entweder:

- den Reverse Proxy so konfigurieren, dass er auch WebSocket weiterleitet
- [`server.strictPort = true`](#server-strictport) setzen und `server.ws.clientPort` auf denselben Wert wie `server.port` setzen
- `server.ws.port` auf einen anderen Wert als [`server.port`](#server-port) setzen

:::

## server.forwardConsole

- **Typ:** `boolean | { unhandledErrors?: boolean, logLevels?: ('error' | 'warn' | 'info' | 'log' | 'debug')[] }`
- **Standard:** auto (`true`, wenn ein KI-Coding-Agent anhand von [`@vercel/detect-agent`](https://www.npmjs.com/package/@vercel/detect-agent) erkannt wird, sonst `false`)

Leitet Browser-Runtime-Events während der Entwicklung an die Konsole des Vite-Servers weiter.

- `true` aktiviert die Weiterleitung nicht behandelter Fehler sowie von `console.error`- / `console.warn`-Logs.
- `unhandledErrors` steuert die Weiterleitung nicht abgefangener Exceptions und nicht behandelter Promise-Rejections.
- `logLevels` steuert, welche `console.*`-Aufrufe weitergeleitet werden.

Zum Beispiel:

```js
export default defineConfig({
  server: {
    forwardConsole: {
      unhandledErrors: true,
      logLevels: ['warn', 'error'],
    },
  },
})
```

Werden nicht behandelte Fehler weitergeleitet, werden sie im Serverterminal mit erweiterter Formatierung protokolliert, zum Beispiel:

```log
1:18:38 AM [vite] (client) [Unhandled error] Error: this is test error
 > testError src/main.ts:20:8
     18|
     19| function testError() {
     20|   throw new Error('this is test error')
       |        ^
     21| }
     22|
 > HTMLButtonElement.<anonymous> src/main.ts:6:2
```

## server.warmup

- **Typ:** `{ clientFiles?: string[], ssrFiles?: string[] }`
- **Verwandt:** [Häufig verwendete Dateien vorwärmen](/guide/performance.html#warm-up-frequently-used-files)

Wärmt Dateien vor, um sie zu transformieren und die Ergebnisse im Voraus zu cachen. Das verbessert das initiale Laden der Seite beim Serverstart und verhindert Transform-Wasserfälle.

`clientFiles` sind Dateien, die nur im Client verwendet werden, `ssrFiles` solche, die nur bei SSR verwendet werden. Beide akzeptieren ein Array von Dateipfaden oder [`tinyglobby`-Mustern](https://superchupu.dev/tinyglobby/comparison) relativ zum `root`.

Fügen Sie nur häufig verwendete Dateien hinzu, um den Vite-Dev-Server beim Start nicht zu überlasten.

```js
export default defineConfig({
  server: {
    warmup: {
      clientFiles: ['./src/components/*.vue', './src/utils/big-utils.js'],
      ssrFiles: ['./src/server/modules/*.js'],
    },
  },
})
```

## server.watch

- **Typ:** `object | null`

Optionen für den Dateisystem-Watcher, die an [chokidar](https://github.com/paulmillr/chokidar/tree/3.6.0#api) weitergereicht werden.

Der Watcher des Vite-Servers beobachtet das `root` und überspringt standardmäßig die Verzeichnisse `.git/`, `node_modules/`, `test-results/` sowie Vites `cacheDir` und `build.outDir`. Wird eine beobachtete Datei aktualisiert, wendet Vite HMR an und aktualisiert die Seite nur, wenn nötig.

Ist der Wert `null`, werden keine Dateien beobachtet. [`server.watcher`](/guide/api-javascript.html#vitedevserver) stellt dann einen kompatiblen Event-Emitter bereit, aber Aufrufe von `add` oder `unwatch` haben keine Wirkung.

::: warning Dateien in `node_modules` beobachten

Derzeit ist es nicht möglich, Dateien und Pakete in `node_modules` zu beobachten. Für den weiteren Fortschritt und für Workarounds können Sie [Issue #8619](https://github.com/vitejs/vite/issues/8619) verfolgen.

:::

::: warning Vite unter Windows Subsystem for Linux (WSL) 2 verwenden

Wenn Sie Vite unter WSL2 ausführen, funktioniert die Dateisystem-Beobachtung nicht, wenn eine Datei von Windows-Anwendungen (also von einem Nicht-WSL2-Prozess) bearbeitet wird. Das liegt an [einer Einschränkung von WSL2](https://github.com/microsoft/WSL/issues/4739). Das gilt auch beim Betrieb unter Docker mit WSL2-Backend.

Zur Behebung können Sie entweder:

- **Empfohlen**: WSL2-Anwendungen zum Bearbeiten Ihrer Dateien verwenden.
  - Außerdem empfiehlt es sich, den Projektordner außerhalb eines Windows-Dateisystems abzulegen. Der Zugriff auf das Windows-Dateisystem aus WSL2 ist langsam. Diesen Overhead zu beseitigen verbessert die Performance.
- `{ usePolling: true }` setzen.
  - Beachten Sie, dass [`usePolling` zu hoher CPU-Auslastung führt](https://github.com/paulmillr/chokidar/tree/3.6.0#performance).

:::

## server.middlewareMode

- **Typ:** `boolean`
- **Standard:** `false`

Erzeugt den Vite-Server im Middleware-Modus.

- **Verwandt:** [appType](./shared-options#apptype), [SSR – Den Dev-Server einrichten](/guide/ssr#setting-up-the-dev-server)

- **Beispiel:**

```js twoslash
import express from 'express'
import { createServer as createViteServer } from 'vite'

async function createServer() {
  const app = express()

  // Create Vite server in middleware mode
  const vite = await createViteServer({
    server: { middlewareMode: true },
    // don't include Vite's default HTML handling middlewares
    appType: 'custom',
  })
  // Use vite's connect instance as middleware
  app.use(vite.middlewares)

  app.use('*', async (req, res) => {
    // Since `appType` is `'custom'`, should serve response here.
    // Note: if `appType` is `'spa'` or `'mpa'`, Vite includes middlewares
    // to handle HTML requests and 404s so user middlewares should be added
    // before Vite's middlewares to take effect instead
  })
}

createServer()
```

## server.fs.strict

- **Typ:** `boolean`
- **Standard:** `true` (seit Vite 2.7 standardmäßig aktiviert)

Beschränkt das Ausliefern von Dateien außerhalb des Workspace-Roots.

## server.fs.allow

- **Typ:** `string[]`

Beschränkt, welche Dateien über `/@fs/` ausgeliefert werden können. Ist `server.fs.strict` auf `true` gesetzt, führt der Zugriff auf Dateien außerhalb dieser Verzeichnisliste, die nicht aus einer erlaubten Datei importiert werden, zu einem 403.

Sowohl Verzeichnisse als auch Dateien können angegeben werden.

Vite sucht nach dem Wurzelverzeichnis des potenziellen Workspace und verwendet es als Standard. Ein gültiger Workspace erfüllt die folgenden Bedingungen, andernfalls wird auf das [Projekt-Root](/guide/#index-html-and-project-root) zurückgefallen.

- enthält das Feld `workspaces` in der `package.json`
- enthält eine der folgenden Dateien
  - `lerna.json`
  - `pnpm-workspace.yaml`

Akzeptiert einen Pfad, um ein eigenes Workspace-Root anzugeben. Das kann ein absoluter Pfad oder ein Pfad relativ zum [Projekt-Root](/guide/#index-html-and-project-root) sein. Zum Beispiel:

```js
export default defineConfig({
  server: {
    fs: {
      // Allow serving files from one level up to the project root
      allow: ['..'],
    },
  },
})
```

Ist `server.fs.allow` angegeben, wird die automatische Erkennung des Workspace-Roots deaktiviert. Um das ursprüngliche Verhalten zu erweitern, wird das Hilfsmittel `searchForWorkspaceRoot` bereitgestellt:

```js
import { defineConfig, searchForWorkspaceRoot } from 'vite'

export default defineConfig({
  server: {
    fs: {
      allow: [
        // search up for workspace root
        searchForWorkspaceRoot(process.cwd()),
        // your custom rules
        '/path/to/custom/allow_directory',
        '/path/to/custom/allow_file.demo',
      ],
    },
  },
})
```

## server.fs.deny

- **Typ:** `string[]`
- **Standard:** `['.env', '.env.*', '*.{crt,pem,key,p12,pfx,cer,der}', '.npmrc', '.yarnrc.yml', '**/.git/**']`

Blockliste für sensible Dateien, deren Auslieferung durch den Vite-Dev-Server unterbunden wird. Sie hat höhere Priorität als [`server.fs.allow`](#server-fs-allow). [picomatch-Muster](https://github.com/micromatch/picomatch#globbing-features) werden unterstützt.

::: tip HINWEIS

Diese Blockliste gilt nicht für [das Verzeichnis public](/guide/assets.md#the-public-directory). Alle Dateien im public-Verzeichnis werden ohne jede Filterung ausgeliefert, da sie beim Build direkt in das Ausgabeverzeichnis kopiert werden.

:::

::: tip HINWEIS

Der Deny-Filter wird auf die Modul-ID und auf die ID ohne Query-Parameter angewendet. Da ein Plugin in seinem load-Hook Dateien von beliebigen Orten lesen kann (einschließlich des Auflösens von Symlinks auf verbotene Pfade), kann Vite nicht garantieren, dass eine verbotene Datei nicht über einen alternativen Pfad erreichbar ist. Wenn es einen alternativen Pfad gibt, nehmen Sie ihn ebenfalls in die Deny-Liste auf.

:::

## server.origin

- **Typ:** `string`

Definiert die Origin der generierten Asset-URLs während der Entwicklung.

```js
export default defineConfig({
  server: {
    origin: 'http://127.0.0.1:8080',
  },
})
```

## server.sourcemapIgnoreList

- **Typ:** `false | (sourcePath: string, sourcemapPath: string) => boolean`
- **Standard:** `(sourcePath) => sourcePath.includes('node_modules')`

Legt fest, ob Quelldateien in der Server-Sourcemap ignoriert werden; dient dazu, die [Source-Map-Erweiterung `x_google_ignoreList`](https://developer.chrome.com/articles/x-google-ignore-list/) zu befüllen.

`server.sourcemapIgnoreList` ist das Gegenstück zu [`build.rolldownOptions.output.sourcemapIgnoreList`](https://rollupjs.org/configuration-options/#output-sourcemapignorelist) für den Dev-Server. Ein Unterschied zwischen den beiden Konfigurationsoptionen besteht darin, dass die Rollup-Funktion mit einem relativen Pfad für `sourcePath` aufgerufen wird, während `server.sourcemapIgnoreList` mit einem absoluten Pfad aufgerufen wird. Während der Entwicklung liegen bei den meisten Modulen Map und Quelle im selben Ordner, sodass der relative Pfad für `sourcePath` der Dateiname selbst ist. In diesen Fällen sind absolute Pfade bequemer.

Standardmäßig werden alle Pfade ausgeschlossen, die `node_modules` enthalten. Sie können `false` übergeben, um dieses Verhalten zu deaktivieren, oder – für volle Kontrolle – eine Funktion, die den Quellpfad und den Sourcemap-Pfad entgegennimmt und zurückgibt, ob der Quellpfad ignoriert werden soll.

```js
export default defineConfig({
  server: {
    // This is the default value, and will add all files with node_modules
    // in their paths to the ignore list.
    sourcemapIgnoreList(sourcePath, sourcemapPath) {
      return sourcePath.includes('node_modules')
    },
  },
})
```

::: tip Hinweis
[`server.sourcemapIgnoreList`](#server-sourcemapignorelist) und [`build.rolldownOptions.output.sourcemapIgnoreList`](https://rollupjs.org/configuration-options/#output-sourcemapignorelist) müssen unabhängig voneinander gesetzt werden. `server.sourcemapIgnoreList` ist eine reine Server-Konfiguration und übernimmt seinen Standardwert nicht aus den definierten Rollup-Optionen.
:::
