# Funktionen

Auf der grundlegendsten Ebene unterscheidet sich die Entwicklung mit Vite nicht sehr von der Arbeit mit einem statischen Dateiserver. Vite bietet jedoch viele Erweiterungen gegenüber nativen ESM-Importen, um verschiedene Funktionen zu unterstützen, die man typischerweise aus bundlerbasierten Setups kennt.

## Auflösung und Pre-Bundling von npm-Abhängigkeiten

Native ES-Importe unterstützen keine Bare-Module-Importe wie den folgenden:

```js
import { someMethod } from 'my-dep'
```

Der obige Import wirft im Browser einen Fehler. Vite erkennt solche Bare-Module-Importe in allen ausgelieferten Quelldateien und führt Folgendes aus:

1. Es [bündelt sie vorab](./dep-pre-bundling), um die Seitenladegeschwindigkeit zu verbessern und CommonJS-/UMD-Module in ESM umzuwandeln. Der Pre-Bundling-Schritt wird mit [Rolldown](https://rolldown.rs/) durchgeführt und macht Vites Kaltstartzeit deutlich schneller als bei jedem JavaScript-basierten Bundler.

2. Es schreibt die Importe in gültige URLs wie `/node_modules/.vite/deps/my-dep.js?v=f3sf2ebd` um, damit der Browser sie korrekt importieren kann.

**Abhängigkeiten werden aggressiv gecacht**

Vite cacht Abhängigkeits-Requests über HTTP-Header. Wenn du also eine Abhängigkeit lokal bearbeiten/debuggen möchtest, folge den Schritten [hier](./dep-pre-bundling#browser-cache).

## Hot Module Replacement

Vite stellt eine [HMR-API](./api-hmr) auf Basis von nativem ESM bereit. Frameworks mit HMR-Fähigkeiten können die API nutzen, um sofortige, präzise Updates zu liefern, ohne die Seite neu zu laden oder den Anwendungszustand zu zerstören. Vite bietet HMR-Integrationen aus erster Hand für [Vue Single File Components](https://github.com/vitejs/vite-plugin-vue/tree/main/packages/plugin-vue) und [React Fast Refresh](https://github.com/vitejs/vite-plugin-react/tree/main/packages/plugin-react). Es gibt außerdem offizielle Integrationen für Preact über [@prefresh/vite](https://github.com/JoviDeCroock/prefresh/tree/main/packages/vite).

Beachte, dass du das nicht manuell einrichten musst – wenn du [eine App über `create-vite` erstellst](./), sind die ausgewählten Templates bereits entsprechend vorkonfiguriert.

## TypeScript

Vite unterstützt den Import von `.ts`-Dateien von Haus aus.

### Nur Transpilierung

Beachte, dass Vite bei `.ts`-Dateien nur transpiliert und **KEINE** Typprüfung durchführt. Es geht davon aus, dass die Typprüfung von deiner IDE und deinem Build-Prozess übernommen wird.

Vite führt die Typprüfung deshalb nicht als Teil des Transformationsprozesses durch, weil die beiden Aufgaben grundlegend unterschiedlich funktionieren. Transpilierung kann pro Datei erfolgen und passt perfekt zu Vites bedarfsgesteuertem Kompiliermodell. Typprüfung dagegen erfordert Kenntnis des gesamten Modulgraphen. Die Typprüfung in Vites Transformations-Pipeline hineinzuzwängen würde Vites Geschwindigkeitsvorteile unweigerlich schmälern.

Vites Aufgabe ist es, deine Quellmodule so schnell wie möglich in eine Form zu bringen, die im Browser lauffähig ist. Dafür empfehlen wir, statische Analysen von Vites Transformations-Pipeline zu trennen. Dieses Prinzip gilt auch für andere statische Analysen wie ESLint.

- Für Produktions-Builds kannst du zusätzlich zu Vites Build-Befehl `tsc --noEmit` ausführen.

- Während der Entwicklung empfehlen wir, `tsc --noEmit --watch` in einem separaten Prozess auszuführen, falls du mehr als IDE-Hinweise brauchst, oder [vite-plugin-checker](https://github.com/fi3ework/vite-plugin-checker) zu verwenden, wenn du Typfehler lieber direkt im Browser gemeldet bekommst.

Vite verwendet den [Oxc Transformer](https://oxc.rs/docs/guide/usage/transformer.html), um TypeScript nach JavaScript zu transpilieren, was schneller ist als reines `tsc`, und HMR-Updates können sich in unter 50 ms im Browser niederschlagen.

Verwende die Syntax [Type-Only Imports and Export](https://www.typescriptlang.org/docs/handbook/release-notes/typescript-3-8.html#type-only-imports-and-export), um mögliche Probleme wie das fälschliche Bündeln reiner Typ-Importe zu vermeiden, zum Beispiel:

```ts
import type { T } from 'only/types'
export type { T }
```

### TypeScript-Compiler-Optionen

Vite berücksichtigt einige der Optionen in der `tsconfig.json` und setzt die entsprechenden Optionen des Oxc Transformers. Für jede Datei verwendet Vite die nächstgelegene übergeordnete `tsconfig.json`, die zu der Datei passt, oder eine über deren Feld [`references`](https://www.typescriptlang.org/tsconfig/#references) referenzierte Konfiguration, die zu der Datei passt. Vite betrachtet eine Konfiguration als passend zur Datei, wenn die Datei die Felder [`files`](https://www.typescriptlang.org/tsconfig/#files), [`include`](https://www.typescriptlang.org/tsconfig/#include) und [`exclude`](https://www.typescriptlang.org/tsconfig/#exclude) der Konfiguration erfüllt.

Wenn die Optionen sowohl in der Vite-Konfiguration als auch in der `tsconfig.json` gesetzt sind, hat der Wert in der Vite-Konfiguration Vorrang.

Einige Konfigurationsfelder unter `compilerOptions` in der `tsconfig.json` erfordern besondere Aufmerksamkeit.

#### `isolatedModules`

- [TypeScript-Dokumentation](https://www.typescriptlang.org/tsconfig#isolatedModules)

Sollte auf `true` gesetzt werden.

Der Grund ist, dass der Oxc Transformer nur transpiliert, ohne Typinformationen, und daher bestimmte Features wie const enum und implizite reine Typ-Importe nicht unterstützt.

Du musst in deiner `tsconfig.json` unter `compilerOptions` `"isolatedModules": true` setzen, damit TS dich vor Features warnt, die mit isolierter Transpilierung nicht funktionieren.

Wenn eine Abhängigkeit mit `"isolatedModules": true` nicht gut funktioniert, kannst du `"skipLibCheck": true` verwenden, um die Fehler vorübergehend zu unterdrücken, bis sie upstream behoben sind.

#### `useDefineForClassFields`

- [TypeScript-Dokumentation](https://www.typescriptlang.org/tsconfig#useDefineForClassFields)

Der Standardwert ist `true`, wenn das TypeScript-Target `ES2022` oder neuer ist, einschließlich `ESNext`. Das entspricht dem [Verhalten von TypeScript 4.3.2+](https://github.com/microsoft/TypeScript/pull/42663). Bei anderen TypeScript-Targets ist der Standard `false`.

`true` ist das standardkonforme ECMAScript-Laufzeitverhalten.

Wenn du eine Bibliothek verwendest, die stark auf Klassenfelder setzt, achte auf die von der Bibliothek beabsichtigte Verwendung. Während die meisten Bibliotheken `"useDefineForClassFields": true` erwarten, kannst du `useDefineForClassFields` explizit auf `false` setzen, wenn deine Bibliothek es nicht unterstützt.

#### `target`

- [TypeScript-Dokumentation](https://www.typescriptlang.org/tsconfig#target)

Vite ignoriert den Wert `target` in der `tsconfig.json` und folgt damit demselben Verhalten wie [esbuild](https://esbuild.github.io/).

Um das Target im Dev-Modus anzugeben, kann die Option [`oxc.target`](/config/shared-options.html#oxc) verwendet werden, die für minimale Transpilierung standardmäßig `esnext` ist. In Builds hat die Option [`build.target`](/config/build-options.html#build-target) höhere Priorität als `oxc.target` und kann bei Bedarf ebenfalls gesetzt werden.

#### `emitDecoratorMetadata`

- [TypeScript-Dokumentation](https://www.typescriptlang.org/tsconfig#emitDecoratorMetadata)

Diese Option wird nur teilweise unterstützt. Vollständige Unterstützung erfordert Typinferenz durch den TypeScript-Compiler, was nicht unterstützt wird. Details siehe [Dokumentation des Oxc Transformers](https://oxc.rs/docs/guide/usage/transformer/typescript.html#decorators).

#### `paths`

- [TypeScript-Dokumentation](https://www.typescriptlang.org/tsconfig/#paths)

Mit [`resolve.tsconfigPaths: true`](/config/shared-options.md#resolve-tsconfigpaths) kann Vite angewiesen werden, die Option `paths` in der `tsconfig.json` zur Auflösung von Importen zu verwenden.

Beachte, dass diese Funktion Performance kostet und [vom TypeScript-Team davon abgeraten wird, diese Option zur Änderung des Verhaltens externer Werkzeuge zu verwenden](https://www.typescriptlang.org/tsconfig/#paths:~:text=Note%20that%20this%20feature%20does%20not%20change%20how%20import%20paths%20are%20emitted%20by%20tsc%2C%20so%20paths%20should%20only%20be%20used%20to%20inform%20TypeScript%20that%20another%20tool%20has%20this%20mapping%20and%20will%20use%20it%20at%20runtime%20or%20when%20bundling.).

#### Weitere Compiler-Optionen, die das Build-Ergebnis beeinflussen

- [`extends`](https://www.typescriptlang.org/tsconfig#extends)
- [`importsNotUsedAsValues`](https://www.typescriptlang.org/tsconfig#importsNotUsedAsValues)
- [`preserveValueImports`](https://www.typescriptlang.org/tsconfig#preserveValueImports)
- [`verbatimModuleSyntax`](https://www.typescriptlang.org/tsconfig#verbatimModuleSyntax)
- [`jsx`](https://www.typescriptlang.org/tsconfig#jsx)
- [`jsxFactory`](https://www.typescriptlang.org/tsconfig#jsxFactory)
- [`jsxFragmentFactory`](https://www.typescriptlang.org/tsconfig#jsxFragmentFactory)
- [`jsxImportSource`](https://www.typescriptlang.org/tsconfig#jsxImportSource)
- [`experimentalDecorators`](https://www.typescriptlang.org/tsconfig#experimentalDecorators)

::: tip `skipLibCheck`
Die Vite-Starter-Templates haben standardmäßig `"skipLibCheck": true`, um die Typprüfung von Abhängigkeiten zu vermeiden, da diese sich entscheiden können, nur bestimmte TypeScript-Versionen und -Konfigurationen zu unterstützen. Mehr dazu unter [vuejs/vue-cli#5688](https://github.com/vuejs/vue-cli/pull/5688).
:::

### Client-Typen

Vites Standardtypen sind für seine Node.js-API gedacht. Um die Umgebung von clientseitigem Code in einer Vite-Anwendung zu ergänzen, kannst du `vite/client` in der `tsconfig.json` zu `compilerOptions.types` hinzufügen:

```json [tsconfig.json]
{
  "compilerOptions": {
    "types": ["vite/client", "some-other-global-lib"]
  }
}
```

Beachte: Wenn [`compilerOptions.types`](https://www.typescriptlang.org/tsconfig#types) angegeben ist, werden nur diese Pakete in den globalen Scope aufgenommen (statt aller sichtbaren „@types“-Pakete). Das wird seit TS 5.9 empfohlen.

::: details Triple-Slash-Direktive verwenden

Alternativ kannst du eine `d.ts`-Deklarationsdatei hinzufügen:

```typescript [vite-env.d.ts]
/// <reference types="vite/client" />
```

:::

`vite/client` stellt die folgenden Typ-Shims bereit:

- Asset-Importe (z. B. den Import einer `.svg`-Datei)
- Typen für die von Vite injizierten [Konstanten](./env-and-mode#env-variables) auf `import.meta.env`
- Typen für die [HMR-API](./api-hmr) auf `import.meta.hot`

::: tip
Um die Standardtypisierung zu überschreiben, füge eine Typdefinitionsdatei mit deinen Typen hinzu. Ergänze dann die Typreferenz vor `vite/client`.

Um zum Beispiel den Standardimport von `*.svg` zu einer React-Komponente zu machen:

- `vite-env-override.d.ts` (die Datei mit deinen Typen):
  ```ts
  declare module '*.svg' {
    const content: React.FC<React.SVGProps<SVGElement>>
    export default content
  }
  ```
- Wenn du `compilerOptions.types` verwendest, stelle sicher, dass die Datei in der `tsconfig.json` enthalten ist:
  ```json [tsconfig.json]
  {
    "include": ["src", "./vite-env-override.d.ts"]
  }
  ```
- Wenn du Triple-Slash-Direktiven verwendest, aktualisiere die Datei, die die Referenz auf `vite/client` enthält (normalerweise `vite-env.d.ts`):
  ```ts
  /// <reference types="./vite-env-override.d.ts" />
  /// <reference types="vite/client" />
  ```

:::

## HTML

HTML-Dateien stehen in einem Vite-Projekt [im Mittelpunkt](/guide/#index-html-and-project-root) und dienen als Einstiegspunkte deiner Anwendung, was das Erstellen von Single-Page- und [Multi-Page-Anwendungen](/guide/build.html#multi-page-app) einfach macht.

Alle HTML-Dateien im Projekt-Root sind direkt über ihren jeweiligen Verzeichnispfad erreichbar:

- `<root>/index.html` -> `http://localhost:5173/`
- `<root>/about.html` -> `http://localhost:5173/about.html`
- `<root>/blog/index.html` -> `http://localhost:5173/blog/index.html`

Von HTML-Elementen wie `<script type="module" src>` und `<link href>` referenzierte Assets werden als Teil der App verarbeitet und gebündelt. Die vollständige Liste der unterstützten Elemente lautet:

- `<audio src>`
- `<embed src>`
- `<img src>` und `<img srcset>`
- `<image href>` und `<image xlink:href>`
- `<input src>`
- `<link href>` und `<link imagesrcset>`
- `<object data>`
- `<script type="module" src>`
- `<source src>` und `<source srcset>`
- `<track src>`
- `<use href>` und `<use xlink:href>`
- `<video src>` und `<video poster>`
- `<meta content>`
  - Nur wenn das Attribut `name` zu `msapplication-tileimage`, `msapplication-square70x70logo`, `msapplication-square150x150logo`, `msapplication-wide310x150logo`, `msapplication-square310x310logo`, `msapplication-config` oder `twitter:image` passt
  - Oder nur wenn das Attribut `property` zu `og:image`, `og:image:url`, `og:image:secure_url`, `og:audio`, `og:audio:secure_url`, `og:video` oder `og:video:secure_url` passt

```html {4-5,8-9}
<!doctype html>
<html>
  <head>
    <link rel="icon" href="/favicon.ico" />
    <link rel="stylesheet" href="/src/styles.css" />
  </head>
  <body>
    <img src="/src/images/logo.svg" alt="logo" />
    <script type="module" src="/src/main.js"></script>
  </body>
</html>
```

Um die HTML-Verarbeitung für bestimmte Elemente abzuwählen, kannst du das Attribut `vite-ignore` am Element ergänzen, was beim Verweis auf externe Assets oder ein CDN nützlich sein kann.

## Frameworks

Alle modernen Frameworks pflegen Integrationen mit Vite. Die meisten Framework-Plugins werden vom jeweiligen Framework-Team gepflegt, mit Ausnahme der offiziellen Vue- und React-Vite-Plugins, die in der vite-Organisation gepflegt werden:

- Vue-Unterstützung über [@vitejs/plugin-vue](https://github.com/vitejs/vite-plugin-vue/tree/main/packages/plugin-vue)
- Vue-JSX-Unterstützung über [@vitejs/plugin-vue-jsx](https://github.com/vitejs/vite-plugin-vue/tree/main/packages/plugin-vue-jsx)
- React-Unterstützung über [@vitejs/plugin-react](https://github.com/vitejs/vite-plugin-react/tree/main/packages/plugin-react)
- React mit SWC-Unterstützung über [@vitejs/plugin-react-swc](https://github.com/vitejs/vite-plugin-react/tree/main/packages/plugin-react-swc)
- Unterstützung für [React Server Components (RSC)](https://react.dev/reference/rsc/server-components) über [@vitejs/plugin-rsc](https://github.com/vitejs/vite-plugin-react/tree/main/packages/plugin-rsc)

Weitere Informationen findest du im [Plugins-Leitfaden](/plugins/).

## JSX

`.jsx`- und `.tsx`-Dateien werden ebenfalls von Haus aus unterstützt. Die JSX-Transpilierung wird ebenfalls über den [Oxc Transformer](https://oxc.rs/docs/guide/usage/transformer.html) abgewickelt.

Das Framework deiner Wahl konfiguriert JSX bereits von Haus aus (Vue-Nutzer sollten zum Beispiel das offizielle Plugin [@vitejs/plugin-vue-jsx](https://github.com/vitejs/vite-plugin-vue/tree/main/packages/plugin-vue-jsx) verwenden, das Vue-3-spezifische Funktionen wie HMR, globale Komponentenauflösung, Direktiven und Slots bietet).

Wenn du JSX mit deinem eigenen Framework verwendest, können eigene `jsxFactory` und `jsxFragment` über die [Option `oxc`](/config/shared-options.md#oxc) konfiguriert werden. Das Preact-Plugin würde zum Beispiel verwenden:

```js twoslash [vite.config.js]
import { defineConfig } from 'vite'

export default defineConfig({
  oxc: {
    jsx: {
      importSource: 'preact',
    },
  },
})
```

Weitere Details in der [Dokumentation des Oxc Transformers](https://oxc.rs/docs/guide/usage/transformer/jsx.html).

Du kannst die JSX-Helfer über `jsxInject` injizieren (eine Vite-exklusive Option), um manuelle Importe zu vermeiden:

```js twoslash [vite.config.js]
import { defineConfig } from 'vite'

export default defineConfig({
  oxc: {
    jsxInject: `import React from 'react'`,
  },
})
```

## CSS

Der Import von `.css`-Dateien injiziert deren Inhalt über ein `<style>`-Tag mit HMR-Unterstützung in die Seite.

### `@import`-Inlining und Rebasing

Vite ist vorkonfiguriert, um CSS-`@import`-Inlining über `postcss-import` zu unterstützen. Vite-Aliase werden auch für CSS-`@import` berücksichtigt. Außerdem werden alle CSS-`url()`-Referenzen immer automatisch neu berechnet (rebased), selbst wenn die importierten Dateien in anderen Verzeichnissen liegen, um Korrektheit sicherzustellen.

`@import`-Aliase und URL-Rebasing werden auch für Sass- und Less-Dateien unterstützt (siehe [CSS-Präprozessoren](#css-pre-processors)).

### PostCSS

Wenn das Projekt eine gültige PostCSS-Konfiguration enthält (jedes von [postcss-load-config](https://github.com/postcss/postcss-load-config) unterstützte Format, z. B. `postcss.config.js`), wird sie automatisch auf jedes importierte CSS angewendet.

Beachte, dass die CSS-Minifizierung nach PostCSS läuft und die Option [`build.cssTarget`](/config/build-options.md#build-csstarget) verwendet.

### CSS Modules

Jede CSS-Datei, die auf `.module.css` endet, gilt als [CSS-Modules-Datei](https://github.com/css-modules/css-modules). Der Import einer solchen Datei liefert das entsprechende Modulobjekt zurück:

```css [example.module.css]
.red {
  color: red;
}
```

```js twoslash
import 'vite/client'
// ---cut---
import classes from './example.module.css'
document.getElementById('foo').className = classes.red
```

Das Verhalten von CSS Modules kann über die [Option `css.modules`](/config/shared-options.md#css-modules) konfiguriert werden.

Wenn `css.modules.localsConvention` so gesetzt ist, dass camelCase-Locals aktiviert sind (z. B. `localsConvention: 'camelCaseOnly'`), kannst du auch benannte Importe verwenden:

```js twoslash
import 'vite/client'
// ---cut---
// .apply-color -> applyColor
import { applyColor } from './example.module.css'
document.getElementById('foo').className = applyColor
```

### CSS-Präprozessoren

Da Vite ausschließlich auf moderne Browser abzielt, wird empfohlen, native CSS-Variablen mit PostCSS-Plugins zu verwenden, die CSSWG-Entwürfe umsetzen (z. B. [postcss-nesting](https://github.com/csstools/postcss-plugins/tree/main/plugins/postcss-nesting)), und schlichtes, zukunftsstandardkonformes CSS zu schreiben.

Dennoch bietet Vite eingebaute Unterstützung für `.scss`-, `.sass`-, `.less`-, `.styl`- und `.stylus`-Dateien. Dafür müssen keine Vite-spezifischen Plugins installiert werden, der jeweilige Präprozessor selbst muss aber installiert sein:

```bash
# .scss and .sass
npm add -D sass-embedded # or sass

# .less
npm add -D less

# .styl and .stylus
npm add -D stylus
```

Bei Verwendung von Vue Single File Components aktiviert das zugleich automatisch `<style lang="sass">` usw.

Vite verbessert die `@import`-Auflösung für Sass und Less, sodass auch Vite-Aliase berücksichtigt werden. Außerdem werden relative `url()`-Referenzen innerhalb importierter Sass-/Less-Dateien, die in anderen Verzeichnissen als die Root-Datei liegen, ebenfalls automatisch neu berechnet, um Korrektheit sicherzustellen. Das Rebasing von `url()`-Referenzen, die mit einer Variablen oder einer Interpolation beginnen, wird aufgrund der API-Einschränkungen nicht unterstützt.

`@import`-Aliase und URL-Rebasing werden für Stylus aufgrund dessen API-Einschränkungen nicht unterstützt.

Du kannst CSS Modules auch mit Präprozessoren kombinieren, indem du `.module` vor die Dateiendung setzt, zum Beispiel `style.module.scss`.

### CSS-Injektion in die Seite deaktivieren

Die automatische Injektion von CSS-Inhalten lässt sich über den Query-Parameter `?inline` abschalten. In diesem Fall wird der verarbeitete CSS-String wie gewohnt als Default-Export des Moduls zurückgegeben, die Styles werden aber nicht in die Seite injiziert.

```js twoslash
import 'vite/client'
// ---cut---
import './foo.css' // will be injected into the page
import otherStyles from './bar.css?inline' // will not be injected
```

::: tip HINWEIS
Default- und benannte Importe aus CSS-Dateien (z. B. `import style from './foo.css'`) wurden seit Vite 5 entfernt. Verwende stattdessen die Query `?inline`.
:::

### Lightning CSS

Vite verwendet standardmäßig [Lightning CSS](https://lightningcss.dev/), um CSS in Produktions-Builds zu minifizieren. Für die übrige CSS-Verarbeitung wird jedoch weiterhin PostCSS verwendet.

Es gibt experimentelle Unterstützung dafür, Lightning CSS vollständig für die CSS-Verarbeitung zu nutzen. Du kannst dich dafür entscheiden, indem du [`css.transformer: 'lightningcss'`](../config/shared-options.md#css-transformer) ergänzt.

Zur Konfiguration kannst du Lightning-CSS-Optionen an die Konfigurationsoption [`css.lightningcss`](../config/shared-options.md#css-lightningcss) übergeben. Um CSS Modules zu konfigurieren, solltest du [`css.lightningcss.cssModules`](https://lightningcss.dev/css-modules.html) statt [`css.modules`](../config/shared-options.md#css-modules) verwenden (das konfiguriert, wie PostCSS CSS Modules behandelt).

## Statische Assets

<ScrimbaLink href="https://scrimba.com/intro-to-vite-c03p6pbbdq/~05pq?via=vite" title="Static Assets in Vite">Sieh dir eine interaktive Lektion auf Scrimba an</ScrimbaLink>

Der Import eines statischen Assets liefert die aufgelöste öffentliche URL zurück, unter der es ausgeliefert wird:

```js twoslash
import 'vite/client'
// ---cut---
import imgUrl from './img.png'
document.getElementById('hero-img').src = imgUrl
```

Spezielle Queries können ändern, wie Assets geladen werden:

```js twoslash
import 'vite/client'
// ---cut---
// Explicitly load assets as URL (automatically inlined depending on the file size)
import assetAsURL from './asset.js?url'
```

```js twoslash
import 'vite/client'
// ---cut---
// Load assets as strings
import assetAsString from './shader.glsl?raw'
```

```js twoslash
import 'vite/client'
// ---cut---
// Load Web Workers
import Worker from './worker.js?worker'
```

```js twoslash
import 'vite/client'
// ---cut---
// Web Workers inlined as base64 strings at build time
import InlineWorker from './worker.js?worker&inline'
```

Weitere Details unter [Static Asset Handling](./assets).

## JSON

JSON-Dateien können direkt importiert werden – benannte Importe werden ebenfalls unterstützt:

```js twoslash
import 'vite/client'
// ---cut---
// import the entire object
import json from './example.json'
// import a root field as named exports - helps with tree-shaking!
import { field } from './example.json'
```

## Glob-Import

Vite unterstützt den Import mehrerer Module aus dem Dateisystem über die spezielle Funktion `import.meta.glob`:

```js twoslash
import 'vite/client'
// ---cut---
const modules = import.meta.glob('./dir/*.js')
```

Das Obige wird in Folgendes transformiert:

```js
// code produced by vite
const modules = {
  './dir/bar.js': () => import('./dir/bar.js'),
  './dir/foo.js': () => import('./dir/foo.js'),
}
```

Du kannst dann über die Schlüssel des Objekts `modules` iterieren, um auf die entsprechenden Module zuzugreifen:

```js
for (const path in modules) {
  modules[path]().then((mod) => {
    console.log(path, mod)
  })
}
```

Passende Dateien werden standardmäßig per dynamischem Import verzögert geladen und beim Build in separate Chunks aufgeteilt. Wenn du stattdessen alle Module direkt importieren möchtest (z. B. weil du dich darauf verlässt, dass Seiteneffekte in diesen Modulen zuerst greifen), kannst du `{ eager: true }` als zweites Argument übergeben:

```js twoslash
import 'vite/client'
// ---cut---
const modules = import.meta.glob('./dir/*.js', { eager: true })
```

Das Obige wird in Folgendes transformiert:

```js
// code produced by vite
import * as __vite_glob_0_0 from './dir/bar.js'
import * as __vite_glob_0_1 from './dir/foo.js'
const modules = {
  './dir/bar.js': __vite_glob_0_0,
  './dir/foo.js': __vite_glob_0_1,
}
```

### Mehrere Patterns

Das erste Argument kann ein Array von Globs sein, zum Beispiel

```js twoslash
import 'vite/client'
// ---cut---
const modules = import.meta.glob(['./dir/*.js', './another/*.js'])
```

### Negative Patterns

Negative Glob-Patterns werden ebenfalls unterstützt (mit `!` als Präfix). Um bestimmte Dateien aus dem Ergebnis auszuschließen, kannst du dem ersten Argument Ausschluss-Glob-Patterns hinzufügen:

```js twoslash
import 'vite/client'
// ---cut---
const modules = import.meta.glob(['./dir/*.js', '!**/bar.js'])
```

```js
// code produced by vite
const modules = {
  './dir/foo.js': () => import('./dir/foo.js'),
}
```

#### Benannte Importe

Es ist möglich, mit den `import`-Optionen nur Teile der Module zu importieren.

```ts twoslash
import 'vite/client'
// ---cut---
const modules = import.meta.glob('./dir/*.js', { import: 'setup' })
```

```ts
// code produced by vite
const modules = {
  './dir/bar.js': () => import('./dir/bar.js').then((m) => m.setup),
  './dir/foo.js': () => import('./dir/foo.js').then((m) => m.setup),
}
```

In Kombination mit `eager` ist es sogar möglich, Tree-Shaking für diese Module zu aktivieren.

```ts twoslash
import 'vite/client'
// ---cut---
const modules = import.meta.glob('./dir/*.js', {
  import: 'setup',
  eager: true,
})
```

```ts
// code produced by vite:
import { setup as __vite_glob_0_0 } from './dir/bar.js'
import { setup as __vite_glob_0_1 } from './dir/foo.js'
const modules = {
  './dir/bar.js': __vite_glob_0_0,
  './dir/foo.js': __vite_glob_0_1,
}
```

Setze `import` auf `default`, um den Default-Export zu importieren.

```ts twoslash
import 'vite/client'
// ---cut---
const modules = import.meta.glob('./dir/*.js', {
  import: 'default',
  eager: true,
})
```

```ts
// code produced by vite:
import { default as __vite_glob_0_0 } from './dir/bar.js'
import { default as __vite_glob_0_1 } from './dir/foo.js'
const modules = {
  './dir/bar.js': __vite_glob_0_0,
  './dir/foo.js': __vite_glob_0_1,
}
```

#### Eigene Queries

Du kannst auch die Option `query` verwenden, um Importen Queries mitzugeben, zum Beispiel um Assets [als String](/guide/assets.html#importing-asset-as-string) oder [als URL](/guide/assets.html#importing-asset-as-url) zu importieren:

```ts twoslash
import 'vite/client'
// ---cut---
const moduleStrings = import.meta.glob('./dir/*.svg', {
  query: '?raw',
  import: 'default',
})
const moduleUrls = import.meta.glob('./dir/*.svg', {
  query: '?url',
  import: 'default',
})
```

```ts
// code produced by vite:
const moduleStrings = {
  './dir/bar.svg': () => import('./dir/bar.svg?raw').then((m) => m['default']),
  './dir/foo.svg': () => import('./dir/foo.svg?raw').then((m) => m['default']),
}
const moduleUrls = {
  './dir/bar.svg': () => import('./dir/bar.svg?url').then((m) => m['default']),
  './dir/foo.svg': () => import('./dir/foo.svg?url').then((m) => m['default']),
}
```

Du kannst auch eigene Queries bereitstellen, die andere Plugins auswerten:

```ts twoslash
import 'vite/client'
// ---cut---
const modules = import.meta.glob('./dir/*.js', {
  query: { foo: 'bar', bar: true },
})
```

#### Basispfad

Du kannst außerdem die Option `base` verwenden, um einen Basispfad für die Importe anzugeben:

```ts twoslash
import 'vite/client'
// ---cut---
const modulesWithBase = import.meta.glob('./**/*.js', {
  base: './base',
})
```

```ts
// code produced by vite:
const modulesWithBase = {
  './dir/foo.js': () => import('./base/dir/foo.js'),
  './dir/bar.js': () => import('./base/dir/bar.js'),
}
```

Die base-Option kann nur ein Verzeichnispfad relativ zur importierenden Datei oder absolut zum Projekt-Root sein. Aliase und virtuelle Module werden nicht unterstützt.

Nur die Globs, die relative Pfade sind, werden relativ zur aufgelösten Base interpretiert.

Alle resultierenden Modulschlüssel werden so angepasst, dass sie relativ zur Base sind, sofern eine angegeben ist.

#### Groß-/Kleinschreibungsabhängiger Abgleich

Standardmäßig unterscheidet der Glob-Pattern-Abgleich zwischen Groß- und Kleinschreibung. Mit der Option `caseSensitive` kannst du dieses Verhalten ändern:

```ts twoslash
import 'vite/client'
// ---cut---
const modules = import.meta.glob('./dir/module*.js', {
  caseSensitive: false,
})
```

Mit `caseSensitive: false` trifft das Glob Dateien unabhängig von der Groß-/Kleinschreibung (z. B. werden `Module.js`, `module.js` und `MODULE.js` alle von `module*.js` getroffen).

### Fallstricke beim Glob-Import

Beachte:

- Dies ist eine Vite-exklusive Funktion und kein Web- oder ES-Standard.
- Die Glob-Patterns werden wie Import-Spezifizierer behandelt: Sie müssen entweder relativ sein (beginnend mit `./`), absolut (beginnend mit `/`, aufgelöst relativ zum Projekt-Root) oder ein Alias-Pfad (siehe [Option `resolve.alias`](/config/shared-options.md#resolve-alias)).
- Der Glob-Abgleich erfolgt über [`tinyglobby`](https://github.com/SuperchupuDev/tinyglobby) – sieh in dessen Dokumentation zu den [unterstützten Glob-Patterns](https://superchupu.dev/tinyglobby/comparison).
- Beachte außerdem, dass alle Argumente in `import.meta.glob` **als Literale übergeben werden müssen**. Du kannst darin KEINE Variablen oder Ausdrücke verwenden.

## Dynamischer Import

Ähnlich wie beim [Glob-Import](#glob-import) unterstützt Vite auch dynamischen Import mit Variablen.

```ts
const module = await import(`./dir/${file}.js`)
```

Beachte, dass Variablen nur Dateinamen einer Ebene abbilden. Wenn `file` den Wert `'foo/bar'` hat, würde der Import fehlschlagen. Für fortgeschrittenere Verwendung kannst du die Funktion [Glob-Import](#glob-import) nutzen.

Beachte außerdem, dass der dynamische Import die folgenden Regeln erfüllen muss, um gebündelt zu werden:

- Importe müssen mit `./` oder `../` beginnen: ``import(`./dir/${foo}.js`)`` ist gültig, ``import(`${foo}.js`)`` jedoch nicht.
- Importe müssen mit einer Dateiendung enden: ``import(`./dir/${foo}.js`)`` ist gültig, ``import(`./dir/${foo}`)`` jedoch nicht.
- Importe in das eigene Verzeichnis müssen ein Dateinamen-Muster angeben: ``import(`./prefix-${foo}.js`)`` ist gültig, ``import(`./${foo}.js`)`` jedoch nicht.

Diese Regeln werden durchgesetzt, um zu verhindern, dass versehentlich Dateien importiert werden, die nicht gebündelt werden sollen. Ohne diese Regeln würde `import(foo)` zum Beispiel alles im Dateisystem bündeln.

## WebAssembly

Vite unterstützt den Import vorkompilierter `.wasm`-Dateien auf zwei Wegen: direkt als [ES-Modul](#esm-integration), wenn du nur die Exporte des Moduls benötigst, oder mit [`?init`](#manual-initialization), wenn du explizite Kontrolle über die Instanziierung brauchst.

### ESM-Integration

Eine `.wasm`-Datei kann direkt importiert werden. Vite liest die Importe und Exporte des Moduls aus der Binärdatei, instanziiert es und stellt seine Exporte erneut als benannte ES-Modul-Exporte bereit:

```js
import { add } from './add.wasm'

console.log(add(1, 2)) // 3
```

Wenn das WebAssembly-Modul eigene Importe deklariert, löst Vite diese aus JavaScript-Modulen auf. Der Modulname jedes Imports wird als Import-Spezifizierer behandelt (aufgelöst relativ zur `.wasm`-Datei), und die angeforderten Member werden automatisch in die Instanz eingebunden.

Das folgt dem [Vorschlag WebAssembly/ES Module Integration](https://github.com/WebAssembly/esm-integration). Da ein WebAssembly-Modul asynchron instanziiert wird, verhält sich eine direkt importierte `.wasm`-Datei wie ein Async-Modul und erfordert Unterstützung für Top-Level-`await`.

::: tip TypeScript-Unterstützung

Da die Typen von `.wasm`-Dateien unbekannt sind, meldet TypeScript Fehler wie `Module '"*.wasm"' has no exported member 'add'`. Um das zu beheben, aktiviere [`allowArbitraryExtensions`](https://www.typescriptlang.org/tsconfig/#allowArbitraryExtensions) in deiner `tsconfig.json` und lege eine Deklarationsdatei neben deiner `.wasm`-Datei an. Mit aktiviertem `allowArbitraryExtensions` sucht TypeScript beim Auflösen eines `.wasm`-Imports nach einer Deklarationsdatei mit dem Namen `{filename}.d.wasm.ts`. Lege zum Beispiel für `add.wasm` die Datei `add.d.wasm.ts` an:

```ts [add.d.wasm.ts]
export function add(a: number, b: number): number
```

:::

### Manuelle Initialisierung

Wenn du Kontrolle darüber brauchst, wann und wie das Modul instanziiert wird, importiere es mit `?init`. Der Default-Export ist dann eine Initialisierungsfunktion, die ein Promise auf die [`WebAssembly.Instance`](https://developer.mozilla.org/en-US/docs/WebAssembly/JavaScript_interface/Instance) zurückgibt:

```js twoslash
import 'vite/client'
// ---cut---
import init from './example.wasm?init'

init().then((instance) => {
  instance.exports.test()
})
```

Die init-Funktion kann außerdem ein importObject entgegennehmen, das als zweites Argument an [`WebAssembly.instantiate`](https://developer.mozilla.org/en-US/docs/WebAssembly/JavaScript_interface/instantiate) weitergereicht wird:

```js twoslash
import 'vite/client'
import init from './example.wasm?init'
// ---cut---
init({
  imports: {
    someFunc: () => {
      /* ... */
    },
  },
}).then(() => {
  /* ... */
})
```

Im Produktions-Build werden `.wasm`-Dateien, die kleiner als `assetsInlineLimit` sind, als base64-Strings eingebettet. Andernfalls werden sie als [statisches Asset](./assets) behandelt und bei Bedarf abgerufen.

::: warning Für SSR-Builds werden nur Node.js-kompatible Runtimes unterstützt

Da es keinen universellen Weg gibt, eine Datei zu laden, stützt sich die interne Implementierung sowohl direkter `.wasm`-Importe als auch von `.wasm?init` auf das Modul `node:fs`. Das bedeutet, dass diese Funktionen bei SSR-Builds nur in Node.js-kompatiblen Runtimes funktionieren.

:::

### Zugriff auf das WebAssembly-Modul

Wenn du Zugriff auf das `Module`-Objekt brauchst, z. B. um es mehrfach zu instanziieren, verwende einen [expliziten URL-Import](./assets#explicit-url-imports), um das Asset aufzulösen, und führe dann die Instanziierung durch:

```js twoslash
import 'vite/client'
// ---cut---
import wasmUrl from 'foo.wasm?url'

const main = async () => {
  const responsePromise = fetch(wasmUrl)
  const { module, instance } =
    await WebAssembly.instantiateStreaming(responsePromise)
  /* ... */
}

main()
```

## Web Worker

### Import mit Konstruktoren

Ein Web-Worker-Skript kann über [`new Worker()`](https://developer.mozilla.org/en-US/docs/Web/API/Worker/Worker) und [`new SharedWorker()`](https://developer.mozilla.org/en-US/docs/Web/API/SharedWorker/SharedWorker) importiert werden. Verglichen mit den Worker-Suffixen liegt diese Syntax näher an den Standards und ist der **empfohlene** Weg, Worker zu erzeugen.

```ts
const worker = new Worker(new URL('./worker.js', import.meta.url))
```

Der Worker-Konstruktor akzeptiert außerdem Optionen, mit denen sich „module“-Worker erzeugen lassen:

```ts
const worker = new Worker(new URL('./worker.js', import.meta.url), {
  type: 'module',
})
```

Die Worker-Erkennung funktioniert nur, wenn der Konstruktor `new URL()` direkt innerhalb der `new Worker()`-Deklaration verwendet wird. Andernfalls wird sie stattdessen als [statische Asset-URL](./assets#new-url-url-import-meta-url) behandelt. Zusätzlich müssen alle Optionsparameter statische Werte sein (also String-Literale).

### Import mit Query-Suffixen

Ein Web-Worker-Skript kann direkt importiert werden, indem `?worker` oder `?sharedworker` an den Import angehängt wird. Der Default-Export ist dann ein eigener Worker-Konstruktor:

```js twoslash
import 'vite/client'
// ---cut---
import MyWorker from './worker?worker'

const worker = new MyWorker()
```

Das Worker-Skript kann außerdem ESM-`import`-Anweisungen statt `importScripts()` verwenden. **Hinweis**: Während der Entwicklung setzt das auf [native Browser-Unterstützung](https://caniuse.com/?search=module%20worker), im Produktions-Build wird es jedoch wegkompiliert.

Standardmäßig wird das Worker-Skript im Produktions-Build als separater Chunk ausgegeben. Wenn du den Worker als base64-String einbetten möchtest, ergänze die Query `inline`:

```js twoslash
import 'vite/client'
// ---cut---
import MyWorker from './worker?worker&inline'
```

Wenn du den Worker als URL erhalten möchtest, ergänze die Query `url`:

```js twoslash
import 'vite/client'
// ---cut---
import MyWorker from './worker?worker&url'
```

Details zur Konfiguration des Bündelns aller Worker findest du unter [Worker Options](/config/worker-options.md).

## Content Security Policy (CSP)

Um eine CSP auszurollen, müssen aufgrund von Vites Interna bestimmte Direktiven oder Konfigurationen gesetzt werden.

### [`'nonce-{RANDOM}'`](https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Content-Security-Policy/Sources#nonce-base64-value)

Wenn [`html.cspNonce`](/config/shared-options#html-cspnonce) gesetzt ist, fügt Vite allen `<script>`- und `<style>`-Tags sowie `<link>`-Tags für Stylesheets und Modul-Preloading ein nonce-Attribut mit dem angegebenen Wert hinzu. Zusätzlich injiziert Vite bei gesetzter Option ein meta-Tag (`<meta property="csp-nonce" nonce="PLACEHOLDER" />`).

Der nonce-Wert eines meta-Tags mit `property="csp-nonce"` wird von Vite bei Bedarf sowohl im Dev-Modus als auch nach dem Build verwendet.

:::warning
Stelle sicher, dass du den Platzhalter für jeden Request durch einen eindeutigen Wert ersetzt. Das ist wichtig, um zu verhindern, dass die Policy einer Ressource umgangen wird, was andernfalls leicht möglich ist.
:::

### [`data:`](<https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Content-Security-Policy/Sources#scheme-source:~:text=schemes%20(not%20recommended).-,data%3A,-Allows%20data%3A>)

Standardmäßig bettet Vite beim Build kleine Assets als Data-URIs ein. Es ist notwendig, `data:` für die betreffenden Direktiven zu erlauben (z. B. [`img-src`](https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Content-Security-Policy/img-src), [`font-src`](https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Content-Security-Policy/font-src)) oder es durch Setzen von [`build.assetsInlineLimit: 0`](/config/build-options#build-assetsinlinelimit) zu deaktivieren.

:::warning
Erlaube `data:` nicht für [`script-src`](https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Content-Security-Policy/script-src). Das würde die Einschleusung beliebiger Skripte ermöglichen.
:::

## Lizenz

Vite kann mit der Option [`build.license`](/config/build-options.md#build-license) eine Datei mit allen Lizenzen der im Build verwendeten Abhängigkeiten erzeugen. Sie kann gehostet werden, um die von der App genutzten Abhängigkeiten anzuzeigen und anzuerkennen.

```js twoslash [vite.config.js]
import { defineConfig } from 'vite'

export default defineConfig({
  build: {
    license: true,
  },
})
```

Damit wird eine Datei `.vite/license.md` erzeugt, deren Ausgabe etwa so aussehen kann:

```md
# Licenses

The app bundles dependencies which contain the following licenses:

## dep-1 - 1.2.3 (CC0-1.0)

CC0 1.0 Universal

...

## dep-2 - 4.5.6 (MIT)

MIT License

...
```

Um die Datei unter einem anderen Pfad auszuliefern, kannst du zum Beispiel `{ fileName: 'license.md' }` übergeben, sodass sie unter `https://example.com/license.md` ausgeliefert wird. Weitere Informationen findest du in der Dokumentation zu [`build.license`](/config/build-options.md#build-license).

## Build-Optimierungen

> Die unten aufgeführten Funktionen werden im Rahmen des Build-Prozesses automatisch angewendet (mit Ausnahme der experimentellen Chunk-Import-Map-Funktion), und es ist keine explizite Konfiguration nötig, sofern du sie nicht deaktivieren möchtest.

### CSS-Code-Splitting

Vite extrahiert automatisch das von Modulen in einem Async-Chunk verwendete CSS und erzeugt dafür eine separate Datei. Die CSS-Datei wird automatisch über ein `<link>`-Tag geladen, wenn der zugehörige Async-Chunk geladen wird, und es ist garantiert, dass der Async-Chunk erst nach dem Laden des CSS ausgewertet wird, um [FOUC](https://en.wikipedia.org/wiki/Flash_of_unstyled_content#:~:text=A%20flash%20of%20unstyled%20content,before%20all%20information%20is%20retrieved.) zu vermeiden.

Wenn du stattdessen möchtest, dass das gesamte CSS in eine einzige Datei extrahiert wird, kannst du das CSS-Code-Splitting deaktivieren, indem du [`build.cssCodeSplit`](/config/build-options.md#build-csscodesplit) auf `false` setzt.

### Erzeugung von Preload-Direktiven

Vite erzeugt im gebauten HTML automatisch `<link rel="modulepreload">`-Direktiven für Einstiegs-Chunks und deren direkte Importe.

### Optimierung des Ladens von Async-Chunks

In realen Anwendungen erzeugt Rollup häufig „gemeinsame“ Chunks – Code, der von zwei oder mehr anderen Chunks geteilt wird. In Kombination mit dynamischen Importen ist folgendes Szenario recht verbreitet:

<script setup>
import graphSvg from '../images/graph.svg?raw'
</script>
<svg-image :svg="graphSvg" />

In den nicht optimierten Szenarien muss der Browser beim Import des Async-Chunks `A` erst `A` anfordern und parsen, bevor er feststellen kann, dass er auch den gemeinsamen Chunk `C` benötigt. Das führt zu einem zusätzlichen Netzwerk-Roundtrip:

```
Entry ---> A ---> C
```

Vite schreibt code-gesplittete dynamische Import-Aufrufe automatisch mit einem Preload-Schritt um, sodass beim Anfordern von `A` auch `C` **parallel** geladen wird:

```
Entry ---> (A + C)
```

`C` kann seinerseits weitere Importe haben, was im nicht optimierten Szenario zu noch mehr Roundtrips führen würde. Vites Optimierung verfolgt alle direkten Importe, um die Roundtrips unabhängig von der Import-Tiefe vollständig zu eliminieren.

### Chunk-Import-Map-Optimierung

Um die Cache-Trefferquote von Chunks zu verbessern, kann Vite eine Import Map für Chunks erzeugen. Das verhindert das Problem der kaskadierenden Cache-Invalidierung, das bei ES Modules auftritt.

Betrachte zum Beispiel das folgende Szenario:

```
Entry --> A ---> C
```

Wenn `C` aktualisiert wird, ist der einzige Chunk, der zwingend invalidiert werden muss, `C`. Wenn `A` jedoch in einem statischen Import über eine gewöhnliche URL auf `C` verweist (die URL enthält also den Hash von `C`), ändert sich der Inhalt von `A`, sodass auch `A` invalidiert werden müsste. Dasselbe gilt für `Entry`.

Durch Nutzung der Import-Maps-Funktion lässt sich dieses Problem vermeiden. Ist diese Optimierung aktiviert, erzeugt Vite eine Import Map, die die ID jedes Chunks auf seine URL abbildet, und verwendet in den Import-Anweisungen die Chunk-ID statt der URL. Wird ein Chunk aktualisiert, muss so nur der aktualisierte Chunk invalidiert werden, während die Chunks, die ihn referenzieren, nicht invalidiert werden.

Beachte, dass diese Optimierung derzeit nicht für CSS und Assets gilt. Wenn du ein Asset aktualisierst, werden die Chunks invalidiert, die es referenzieren. Allerdings kaskadiert die Invalidierung nicht, und der Chunk, der den invalidierten Chunk importiert, wird nicht invalidiert.

Um diese Funktion zu aktivieren, setze [`build.chunkImportMap`](/config/build-options.md#build-chunkimportmap) auf `true`.
