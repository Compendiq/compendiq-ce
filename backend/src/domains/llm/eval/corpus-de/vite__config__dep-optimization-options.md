# Optionen zur Dependency-Optimierung

- **Verwandt:** [Dependency Pre-Bundling](/guide/dep-pre-bundling)

Sofern nicht anders vermerkt, gelten die Optionen in diesem Abschnitt nur für den Dependency-Optimizer, der ausschließlich im Dev-Modus verwendet wird.

## optimizeDeps.entries <NonInheritBadge />

- **Typ:** `string | string[]`

Standardmäßig durchsucht Vite alle deine `.html`-Dateien, um Abhängigkeiten zu erkennen, die vorgebündelt werden müssen (dabei werden `node_modules`, `build.outDir`, `__tests__` und `coverage` ignoriert). Ist auf oberster Ebene [`input`](/config/shared-options#input) oder `build.rolldownOptions.input` angegeben, durchsucht Vite stattdessen diese Einstiegspunkte.

Wenn keines davon deinen Anforderungen entspricht, kannst du mit dieser Option eigene Einträge angeben – der Wert sollte ein [`tinyglobby`-Pattern](https://superchupu.dev/tinyglobby/comparison) oder ein Array von Patterns sein, jeweils relativ zum Vite-Projekt-Root. Damit wird die standardmäßige Ermittlung der Einträge überschrieben. Nur die Ordner `node_modules` und `build.outDir` werden standardmäßig ignoriert, wenn `optimizeDeps.entries` explizit definiert ist. Sollen weitere Ordner ignoriert werden, kannst du ein Ignore-Pattern als Teil der Eintragsliste verwenden, gekennzeichnet durch ein führendes `!`. `node_modules` wird bei Patterns, die die Zeichenfolge `node_modules` ausdrücklich enthalten, nicht ignoriert.

## optimizeDeps.exclude <NonInheritBadge />

- **Typ:** `string[]`

Abhängigkeiten, die vom Pre-Bundling ausgeschlossen werden sollen.

:::warning CommonJS
CommonJS-Abhängigkeiten sollten nicht von der Optimierung ausgeschlossen werden. Wird eine ESM-Abhängigkeit von der Optimierung ausgeschlossen, hat aber eine verschachtelte CommonJS-Abhängigkeit, sollte die CommonJS-Abhängigkeit zu `optimizeDeps.include` hinzugefügt werden. Beispiel:

```js twoslash
import { defineConfig } from 'vite'
// ---cut---
export default defineConfig({
  optimizeDeps: {
    include: ['esm-dep > cjs-dep'],
  },
})
```

:::

## optimizeDeps.include <NonInheritBadge />

- **Typ:** `string[]`

Standardmäßig werden verlinkte Pakete außerhalb von `node_modules` nicht vorgebündelt. Verwende diese Option, um das Pre-Bundling eines verlinkten Pakets zu erzwingen.

**Experimentell:** Wenn du eine Bibliothek mit vielen tiefen Imports verwendest, kannst du auch ein abschließendes Glob-Pattern angeben, um alle tiefen Imports auf einmal vorzubündeln. Damit wird vermieden, dass ständig neu vorgebündelt wird, sobald ein neuer tiefer Import verwendet wird. [Gib Feedback](https://github.com/vitejs/vite/discussions/15833). Zum Beispiel:

```js twoslash
import { defineConfig } from 'vite'
// ---cut---
export default defineConfig({
  optimizeDeps: {
    include: ['my-lib/components/**/*.vue'],
  },
})
```

## optimizeDeps.rolldownOptions <NonInheritBadge />

- **Typ:** <code>Omit<<a href="https://rolldown.rs/reference/Interface.RolldownOptions">RolldownOptions</a>, 'input' | 'logLevel' | 'output'> & { output?: Omit<<a href="https://rolldown.rs/reference/#:~:text=Output%20Options">RolldownOutputOptions</a>, 'format' | 'sourcemap' | 'dir' | 'banner'> }</code>

Optionen, die während des Dep-Scannings und der Optimierung an Rolldown übergeben werden.

Bestimmte Optionen sind ausgelassen, da ihre Änderung nicht mit Vites Dep-Optimierung kompatibel wäre.

- `plugins` werden mit Vites Dep-Plugin zusammengeführt

## optimizeDeps.esbuildOptions <NonInheritBadge />

- **Typ:** <code>Omit<<a href="https://esbuild.github.io/api/#general-options">EsbuildBuildOptions</a>, 'bundle' | 'entryPoints' | 'external' | 'write' | 'watch' | 'outdir' | 'outfile' | 'outbase' | 'outExtension' | 'metafile'></code>
- **Deprecated**

Diese Option wird intern in `optimizeDeps.rolldownOptions` überführt. Verwende stattdessen `optimizeDeps.rolldownOptions`.

## optimizeDeps.force <NonInheritBadge />

- **Typ:** `boolean`

Auf `true` setzen, um das Pre-Bundling von Abhängigkeiten zu erzwingen und zuvor zwischengespeicherte optimierte Abhängigkeiten zu ignorieren.

## optimizeDeps.noDiscovery <NonInheritBadge />

- **Typ:** `boolean`
- **Standard:** `false`

Ist dies auf `true` gesetzt, wird die automatische Erkennung von Abhängigkeiten deaktiviert und nur die in `optimizeDeps.include` aufgeführten Abhängigkeiten werden optimiert. Reine CJS-Abhängigkeiten müssen im Dev-Modus in `optimizeDeps.include` enthalten sein.

## optimizeDeps.holdUntilCrawlEnd <NonInheritBadge />

- **Experimentell:** [Gib Feedback](https://github.com/vitejs/vite/discussions/15834)
- **Typ:** `boolean`
- **Standard:** `true`

Ist dies aktiviert, werden die ersten Ergebnisse der optimierten Abhängigkeiten zurückgehalten, bis beim Kaltstart alle statischen Imports durchsucht wurden. Damit werden vollständige Seiten-Reloads vermieden, wenn neue Abhängigkeiten entdeckt werden und diese die Erzeugung neuer gemeinsamer Chunks auslösen. Werden alle Abhängigkeiten vom Scanner gefunden, zusammen mit den in `include` explizit definierten, ist es besser, diese Option zu deaktivieren, damit der Browser mehr Requests parallel verarbeiten kann.

## optimizeDeps.disabled <NonInheritBadge />

- **Deprecated**
- **Experimentell:** [Gib Feedback](https://github.com/vitejs/vite/discussions/13839)
- **Typ:** `boolean | 'build' | 'dev'`
- **Standard:** `'build'`

Diese Option ist deprecated. Seit Vite 5.1 wurde das Pre-Bundling von Abhängigkeiten während des Builds entfernt. `optimizeDeps.disabled` auf `true` oder `'dev'` zu setzen deaktiviert den Optimizer; auf `false` oder `'build'` gesetzt bleibt der Optimizer im Dev-Modus aktiviert.

Um den Optimizer vollständig zu deaktivieren, verwende `optimizeDeps.noDiscovery: true`, um die automatische Erkennung von Abhängigkeiten zu unterbinden, und lasse `optimizeDeps.include` undefiniert oder leer.

:::warning
Das Optimieren von Abhängigkeiten zur Build-Zeit war eine **experimentelle** Funktion. Projekte, die diese Strategie ausprobiert haben, entfernten zudem `@rollup/plugin-commonjs` mittels `build.commonjsOptions: { include: [] }`. Falls du das getan hast, wird dich eine Warnung dazu anleiten, es wieder zu aktivieren, um beim Bundling reine CJS-Pakete zu unterstützen.
:::

## optimizeDeps.needsInterop <NonInheritBadge />

- **Experimentell**
- **Typ:** `string[]`

Erzwingt ESM-Interop beim Import dieser Abhängigkeiten. Vite kann in der Regel korrekt erkennen, wann eine Abhängigkeit Interop benötigt, daher wird diese Option meist nicht gebraucht. Allerdings können unterschiedliche Kombinationen von Abhängigkeiten dazu führen, dass einige von ihnen anders vorgebündelt werden. Diese Pakete zu `needsInterop` hinzuzufügen kann den Kaltstart beschleunigen, indem vollständige Seiten-Reloads vermieden werden. Du erhältst eine Warnung, falls dies auf eine deiner Abhängigkeiten zutrifft, mit dem Vorschlag, den Paketnamen diesem Array in deiner Konfiguration hinzuzufügen.
