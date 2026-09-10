# Matcher verwenden

Vitest verwendet `expect` zusammen mit „Matchern“, um zu prüfen, ob Werte bestimmte Bedingungen erfüllen. Diese Seite behandelt die Matcher, die Sie am häufigsten einsetzen werden. Die vollständige Liste finden Sie in der [Expect-API-Referenz](/api/expect).

## Gängige Matcher

Am einfachsten prüfen Sie einen Wert auf exakte Gleichheit. Wenn Sie `expect(2 + 2).toBe(4)` schreiben, prüft der Matcher [`toBe`](/api/expect#tobe) mithilfe von [`Object.is`](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Object/is), dass der Wert exakt `4` ist.

```js
import { expect, test } from 'vitest'

test('two plus two is four', () => {
  expect(2 + 2).toBe(4)
})
```

Für primitive Werte wie Zahlen, Strings und Booleans funktioniert das hervorragend. Beim Vergleich von Objekten prüft `toBe` jedoch die *Identität* (ob es sich um exakt dasselbe Objekt im Speicher handelt) und nicht, ob sie dieselbe Struktur haben. Genau dafür gibt es [`toEqual`](/api/expect#toequal). Es vergleicht rekursiv jedes Feld eines Objekts bzw. jedes Element eines Arrays und ignoriert dabei die Objektidentität:

```js
test('object assignment', () => {
  const data = { one: 1 }
  data.two = 2

  expect(data).toEqual({ one: 1, two: 2 })
})
```

Hier ein Beispiel, das den Unterschied deutlicher zeigt. Zwei Objekte mit gleichem Inhalt sind `toEqual`, aber nicht `toBe`:

```js
test('toBe vs toEqual', () => {
  const a = { name: 'Alice' }
  const b = { name: 'Alice' }

  // These are different objects in memory
  expect(a).not.toBe(b)

  // But they have the same structure
  expect(a).toEqual(b)
})
```

Es gibt außerdem [`toStrictEqual`](/api/expect#tostrictequal), das in drei Punkten strenger ist als `toEqual`: Es berücksichtigt `undefined`-Eigenschaften, unterscheidet dünn besetzte Arrays von `undefined`-Werten und prüft, ob Objekte denselben Typ haben (nicht nur dieselbe Struktur):

```js
test('toEqual vs toStrictEqual', () => {
  // toEqual ignores undefined properties
  expect({ a: 1 }).toEqual({ a: 1, b: undefined })

  // toStrictEqual catches them
  expect({ a: 1 }).not.toStrictEqual({ a: 1, b: undefined })

  // toEqual doesn't check object types
  class User {
    constructor(name) {
      this.name = name
    }
  }
  expect(new User('Alice')).toEqual({ name: 'Alice' })
  expect(new User('Alice')).not.toStrictEqual({ name: 'Alice' })
})
```

::: tip
Eine gute Faustregel: Verwenden Sie `toBe` für Primitive (Zahlen, Strings, Booleans), `toEqual` zum Vergleich der Struktur und `toStrictEqual`, wenn Ihnen zusätzlich Typen und explizite `undefined`-Werte wichtig sind.
:::

Sie können jeden Matcher negieren, indem Sie `.not` davorsetzen. Das ist nützlich, wenn Sie überprüfen möchten, dass etwas *nicht* zutrifft:

```js
test('adding positive numbers is not zero', () => {
  expect(1 + 2).not.toBe(0)
})
```

## Wahrheitswerte

In Tests müssen Sie manchmal zwischen `undefined`, `null` und `false` unterscheiden. Ein anderes Mal ist Ihnen der genaue Wert egal und Sie möchten nur wissen, ob etwas truthy oder falsy ist. Vitest bietet Matcher für beide Situationen:

- [`toBeNull`](/api/expect#tobenull) trifft nur auf `null` zu
- [`toBeUndefined`](/api/expect#tobeundefined) trifft nur auf `undefined` zu
- [`toBeDefined`](/api/expect#tobedefined) ist das Gegenteil von `toBeUndefined`. Es ist erfolgreich für alles, was nicht `undefined` ist
- [`toBeTruthy`](/api/expect#tobetruthy) trifft auf alles zu, was eine `if`-Anweisung als wahr behandeln würde
- [`toBeFalsy`](/api/expect#tobefalsy) trifft auf alles zu, was eine `if`-Anweisung als falsch behandeln würde

Wählen Sie den Matcher, der am präzisesten beschreibt, was Sie prüfen. `toBeTruthy` zu verwenden, wenn Sie eigentlich `toBeDefined` meinen, kann Fehler verdecken, denn `0` und `""` sind beide definiert, aber falsy.

```js
test('null checks', () => {
  const n = null

  expect(n).toBeNull()
  expect(n).toBeDefined()
  expect(n).toBeFalsy()
  expect(n).not.toBeTruthy()
  expect(n).not.toBeUndefined()
})

test('zero', () => {
  const z = 0

  expect(z).toBeDefined() // passes: 0 is defined
  expect(z).toBeFalsy() // passes: 0 is falsy
  expect(z).not.toBeNull() // passes: 0 is not null
})
```

## Zahlen

Die meisten Zahlenvergleiche sind unkompliziert. Vitest bietet die Matcher, die Sie für Größer-als-, Kleiner-als- und Gleichheitsprüfungen erwarten:

```js
test('number comparisons', () => {
  const value = 2 + 2

  expect(value).toBeGreaterThan(3)
  expect(value).toBeGreaterThanOrEqual(3.5)
  expect(value).toBeLessThan(5)
  expect(value).toBeLessThanOrEqual(4.5)

  // For exact equality, both toBe and toEqual work the same for numbers
  expect(value).toBe(4)
  expect(value).toEqual(4)
})
```

Bei Gleitkomma-Arithmetik gibt es eine verbreitete Falle. In JavaScript ergibt `0.1 + 0.2` nicht exakt `0.3` (sondern `0.30000000000000004`). Das bedeutet, dass eine Prüfung mit `toBe(0.3)` fehlschlägt. Verwenden Sie stattdessen [`toBeCloseTo`](/api/expect#tobecloseto), das Zahlen innerhalb eines kleinen Rundungsfehlers vergleicht:

```js
test('adding floating point numbers', () => {
  const value = 0.1 + 0.2

  // This won't work because of floating point rounding
  // expect(value).toBe(0.3)

  // This works
  expect(value).toBeCloseTo(0.3)
})
```

## Strings

Mit [`toMatch`](/api/expect#tomatch) können Sie Strings gegen reguläre Ausdrücke prüfen. Das ist besonders praktisch, wenn Ihnen ein Muster statt eines exakten Werts wichtig ist – etwa um zu prüfen, ob eine Fehlermeldung ein bestimmtes Wort enthält oder ob eine URL einem bestimmten Format entspricht:

```js
test('there is no I in team', () => {
  expect('team').not.toMatch(/I/)
})

test('version string matches semver format', () => {
  expect('vitest@1.0.0').toMatch(/vitest@\d+\.\d+\.\d+/)
})
```

## Arrays und Iterables

[`toContain`](/api/expect#tocontain) prüft, ob ein Array (oder ein beliebiges Iterable wie ein `Set`) ein bestimmtes Element enthält. Für den Vergleich wird `===` verwendet, sodass es bei Primitiven gut funktioniert:

```js
test('the shopping list has milk in it', () => {
  const shoppingList = ['milk', 'bread', 'eggs', 'butter']

  expect(shoppingList).toContain('milk')
  expect(new Set(shoppingList)).toContain('milk')
})
```

Wenn Sie prüfen müssen, ob ein Array ein Objekt mit einer bestimmten Struktur enthält, verwenden Sie stattdessen [`toContainEqual`](/api/expect#tocontainequal). Es arbeitet wie `toEqual`, jedoch für einzelne Elemente innerhalb eines Arrays.

## Objekte

Beim Testen von Objekten möchten Sie häufig nur einige wichtige Felder prüfen, ohne jede Eigenschaft anzugeben. Genau das erlaubt [`toMatchObject`](/api/expect#tomatchobject). Es prüft, dass das Objekt mindestens die von Ihnen angegebenen Eigenschaften enthält, und ignoriert alle zusätzlichen:

```js
test('user has expected fields', () => {
  const user = {
    id: 1,
    name: 'Alice',
    email: 'alice@example.com',
    createdAt: '2024-01-01'
  }

  // We only care about name and email here
  expect(user).toMatchObject({
    name: 'Alice',
    email: 'alice@example.com',
  })
})
```

Zum Prüfen einzelner Eigenschaften, insbesondere verschachtelter, ist [`toHaveProperty`](/api/expect#tohaveproperty) besser lesbar. Sie übergeben einen durch Punkte getrennten Pfad und optional einen erwarteten Wert:

```js
test('object has property', () => {
  const user = {
    name: 'Alice',
    address: { city: 'Paris', zip: '75001' }
  }

  expect(user).toHaveProperty('name')
  expect(user).toHaveProperty('name', 'Alice')
  expect(user).toHaveProperty('address.city', 'Paris')
  expect(user).toHaveProperty('address.zip')
})
```

## Asymmetrische Matcher

Manchmal kennen Sie den genauen Wert nicht, wohl aber seinen Typ oder seine Struktur. Asymmetrische Matcher erlauben es Ihnen zu beschreiben, wie ein Wert *aussehen* soll, ohne den exakten Inhalt festzulegen. Sie funktionieren in jedem Matcher, der einen Tiefenvergleich durchführt, etwa `toEqual` oder `toMatchObject`:

```js
test('user has the right shape', () => {
  const user = createUser('Alice')

  expect(user).toEqual({
    id: expect.any(Number),
    name: 'Alice',
    email: expect.stringContaining('@'),
    roles: expect.arrayContaining(['viewer']),
  })
})
```

Die gängigsten asymmetrischen Matcher sind:

- [`expect.any(Constructor)`](/api/expect#expect-any) trifft auf jeden Wert zu, der mit dem angegebenen Konstruktor erzeugt wurde (z. B. `Number`, `String`, `Array`)
- [`expect.stringContaining(str)`](/api/expect#expect-stringcontaining) trifft auf einen String zu, der den angegebenen Teilstring enthält
- [`expect.stringMatching(regex)`](/api/expect#expect-stringmatching) prüft einen String gegen einen regulären Ausdruck
- [`expect.arrayContaining(arr)`](/api/expect#expect-arraycontaining) trifft auf ein Array zu, das alle Elemente des erwarteten Arrays enthält (die Reihenfolge spielt keine Rolle, zusätzliche Elemente sind erlaubt)
- [`expect.objectContaining(obj)`](/api/expect#expect-objectcontaining) trifft auf ein Objekt zu, das mindestens die angegebenen Eigenschaften enthält

## Ausnahmen

Um zu überprüfen, dass eine Funktion einen Fehler wirft, verwenden Sie [`toThrow`](/api/expect#tothrow). Sie müssen den Aufruf in eine weitere Funktion einpacken, damit Vitest den Fehler abfangen kann, statt ihn den Test abstürzen zu lassen:

```js
function compileCode(code) {
  if (code === '') {
    throw new Error('Cannot compile empty string')
  }
  return code
}

test('compiling an empty string throws', () => {
  // Check that it throws at all
  expect(() => compileCode('')).toThrow()

  // Check the error message
  expect(() => compileCode('')).toThrow('Cannot compile empty string')

  // Check the message with a regex
  expect(() => compileCode('')).toThrow(/empty string/)
})
```

::: tip
Die umschließende Funktion `() => compileCode('')` ist wichtig. Würden Sie `expect(compileCode('')).toThrow()` schreiben, würde der Fehler geworfen, *bevor* `expect` die Gelegenheit hat, ihn abzufangen, und der Test würde stattdessen mit einem unbehandelten Fehler fehlschlagen.
:::

## Soft Assertions

Normalerweise bricht eine fehlgeschlagene Assertion den Test sofort ab. Das ist meistens sinnvoll, doch manchmal möchten Sie mehrere unabhängige Dinge prüfen und alle Fehlschläge auf einmal sehen, statt sie einzeln zu beheben.

[`expect.soft`](/api/expect#soft) tut genau das. Es zeichnet den Fehlschlag auf, lässt den Test aber weiterlaufen:

```js
test('check multiple fields', () => {
  const user = { name: 'Alice', age: 30, role: 'admin' }

  expect.soft(user.name).toBe('Alice')
  expect.soft(user.age).toBe(25) // this fails but execution continues
  expect.soft(user.role).toBe('admin')
  // the test report will show that age didn't match
})
```

Das ist besonders nützlich, um die Struktur einer API-Response oder eines komplexen Objekts zu validieren, bei dem mehrere Felder gleichzeitig falsch sein können.
