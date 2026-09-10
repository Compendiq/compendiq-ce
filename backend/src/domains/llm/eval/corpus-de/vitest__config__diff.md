# diff

- **Typ:** `string`
- **CLI:** `--diff=<path>`

Ein `DiffOptions`-Objekt oder ein Pfad zu einem Modul, das `DiffOptions` exportiert. Nützlich, wenn du die Diff-Darstellung anpassen möchtest.

Die Diff-Darstellung von Vitest verwendet intern [`@vitest/pretty-format`](https://npmx.dev/package/@vitest/pretty-format); ein Teil der `DiffOptions` wird an die pretty-format-Konfiguration weitergereicht, der Rest beeinflusst die Diff-Darstellung selbst.

Zum Beispiel als Konfigurationsobjekt:

```ts
import { defineConfig } from 'vitest/config'
import c from 'picocolors'

export default defineConfig({
  test: {
    diff: {
      aIndicator: c.bold('--'),
      bIndicator: c.bold('++'),
      omitAnnotationLines: true,
    },
  },
})
```

Oder als Modul:

:::code-group
```ts [vitest.config.js]
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    diff: './vitest.diff.ts',
  },
})
```

```ts [vitest.diff.ts]
import type { DiffOptions } from 'vitest'
import c from 'picocolors'

export default {
  aIndicator: c.bold('--'),
  bIndicator: c.bold('++'),
  omitAnnotationLines: true,
} satisfies DiffOptions
```
:::

## diff.expand

- **Typ:** `boolean`
- **Standard:** `true`
- **CLI:** `--diff.expand=false`

Alle gemeinsamen Zeilen ausklappen.

## diff.truncateThreshold

- **Typ:** `number`
- **Standard:** `0`
- **CLI:** `--diff.truncateThreshold=<path>`

Die maximale Länge des anzuzeigenden Diff-Ergebnisses. Diffs oberhalb dieses Schwellenwerts werden gekürzt.
Beim Standardwert 0 findet keine Kürzung statt.

## diff.truncateAnnotation

- **Typ:** `string`
- **Standard:** `'... Diff result is truncated'`
- **CLI:** `--diff.truncateAnnotation=<annotation>`

Anmerkung, die am Ende des Diff-Ergebnisses ausgegeben wird, wenn es gekürzt wurde.

## diff.truncateAnnotationColor

- **Typ:** `DiffOptionsColor = (arg: string) => string`
- **Standard:** `noColor = (string: string): string => string`

Farbe der Kürzungsanmerkung; standardmäßig erfolgt die Ausgabe ohne Farbe.

## diff.printBasicPrototype

- **Typ:** `boolean`
- **Standard:** `false`

Die grundlegenden Prototypen `Object` und `Array` in der Diff-Ausgabe mitausgeben.

## diff.maxDepth

- **Typ:** `number`
- **Standard:** `20` (oder `8` beim Vergleich unterschiedlicher Typen)

Begrenzt die Rekursionstiefe beim Ausgeben verschachtelter Objekte.
