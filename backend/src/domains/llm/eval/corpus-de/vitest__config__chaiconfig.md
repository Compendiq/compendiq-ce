# chaiConfig

- **Typ:** `{ includeStack?, showDiff?, truncateThreshold? }`
- **Standard:** `{ includeStack: false, showDiff: true, truncateThreshold: 40 }`

Entspricht der [Chai-Konfiguration](https://github.com/chaijs/chai/blob/4.x.x/lib/chai/config.js).

## chaiConfig.includeStack

- **Typ:** `boolean`
- **Standard:** `false`

Bestimmt, ob der Stacktrace in die Fehlermeldung einer Assertion aufgenommen wird. Der Standardwert `false` unterdrückt den Stacktrace in der Fehlermeldung.

## chaiConfig.showDiff

- **Typ:** `boolean`
- **Standard:** `true`

Bestimmt, ob das `showDiff`-Flag in den geworfenen AssertionErrors enthalten sein soll. `false` ist immer `false`; `true` ist dann wahr, wenn die Assertion die Anzeige eines Diffs angefordert hat.

## chaiConfig.truncateThreshold

- **Typ:** `number`
- **Standard:** `40`

Legt den Längenschwellenwert für die tatsächlichen und erwarteten Werte in Assertion-Fehlermeldungen fest. Wird dieser Schwellenwert überschritten, etwa bei großen Datenstrukturen, wird der Wert durch etwas wie `[ Array(3) ]` oder `{ Object (prop1, prop2) }` ersetzt. Setze ihn auf `0`, wenn du das Kürzen vollständig deaktivieren möchtest.
