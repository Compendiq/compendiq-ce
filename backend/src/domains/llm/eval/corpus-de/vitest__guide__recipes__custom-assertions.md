# Eigene Assertion-Helfer

Wiederverwendbare Assertion-Helfer machen Tests leichter lesbar – auf Kosten der Stacktraces. Schlägt eine Assertion innerhalb eines Helfers fehl, verweist der Trace auf die Zeile im Helfer statt auf den Test, der ihn aufgerufen hat. Wird derselbe Helfer in vielen Tests verwendet, lässt sich allein am Stacktrace nicht erkennen, welche Aufrufstelle fehlgeschlagen ist.

[`vi.defineHelper`](/api/vi#vi-defineHelper) <Version>4.1.0</Version> umhüllt eine Funktion so, dass Vitest ihre Interna aus dem Stack entfernt und den Fehler stattdessen auf die Aufrufstelle zurückführt.

## Muster

```ts
import { expect, test, vi } from 'vitest'

const assertPair = vi.defineHelper((a: unknown, b: unknown) => {
  expect(a).toEqual(b) // ❌ failure does NOT point here
})

test('example', () => {
  assertPair('left', 'right') // ✅ failure points here
})
```

Wenn `assertPair` fehlschlägt, zeigen das Diff und der Stack-Frame die Testzeile, die den Helfer aufgerufen hat. Das ist dasselbe Verhalten, das eingebaute Matcher bieten.

## Mehrere Erwartungen kombinieren

Derselbe Wrapper funktioniert für Helfer, die mehrere Assertions bündeln:

```ts
import { expect, test, vi } from 'vitest'

const expectValidUser = vi.defineHelper((user: unknown) => {
  expect(user).toHaveProperty('id')
  expect(user).toHaveProperty('email')
  expect(user.email).toMatch(/@/)
})

test('returns a valid user', async () => {
  const user = await fetchUser('alice')
  expectValidUser(user)
})
```

Ein Fehlschlag in einem der inneren `expect`-Aufrufe wird gegen die Zeile `expectValidUser(user)` im Test gemeldet.

Greifen Sie zu `defineHelper`, sobald eine wiederverwendbare Prüfung `expect` mehr als einmal aufruft – sei es ein domänenspezifischer Helfer wie `expectValidJWT` oder irgendein Block von `expect`-Aufrufen, den Sie sonst in jeden Test hineinschreiben würden.

Zu asymmetrischen Matchern und eigenen Matchern, die über `expect.extend` angehängt werden, siehe [Extending Matchers](/guide/extending-matchers).

## Siehe auch

- [`vi.defineHelper`](/api/vi#vi-defineHelper)
- [Extending Matchers](/guide/extending-matchers)
