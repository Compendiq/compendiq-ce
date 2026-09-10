# Backend-Integration

:::tip Hinweis
Wenn Sie das HTML über ein klassisches Backend (z. B. Rails, Laravel) ausliefern, aber Vite für die Auslieferung der Assets verwenden möchten, sehen Sie sich die bestehenden Integrationen in [Awesome Vite](https://github.com/vitejs/awesome-vite#integrations-with-backends) an.

Falls Sie eine eigene Integration benötigen, können Sie den Schritten in diesem Leitfaden folgen, um sie manuell einzurichten.
:::

1. Konfigurieren Sie in Ihrer Vite-Konfiguration den Einstiegspunkt und aktivieren Sie das Build-Manifest:

   ```js twoslash [vite.config.js]
   import { defineConfig } from 'vite'
   // ---cut---
   export default defineConfig({
     // overwrite default .html entry
     input: '/path/to/main.js',
     server: {
       cors: {
         // the origin you will be accessing via browser
         origin: 'http://my-backend.example.com',
       },
     },
     build: {
       // generate .vite/manifest.json in outDir
       manifest: true,
     },
   })
   ```

   Wenn Sie das [Module-Preload-Polyfill](/config/build-options.md#build-polyfillmodulepreload) nicht deaktiviert haben, müssen Sie das Polyfill zusätzlich in Ihrem Einstiegspunkt importieren

   ```js
   // add the beginning of your app entry
   import 'vite/modulepreload-polyfill'
   ```

2. Fügen Sie für die Entwicklung Folgendes in das HTML-Template Ihres Servers ein (ersetzen Sie `http://localhost:5173` durch die lokale URL, unter der Vite läuft):

   ```html
   <!-- if development -->
   <script type="module" src="http://localhost:5173/@vite/client"></script>
   <script type="module" src="http://localhost:5173/main.js"></script>
   ```

   Um Assets korrekt auszuliefern, haben Sie zwei Möglichkeiten:
   - Stellen Sie sicher, dass der Server so konfiguriert ist, dass er Anfragen nach statischen Assets an den Vite-Server weiterleitet
   - Setzen Sie [`server.origin`](/config/server-options.md#server-origin), damit generierte Asset-URLs über die URL des Backend-Servers statt über einen relativen Pfad aufgelöst werden

   Das ist nötig, damit Assets wie Bilder korrekt geladen werden.

   Beachten Sie: Wenn Sie React mit `@vitejs/plugin-react` verwenden, müssen Sie zusätzlich Folgendes vor den obigen Skripten einfügen, da das Plugin das von Ihnen ausgelieferte HTML nicht verändern kann (ersetzen Sie `http://localhost:5173` durch die lokale URL, unter der Vite läuft):

   ```html
   <script type="module">
     import RefreshRuntime from 'http://localhost:5173/@react-refresh'
     RefreshRuntime.injectIntoGlobalHook(window)
     window.$RefreshReg$ = () => {}
     window.$RefreshSig$ = () => (type) => type
     window.__vite_plugin_react_preamble_installed__ = true
   </script>
   ```

3. Für die Produktion wird nach dem Ausführen von `vite build` neben den anderen Asset-Dateien eine Datei `.vite/manifest.json` erzeugt. Eine Beispiel-Manifestdatei sieht so aus:

   ```json [.vite/manifest.json] style:max-height:400px
   {
     "_shared-B7PI925R.js": {
       "file": "assets/shared-B7PI925R.js",
       "name": "shared",
       "css": ["assets/shared-ChJ_j-JJ.css"]
     },
     "_shared-ChJ_j-JJ.css": {
       "file": "assets/shared-ChJ_j-JJ.css",
       "src": "_shared-ChJ_j-JJ.css"
     },
     "logo.svg": {
       "file": "assets/logo-BuPIv-2h.svg",
       "src": "logo.svg"
     },
     "baz.js": {
       "file": "assets/baz-B2H3sXNv.js",
       "name": "baz",
       "src": "baz.js",
       "isDynamicEntry": true
     },
     "views/bar.js": {
       "file": "assets/bar-gkvgaI9m.js",
       "name": "bar",
       "src": "views/bar.js",
       "isEntry": true,
       "imports": ["_shared-B7PI925R.js"],
       "dynamicImports": ["baz.js"]
     },
     "views/foo.js": {
       "file": "assets/foo-BRBmoGS9.js",
       "name": "foo",
       "src": "views/foo.js",
       "isEntry": true,
       "imports": ["_shared-B7PI925R.js"],
       "css": ["assets/foo-5UjPuW-k.css"]
     }
   }
   ```

   Das Manifest bildet Quelldateien auf ihre Build-Ausgaben und Abhängigkeiten ab:

   ```dot
   digraph manifest {
     rankdir=TB
     node [shape=box style="rounded,filled" fontname="Arial" fontsize=10 margin="0.2,0.1" fontcolor="${#3c3c43|#ffffff}" color="${#c2c2c4|#3c3f44}"]
     edge [color="${#67676c|#98989f}" fontname="Arial" fontsize=9 fontcolor="${#67676c|#98989f}"]
     bgcolor="transparent"

     foo [label="views/foo.js\n(entry)" fillcolor="${#e9eaff|#222541}"]
     bar [label="views/bar.js\n(entry)" fillcolor="${#e9eaff|#222541}"]
     shared [label="_shared-B7PI925R.js\n(common chunk)" fillcolor="${#f2ecfc|#2c273e}"]
     baz [label="baz.js\n(dynamic import)" fillcolor="${#fcf4dc|#38301a}"]
     foocss [label="foo.css" shape=ellipse fillcolor="${#fde4e8|#3a1d27}"]
     sharedcss [label="shared.css" shape=ellipse fillcolor="${#fde4e8|#3a1d27}"]
     logo [label="logo.svg\n(asset)" shape=ellipse fillcolor="${#def5ed|#15312d}"]

     foo -> shared [label="imports"]
     bar -> shared [label="imports"]
     bar -> baz [label="dynamicImports" style=dashed]
     foo -> foocss [label="css"]
     shared -> sharedcss [label="css"]
   }
   ```

   Das Manifest hat die Struktur `Record<name, chunk>`, wobei jeder Chunk dem Interface `ManifestChunk` folgt:

   ```ts style:max-height:400px
   interface ManifestChunk {
     /**
      * The input file name of this chunk / asset if known
      */
     src?: string
     /**
      * The output file name of this chunk / asset
      */
     file: string
     /**
      * The list of CSS files imported by this chunk
      */
     css?: string[]
     /**
      * The list of asset files imported by this chunk, excluding CSS files
      */
     assets?: string[]
     /**
      * Whether this chunk or asset is an entry point
      */
     isEntry?: boolean
     /**
      * The name of this chunk / asset if known
      */
     name?: string
     /**
      * Whether this chunk is a dynamic entry point
      *
      * This field is only present in JS chunks.
      */
     isDynamicEntry?: boolean
     /**
      * The list of statically imported chunks by this chunk
      *
      * The values are the keys of the manifest. This field is only present in JS chunks.
      */
     imports?: string[]
     /**
      * The list of dynamically imported chunks by this chunk
      *
      * The values are the keys of the manifest. This field is only present in JS chunks.
      */
     dynamicImports?: string[]
   }
   ```

   Jeder Eintrag im Manifest steht für eines der Folgenden:
   - **Entry-Chunks**: erzeugt aus Dateien, die in [`build.rolldownOptions.input`](https://rolldown.rs/reference/InputOptions.input#input) angegeben sind. Diese Chunks haben `isEntry: true`, und ihr Schlüssel ist der relative src-Pfad ab dem Projekt-Root.
   - **Dynamische Entry-Chunks**: erzeugt aus dynamischen Importen. Diese Chunks haben `isDynamicEntry: true`, und ihr Schlüssel ist der relative src-Pfad ab dem Projekt-Root.
   - **Nicht-Entry-Chunks**: Ihr Schlüssel ist der Basisname der erzeugten Datei mit vorangestelltem `_`.
   - **Asset-Chunks**: erzeugt aus importierten Assets wie Bildern oder Schriften. Ihr Schlüssel ist der relative src-Pfad ab dem Projekt-Root.
   - **CSS-Dateien**: Ist [`build.cssCodeSplit`](/config/build-options.md#build-csscodesplit) auf `false` gesetzt, wird eine einzelne CSS-Datei mit dem Schlüssel `style.css` erzeugt. Ist `build.cssCodeSplit` nicht `false`, wird der Schlüssel ähnlich wie bei JS-Chunks gebildet (Entry-Chunks erhalten also kein `_`-Präfix, Nicht-Entry-Chunks schon).

   JS-Chunks (also alle Chunks außer Assets oder CSS) enthalten Informationen über ihre statischen und dynamischen Importe (beides sind Schlüssel, die auf den entsprechenden Chunk im Manifest verweisen). Chunks führen außerdem ihre zugehörigen CSS- und Asset-Dateien auf, sofern vorhanden.

4. Sie können diese Datei verwenden, um Links oder Preload-Direktiven mit gehashten Dateinamen zu rendern.

   Hier ist ein beispielhaftes HTML-Template, das die passenden Links rendert. Die Syntax dient
   nur der Erläuterung, ersetzen Sie sie durch die Templating-Sprache Ihres Servers. Die Funktion
   `importedChunks` dient der Veranschaulichung und wird nicht von Vite bereitgestellt.

   ```html
   <!-- if production -->

   <!-- for cssFile of manifest[name].css -->
   <link rel="stylesheet" href="/{{ cssFile }}" />

   <!-- for chunk of importedChunks(manifest, name) -->
   <!-- for cssFile of chunk.css -->
   <link rel="stylesheet" href="/{{ cssFile }}" />

   <script type="module" src="/{{ manifest[name].file }}"></script>

   <!-- for chunk of importedChunks(manifest, name) -->
   <link rel="modulepreload" href="/{{ chunk.file }}" />
   ```

   Konkret sollte ein Backend, das HTML erzeugt, bei gegebener Manifestdatei und gegebenem Einstiegspunkt
   die folgenden Tags einbinden. Beachten Sie, dass diese Reihenfolge für optimale Performance empfohlen wird:
   1. ein `<link rel="stylesheet">`-Tag für jede Datei in der `css`-Liste des Entry-Point-Chunks (sofern vorhanden)
   2. Folgen Sie rekursiv allen Chunks in der `imports`-Liste des Einstiegspunkts und binden Sie
      für jede CSS-Datei in der `css`-Liste jedes importierten Chunks ein `<link rel="stylesheet">`-Tag ein (sofern vorhanden).
   3. ein Tag für den Schlüssel `file` des Entry-Point-Chunks. Das kann `<script type="module">` für JavaScript oder `<link rel="stylesheet">` für CSS sein.
   4. optional ein `<link rel="modulepreload">`-Tag für die `file` jedes importierten JavaScript-Chunks,
      wobei den Importen ausgehend vom Entry-Point-Chunk erneut rekursiv gefolgt wird.

   Gemäß dem obigen Beispielmanifest sollten für den Einstiegspunkt `views/foo.js` in der Produktion die folgenden Tags eingebunden werden:

   ```html
   <link rel="stylesheet" href="assets/foo-5UjPuW-k.css" />
   <link rel="stylesheet" href="assets/shared-ChJ_j-JJ.css" />
   <script type="module" src="assets/foo-BRBmoGS9.js"></script>
   <!-- optional -->
   <link rel="modulepreload" href="assets/shared-B7PI925R.js" />
   ```

   Für den Einstiegspunkt `views/bar.js` sollte dagegen Folgendes eingebunden werden:

   ```html
   <link rel="stylesheet" href="assets/shared-ChJ_j-JJ.css" />
   <script type="module" src="assets/bar-gkvgaI9m.js"></script>
   <!-- optional -->
   <link rel="modulepreload" href="assets/shared-B7PI925R.js" />
   ```

   ::: details Pseudo-Implementierung von `importedChunks`
   Eine beispielhafte Pseudo-Implementierung von `importedChunks` in TypeScript (sie muss
   an Ihre Programmier- und Templating-Sprache angepasst werden):

   ```ts
   import type { Manifest, ManifestChunk } from 'vite'

   export default function importedChunks(
     manifest: Manifest,
     name: string,
   ): ManifestChunk[] {
     const seen = new Set<string>()

     function getImportedChunks(chunk: ManifestChunk): ManifestChunk[] {
       const chunks: ManifestChunk[] = []
       for (const file of chunk.imports ?? []) {
         const importee = manifest[file]
         if (seen.has(file)) {
           continue
         }
         seen.add(file)

         chunks.push(...getImportedChunks(importee))
         chunks.push(importee)
       }

       return chunks
     }

     return getImportedChunks(manifest[name])
   }
   ```

   :::

   :::info Unterstützung für Chunk-Import-Maps (experimentell)

   Wenn Sie die experimentelle Option [`build.chunkImportMap`](/config/build-options#build-chunkimportmap) verwenden, müssen Sie die Import-Map zusätzlich in das HTML einfügen.

   Die Import-Map wird als `importmap.json` im Ausgabeverzeichnis abgelegt. Achten Sie darauf, das `<script type="importmap">`-Tag vor allen `<script type="module">`- und `<link rel="modulepreload">`-Tags einzufügen.
   :::
