# Umgang mit statischen Assets

- Verwandt: [Öffentlicher Basispfad](./build#public-base-path)
- Verwandt: [Konfigurationsoption `assetsInclude`](/config/shared-options.md#assetsinclude)

## Ein Asset als URL importieren

Der Import eines statischen Assets liefert die aufgelöste öffentliche URL, unter der es ausgeliefert wird:

```js twoslash
import 'vite/client'
// ---cut---
import imgUrl from './img.png'
document.getElementById('hero-img').src = imgUrl
```

Beispielsweise ist `imgUrl` während der Entwicklung `/src/img.png` und wird im Produktions-Build zu `/assets/img.2d8efhg.png`.

Das Verhalten ähnelt dem `file-loader` von webpack. Der Unterschied besteht darin, dass der Import entweder absolute öffentliche Pfade (bezogen auf das Projekt-Root während der Entwicklung) oder relative Pfade verwenden kann.

- `url()`-Referenzen in CSS werden auf dieselbe Weise behandelt.

- Bei Verwendung des Vue-Plugins werden Asset-Referenzen in Vue-SFC-Templates automatisch in Importe umgewandelt.

- Gängige Bild-, Medien- und Schriftdateitypen werden automatisch als Assets erkannt. Sie können die interne Liste mit der [Option `assetsInclude`](/config/shared-options.md#assetsinclude) erweitern.

- Referenzierte Assets werden Teil des Asset-Graphen des Builds, erhalten gehashte Dateinamen und können von Plugins zur Optimierung verarbeitet werden.

- Assets, die in Bytes kleiner sind als die [Option `assetsInlineLimit`](/config/build-options.md#build-assetsinlinelimit), werden als base64-Data-URLs inline eingebettet.

- Git-LFS-Platzhalter werden automatisch vom Inlining ausgeschlossen, da sie nicht den Inhalt der Datei enthalten, die sie repräsentieren. Damit Inlining greift, laden Sie die Dateiinhalte vor dem Build über Git LFS herunter.

- TypeScript erkennt Importe statischer Assets standardmäßig nicht als gültige Module. Binden Sie zur Behebung [`vite/client`](./features#client-types) ein.

::: tip SVGs über `url()` inlinen
Wenn Sie die URL eines SVG per JS an ein manuell konstruiertes `url()` übergeben, sollte die Variable in doppelte Anführungszeichen eingeschlossen werden.

```js twoslash
import 'vite/client'
// ---cut---
import imgUrl from './img.svg'
document.getElementById('hero-img').style.background = `url("${imgUrl}")`
```

:::

### Explizite URL-Importe

Assets, die weder in der internen Liste noch in `assetsInclude` enthalten sind, können mit dem Suffix `?url` explizit als URL importiert werden. Das ist zum Beispiel nützlich, um [Houdini Paint Worklets](https://developer.mozilla.org/en-US/docs/Web/API/CSS/paintWorklet_static) zu importieren.

```js twoslash
import 'vite/client'
// ---cut---
import workletURL from 'extra-scalloped-border/worklet.js?url'
CSS.paintWorklet.addModule(workletURL)
```

### Explizite Steuerung des Inlinings

Assets können mit dem Suffix `?inline` bzw. `?no-inline` explizit mit oder ohne Inlining importiert werden.

```js twoslash
import 'vite/client'
// ---cut---
import imgUrl1 from './img.svg?no-inline'
import imgUrl2 from './img.png?inline'
```

### Ein Asset als String importieren

Assets können mit dem Suffix `?raw` als Strings importiert werden.

```js twoslash
import 'vite/client'
// ---cut---
import shaderString from './shader.glsl?raw'
```

### Ein Skript als Worker importieren

Skripte können mit dem Suffix `?worker` oder `?sharedworker` als Web Worker importiert werden.

```js twoslash
import 'vite/client'
// ---cut---
// Separate chunk in the production build
import Worker from './shader.js?worker'
const worker = new Worker()
```

```js twoslash
import 'vite/client'
// ---cut---
// sharedworker
import SharedWorker from './shader.js?sharedworker'
const sharedWorker = new SharedWorker()
```

```js twoslash
import 'vite/client'
// ---cut---
// Inlined as base64 strings
import InlineWorker from './shader.js?worker&inline'
```

Weitere Details finden Sie im [Abschnitt zu Web Workern](./features.md#web-workers).

## Das Verzeichnis `public`

Wenn Sie Assets haben, die

- niemals im Quellcode referenziert werden (z. B. `robots.txt`),
- exakt denselben Dateinamen behalten müssen (ohne Hashing),
- ... oder wenn Sie ein Asset schlicht nicht erst importieren möchten, nur um an seine URL zu kommen,

dann können Sie das Asset in einem speziellen Verzeichnis `public` unterhalb Ihres Projekt-Roots ablegen. Assets in diesem Verzeichnis werden während der Entwicklung unter dem Root-Pfad `/` ausgeliefert und unverändert in das Root des dist-Verzeichnisses kopiert.

Das Verzeichnis ist standardmäßig `<root>/public`, kann aber über die [Option `publicDir`](/config/shared-options.md#publicdir) konfiguriert werden.

Beachten Sie, dass Sie `public`-Assets immer über einen absoluten Root-Pfad referenzieren sollten – zum Beispiel sollte `public/icon.png` im Quellcode als `/icon.png` referenziert werden.

::: tip Die Wahl zwischen Importen und dem Verzeichnis `public`

Bevorzugen Sie generell das **Importieren von Assets**, sofern Sie nicht ausdrücklich die Garantien benötigen, die das Verzeichnis `public` bietet.

:::

## new URL(url, import.meta.url)

[import.meta.url](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Statements/import.meta) ist ein natives ESM-Feature, das die URL des aktuellen Moduls verfügbar macht. In Kombination mit dem nativen [URL-Konstruktor](https://developer.mozilla.org/en-US/docs/Web/API/URL) lässt sich die vollständige, aufgelöste URL eines statischen Assets ausgehend von einem relativen Pfad in einem JavaScript-Modul ermitteln:

```js
const imgUrl = new URL('./img.png', import.meta.url).href

document.getElementById('hero-img').src = imgUrl
```

Das funktioniert nativ in modernen Browsern – tatsächlich muss Vite diesen Code während der Entwicklung überhaupt nicht verarbeiten!

Dieses Muster unterstützt über Template-Literale auch dynamische URLs:

```js
function getImageUrl(name) {
  // note that this does not include files in subdirectories
  return new URL(`./dir/${name}.png`, import.meta.url).href
}
```

Während des Produktions-Builds führt Vite die notwendigen Transformationen durch, damit die URLs auch nach dem Bundling und dem Asset-Hashing noch auf die richtige Stelle zeigen. Der URL-String muss jedoch statisch sein, damit er analysiert werden kann; andernfalls bleibt der Code unverändert, was zu Laufzeitfehlern führen kann, wenn `build.target` `import.meta.url` nicht unterstützt.

```js
// Vite will not transform this
const imgUrl = new URL(imagePath, import.meta.url).href
```

::: details Wie es funktioniert

Vite transformiert die Funktion `getImageUrl` zu:

```js
import __img0png from './dir/img0.png'
import __img1png from './dir/img1.png'

function getImageUrl(name) {
  const modules = {
    './dir/img0.png': __img0png,
    './dir/img1.png': __img1png,
  }
  return new URL(modules[`./dir/${name}.png`], import.meta.url).href
}
```

:::

::: warning Funktioniert nicht mit SSR
Dieses Muster funktioniert nicht, wenn Sie Vite für serverseitiges Rendering einsetzen, da `import.meta.url` im Browser eine andere Semantik hat als in Node.js. Das Server-Bundle kann die Host-URL des Clients außerdem nicht im Voraus bestimmen.
:::
