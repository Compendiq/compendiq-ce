# Plugins verwenden

Vite lässt sich mit Plugins erweitern, die auf Rollups gut durchdachter Plugin-Schnittstelle basieren, ergänzt um einige Vite-spezifische Optionen. Das bedeutet, dass Vite-Nutzer auf das ausgereifte Ökosystem der Rollup-Plugins zurückgreifen und zugleich den Dev-Server sowie die SSR-Funktionalität nach Bedarf erweitern können.

<ScrimbaLink href="https://scrimba.com/intro-to-vite-c03p6pbbdq/~0y4g?via=vite" title="Using Plugins in Vite">Sehen Sie sich eine interaktive Lektion auf Scrimba an</ScrimbaLink>

## Ein Plugin hinzufügen

Um ein Plugin zu verwenden, muss es den `devDependencies` des Projekts hinzugefügt und in das `plugins`-Array in der Konfigurationsdatei `vite.config.js` aufgenommen werden. Um zum Beispiel ältere Browser zu unterstützen, kann das offizielle [@vitejs/plugin-legacy](https://github.com/vitejs/vite/tree/main/packages/plugin-legacy) verwendet werden:

```bash
$ npm add -D @vitejs/plugin-legacy
```

```js twoslash [vite.config.js]
import legacy from '@vitejs/plugin-legacy'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [
    legacy({
      targets: ['defaults', 'not IE 11'],
    }),
  ],
})
```

`plugins` akzeptiert auch Presets, die mehrere Plugins als ein einzelnes Element bündeln. Das ist nützlich für komplexe Funktionen (etwa die Integration eines Frameworks), die über mehrere Plugins umgesetzt werden. Das Array wird intern flachgeklopft.

Falsy-Plugins werden ignoriert, was sich nutzen lässt, um Plugins bequem zu aktivieren oder zu deaktivieren.

## Plugins finden

:::tip NOTE
Vite hat den Anspruch, gängige Muster der Webentwicklung ab Werk zu unterstützen. Bevor Sie nach einem Vite- oder kompatiblen Rollup-Plugin suchen, werfen Sie einen Blick in den [Features-Guide](../guide/features.md). Viele Fälle, in denen ein Rollup-Projekt ein Plugin bräuchte, sind in Vite bereits abgedeckt.
:::

Informationen zu offiziellen Plugins finden Sie im [Plugins-Abschnitt](../plugins/). Community-Plugins, die auf npm veröffentlicht sind, werden in der [Vite Plugin Registry](https://registry.vite.dev/plugins) aufgeführt.

## Die Reihenfolge von Plugins erzwingen

Zur Kompatibilität mit einigen Rollup-Plugins kann es nötig sein, die Reihenfolge des Plugins zu erzwingen oder es nur zur Build-Zeit anzuwenden. Für Vite-Plugins sollte das ein Implementierungsdetail sein. Mit dem Modifikator `enforce` können Sie die Position eines Plugins festlegen:

- `pre`: Plugin vor den Vite-Kern-Plugins aufrufen
- Standard: Plugin nach den Vite-Kern-Plugins aufrufen
- `post`: Plugin nach den Vite-Build-Plugins aufrufen

```js twoslash [vite.config.js]
import image from '@rollup/plugin-image'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [
    {
      ...image(),
      enforce: 'pre',
    },
  ],
})
```

Ausführliche Informationen finden Sie im [Plugins-API-Guide](./api-plugin.md#plugin-ordering).

## Bedingte Anwendung

Standardmäßig werden Plugins sowohl für serve als auch für build aufgerufen. Falls ein Plugin nur während serve oder build angewendet werden soll, verwenden Sie die Eigenschaft `apply`, um es ausschließlich bei `'build'` oder `'serve'` aufzurufen:

```js twoslash [vite.config.js]
import typescript2 from 'rollup-plugin-typescript2'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [
    {
      ...typescript2(),
      apply: 'build',
    },
  ],
})
```

## Plugins entwickeln

Dokumentation zum Erstellen von Plugins finden Sie im [Plugins-API-Guide](./api-plugin.md).
