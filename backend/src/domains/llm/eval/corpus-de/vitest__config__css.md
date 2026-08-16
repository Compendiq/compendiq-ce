# css

- **Typ:** `boolean | { include?, exclude?, modules? }`

Konfiguriert, ob CSS verarbeitet werden soll. Wird es ausgeschlossen, werden CSS-Dateien durch leere Strings ersetzt, um die nachfolgende Verarbeitung zu umgehen. CSS Modules geben einen Proxy zurück, um die Laufzeit nicht zu beeinflussen.

::: warning
Diese Option gilt nicht für [Browser-Tests](/guide/browser/).
:::

## css.include

- **Typ:** `RegExp | RegExp[]`
- **Standard:** `[]`

RegExp-Muster für Dateien, die tatsächliches CSS zurückgeben sollen und von der Vite-Pipeline verarbeitet werden.

:::tip
Um alle CSS-Dateien zu verarbeiten, verwende `/.+/`.
:::

## css.exclude

- **Typ:** `RegExp | RegExp[]`
- **Standard:** `[]`

RegExp-Muster für Dateien, die eine leere CSS-Datei zurückgeben.

## css.modules

- **Typ:** `{ classNameStrategy? }`
- **Standard:** `{}`

### css.modules.classNameStrategy

- **Typ:** `'stable' | 'scoped' | 'non-scoped'`
- **Standard:** `'stable'`

Wenn du dich für die Verarbeitung von CSS-Dateien entscheidest, kannst du konfigurieren, ob Klassennamen innerhalb von CSS Modules gescopet werden sollen. Du hast folgende Möglichkeiten:

- `stable`: Klassennamen werden als `_${name}_${hashedFilename}` erzeugt. Der generierte Klassenname bleibt also gleich, wenn sich der CSS-Inhalt ändert, ändert sich aber, wenn der Dateiname geändert oder die Datei in einen anderen Ordner verschoben wird. Diese Einstellung ist nützlich, wenn du Snapshots verwendest.
- `scoped`: Klassennamen werden wie gewohnt erzeugt und berücksichtigen dabei die Methode `css.modules.generateScopedName`, sofern du eine hast und die CSS-Verarbeitung aktiviert ist. Standardmäßig wird der Dateiname als `_${name}_${hash}` erzeugt, wobei der Hash Dateiname und Dateiinhalt einbezieht.
- `non-scoped`: Klassennamen werden nicht gehasht.

::: warning
Standardmäßig exportiert Vitest einen Proxy und umgeht damit die Verarbeitung von CSS Modules. Wenn du auf CSS-Eigenschaften deiner Klassen angewiesen bist, musst du die CSS-Verarbeitung über die Option `include` aktivieren.
:::
