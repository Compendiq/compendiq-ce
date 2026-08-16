# snapshotFormat <CRoot />

- **Typ:** `Omit<PrettyFormatOptions, 'plugins' | 'compareKeys'> & { compareKeys?: null | undefined }`

Formatierungsoptionen für Snapshot-Tests. Diese Optionen konfigurieren die snapshot-spezifische Formatierungsschicht, die auf [`@vitest/pretty-format`](https://npmx.dev/package/@vitest/pretty-format) aufsetzt.

Die vollständige Optionsfläche von `PrettyFormatOptions` findest du unter [`@vitest/pretty-format`](https://npmx.dev/package/@vitest/pretty-format). Diese Seite konzentriert sich auf die snapshot-spezifischen Standardwerte und Einschränkungen von Vitest.

Vitest-Snapshots wenden diese Standardwerte bereits an, bevor deine `snapshotFormat`-Überschreibungen greifen:

- `printBasicPrototype: false`
- `escapeString: false`
- `escapeRegex: true`
- `printFunctionName: false`

Vitest unterstützt in `snapshotFormat` außerdem Formatter-Optionen wie `printShadowRoot` und `maxOutputLength`.

`printShadowRoot` steuert, ob die Inhalte von Shadow Roots in DOM-Snapshots aufgenommen werden.

`maxOutputLength` ist ein ungefähres Ausgabebudget pro Tiefenebene, keine harte Obergrenze für die final gerenderte Zeichenkette.

Standardmäßig werden Snapshot-Schlüssel nach dem Standardverhalten des Formatters sortiert. Setze `compareKeys` auf `null`, um die Schlüsselsortierung zu deaktivieren. Eigene Vergleichsfunktionen werden in `snapshotFormat` nicht unterstützt.

::: tip
Achtung: `plugins` in diesem Objekt wird ignoriert.

Wenn du die Snapshot-Serialisierung über pretty-format-Plugins erweitern musst, verwende stattdessen [`expect.addSnapshotSerializer`](/api/expect#expect-addsnapshotserializer) oder [`snapshotSerializers`](/config/snapshotserializers).
:::
