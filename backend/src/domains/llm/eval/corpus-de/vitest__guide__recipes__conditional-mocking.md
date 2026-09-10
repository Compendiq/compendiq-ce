# Bedingtes Mocking mit `vi.when`

::: tip Voraussetzungen
Dieses Rezept setzt voraus, dass Sie mit [Mocking](/guide/mocking) in Vitest bereits etwas vertraut sind.
:::

Wenn ein Mock je nach den erhaltenen Argumenten unterschiedliche Werte zurückgeben soll, hilft [`mockReturnValue`](/api/mock#mockreturnvalue) nicht weiter, weil es immer denselben Wert liefert. Der übliche Ansatz wäre [`mockImplementation`](/api/mock#mockimplementation) mit einem `switch` oder einer Reihe von `if/else`-Anweisungen:

```ts
db.findById.mockImplementation((id) => {
  if (id === 1) {
    return Promise.resolve({ id: 1, name: 'Ella' })
  }

  if (id === 2) {
    return Promise.resolve({ id: 2, name: 'Gracie' })
  }

  return Promise.resolve(undefined)
})
```

Das funktioniert, wird aber mühsam, weil Sie die Logik zum Abgleich der Argumente selbst schreiben müssen. Genau das kann Vitest für Sie übernehmen, wenn Sie die API [`vi.when`](/api/vi#vi-when) <Version>5.0.0</Version> verwenden.

## Muster

`vi.when` nimmt einen Spy entgegen und erlaubt Ihnen, argumentspezifische Verhaltensweisen zu definieren.

Rufen Sie `.calledWith(...args)` auf, um zu deklarieren, welche Argumente getroffen werden sollen. Damit entsteht ein _Behavior_.

Hängen Sie anschließend eine _Action_ an, indem Sie eine `then*`-Methode aufrufen. Die Action bestimmt, was passiert, wenn das Behavior zutrifft.

Mehrere Behaviors lassen sich am selben Spy verketten:

```ts
import { test, vi } from 'vitest'
import { getUserById } from './user.ts'

test('returns user data', async () => {
  const db = { findById: vi.fn<FindById>() }

  vi.when(db.findById)
    .calledWith(1)
    .thenResolve({ id: 1, name: 'Ella' })
    .calledWith(2)
    .thenResolve({ id: 2, name: 'Gracie' })

  await expect(getUserById(db, 1)).resolves.toEqual({ name: 'Ella' })
  await expect(getUserById(db, 2)).resolves.toEqual({ name: 'Gracie' })
})
```

Derselbe Ansatz funktioniert für alle Arten von Mock-Ergebnissen. Hier die vollständige Liste der Actions und ihrer Entsprechungen:

| Action | Entspricht | Äquivalenter Code |
|---|---|---|
| `thenReturn(value)` | `mockReturnValue(value)` | `return value` |
| `thenThrow(error)` | `mockThrow(error)` | `throw error` |
| `thenResolve(value)` | `mockResolvedValue(value)` | `return Promise.resolve(value)` |
| `thenReject(error)` | `mockRejectedValue(error)` | `return Promise.reject(error)` |

## Actions stapeln

An ein einzelnes Behavior lassen sich mehrere Actions anhängen. Trifft das Behavior zu, werden die Actions in **Last-in-first-out**-Reihenfolge _verbraucht_: Die zuletzt registrierte Action läuft zuerst. Sobald diese Action verbraucht ist, fällt Vitest auf die vorherige zurück. Über die Option `times` begrenzen Sie, wie viele Aufrufe eine Action bedient, bevor an die nächste Action durchgereicht wird. Eine Action ohne `times`-Limit läuft unbegrenzt.

Da Actions in umgekehrter Registrierungsreihenfolge ausgewertet werden, sollten unbegrenzte Actions zuerst registriert werden, damit spätere, endliche Actions sie vorübergehend überschreiben können.

```ts
import { test, vi } from 'vitest'
import { readConfig } from './config.ts'

test('retries after an initial failure', async () => {
  const fetchInstance = vi.fn<() => Promise<unknown>>()

  vi.when(fetchInstance)
    .calledWith('/data/config.json')
    .thenResolve(new Response('{ debug: true }'))
    // ↳ indefinite fallback
    .thenReject(new Error('network error'), { times: 1 })
    // ↳ applied first and consumed after one call

  await expect(readConfig(fetchInstance)).resolves.toEqual({ debug: true })

  expect(fetchInstance).toHaveBeenCalledTimes(2)
})
```

Der Bequemlichkeit halber gibt es `then*Once`-Kurzformen, die `{ times: 1 }` entsprechen: `thenReturnOnce`, `thenResolveOnce`, `thenThrowOnce`, `thenRejectOnce`.

## Asymmetrische Matcher

`calledWith` unterstützt [asymmetrische Matcher](/guide/learn/matchers#asymmetric-matchers). Das ist nützlich, wenn es Ihnen eher auf die Form oder den Typ eines Arguments ankommt als auf dessen exakten Wert:

```ts
test('sends email to each recipient', () => {
  vi.when(sendEmail)
    .calledWith(expect.stringContaining('@'))
    .thenReturn({ ok: true, message: 'sent via external relay' })
})
```

Behaviors werden, anders als Actions, in **First-in-first-out**-Reihenfolge abgeglichen. Das erste Behavior, dessen Argumente zum Aufruf passen, gewinnt — genau wie eine Kette von `if/else`-Anweisungen. Spezifische Matcher müssen daher vor allgemeinen registriert werden.

```ts
test('sends email to each recipient', () => {
  vi.when(sendEmail)
    .calledWith(expect.stringContaining('@internal.example.com'))
    .thenReturn({ ok: true, message: 'sent via internal relay' })
    .calledWith(expect.stringContaining('@'))
    .thenReturn({ ok: true, message: 'sent via external relay' })
})
```

::: warning Zusammenführen von Behaviors
Beim Registrieren eines neuen Behaviors prüft Vitest die vorhandenen Behaviors in Registrierungsreihenfolge. Passen die neuen Argumente bereits zu einem vorhandenen Behavior, wird die neue Action in dieses Behavior zusammengeführt, statt ein neues anzulegen.

Besonders wichtig ist das bei weit gefassten asymmetrischen Matchern:

```ts
vi.when(getRole)
  .calledWith(expect.any(String))
  .thenReturn('user')
  .calledWith('admin@example.com')
  .thenReturnOnce('admin')
```

Weil die zweite Registrierung in das bestehende Behavior zusammengeführt wird, ist die `'admin'`-Action nicht auf `'admin@example.com'` beschränkt. Stattdessen wird sie zur nächsten Action des gesamten `expect.any(String)`-Behaviors. Das resultierende Behavior verhält sich, als wäre es so geschrieben worden:

```ts
vi.when(getRole)
  .calledWith(expect.any(String))
  .thenReturn('user')
  .thenReturnOnce('admin')
```

Folglich liefert der erste Aufruf mit einem beliebigen String `'admin'`, während spätere Aufrufe `'user'` zurückgeben:

```ts
expect(getRole('user@example.com')).toBe('admin')
expect(getRole('user@example.com')).toBe('user')
```
:::

## Nicht getroffene Aufrufe behandeln

Wird der Spy standardmäßig mit Argumenten aufgerufen, die zu keinem registrierten Behavior passen, fällt er auf die ursprüngliche Implementierung des Spys zurück. Hat der Spy keine ursprüngliche Implementierung, gibt er `undefined` zurück.

Es gibt drei Möglichkeiten, das anders zu handhaben:

1. [einen Fehler werfen](#onunmatched-throw);
1. [eine eigene Funktion ausführen](#onunmatched-fn);
1. [asymmetrische Matcher als Catch-all-Behaviors verwenden](#asymmetric-matcher-as-catch-all).

### `onUnmatched: 'throw'`

Übergeben Sie `{ onUnmatched: 'throw' }`, damit ein Fehler geworfen wird, sobald der Spy mit nicht registrierten Argumenten aufgerufen wird:

```ts
vi.when(db.findById, { onUnmatched: 'throw' })
  .calledWith(1)
  .thenResolve({ id: 1, name: 'Ella' })

await expect(db.findById(1)).resolves.toMatchObject({ name: 'Ella' })
await expect(db.findById(3)).rejects.toThrow(
  'vi.when: no behavior defined when called with [3]',
)
```

Die Fehlermeldung enthält die nicht getroffenen Argumente. Fehlertyp und Meldung sind fest vorgegeben und lassen sich nicht anpassen.

### `onUnmatched: fn`

Übergeben Sie eine Funktion, um nicht getroffene Aufrufe mit eigener Logik zu behandeln, etwa wenn ein geteilter Mock pro Test einen anderen Fallback benötigt.

```ts
const db = { findById: vi.fn<FindById>() }

test('returns a placeholder for unknown ids', async () => {
  vi.when(
    db.findById,
    { onUnmatched: id => Promise.resolve({ id, name: `User ${id}` }) }
  )
    .calledWith(1)
    .thenResolve({ id: 1, name: 'Ella' })

  await expect(db.findById(1)).resolves.toMatchObject({ name: 'Ella' })
  await expect(db.findById(42)).resolves.toMatchObject({ name: 'User 42' })
})
```

Die Funktion wird mit denselben Argumenten wie der Spy aufgerufen, und ihr Rückgabewert wird direkt als Ergebnis des Spys verwendet. Wirft sie einen Fehler oder gibt sie ein abgelehntes Promise zurück, propagiert dieser Fehler genauso zum Aufrufer, wie es bei jeder Action der Fall wäre.

### Asymmetrischer Matcher als Catch-all

Ein zuletzt registriertes, weit gefasstes `calledWith` wirkt als Fallback für Aufrufe, die zu keinem früheren, spezifischeren Behavior passen. Das Fallback-Behavior kann einen bestimmten Wert zurückgeben, ein Promise auflösen oder ablehnen oder einen typisierten Fehler werfen.

```ts
vi.when(db.findById)
  .calledWith(1)
  .thenResolve({ id: 1, name: 'Ella' })
  .calledWith(2)
  .thenResolve({ id: 2, name: 'Gracie' })
  .calledWith(expect.any(Number))
  .thenReject(new Error('user not found'))
```

## Prüfen, ob alle Behaviors aufgerufen wurden

Um zu prüfen, ob alle registrierten Behaviors tatsächlich getroffen und ihre Actions verbraucht wurden, unterstützt das von `vi.when` zurückgegebene Objekt die Assertion [`toHaveBeenExhausted`](/api/expect#tohavebeenexhausted):

```ts
test('loads both users', async () => {
  const db = { findById: vi.fn<FindById>() }

  const w = vi.when(db.findById)
    .calledWith(1)
    .thenResolveOnce({ id: 1, name: 'Ella' })
    .calledWith(2)
    .thenResolveOnce({ id: 2, name: 'Gracie' })

  await loadDashboard(db)

  expect(w).toHaveBeenExhausted()
})
```

Ruft `loadDashboard` in diesem Beispiel nur `findById(1)` auf, schlägt der Test mit einer Meldung fehl, die die nie getroffenen Behaviors auflistet:

```
AssertionError: expected all behaviors to have been exhausted, but some remain:

  calledWith(2)
    ✗ thenReturn({ id: 2, name: 'Gracie' })  never called
```

::: warning Einschränkung
Eine `vi.when`-Kette ohne Behaviors gilt nie als erschöpft. Dasselbe gilt für ein bloßes `.calledWith()` ohne angehängte `then*`-Action. Beides führt stets dazu, dass `toHaveBeenExhausted` fehlschlägt.

Unbegrenzte Actions (ohne `times`-Limit) erfüllen die Erschöpfungsprüfung, sobald sie mindestens einmal verwendet wurden. Die Actions antworten danach weiterhin, die Assertion ist aber erfüllt.
:::

## Automatisches Aufräumen mit `using`

`vi.when` unterstützt das Protokoll [Explicit Resource Management](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Guide/Resource_management).

Deklarieren Sie die Kette mit `using`, um Behaviors auf den aktuellen Block zu beschränken und den Spy automatisch wiederherzustellen, sobald die Ausführung ihn verlässt.

```ts
const spy = vi.fn(() => 'original')

test('with mocked behavior', () => {
  using w = vi.when(spy).calledWith('hello').thenReturn('mocked')
  expect(spy('hello')).toBe('mocked')
}) // ← restored here

test('without mocked behavior', () => {
  expect(spy('hello')).toBe('original')
})
```

## Siehe auch

- [`vi.when`](/api/vi#vi-when)
- [`toHaveBeenExhausted`](/api/expect#tohavebeenexhausted)
- [`vi.isWhenChain`](/api/vi#vi-iswhenchain)
- [Automatisches Aufräumen mit `using`](/guide/recipes/explicit-resources)
