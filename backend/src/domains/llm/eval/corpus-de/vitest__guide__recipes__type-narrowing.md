# Typeinschränkung in Tests

Tests haben es überall mit möglicherweise null-Werten zu tun. `document.querySelector` gibt `Element | null` zurück, `Map.get(key)` gibt `T | undefined` zurück, und ähnliche optionale Formen tauchen durchgehend auf. Die üblichen Behelfslösungen in Testcode sind ein unsicherer Cast mit `as`, eine Non-Null-Assertion mit `!` bei jedem Zugriff oder eine Laufzeitprüfung wie `expect(x).toBeTruthy()`, die wirft, wenn der Wert fehlt. Alle drei erzeugen Rauschen, und die Laufzeitprüfung ist geradezu irreführend, weil sie den Typ nicht so einschränkt, wie es den Anschein hat.

[`expect.assert`](/api/expect#assert) <Version>4.0.0</Version> wirft zur Laufzeit und schränkt zugleich den TypeScript-Typ ein. Derselbe Aufruf ersetzt alle drei.

## Muster

```ts
import { expect, test } from 'vitest'

test('reads stored user', () => {
  const cache = new Map<string, { id: string; name: string }>()
  cache.set('alice', { id: '1', name: 'Alice' })

  const user = cache.get('alice') // typed as `{ id, name } | undefined`
  expect.assert(user) // throws if undefined, narrows below
  expect(user.name).toBe('Alice') // no `!`, no `as`, type is `{ id, name }`
})
```

Dieselbe Form fasst jede Abfolge nach dem Schema „Wert nachschlagen, Existenz prüfen, dann verwenden“ zusammen:

```ts
const job = queue.find(j => j.id === 'build-42') // Job | undefined
expect.assert(job)
job.cancel() // narrowed to Job
```

## Warum `toBeTruthy` nicht einschränkt

`expect(x).toBeTruthy()` und `expect(x).toBeDefined()` werfen zur Laufzeit, wenn der Wert fehlt, sodass der Test wie gewünscht fehlschlägt. Sie schränken den Typ jedoch nicht ein, weil ihre TypeScript-Signatur `void` zurückgibt statt der besonderen `asserts`-Form.

`expect.assert` ist als Assertion-Funktion typisiert, sodass derselbe Aufruf beide Aufgaben erfüllt.

## Einschränken über null hinaus

`expect.assert` akzeptiert jeden booleschen Ausdruck und wendet dieselbe Einschränkung an, die TypeScript für einen `if`-Zweig vornehmen würde. Das deckt `typeof`- und `instanceof`-Prüfungen ab:

```ts
expect.assert(typeof input === 'string')
input.toUpperCase() // input is `string`

expect.assert(error instanceof MyError)
expect(error.code).toBe('E_FOO') // error is `MyError`
```

Für häufige Formen gibt es vorgefertigte Helfer aus chais [`assert`-API](/api/assert), erreichbar über denselben Namespace `expect.assert`:

```ts
expect.assert.isDefined(maybeUser) // narrows away `undefined`
expect.assert.isString(input) // narrows to string
expect.assert.instanceOf(error, MyError) // narrows to MyError
```

## Siehe auch

- [`expect.assert`](/api/expect#assert)
- [Chai `assert`-API](/api/assert)
- [Auf asynchrone Bedingungen warten](/guide/recipes/wait-for)
