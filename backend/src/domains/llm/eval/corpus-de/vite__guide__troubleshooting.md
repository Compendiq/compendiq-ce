# Fehlerbehebung

Weitere Informationen findest du auch im [Troubleshooting-Leitfaden von Rollup](https://rollupjs.org/troubleshooting/).

Wenn die Vorschläge hier nicht helfen, stelle deine Fragen bitte in den [GitHub Discussions](https://github.com/vitejs/vite/discussions) oder im `#help`-Kanal des [Vite Land Discord](https://chat.vite.dev).

## CLI

### `Error: Cannot find module 'C:\foo\bar&baz\vite\bin\vite.js'`

Der Pfad zu deinem Projektordner enthält möglicherweise ein `&`, was mit `npm` unter Windows nicht funktioniert ([npm/cmd-shim#45](https://github.com/npm/cmd-shim/issues/45)).

Du musst entweder:

- zu einem anderen Paketmanager wechseln (z. B. `pnpm`, `yarn`)
- das `&` aus dem Pfad zu deinem Projekt entfernen

## Konfiguration

### Dieses Paket ist ESM-only

Beim Importieren eines ESM-only-Pakets per `require` tritt der folgende Fehler auf.

> Failed to resolve "foo". This package is ESM only but it was tried to load by `require`.

> Error [ERR_REQUIRE_ESM]: require() of ES Module /path/to/dependency.js from /path/to/vite.config.js not supported.
> Instead change the require of index.js in /path/to/vite.config.js to a dynamic import() which is available in all CommonJS modules.

In Node.js <=22 können ESM-Dateien standardmäßig nicht per [`require`](https://nodejs.org/docs/latest-v22.x/api/esm.html#require) geladen werden.

Auch wenn es mit [`--experimental-require-module`](https://nodejs.org/docs/latest-v22.x/api/modules.html#loading-ecmascript-modules-using-require), mit Node.js >22 oder in anderen Runtimes funktionieren mag, empfehlen wir dennoch, deine Konfiguration auf ESM umzustellen, indem du entweder:

- `"type": "module"` zur nächstgelegenen `package.json` hinzufügst
- `vite.config.js`/`vite.config.ts` in `vite.config.mjs`/`vite.config.mts` umbenennst

## Dev-Server

### Requests bleiben endlos hängen

Wenn du Linux verwendest, können Limits für Dateideskriptoren und inotify die Ursache sein. Da Vite die meisten Dateien nicht bündelt, fordern Browser möglicherweise viele Dateien an, was viele Dateideskriptoren erfordert und das Limit überschreitet.

Lösung:

- Erhöhe das Limit für Dateideskriptoren mit `ulimit`

  ```shell
  # Check current limit
  $ ulimit -Sn
  # Change limit (temporary)
  $ ulimit -Sn 10000 # You might need to change the hard limit too
  # Restart your browser
  ```

- Erhöhe die folgenden inotify-bezogenen Limits mit `sysctl`

  ```shell
  # Check current limits
  $ sysctl fs.inotify
  # Change limits (temporary)
  $ sudo sysctl fs.inotify.max_queued_events=16384
  $ sudo sysctl fs.inotify.max_user_instances=8192
  $ sudo sysctl fs.inotify.max_user_watches=524288
  ```

Wenn die obigen Schritte nicht helfen, kannst du versuchen, `DefaultLimitNOFILE=65536` als unkommentierte Konfiguration in die folgenden Dateien einzutragen:

- /etc/systemd/system.conf
- /etc/systemd/user.conf

Unter Ubuntu Linux musst du möglicherweise stattdessen die Zeile `* - nofile 65536` in die Datei `/etc/security/limits.conf` eintragen, statt die systemd-Konfigurationsdateien anzupassen.

Beachte, dass diese Einstellungen dauerhaft sind, aber ein **Neustart erforderlich** ist.

Alternativ kann ein Request scheinbar hängen bleiben, wenn der Server in einem VS-Code-Devcontainer läuft. Zur Behebung dieses Problems siehe
[Dev Containers / VS Code Port Forwarding](#dev-containers-vs-code-port-forwarding).

### Vite stürzt mit einem ENOSPC-Fehler ab

Wenn du unter Linux einen Fehler wie diesen siehst:

> Error: ENOSPC: System limit for number of file watchers reached

Das passiert, wenn du zu viele Dateien in deinem Projektverzeichnis hast (z. B. viele Bilder oder Assets) und das systemweite Limit für File-Watcher überschreitest. Linux hat ein Standardlimit von etwa 8.192 bis 10.000 File-Watchern.

Lösungsmöglichkeiten:

- Erhöhe das systemweite Limit für File-Watcher:

  ```shell
  # Check current limit
  $ cat /proc/sys/fs/inotify/max_user_watches
  # Increase limit (temporary)
  $ sudo sysctl fs.inotify.max_user_watches=524288
  # Make it permanent - add to /etc/sysctl.conf (or edit if it already exists)
  $ echo "fs.inotify.max_user_watches=524288" | sudo tee -a /etc/sysctl.conf
  $ sudo sysctl -p
  ```

- Schließe Verzeichnisse mit vielen Dateien über [`server.watch.ignored`](/config/server-options#server-watch) vom Watching aus
- Verwende Polling statt Dateisystem-Events über [`server.watch.usePolling`](/config/server-options#server-watch). Beachte, dass Polling mehr CPU-Ressourcen verbraucht

### Netzwerk-Requests laden nicht mehr

Bei Verwendung eines selbstsignierten SSL-Zertifikats ignoriert Chrome sämtliche Caching-Direktiven und lädt den Inhalt neu. Vite ist auf diese Caching-Direktiven angewiesen.

Verwende zur Lösung des Problems ein vertrauenswürdiges SSL-Zertifikat.

Siehe: [Chrome-Issue](https://bugs.chromium.org/p/chromium/issues/detail?id=110649#c8)

#### macOS

Ein vertrauenswürdiges Zertifikat kannst du über die CLI mit diesem Kommando installieren:

```
security add-trusted-cert -d -r trustRoot -k ~/Library/Keychains/login.keychain-db your-cert.cer
```

Oder indem du es in die Schlüsselbundverwaltung importierst und die Vertrauenseinstellung deines Zertifikats auf "Immer vertrauen" setzt.

### 431 Request Header Fields Too Large

Wenn der Server bzw. der WebSocket-Server einen großen HTTP-Header empfängt, wird der Request verworfen und die folgende Warnung angezeigt.

> Server responded with status code 431. See https://vite.dev/guide/troubleshooting.html#_431-request-header-fields-too-large.

Der Grund ist, dass Node.js die Größe von Request-Headern begrenzt, um [CVE-2018-12121](https://www.cve.org/CVERecord?id=CVE-2018-12121) abzuschwächen.

Um das zu vermeiden, versuche, die Größe deiner Request-Header zu reduzieren. Ist zum Beispiel das Cookie lang, lösche es. Alternativ kannst du mit [`--max-http-header-size`](https://nodejs.org/api/cli.html#--max-http-header-sizesize) die maximale Header-Größe ändern.

### Dev Containers / VS Code Port Forwarding

Wenn du einen Dev Container oder das Port-Forwarding-Feature in VS Code verwendest, musst du eventuell die Option [`server.host`](/config/server-options.md#server-host) in der Konfiguration auf `127.0.0.1` setzen, damit es funktioniert.

Der Grund ist, dass [das Port-Forwarding-Feature in VS Code kein IPv6 unterstützt](https://github.com/microsoft/vscode-remote-release/issues/7029).

Weitere Details findest du unter [#16522](https://github.com/vitejs/vite/issues/16522).

## HMR

### Vite erkennt eine Dateiänderung, aber HMR funktioniert nicht

Möglicherweise importierst du eine Datei mit abweichender Groß-/Kleinschreibung. Zum Beispiel existiert `src/foo.js` und `src/bar.js` enthält:

```js
import './Foo.js' // should be './foo.js'
```

Zugehöriges Issue: [#964](https://github.com/vitejs/vite/issues/964)

### Vite erkennt eine Dateiänderung nicht

Wenn du Vite unter WSL2 betreibst, kann Vite Dateiänderungen unter bestimmten Bedingungen nicht überwachen. Siehe [Option `server.watch`](/config/server-options.md#server-watch).

### Es erfolgt ein vollständiger Reload statt HMR

Wenn HMR weder von Vite noch von einem Plugin behandelt wird, erfolgt ein vollständiger Reload, da dies die einzige Möglichkeit ist, den Zustand zu aktualisieren.

Wird HMR zwar behandelt, liegt aber innerhalb einer zirkulären Abhängigkeit, erfolgt ebenfalls ein vollständiger Reload, um die Ausführungsreihenfolge wiederherzustellen. Versuche zur Lösung, den Zyklus aufzubrechen. Mit `vite --debug hmr` kannst du dir den Pfad der zirkulären Abhängigkeit ausgeben lassen, falls eine Dateiänderung ihn ausgelöst hat.

## Build

### Die gebaute Datei funktioniert wegen eines CORS-Fehlers nicht

Wenn die ausgegebene HTML-Datei über das `file`-Protokoll geöffnet wurde, laufen die Skripte mit folgendem Fehler nicht.

> Access to script at 'file:///foo/bar.js' from origin 'null' has been blocked by CORS policy: Cross origin requests are only supported for protocol schemes: http, data, isolated-app, chrome-extension, chrome, https, chrome-untrusted.

> Cross-Origin Request Blocked: The Same Origin Policy disallows reading the remote resource at file:///foo/bar.js. (Reason: CORS request not http).

Mehr dazu, warum das passiert, findest du unter [Reason: CORS request not HTTP - HTTP | MDN](https://developer.mozilla.org/en-US/docs/Web/HTTP/CORS/Errors/CORSRequestNotHttp).

Du musst die Datei über das `http`-Protokoll aufrufen. Am einfachsten gelingt das mit `npx vite preview`.

### Fehler "No such file or directory" wegen Groß-/Kleinschreibung

Wenn dir Fehler wie `ENOENT: no such file or directory` oder `Module not found` begegnen, liegt das häufig daran, dass dein Projekt auf einem Dateisystem ohne Beachtung der Groß-/Kleinschreibung (Windows / macOS) entwickelt, aber auf einem mit Beachtung (Linux) gebaut wurde. Achte bitte darauf, dass die Imports die korrekte Schreibweise verwenden.

### Fehler `Failed to fetch dynamically imported module`

> TypeError: Failed to fetch dynamically imported module

Dieser Fehler tritt in mehreren Fällen auf:

- Versionsversatz
- Schlechte Netzwerkbedingungen
- Browser-Erweiterungen, die Requests blockieren

#### Versionsversatz

Wenn du eine neue Version deiner Anwendung deployst, verweisen die HTML-Datei und die JS-Dateien weiterhin auf alte Chunk-Namen, die im neuen Deployment gelöscht wurden. Das passiert, wenn:

1. Benutzer eine alte Version deiner App im Browser gecacht haben
2. Du eine neue Version mit anderen Chunk-Namen deployst (durch Codeänderungen)
3. Das gecachte HTML versucht, Chunks zu laden, die nicht mehr existieren

Wenn du ein Framework verwendest, sieh zuerst in dessen Dokumentation nach — es könnte eine eingebaute Lösung für dieses Problem bieten.

Zur Lösung kannst du:

- **Alte Chunks vorübergehend behalten**: Erwäge, die Chunks des vorherigen Deployments eine Zeit lang aufzubewahren, damit Benutzer mit Cache reibungslos wechseln können.
- **Einen Service Worker verwenden**: Implementiere einen Service Worker, der alle Assets vorlädt und cacht.
- **Die dynamischen Chunks vorladen**: Beachte, dass das nicht hilft, wenn deine HTML-Datei aufgrund von `Cache-Control`-Headern vom Browser gecacht wird.
- **Einen sauberen Fallback implementieren**: Implementiere eine Fehlerbehandlung für dynamische Imports, die die Seite neu lädt, wenn Chunks fehlen. Weitere Details findest du unter [Behandlung von Ladefehlern](./build.md#load-error-handling).

#### Schlechte Netzwerkbedingungen

Dieser Fehler kann in instabilen Netzwerkumgebungen auftreten, zum Beispiel wenn der Request wegen Netzwerkfehlern oder Serverausfällen fehlschlägt.

Beachte, dass du den dynamischen Import aufgrund von Browser-Einschränkungen nicht wiederholen kannst ([whatwg/html#6768](https://github.com/whatwg/html/issues/6768)).

#### Browser-Erweiterungen, die Requests blockieren

Der Fehler kann auch auftreten, wenn Browser-Erweiterungen (etwa Werbeblocker) diesen Request blockieren.

Möglicherweise lässt sich das umgehen, indem du über [`build.rolldownOptions.output.chunkFileNames`](../config/build-options.md#build-rolldownoptions) einen anderen Chunk-Namen wählst, da solche Erweiterungen Requests häufig anhand von Dateinamen blockieren (z. B. Namen, die `ad` oder `track` enthalten).

## Optimierte Abhängigkeiten

### Veraltete vorab gebündelte Abhängigkeiten beim Verlinken auf ein lokales Paket

Der Hash-Schlüssel, mit dem optimierte Abhängigkeiten invalidiert werden, hängt vom Inhalt der Lockfile, den auf Abhängigkeiten angewendeten Patches und den Optionen in der Vite-Konfigurationsdatei ab, die das Bündeln von Node-Modulen beeinflussen. Das bedeutet, dass Vite erkennt, wenn eine Abhängigkeit über ein Feature wie [npm overrides](https://docs.npmjs.com/cli/v9/configuring-npm/package-json#overrides) überschrieben wird, und deine Abhängigkeiten beim nächsten Serverstart neu bündelt. Vite invalidiert die Abhängigkeiten jedoch nicht, wenn du ein Feature wie [npm link](https://docs.npmjs.com/cli/v9/commands/npm-link) verwendest. Falls du eine Abhängigkeit verlinkst oder die Verlinkung aufhebst, musst du die Neuoptimierung beim nächsten Serverstart mit `vite --force` erzwingen. Wir empfehlen stattdessen Overrides, die inzwischen von jedem Paketmanager unterstützt werden (siehe auch [pnpm overrides](https://pnpm.io/settings#overrides) und [yarn resolutions](https://yarnpkg.com/configuration/manifest/#resolutions)).

## Performance-Engpässe

Wenn du unter Performance-Engpässen deiner Anwendung leidest, die zu langen Ladezeiten führen, kannst du den eingebauten Node.js-Inspector zusammen mit deinem Vite-Dev-Server oder beim Bauen deiner Anwendung starten, um ein CPU-Profil zu erstellen:

::: code-group

```bash [dev server]
vite --profile --open
```

```bash [build]
vite build --profile
```

:::

::: tip Vite-Dev-Server
Sobald deine Anwendung im Browser geöffnet ist, warte einfach, bis sie fertig geladen hat, wechsle zurück ins Terminal und drücke die Taste `p` (das stoppt den Node.js-Inspector), danach die Taste `q`, um den Dev-Server zu beenden.
:::

Der Node.js-Inspector erzeugt `vite-profile-0.cpuprofile` im Root-Ordner; gehe auf https://www.speedscope.app/ und lade das CPU-Profil über die Schaltfläche `BROWSE` hoch, um das Ergebnis zu untersuchen.

Du kannst [vite-plugin-inspect](https://github.com/antfu/vite-plugin-inspect) installieren, mit dem du den Zwischenzustand von Vite-Plugins untersuchen kannst und das dir auch hilft zu erkennen, welche Plugins oder Middlewares der Engpass in deinen Anwendungen sind. Das Plugin lässt sich sowohl im Dev- als auch im Build-Modus verwenden. Weitere Details findest du in der Readme-Datei.

## Sonstiges

### Modul aus Gründen der Browser-Kompatibilität externalisiert

Wenn du ein Node.js-Modul im Browser verwendest, gibt Vite die folgende Warnung aus.

> Module "fs" has been externalized for browser compatibility. Cannot access "fs.readFile" in client code.

Der Grund ist, dass Vite Node.js-Module nicht automatisch polyfillt.

Wir empfehlen, Node.js-Module in Browser-Code zu vermeiden, um die Bundle-Größe zu reduzieren — Polyfills lassen sich aber manuell ergänzen. Wenn das Modul aus einer Drittanbieter-Bibliothek importiert wird (die für den Browser gedacht ist), ist es ratsam, das Problem der jeweiligen Bibliothek zu melden.

### Es tritt ein Syntax Error / Type Error auf

Vite kann Code, der nur im Non-Strict-Modus (Sloppy Mode) läuft, nicht verarbeiten und unterstützt ihn nicht. Der Grund ist, dass Vite ESM verwendet und innerhalb von ESM immer der [Strict Mode](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Strict_mode) gilt.

Du könntest zum Beispiel diese Fehler sehen.

> [ERROR] With statements cannot be used with the "esm" output format due to strict mode

> TypeError: Cannot create property 'foo' on boolean 'false'

Wenn solcher Code innerhalb von Abhängigkeiten verwendet wird, kannst du [`patch-package`](https://github.com/ds300/patch-package) (oder [`yarn patch`](https://yarnpkg.com/cli/patch) bzw. [`pnpm patch`](https://pnpm.io/cli/patch)) als Notausgang nutzen.

### Browser-Erweiterungen

Manche Browser-Erweiterungen (etwa Werbeblocker) können verhindern, dass der Vite-Client Requests an den Vite-Dev-Server sendet. Du siehst in diesem Fall möglicherweise einen weißen Bildschirm ohne protokollierte Fehler. Eventuell siehst du auch den folgenden Fehler:

> TypeError: Failed to fetch dynamically imported module

Versuche, die Erweiterungen zu deaktivieren, wenn du dieses Problem hast.

### Laufwerksübergreifende Verknüpfungen unter Windows

Wenn es in deinem Projekt unter Windows laufwerksübergreifende Verknüpfungen gibt, funktioniert Vite möglicherweise nicht.

Beispiele für laufwerksübergreifende Verknüpfungen sind:

- ein virtuelles Laufwerk, das per `subst`-Kommando mit einem Ordner verknüpft ist
- ein Symlink/Junction auf ein anderes Laufwerk per `mklink`-Kommando (z. B. der globale Yarn-Cache)

Zugehöriges Issue: [#10802](https://github.com/vitejs/vite/issues/10802)

### Der Default-Import gibt unerwartet ein Objekt zurück

Der Default-Import gibt bei CJS-Modulen das `module.exports`-Objekt zurück, während du vielleicht den Wert von `module.exports.default` erwartest.

Das kann Fehler wie diese verursachen:

> Element type is invalid: expected a string (for built-in components) or a class/function (for composite components) but got: object.

> foo is not a function

Weitere Details zu diesem Problem findest du in der Dokumentation von Rolldown: [Ambiguous `default` import from CJS modules - Bundling CJS | Rolldown](https://rolldown.rs/in-depth/bundling-cjs#ambiguous-default-import-from-cjs-modules).

<script setup lang="ts">
// redirect old links with hash to old version docs
if (typeof window !== "undefined") {
  const hashForOldVersion = {
    'vite-cjs-node-api-deprecated': 6
  }

  const version = hashForOldVersion[location.hash.slice(1)]
  if (version) {
    // update the scheme and the port as well so that it works in local preview (it is http and 4173 locally)
    location.href = `https://v${version}.vite.dev` + location.pathname + location.search + location.hash
  }
}
</script>
