# fakeTimers

- **Typ:** `FakeTimerConfig`

Optionen, die Vitest an [`@sinon/fake-timers`](https://npmx.dev/package/@sinonjs/fake-timers) weiterreicht, wenn [`vi.useFakeTimers()`](/api/vi#vi-usefaketimers) verwendet wird.

## fakeTimers.now

- **Typ:** `number | Date`
- **Standard:** `Date.now()`

Installiert Fake Timers mit der angegebenen Unix-Epoche.

## fakeTimers.toFake

- **Typ:** `('setTimeout' | 'clearTimeout' | 'setImmediate' | 'clearImmediate' | 'setInterval' | 'clearInterval' | 'Date' | 'nextTick' | 'hrtime' | 'requestAnimationFrame' | 'cancelAnimationFrame' | 'requestIdleCallback' | 'cancelIdleCallback' | 'performance' | 'queueMicrotask' | 'Intl' | 'Temporal')[]`
- **Standard:** alles global Verfügbare außer `nextTick` und `queueMicrotask`

Ein Array mit den Namen globaler Methoden und APIs, die gefälscht werden sollen. Um beispielsweise nur `setTimeout()` und `nextTick()` zu mocken, geben Sie für diese Eigenschaft `['setTimeout', 'nextTick']` an.

Das Mocken von `nextTick` wird nicht unterstützt, wenn Vitest innerhalb von `node:child_process` mit `--pool=forks` läuft. NodeJS verwendet `process.nextTick` intern in `node:child_process` und hängt sich auf, wenn es gemockt wird. Das Mocken von `nextTick` wird unterstützt, wenn Vitest mit `--pool=threads` läuft.

## fakeTimers.toNotFake

- **Typ:** `('setTimeout' | 'clearTimeout' | 'setImmediate' | 'clearImmediate' | 'setInterval' | 'clearInterval' | 'Date' | 'nextTick' | 'hrtime' | 'requestAnimationFrame' | 'cancelAnimationFrame' | 'requestIdleCallback' | 'cancelIdleCallback' | 'performance' | 'queueMicrotask' | 'Intl' | 'Temporal')[]`
- **Standard:** `[]`

Ein Array mit den Namen globaler Methoden und APIs, die nativ bleiben sollen. Alle übrigen verfügbaren Timer werden gemockt. Um beispielsweise `setInterval()` nativ zu belassen und alle anderen Timer zu mocken, geben Sie für diese Eigenschaft `['setInterval']` an.

Das Mocken von `nextTick` wird nicht unterstützt, wenn Vitest innerhalb von `node:child_process` mit `--pool=forks` läuft. Beim Betrieb mit `--pool=forks` fügt Vitest `nextTick` automatisch dem Array `toNotFake` hinzu.

::: warning
Die gleichzeitige Verwendung von `toFake` und `toNotFake` wird nicht unterstützt.
:::

## fakeTimers.loopLimit

- **Typ:** `number`
- **Standard:** `10_000`

Die maximale Anzahl an Timern, die beim Aufruf von [`vi.runAllTimers()`](/api/vi#vi-runalltimers) ausgeführt werden.

## fakeTimers.shouldAdvanceTime

- **Typ:** `boolean`
- **Standard:** `false`

Weist @sinonjs/fake-timers an, die gemockte Zeit automatisch entsprechend dem tatsächlichen Fortschreiten der Systemzeit zu erhöhen (z. B. wird die gemockte Zeit für jede Änderung der realen Systemzeit um 20 ms ebenfalls um 20 ms erhöht).

## fakeTimers.advanceTimeDelta

- **Typ:** `number`
- **Standard:** `20`

Nur relevant in Verbindung mit `shouldAdvanceTime: true`. Erhöht die gemockte Zeit um advanceTimeDelta ms bei jeder Änderung der realen Systemzeit um advanceTimeDelta ms.

## fakeTimers.shouldClearNativeTimers

- **Typ:** `boolean`
- **Standard:** `true`

Weist die Fake Timers an, „native“ (also nicht gefälschte) Timer zu löschen, indem an deren jeweilige Handler delegiert wird. Ist die Option deaktiviert, kann das zu potenziell unerwartetem Verhalten führen, wenn bereits vor dem Start der Fake-Timer-Sitzung Timer existierten.
