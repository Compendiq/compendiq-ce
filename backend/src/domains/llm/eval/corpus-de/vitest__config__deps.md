# deps

- **Typ:** `{ optimizer?, ... }`

Handhabung der Auflösung von Abhängigkeiten.

## deps.optimizer {#deps-optimizer}

- **Typ:** `{ ssr?, client? }`
- **Siehe auch:** [Dep Optimization Options](https://vitejs.dev/config/dep-optimization-options.html)

Aktiviert die Optimierung von Abhängigkeiten. Wenn Sie viele Tests haben, kann das deren Performance verbessern.

Wenn Vitest auf eine in `include` aufgeführte externe Bibliothek trifft, wird diese mit esbuild in eine einzelne Datei gebündelt und als komplettes Modul importiert. Das ist aus mehreren Gründen sinnvoll:

- Pakete mit vielen Imports zu importieren ist teuer. Indem wir sie in eine Datei bündeln, sparen wir viel Zeit
- Der Import von UI-Bibliotheken ist teuer, weil sie nicht dafür gedacht sind, innerhalb von Node.js zu laufen
- Ihre `alias`-Konfiguration wird jetzt auch innerhalb gebündelter Pakete berücksichtigt
- Der Code in Ihren Tests läuft näher an dem, wie er im Browser läuft

Beachten Sie, dass nur Pakete aus der Option `deps.optimizer?.[mode].include` gebündelt werden (manche Plugins füllen diese automatisch, etwa Svelte). Mehr zu den verfügbaren Optionen finden Sie in der [Vite](https://vitejs.dev/config/dep-optimization-options.html)-Dokumentation (Vitest unterstützt die Optionen `disable` und `noDiscovery` nicht). Standardmäßig verwendet Vitest `optimizer.client` für die Umgebungen `jsdom` und `happy-dom` sowie `optimizer.ssr` für die Umgebungen `node` und `edge`.

Diese Optionen erben außerdem Ihre `optimizeDeps`-Konfiguration (für Web erweitert Vitest `optimizeDeps`, für SSR `ssr.optimizeDeps`). Wenn Sie die Option `include`/`exclude` in `deps.optimizer` neu definieren, erweitert sie beim Testlauf Ihr `optimizeDeps`. Vitest entfernt automatisch dieselben Optionen aus `include`, wenn sie in `exclude` aufgeführt sind.

::: tip
Sie können Ihren Code in `node_modules` nicht zum Debuggen bearbeiten, da der Code tatsächlich in Ihrem Verzeichnis `cacheDir` bzw. `test.cache.dir` liegt. Wenn Sie mit `console.log`-Anweisungen debuggen möchten, bearbeiten Sie ihn dort direkt oder erzwingen Sie ein erneutes Bündeln mit der Option `deps.optimizer?.[mode].force`.
:::

### deps.optimizer.{mode}.enabled

- **Typ:** `boolean`
- **Standard:** `false`

Aktiviert die Optimierung von Abhängigkeiten.

## deps.client  {#deps-client}

- **Typ:** `{ transformAssets?, ... }`

Optionen, die auf externe Dateien angewendet werden, wenn die Umgebung auf `client` gesetzt ist. Standardmäßig verwenden `jsdom` und `happy-dom` die `client`-Umgebung, während die Umgebungen `node` und `edge` `ssr` nutzen; diese Optionen haben daher keine Auswirkung auf Dateien innerhalb jener Umgebungen.

Normalerweise werden Dateien in `node_modules` externalisiert, diese Optionen betreffen aber auch Dateien in [`server.deps.external`](/config/server#server-deps-external).

### deps.client.transformAssets

- **Typ:** `boolean`
- **Standard:** `true`

Ob Vitest Asset-Dateien (.png, .svg, .jpg usw.) verarbeiten und so auflösen soll, wie Vite es im Browser tut.

Dieses Modul hat einen Default-Export, der dem Pfad zum Asset entspricht, sofern keine Query angegeben ist.

::: warning
Derzeit funktioniert diese Option nur mit den Pools [`vmThreads`](/config/pool#vmthreads) und [`vmForks`](/config/pool#vmforks).
:::

### deps.client.transformCss

- **Typ:** `boolean`
- **Standard:** `true`

Ob Vitest CSS-Dateien (.css, .scss, .sass usw.) verarbeiten und so auflösen soll, wie Vite es im Browser tut.

Wenn CSS-Dateien über die [`css`](/config/css)-Optionen deaktiviert sind, unterdrückt diese Option lediglich `ERR_UNKNOWN_FILE_EXTENSION`-Fehler.

::: warning
Derzeit funktioniert diese Option nur mit den Pools [`vmThreads`](/config/pool#vmthreads) und [`vmForks`](/config/pool#vmforks).
:::

### deps.client.transformGlobPattern

- **Typ:** `RegExp | RegExp[]`
- **Standard:** `[]`

Regex-Muster, das externe Dateien erfasst, die transformiert werden sollen.

Standardmäßig werden Dateien in `node_modules` externalisiert und nicht transformiert, außer es handelt sich um CSS oder ein Asset und die entsprechende Option ist nicht deaktiviert.

::: warning
Derzeit funktioniert diese Option nur mit den Pools [`vmThreads`](/config/pool#vmthreads) und [`vmForks`](/config/pool#vmforks).
:::

## deps.interopDefault

- **Typ:** `boolean`
- **Standard:** `true`

Interpretiert den Default eines CJS-Moduls als benannte Exporte. Manche Abhängigkeiten bündeln ausschließlich CJS-Module und verwenden keine benannten Exporte, die Node.js statisch analysieren kann, wenn ein Paket per `import`-Syntax statt per `require` importiert wird. Wenn Sie solche Abhängigkeiten in einer Node-Umgebung über benannte Exporte importieren, sehen Sie diesen Fehler:

```
import { read } from 'fs-jetpack';
         ^^^^
SyntaxError: Named export 'read' not found. The requested module 'fs-jetpack' is a CommonJS module, which may not support all module.exports as named exports.
CommonJS modules can always be imported via the default export.
```

Vitest führt keine statische Analyse durch und kann nicht fehlschlagen, bevor Ihr Code läuft. Deshalb sehen Sie diesen Fehler höchstwahrscheinlich erst beim Ausführen der Tests, falls diese Funktion deaktiviert ist:

```
TypeError: createAsyncThunk is not a function
TypeError: default is not a function
```

Standardmäßig geht Vitest davon aus, dass Sie einen Bundler verwenden, um das zu umgehen, und schlägt nicht fehl. Sie können dieses Verhalten aber manuell deaktivieren, falls Ihr Code nicht verarbeitet wird.

## deps.moduleDirectories

- **Typ:** `string[]`
- **Standard:** `['node_modules']`

Eine Liste von Verzeichnissen, die als Modulverzeichnisse behandelt werden sollen. Diese Konfigurationsoption beeinflusst das Verhalten von [`vi.mock`](/api/vi#vi-mock): Wenn keine Factory angegeben ist und der Pfad des zu mockenden Objekts einem der Werte von `moduleDirectories` entspricht, versucht Vitest, den Mock aufzulösen, indem es im [root](/config/root) des Projekts nach einem `__mocks__`-Ordner sucht.

Diese Option beeinflusst außerdem, ob eine Datei beim Externalisieren von Abhängigkeiten als Modul behandelt wird. Standardmäßig importiert Vitest externe Module nativ über Node.js und umgeht dabei den Transformationsschritt von Vite.

Das Setzen dieser Option _überschreibt_ den Standardwert. Wenn Sie weiterhin in `node_modules` nach Paketen suchen möchten, nehmen Sie es zusammen mit allen anderen Angaben mit auf:

```ts
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    deps: {
      moduleDirectories: ['node_modules', path.resolve('../../packages')],
    }
  },
})
```
