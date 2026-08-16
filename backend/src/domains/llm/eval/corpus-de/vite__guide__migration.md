# Migration von v7

Wenn Sie von `rolldown-vite` migrieren – dem Technical-Preview-Release des Rolldown-integrierten Vite für v6 und v7 –, sind nur die Abschnitte mit <Badge text="NRV" type="warning" /> im Titel relevant.

## Änderung des Standard-Browser-Targets [<Badge text="NRV" type="warning" />](#migration-from-v7)

Die Standard-Browser-Werte von `build.target` und `'baseline-widely-available'` werden auf neuere Browser-Versionen angehoben:

- Chrome 107 → 111
- Edge 107 → 111
- Firefox 104 → 114
- Safari 16.0 → 16.4

Diese Browser-Versionen entsprechen den Feature-Sets von [Baseline Widely Available](https://web-platform-dx.github.io/baseline/) mit Stand 2026-01-01. Mit anderen Worten: Sie wurden alle vor etwa zweieinhalb Jahren veröffentlicht.

## Rolldown

Vite 8 verwendet Werkzeuge auf Basis von [Rolldown](https://rolldown.rs/) und [Oxc](https://oxc.rs/) anstelle von [esbuild](https://esbuild.github.io/) und [Rollup](https://rollupjs.org/).

### Schrittweise Migration

Das Paket `rolldown-vite` setzt Vite 7 mit Rolldown um, ohne die übrigen Änderungen von Vite 8. Es lässt sich als Zwischenschritt für die Migration auf Vite 8 nutzen. Wie Sie von Vite 7 auf `rolldown-vite` wechseln, beschreibt [der Leitfaden zur Rolldown-Integration](https://v7.vite.dev/guide/rolldown) in den Vite-7-Docs.

Wer von `rolldown-vite` auf Vite 8 migriert, kann die Änderungen an den Abhängigkeiten in der `package.json` zurücknehmen und auf Vite 8 aktualisieren:

```json
{
  "devDependencies": {
    "vite": "npm:rolldown-vite@7.2.2" // [!code --]
    "vite": "^8.0.0" // [!code ++]
  }
}
```

### Der Dependency Optimizer verwendet nun Rolldown

Für die Optimierung von Abhängigkeiten wird nun Rolldown statt esbuild verwendet. Vite unterstützt [`optimizeDeps.esbuildOptions`](/config/dep-optimization-options#optimizedeps-esbuildoptions) aus Gründen der Rückwärtskompatibilität weiterhin, indem es die Option automatisch nach [`optimizeDeps.rolldownOptions`](/config/dep-optimization-options#optimizedeps-rolldownoptions) übersetzt. `optimizeDeps.esbuildOptions` ist nun deprecated und wird künftig entfernt; wir empfehlen die Migration zu `optimizeDeps.rolldownOptions`.

Die folgenden Optionen werden automatisch übersetzt:

- [`esbuildOptions.minify`](https://esbuild.github.io/api/#minify) -> [`rolldownOptions.output.minify`](https://rolldown.rs/reference/OutputOptions.minify)
- [`esbuildOptions.treeShaking`](https://esbuild.github.io/api/#tree-shaking) -> [`rolldownOptions.treeshake`](https://rolldown.rs/reference/InputOptions.treeshake)
- [`esbuildOptions.define`](https://esbuild.github.io/api/#define) -> [`rolldownOptions.transform.define`](https://rolldown.rs/reference/InputOptions.transform#define)
- [`esbuildOptions.loader`](https://esbuild.github.io/api/#loader) -> [`rolldownOptions.moduleTypes`](https://rolldown.rs/reference/InputOptions.moduleTypes)
- [`esbuildOptions.preserveSymlinks`](https://esbuild.github.io/api/#preserve-symlinks) -> [`!rolldownOptions.resolve.symlinks`](https://rolldown.rs/reference/InputOptions.resolve#symlinks)
- [`esbuildOptions.resolveExtensions`](https://esbuild.github.io/api/#resolve-extensions) -> [`rolldownOptions.resolve.extensions`](https://rolldown.rs/reference/InputOptions.resolve#extensions)
- [`esbuildOptions.mainFields`](https://esbuild.github.io/api/#main-fields) -> [`rolldownOptions.resolve.mainFields`](https://rolldown.rs/reference/InputOptions.resolve#mainfields)
- [`esbuildOptions.conditions`](https://esbuild.github.io/api/#conditions) -> [`rolldownOptions.resolve.conditionNames`](https://rolldown.rs/reference/InputOptions.resolve#conditionnames)
- [`esbuildOptions.keepNames`](https://esbuild.github.io/api/#keep-names) -> [`rolldownOptions.output.keepNames`](https://rolldown.rs/reference/OutputOptions.keepNames)
- [`esbuildOptions.platform`](https://esbuild.github.io/api/#platform) -> [`rolldownOptions.platform`](https://rolldown.rs/reference/InputOptions.platform)
- [`esbuildOptions.plugins`](https://esbuild.github.io/plugins/) -> [`rolldownOptions.plugins`](https://rolldown.rs/reference/InputOptions.plugins) (teilweise unterstützt)

Die von der Kompatibilitätsschicht gesetzten Optionen erhalten Sie über den Hook `configResolved`:

```js
const plugin = {
  name: 'log-config',
  configResolved(config) {
    console.log('options', config.optimizeDeps.rolldownOptions)
  },
},
```

### JavaScript-Transformationen durch Oxc

Für die JavaScript-Transformation wird nun Oxc statt esbuild verwendet. Vite unterstützt die Option [`esbuild`](/config/shared-options#esbuild) aus Gründen der Rückwärtskompatibilität weiterhin, indem es sie automatisch nach [`oxc`](/config/shared-options#oxc) übersetzt. `esbuild` ist nun deprecated und wird künftig entfernt; wir empfehlen die Migration zu `oxc`.

Die folgenden Optionen werden automatisch übersetzt:

- `esbuild.jsxInject` -> `oxc.jsxInject`
- `esbuild.include` -> `oxc.include`
- `esbuild.exclude` -> `oxc.exclude`
- [`esbuild.jsx`](https://esbuild.github.io/api/#jsx) -> [`oxc.jsx`](https://oxc.rs/docs/guide/usage/transformer/jsx)
  - `esbuild.jsx: 'preserve'` -> `oxc.jsx: 'preserve'`
  - `esbuild.jsx: 'automatic'` -> `oxc.jsx: { runtime: 'automatic' }`
    - [`esbuild.jsxImportSource`](https://esbuild.github.io/api/#jsx-import-source) -> `oxc.jsx.importSource`
  - `esbuild.jsx: 'transform'` -> `oxc.jsx: { runtime: 'classic' }`
    - [`esbuild.jsxFactory`](https://esbuild.github.io/api/#jsx-factory) -> `oxc.jsx.pragma`
    - [`esbuild.jsxFragment`](https://esbuild.github.io/api/#jsx-fragment) -> `oxc.jsx.pragmaFrag`
  - [`esbuild.jsxDev`](https://esbuild.github.io/api/#jsx-dev) -> `oxc.jsx.development`
  - [`esbuild.jsxSideEffects`](https://esbuild.github.io/api/#jsx-side-effects) -> `oxc.jsx.pure`
- [`esbuild.define`](https://esbuild.github.io/api/#define) -> [`oxc.define`](https://oxc.rs/docs/guide/usage/transformer/global-variable-replacement#define)
- [`esbuild.banner`](https://esbuild.github.io/api/#banner) -> eigenes Plugin mit transform-Hook
- [`esbuild.footer`](https://esbuild.github.io/api/#footer) -> eigenes Plugin mit transform-Hook

Die Option [`esbuild.supported`](https://esbuild.github.io/api/#supported) wird von Oxc nicht unterstützt. Wenn Sie diese Option benötigen, sehen Sie sich bitte [oxc-project/oxc#15373](https://github.com/oxc-project/oxc/issues/15373) an.

Die von der Kompatibilitätsschicht gesetzten Optionen erhalten Sie über den Hook `configResolved`:

```js
const plugin = {
  name: 'log-config',
  configResolved(config) {
    console.log('options', config.oxc)
  },
},
```

Derzeit unterstützt der Oxc-Transformer das Lowering nativer Decorators nicht, da wir auf den Fortschritt der Spezifikation warten, siehe ([oxc-project/oxc#9170](https://github.com/oxc-project/oxc/issues/9170)).

:::: details Workaround für das Lowering nativer Decorators

Sie können vorerst [Babel](https://babeljs.io/) oder [SWC](https://swc.rs/) verwenden, um native Decorators zu lowern.

**Mit Babel:**

::: code-group

```bash [npm]
$ npm install -D @rolldown/plugin-babel @babel/plugin-proposal-decorators
```

```bash [Yarn]
$ yarn add -D @rolldown/plugin-babel @babel/plugin-proposal-decorators
```

```bash [pnpm]
$ pnpm add -D @rolldown/plugin-babel @babel/plugin-proposal-decorators
```

```bash [Bun]
$ bun add -D @rolldown/plugin-babel @babel/plugin-proposal-decorators
```

```bash [Deno]
$ deno add -D npm:@rolldown/plugin-babel npm:@babel/plugin-proposal-decorators
```

:::

```ts [vite.config.ts]
import { defineConfig } from 'vite'
import babel from '@rolldown/plugin-babel'

function decoratorPreset(options: Record<string, unknown>) {
  return {
    preset: () => ({
      plugins: [['@babel/plugin-proposal-decorators', options]],
    }),
    rolldown: {
      // Only run this transform if the file contains a decorator.
      filter: {
        code: '@',
      },
    },
  }
}

export default defineConfig({
  plugins: [babel({ presets: [decoratorPreset({ version: '2023-11' })] })],
})
```

**Mit SWC:**

::: code-group

```bash [npm]
$ npm install -D @rollup/plugin-swc @swc/core
```

```bash [Yarn]
$ yarn add -D @rollup/plugin-swc @swc/core
```

```bash [pnpm]
$ pnpm add -D @rollup/plugin-swc @swc/core
```

```bash [Bun]
$ bun add -D @rollup/plugin-swc @swc/core
```

```bash [Deno]
$ deno add -D npm:@rollup/plugin-swc npm:@swc/core
```

:::

```js
import { defineConfig, withFilter } from 'vite'
import swc from '@rollup/plugin-swc'

export default defineConfig({
  // ...
  plugins: [
    withFilter(
      swc({
        swc: {
          jsc: {
            parser: { decorators: true, decoratorsBeforeExport: true },
            transform: { decoratorVersion: '2023-11' },
          },
        },
      }),
      // Only run this transform if the file contains a decorator.
      { transform: { code: '@' } },
    ),
  ],
})
```

::::

#### esbuild-Fallbacks

`esbuild` wird von Vite nicht mehr direkt verwendet und ist nun eine optionale Abhängigkeit. Wenn Sie ein Plugin einsetzen, das die Funktion `transformWithEsbuild` verwendet, müssen Sie `esbuild` als `devDependency` installieren. Die Funktion `transformWithEsbuild` ist deprecated und wird künftig entfernt. Wir empfehlen stattdessen die Migration zur neuen Funktion `transformWithOxc`.

### JavaScript-Minifizierung durch Oxc

Für die JavaScript-Minifizierung wird nun der Oxc Minifier statt esbuild verwendet. Über die deprecatete Option [`build.minify: 'esbuild'`](/config/build-options#build-minify) können Sie zu esbuild zurückwechseln. Diese Konfigurationsoption wird künftig entfernt, und Sie müssen `esbuild` als `devDependency` installieren, da Vite nicht mehr direkt auf esbuild setzt.

Wenn Sie die Optionen `esbuild.minify*` genutzt haben, um das Minifizierungsverhalten zu steuern, können Sie nun stattdessen `build.rolldownOptions.output.minify` verwenden. Wenn Sie die Option `esbuild.drop` genutzt haben, stehen Ihnen nun die [Optionen `build.rolldownOptions.output.minify.compress.drop*`](https://oxc.rs/docs/guide/usage/minifier/dead-code-elimination) zur Verfügung.

Property Mangling und die zugehörigen Optionen ([`mangleProps`, `reserveProps`, `mangleQuoted`, `mangleCache`](https://esbuild.github.io/api/#mangle-props)) werden von Oxc nicht unterstützt. Wenn Sie diese Optionen benötigen, sehen Sie sich bitte [oxc-project/oxc#15375](https://github.com/oxc-project/oxc/issues/15375) an.

esbuild und der Oxc Minifier treffen leicht unterschiedliche Annahmen über den Quellcode. Falls Sie vermuten, dass der Minifier Ihren Code kaputt macht, können Sie diese Annahmen hier vergleichen:

- [Minify-Annahmen von esbuild](https://esbuild.github.io/api/#minify-considerations)
- [Annahmen des Oxc Minifier](https://github.com/oxc-project/oxc/blob/main/crates/oxc_minifier/docs/ASSUMPTIONS.md)

Bitte melden Sie alle Probleme, die Ihnen im Zusammenhang mit der Minifizierung Ihrer JavaScript-Apps auffallen.

### CSS-Minifizierung durch Lightning CSS

Für die CSS-Minifizierung wird nun standardmäßig [Lightning CSS](https://lightningcss.dev/) verwendet. Über die Option [`build.cssMinify: 'esbuild'`](/config/build-options#build-cssminify) können Sie zu esbuild zurückwechseln. Beachten Sie, dass Sie `esbuild` als `devDependency` installieren müssen.

Lightning CSS unterstützt besseres Syntax-Lowering, und die Größe Ihres CSS-Bundles kann dadurch leicht zunehmen.

### Konsistente CommonJS-Interoperabilität

Der `default`-Import aus einem CommonJS-Modul (CJS) wird nun einheitlich behandelt.

Trifft eine der folgenden Bedingungen zu, ist der `default`-Import der Wert von `module.exports` des importierten CJS-Moduls. Andernfalls ist der `default`-Import der Wert von `module.exports.default` des importierten CJS-Moduls:

- Der Importeur ist `.mjs` oder `.mts`.
- Die nächstgelegene `package.json` des Importeurs hat das Feld `type` auf `module` gesetzt.
- Der Wert `module.exports.__esModule` des importierten CJS-Moduls ist nicht auf `true` gesetzt.

::: details Das bisherige Verhalten

In der Entwicklung war der `default`-Import der Wert von `module.exports` des importierten CJS-Moduls, wenn eine der folgenden Bedingungen zutraf. Andernfalls war der `default`-Import der Wert von `module.exports.default` des importierten CJS-Moduls:

- _Der Importeur ist Teil der Abhängigkeitsoptimierung_ und ist `.mjs` oder `.mts`.
- _Der Importeur ist Teil der Abhängigkeitsoptimierung_ und die nächstgelegene `package.json` des Importeurs hat das Feld `type` auf `module` gesetzt.
- Der Wert `module.exports.__esModule` des importierten CJS-Moduls ist nicht auf `true` gesetzt.

Im Build lauteten die Bedingungen:

- Der Wert `module.exports.__esModule` des importierten CJS-Moduls ist nicht auf `true` gesetzt.
- _Die Eigenschaft `default` von `module.exports` existiert nicht_.

(unter der Annahme, dass [`build.commonjsOptions.defaultIsModuleExports`](https://github.com/rollup/plugins/tree/master/packages/commonjs#defaultismoduleexports) nicht vom Standardwert `'auto'` abweicht)

:::

Weitere Details zu diesem Problem finden Sie in den Rolldown-Docs: [Ambiguous `default` import from CJS modules - Bundling CJS | Rolldown](https://rolldown.rs/in-depth/bundling-cjs#ambiguous-default-import-from-cjs-modules).

Diese Änderung kann bestehenden Code, der CJS-Module importiert, unbrauchbar machen. Über die deprecatete Option `legacy.inconsistentCjsInterop: true` können Sie das bisherige Verhalten vorübergehend wiederherstellen. Wenn Sie ein von dieser Änderung betroffenes Paket finden, melden Sie es bitte den Autorinnen und Autoren des Pakets oder senden Sie ihnen einen Pull Request. Verlinken Sie dabei die obige Rolldown-Dokumentation, damit sie den Kontext nachvollziehen können.

### Entfernte Modulauflösung per Format-Sniffing

Waren in der `package.json` sowohl das Feld `browser` als auch `module` vorhanden, löste Vite das Feld bislang anhand des Dateiinhalts auf und wählte für Browser die ESM-Datei. Das wurde eingeführt, weil manche Pakete das Feld `module` verwendeten, um auf ESM-Dateien für Node.js zu zeigen, und andere das Feld `browser`, um auf UMD-Dateien für Browser zu zeigen. Da das moderne Feld `exports` dieses Problem löst und inzwischen von vielen Paketen genutzt wird, verwendet Vite diese Heuristik nicht mehr und respektiert stets die Reihenfolge der Option [`resolve.mainFields`](/config/shared-options#resolve-mainfields). Wenn Sie sich auf dieses Verhalten verlassen haben, können Sie über die Option [`resolve.alias`](/config/shared-options#resolve-alias) das Feld auf die gewünschte Datei abbilden oder mit Ihrem Paketmanager einen Patch anwenden (z. B. `patch-package`, `pnpm patch`).

### `require`-Aufrufe für externalisierte Module

`require`-Aufrufe für externalisierte Module bleiben nun als `require`-Aufrufe erhalten und werden nicht in `import`-Anweisungen umgewandelt. So bleibt die Semantik von `require`-Aufrufen erhalten. Wenn Sie sie in `import`-Anweisungen umwandeln möchten, können Sie [Rolldowns eingebautes `esmExternalRequirePlugin`](https://rolldown.rs/builtin-plugins/esm-external-require) verwenden, das aus `vite` re-exportiert wird.

```js
import { defineConfig, esmExternalRequirePlugin } from 'vite'

export default defineConfig({
  // ...
  plugins: [
    esmExternalRequirePlugin({
      external: ['react', 'vue', /^node:/],
    }),
  ],
})
```

Weitere Details finden Sie in den Rolldown-Docs: [`require` external modules - Bundling CJS | Rolldown](https://rolldown.rs/in-depth/bundling-cjs#require-external-modules).

### `import.meta.url` in UMD / IIFE

`import.meta.url` wird in den Ausgabeformaten UMD / IIFE nicht mehr polyfilled. Es wird standardmäßig durch `undefined` ersetzt. Wenn Sie das bisherige Verhalten bevorzugen, können Sie die Option [`define`](/config/shared-options#define) zusammen mit der Option [`build.rolldownOptions.output.intro`](https://rolldown.rs/reference/OutputOptions.intro) verwenden. Weitere Details finden Sie in den Rolldown-Docs: [Well-known `import.meta` properties - Non ESM Output Formats | Rolldown](https://rolldown.rs/in-depth/non-esm-output-formats#well-known-import-meta-properties).

### Entfernte Option `build.rollupOptions.watch.chokidar`

Die Option `build.rollupOptions.watch.chokidar` wurde entfernt. Bitte migrieren Sie zur Option [`build.rolldownOptions.watch.watcher`](https://rolldown.rs/reference/InputOptions.watch#watcher).

### Objektform von `build.rollupOptions.output.manualChunks` entfernt, Funktionsform deprecated

Die Objektform der Option `output.manualChunks` wird nicht mehr unterstützt. Die Funktionsform von `output.manualChunks` ist deprecated. Rolldown bietet die flexiblere Option [`codeSplitting`](https://rolldown.rs/reference/OutputOptions.codeSplitting). Weitere Details zu `codeSplitting` finden Sie in den Rolldown-Docs: [Manual Code Splitting - Rolldown](https://rolldown.rs/in-depth/manual-code-splitting).

### `build()` wirft `BundleError`

_Diese Änderung betrifft nur Nutzende der JS-API._

`build()` wirft nun einen [`BundleError`](https://rolldown.rs/reference/TypeAlias.BundleError) statt des rohen im Plugin geworfenen Fehlers. `BundleError` ist als `Error & { errors?: RolldownError[] }` typisiert und umschließt die einzelnen Fehler in einem `errors`-Array. Wenn Sie die einzelnen Fehler benötigen, greifen Sie auf `.errors` zu:

```js
try {
  await build()
} catch (e) {
  if (e.errors) {
    for (const error of e.errors) {
      console.log(error.code) // error code
    }
  }
}
```

### Unterstützung und automatische Erkennung von Modultypen

_Diese Änderung betrifft nur Plugin-Autoren._

Rolldown bietet experimentelle Unterstützung für [Modultypen](https://rolldown.rs/guide/notable-features#module-types), ähnlich der [`loader`-Option von esbuild](https://esbuild.github.io/api/#loader). Deshalb setzt Rolldown automatisch einen Modultyp anhand der Erweiterung der aufgelösten ID. Wenn Sie in `load`- oder `transform`-Hooks Inhalte anderer Modultypen nach JavaScript umwandeln, müssen Sie dem Rückgabewert unter Umständen `moduleType: 'js'` hinzufügen:

```js
const plugin = {
  name: 'txt-loader',
  load(id) {
    if (id.endsWith('.txt')) {
      const content = fs.readFile(id, 'utf-8')
      return {
        code: `export default ${JSON.stringify(content)}`,
        moduleType: 'js', // [!code ++]
      }
    }
  },
}
```

### Weitere zugehörige Deprecations

Die folgenden Optionen sind deprecated und werden künftig entfernt:

- `build.rollupOptions`: umbenannt in `build.rolldownOptions`
- `worker.rollupOptions`: umbenannt in `worker.rolldownOptions`
- `build.commonjsOptions`: wirkungslos
- `build.dynamicImportVarsOptions.warnOnError`: wirkungslos
- `resolve.alias[].customResolver`: Verwenden Sie stattdessen ein eigenes Plugin mit dem `resolveId`-Hook und `enforce: 'pre'`

## Entfernte deprecatete Funktionen [<Badge text="NRV" type="warning" />](#migration-from-v7)

- Das Übergeben einer URL an `import.meta.hot.accept` wird nicht mehr unterstützt. Bitte übergeben Sie stattdessen eine ID. ([#21382](https://github.com/vitejs/vite/pull/21382))

## Fortgeschritten

Von diesen Breaking Changes dürfte nur eine Minderheit der Anwendungsfälle betroffen sein:

- [Extglobs](https://github.com/micromatch/picomatch/blob/master/README.md#extglobs) werden noch nicht unterstützt ([rolldown-vite#365](https://github.com/vitejs/rolldown-vite/issues/365))
- TypeScript-Legacy-Namespaces werden nur teilweise unterstützt. Weitere Details finden Sie in der [zugehörigen Dokumentation des Oxc Transformer](https://oxc.rs/docs/guide/usage/transformer/typescript.html#partial-namespace-support).
- `define` teilt keine Referenz für Objekte: Wenn Sie ein Objekt als Wert an `define` übergeben, erhält jede Variable eine eigene Kopie des Objekts. Weitere Details finden Sie in der [zugehörigen Dokumentation des Oxc Transformer](https://oxc.rs/docs/guide/usage/transformer/global-variable-replacement#define).
- Änderungen am `bundle`-Objekt (`bundle` ist ein Objekt, das in den Hooks `generateBundle` / `writeBundle` übergeben und von der Funktion `build` zurückgegeben wird):
  - Zuweisungen an `bundle[foo]` werden nicht unterstützt. Auch Rollup rät davon ab. Bitte verwenden Sie stattdessen `this.emitFile()`.
  - Die Referenz wird nicht zwischen den Hooks geteilt ([rolldown-vite#410](https://github.com/vitejs/rolldown-vite/issues/410))
  - `structuredClone(bundle)` schlägt mit `DataCloneError: #<Object> could not be cloned` fehl. Das wird nicht mehr unterstützt. Bitte klonen Sie es mit `structuredClone({ ...bundle })`. ([rolldown-vite#128](https://github.com/vitejs/rolldown-vite/issues/128))
- Alle parallelen Hooks aus Rollup arbeiten als sequenzielle Hooks. Weitere Details finden Sie in der [Dokumentation von Rolldown](https://rolldown.rs/apis/plugin-api#sequential-hook-execution).
- `"use strict";` wird manchmal nicht eingefügt. Weitere Details finden Sie in der [Dokumentation von Rolldown](https://rolldown.rs/in-depth/directives).
- Das Transformieren nach ES5 und darunter mit plugin-legacy wird nicht unterstützt ([rolldown-vite#452](https://github.com/vitejs/rolldown-vite/issues/452))
- Denselben Browser mit mehreren Versionen an die Option `build.target` zu übergeben führt nun zu einem Fehler: esbuild wählte die neueste Version davon, was vermutlich nicht Ihrer Absicht entsprach.
- Fehlende Unterstützung durch Rolldown: Die folgenden Funktionen werden von Rolldown und damit auch von Vite nicht mehr unterstützt.
  - `build.rollupOptions.output.format: 'system'` ([rolldown#2387](https://github.com/rolldown/rolldown/issues/2387))
  - `build.rollupOptions.output.format: 'amd'` ([rolldown#2528](https://github.com/rolldown/rolldown/issues/2528))
  - Hook `shouldTransformCachedModule` ([rolldown#4389](https://github.com/rolldown/rolldown/issues/4389))
  - Hook `resolveImportMeta` ([rolldown#1010](https://github.com/rolldown/rolldown/issues/1010))
  - Hook `renderDynamicImport` ([rolldown#4532](https://github.com/rolldown/rolldown/issues/4532))
  - Hook `resolveFileUrl`
- Die Funktionen `parseAst` / `parseAstAsync` sind nun zugunsten der funktionsreicheren Funktionen `parseSync` / `parse` deprecated.
- Kommentare werden vor statt nach dem `renderChunk`-Hook entfernt
- Andere als die [hier](https://rolldown.rs/reference/OutputOptions.comments) aufgeführten Kommentare werden verschoben, während Rollup Kommentare nur entfernt, wenn der angrenzende Code entfernt wird

## Migration von v6

Sehen Sie sich zunächst den [Leitfaden zur Migration von v6](https://v7.vite.dev/guide/migration) in den Vite-v7-Docs an, um die für die Portierung Ihrer App auf Vite 7 nötigen Änderungen zu ermitteln, und fahren Sie dann mit den Änderungen auf dieser Seite fort.
