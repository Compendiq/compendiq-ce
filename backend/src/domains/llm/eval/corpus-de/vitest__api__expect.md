# expect

Die folgenden Typen werden in den untenstehenden Typsignaturen verwendet

```ts
type Awaitable<T> = T | PromiseLike<T>
```

`expect` wird verwendet, um Assertions zu erstellen. In diesem Kontext sind `assertions` Funktionen, die aufgerufen werden können, um eine Aussage zu prüfen. Vitest stellt standardmäßig `chai`-Assertions bereit und zusätzlich `Jest`-kompatible Assertions, die auf `chai` aufbauen. Seit Vitest 4.1 stellt Vitest für Spy-/Mock-Tests außerdem Assertions im Chai-Stil bereit (z. B. [`expect(spy).to.have.been.called()`](#called)) neben den Assertions im Jest-Stil (z. B. `expect(spy).toHaveBeenCalled()`). Anders als `Jest` unterstützt Vitest eine Nachricht als zweites Argument – wenn die Assertion fehlschlägt, entspricht die Fehlermeldung dieser Nachricht.

```ts
export interface ExpectStatic
  extends Chai.ExpectStatic,
  Matchers<any>,
  AsymmetricMatchersContaining {
  <T>(actual: T, message?: string): Assertion<void, T>
  extend: (expects: MatchersObject) => void
  anything: () => any
  any: (constructor: unknown) => any
  getState: () => MatcherState
  setState: (state: Partial<MatcherState>) => void
  not: AsymmetricMatchersContaining
}
```

Dieser Code prüft zum Beispiel, dass ein `input`-Wert gleich `2` ist. Ist er es nicht, wirft die Assertion einen Fehler und der Test schlägt fehl.

```ts twoslash
import { expect } from 'vitest'

const input = Math.sqrt(4)

expect(input).to.equal(2) // chai API
expect(input).toBe(2) // jest API
```

Technisch gesehen verwendet dieses Beispiel keine [`test`](/api/test)-Funktion, daher sehen Sie in der Konsole einen Node.js-Fehler statt einer Vitest-Ausgabe. Um mehr über `test` zu erfahren, lesen Sie bitte die [Test-API-Referenz](/api/test).

`expect` kann außerdem statisch verwendet werden, um auf Matcher-Funktionen zuzugreifen, die später beschrieben werden, und mehr.

::: warning
`expect` hat keine Wirkung auf das Testen von Typen, wenn der Ausdruck keinen Typfehler enthält. Wenn Sie Vitest als [Typechecker](/guide/testing-types) verwenden möchten, nutzen Sie [`expectTypeOf`](/api/expect-typeof) oder [`assertType`](/api/assert-type).
:::

## assert

- **Typ:** `Chai.AssertStatic`

Vitest reexportiert chais [`assert`-API](https://www.chaijs.com/api/assert/) der Bequemlichkeit halber als `expect.assert`. Die unterstützten Methoden finden Sie auf der [Assert-API-Seite](/api/assert).

Das ist besonders nützlich, wenn Sie den Typ eingrenzen müssen, da die `expect.to*`-Methoden das nicht unterstützen:

```ts
interface Cat {
  __type: 'Cat'
  mew(): void
}
interface Dog {
  __type: 'Dog'
  bark(): void
}
type Animal = Cat | Dog

const animal: Animal = { __type: 'Dog', bark: () => {} }

expect.assert(animal.__type === 'Dog')
// does not show a type error!
expect(animal.bark()).toBeUndefined()
```

::: tip
Beachten Sie, dass `expect.assert` auch andere Methoden zur Typeingrenzung unterstützt (wie `assert.isDefined`, `assert.exists` und so weiter).
:::

## soft

- **Typ:** `ExpectStatic & (actual: any) => Assertions`

`expect.soft` funktioniert ähnlich wie `expect`, beendet die Testausführung bei einer fehlgeschlagenen Assertion jedoch nicht, sondern läuft weiter und markiert den Fehlschlag als Testfehler. Alle während des Tests aufgetretenen Fehler werden angezeigt, bis der Test abgeschlossen ist.

```ts
import { expect, test } from 'vitest'

test('expect.soft test', () => {
  expect.soft(1 + 1).toBe(3) // mark the test as fail and continue
  expect.soft(1 + 2).toBe(4) // mark the test as fail and continue
})
// reporter will report both errors at the end of the run
```

Es kann auch zusammen mit `expect` verwendet werden. Wenn eine `expect`-Assertion fehlschlägt, wird der Test beendet und alle Fehler werden angezeigt.

```ts
import { expect, test } from 'vitest'

test('expect.soft test', () => {
  expect.soft(1 + 1).toBe(3) // mark the test as fail and continue
  expect(1 + 2).toBe(4) // failed and terminate the test, all previous errors will be output
  expect.soft(1 + 3).toBe(5) // do not run
})
```

::: warning
`expect.soft` kann nur innerhalb der [`test`](/api/test)-Funktion verwendet werden.
:::

## poll

```ts
interface ExpectPoll extends ExpectStatic {
  (actual: (options: { signal: AbortSignal }) => T, options?: { interval?: number; timeout?: number; message?: string }): Promise<Assertions<Awaited<T>>>
}
```

`expect.poll` führt die _Assertion_ so lange erneut aus, bis sie erfolgreich ist. Sie können über die Optionen `interval` und `timeout` konfigurieren, wie oft Vitest es erneut versucht und wie lange es wartet. Das `timeout` gilt für den gesamten Polling-Vorgang, einschließlich des ausstehenden Callbacks und der Ausführung asynchroner Matcher.

Der Callback erhält ein `AbortSignal`, das abgebrochen wird, wenn das Poll-Timeout erreicht ist.

Wenn innerhalb des `expect.poll`-Callbacks ein Fehler geworfen wird, versucht Vitest es erneut, bis das Timeout abläuft.

```ts
import { expect, test } from 'vitest'

test('element exists', async () => {
  asyncInjectElement()

  await expect.poll(() => document.querySelector('.element')).toBeTruthy()
})
```

::: warning
`expect.poll` macht jede Assertion asynchron, Sie müssen sie also awaiten. Seit Vitest 3 schlägt der Test mit einer entsprechenden Warnung fehl, wenn Sie das Awaiten vergessen.

`expect.poll` funktioniert mit mehreren Matchern nicht:

- Snapshot-Matcher werden nicht unterstützt, weil sie immer erfolgreich sind. Wenn Ihre Bedingung flaky ist, ziehen Sie stattdessen [`vi.waitFor`](/api/vi#vi-waitfor) in Betracht, um sie zuerst aufzulösen:

```ts
import { expect, vi } from 'vitest'

const flakyValue = await vi.waitFor(() => getFlakyValue())
expect(flakyValue).toMatchSnapshot()
```

- `.resolves` und `.rejects` werden nicht unterstützt. `expect.poll` awaitet die Bedingung bereits, wenn sie asynchron ist.
- `toThrow` und seine Aliase werden nicht unterstützt, weil die `expect.poll`-Bedingung immer aufgelöst ist, bevor der Matcher den Wert erhält
:::

## not

Die Verwendung von `not` negiert die Assertion. Dieser Code prüft zum Beispiel, dass ein `input`-Wert nicht gleich `2` ist. Ist er gleich, wirft die Assertion einen Fehler und der Test schlägt fehl.

```ts
import { expect, test } from 'vitest'

const input = Math.sqrt(16)

expect(input).not.to.equal(2) // chai API
expect(input).not.toBe(2) // jest API
```

## toBe

- **Typ:** `(value: any) => Awaitable<void>`

`toBe` kann verwendet werden, um zu prüfen, ob Primitive gleich sind oder ob Objekte dieselbe Referenz teilen. Es entspricht dem Aufruf von `expect(Object.is(3, 3)).toBe(true)`. Wenn die Objekte nicht dieselben sind, Sie aber prüfen möchten, ob ihre Strukturen identisch sind, können Sie [`toEqual`](#toequal) verwenden.

Der folgende Code prüft zum Beispiel, ob der Händler 13 Äpfel hat.

```ts
import { expect, test } from 'vitest'

const stock = {
  type: 'apples',
  count: 13,
}

test('stock has 13 apples', () => {
  expect(stock.type).toBe('apples')
  expect(stock.count).toBe(13)
})

test('stocks are the same', () => {
  const refStock = stock // same reference

  expect(stock).toBe(refStock)
})
```

Versuchen Sie, `toBe` nicht mit Gleitkommazahlen zu verwenden. Da JavaScript sie rundet, ist `0.1 + 0.2` nicht strikt `0.3`. Um Gleitkommazahlen zuverlässig zu prüfen, verwenden Sie die [`toBeCloseTo`](#tobecloseto)-Assertion.

## toBeCloseTo

- **Typ:** `(value: number, numDigits?: number) => Awaitable<void>`

Verwenden Sie `toBeCloseTo`, um Gleitkommazahlen zu vergleichen. Das optionale Argument `numDigits` begrenzt die Anzahl der zu prüfenden Stellen _nach_ dem Dezimalpunkt. Der Standardwert für `numDigits` ist 2. Zum Beispiel:

```ts
import { expect, test } from 'vitest'

test.fails('decimals are not equal in javascript', () => {
  expect(0.2 + 0.1).toBe(0.3) // 0.2 + 0.1 is 0.30000000000000004
})

test('decimals are rounded to 5 after the point', () => {
  // 0.2 + 0.1 is 0.30000 | "000000000004" removed
  expect(0.2 + 0.1).toBeCloseTo(0.3, 5)
  // nothing from 0.30000000000000004 is removed
  expect(0.2 + 0.1).not.toBeCloseTo(0.3, 50)
})
```

## toBeDefined

- **Typ:** `() => Awaitable<void>`

`toBeDefined` prüft, dass der Wert nicht gleich `undefined` ist. Ein nützlicher Anwendungsfall wäre zu prüfen, ob eine Funktion überhaupt etwas _zurückgegeben_ hat.

```ts
import { expect, test } from 'vitest'

function getApples() {
  return 3
}

test('function returned something', () => {
  expect(getApples()).toBeDefined()
})
```

## toBeUndefined

- **Typ:** `() => Awaitable<void>`

Als Gegenstück zu `toBeDefined` prüft `toBeUndefined`, dass der Wert gleich `undefined` _ist_. Ein nützlicher Anwendungsfall wäre zu prüfen, ob eine Funktion nichts _zurückgegeben_ hat.

```ts
import { expect, test } from 'vitest'

function getApplesFromStock(stock: string) {
  if (stock === 'Bill') {
    return 13
  }
}

test('mary doesn\'t have a stock', () => {
  expect(getApplesFromStock('Mary')).toBeUndefined()
})
```

## toBeTruthy

- **Typ:** `() => Awaitable<void>`

`toBeTruthy` prüft, dass der Wert bei der Umwandlung in einen Boolean `true` ergibt. Nützlich, wenn Ihnen der Wert selbst egal ist und Sie nur wissen wollen, dass er zu `true` konvertiert werden kann.

Bei diesem Code ist Ihnen zum Beispiel der Rückgabewert von `stocks.getInfo` egal – es kann ein komplexes Objekt, ein String oder etwas ganz anderes sein. Der Code funktioniert trotzdem.

```ts
import { Stocks } from './stocks.js'

const stocks = new Stocks()
stocks.sync('Bill')
if (stocks.getInfo('Bill')) {
  stocks.sell('apples', 'Bill')
}
```

Wenn Sie also testen möchten, dass `stocks.getInfo` truthy ist, könnten Sie schreiben:

```ts
import { expect, test } from 'vitest'
import { Stocks } from './stocks.js'

const stocks = new Stocks()

test('if we know Bill stock, sell apples to him', () => {
  stocks.sync('Bill')
  expect(stocks.getInfo('Bill')).toBeTruthy()
})
```

Alles in JavaScript ist truthy, außer `false`, `null`, `undefined`, `NaN`, `0`, `-0`, `0n`, `""` und `document.all`.

## toBeFalsy

- **Typ:** `() => Awaitable<void>`

`toBeFalsy` prüft, dass der Wert bei der Umwandlung in einen Boolean `false` ergibt. Nützlich, wenn Ihnen der Wert selbst egal ist und Sie nur wissen wollen, ob er zu `false` konvertiert werden kann.

Bei diesem Code ist Ihnen zum Beispiel der Rückgabewert von `stocks.stockFailed` egal – er kann jeden falsy Wert zurückgeben, aber der Code funktioniert trotzdem.

```ts
import { Stocks } from './stocks.js'

const stocks = new Stocks()
stocks.sync('Bill')
if (!stocks.stockFailed('Bill')) {
  stocks.sell('apples', 'Bill')
}
```

Wenn Sie also testen möchten, dass `stocks.stockFailed` falsy ist, könnten Sie schreiben:

```ts
import { expect, test } from 'vitest'
import { Stocks } from './stocks.js'

const stocks = new Stocks()

test('if Bill stock hasn\'t failed, sell apples to him', () => {
  stocks.syncStocks('Bill')
  expect(stocks.stockFailed('Bill')).toBeFalsy()
})
```

Alles in JavaScript ist truthy, außer `false`, `null`, `undefined`, `NaN`, `0`, `-0`, `0n`, `""` und `document.all`.

## toBeNull

- **Typ:** `() => Awaitable<void>`

`toBeNull` prüft einfach, ob etwas `null` ist. Alias für `.toBe(null)`.

```ts
import { expect, test } from 'vitest'

function apples() {
  return null
}

test('we don\'t have apples', () => {
  expect(apples()).toBeNull()
})
```

## toBeNullable

- **Typ:** `() => Awaitable<void>`

`toBeNullable` prüft einfach, ob etwas nullable ist (`null` oder `undefined`).

```ts
import { expect, test } from 'vitest'

function apples() {
  return null
}

function bananas() {
  return undefined
}

test('we don\'t have apples', () => {
  expect(apples()).toBeNullable()
})

test('we don\'t have bananas', () => {
  expect(bananas()).toBeNullable()
})
```

## toBeNaN

- **Typ:** `() => Awaitable<void>`

`toBeNaN` prüft einfach, ob etwas `NaN` ist. Alias für `.toBe(NaN)`.

```ts
import { expect, test } from 'vitest'

let i = 0

function getApplesCount() {
  i++
  return i > 1 ? Number.NaN : i
}

test('getApplesCount has some unusual side effects...', () => {
  expect(getApplesCount()).not.toBeNaN()
  expect(getApplesCount()).toBeNaN()
})
```

## toBeOneOf

- **Typ:** `(sample: Array<any> | Set<any>) => any`

`toBeOneOf` prüft, ob ein Wert einem der Werte im übergebenen Array oder Set entspricht.

::: warning EXPERIMENTAL
Die Übergabe eines `Set` ist ein experimentelles Feature und kann sich in einem zukünftigen Release ändern.
:::

```ts
import { expect, test } from 'vitest'

test('fruit is one of the allowed values', () => {
  expect(fruit).toBeOneOf(['apple', 'banana', 'orange'])
})
```

Der asymmetrische Matcher ist besonders nützlich beim Testen optionaler Eigenschaften, die entweder `null` oder `undefined` sein können:

```ts
test('optional properties can be null or undefined', () => {
  const user = {
    firstName: 'John',
    middleName: undefined,
    lastName: 'Doe'
  }

  expect(user).toEqual({
    firstName: expect.any(String),
    middleName: expect.toBeOneOf([expect.any(String), undefined]),
    lastName: expect.any(String),
  })
})
```

:::tip
Sie können `expect.not` mit diesem Matcher verwenden, um sicherzustellen, dass ein Wert KEINER der angegebenen Optionen entspricht.
:::

## toBeTypeOf

- **Typ:** `(c: 'bigint' | 'boolean' | 'function' | 'number' | 'object' | 'string' | 'symbol' | 'undefined') => Awaitable<void>`

`toBeTypeOf` prüft, ob ein tatsächlicher Wert vom übergebenen Typ ist.

```ts
import { expect, test } from 'vitest'

const actual = 'stock'

test('stock is type of string', () => {
  expect(actual).toBeTypeOf('string')
})
```

:::warning
`toBeTypeOf` verwendet intern den nativen `typeof`-Operator mit all seinen Eigenheiten – vor allem der, dass der Wert `null` den Typ `object` hat.

```ts
test('toBeTypeOf cannot check for null or array', () => {
  expect(null).toBeTypeOf('object')
  expect([]).toBeTypeOf('object')
})
```
:::

## toBeInstanceOf

- **Typ:** `(c: any) => Awaitable<void>`

`toBeInstanceOf` prüft, ob ein tatsächlicher Wert eine Instanz der übergebenen Klasse ist.

```ts
import { expect, test } from 'vitest'
import { Stocks } from './stocks.js'

const stocks = new Stocks()

test('stocks are instance of Stocks', () => {
  expect(stocks).toBeInstanceOf(Stocks)
})
```

## toBeGreaterThan

- **Typ:** `(n: number | bigint) => Awaitable<void>`

`toBeGreaterThan` prüft, ob der tatsächliche Wert größer als der übergebene ist. Bei gleichen Werten schlägt der Test fehl.

```ts
import { expect, test } from 'vitest'
import { getApples } from './stocks.js'

test('have more then 10 apples', () => {
  expect(getApples()).toBeGreaterThan(10)
})
```

## toBeGreaterThanOrEqual

- **Typ:** `(n: number | bigint) => Awaitable<void>`

`toBeGreaterThanOrEqual` prüft, ob der tatsächliche Wert größer als der übergebene oder gleich ihm ist.

```ts
import { expect, test } from 'vitest'
import { getApples } from './stocks.js'

test('have 11 apples or more', () => {
  expect(getApples()).toBeGreaterThanOrEqual(11)
})
```

## toBeLessThan

- **Typ:** `(n: number | bigint) => Awaitable<void>`

`toBeLessThan` prüft, ob der tatsächliche Wert kleiner als der übergebene ist. Bei gleichen Werten schlägt der Test fehl.

```ts
import { expect, test } from 'vitest'
import { getApples } from './stocks.js'

test('have less then 20 apples', () => {
  expect(getApples()).toBeLessThan(20)
})
```

## toBeLessThanOrEqual

- **Typ:** `(n: number | bigint) => Awaitable<void>`

`toBeLessThanOrEqual` prüft, ob der tatsächliche Wert kleiner als der übergebene oder gleich ihm ist.

```ts
import { expect, test } from 'vitest'
import { getApples } from './stocks.js'

test('have 11 apples or less', () => {
  expect(getApples()).toBeLessThanOrEqual(11)
})
```

## toEqual

- **Typ:** `(received: any) => Awaitable<void>`

`toEqual` prüft, ob der tatsächliche Wert gleich dem übergebenen ist oder – falls es sich um ein Objekt handelt – dieselbe Struktur hat (der Vergleich erfolgt rekursiv). Den Unterschied zwischen `toEqual` und [`toBe`](#tobe) sehen Sie in diesem Beispiel:

```ts
import { expect, test } from 'vitest'

const stockBill = {
  type: 'apples',
  count: 13,
}

const stockMary = {
  type: 'apples',
  count: 13,
}

test('stocks have the same properties', () => {
  expect(stockBill).toEqual(stockMary)
})

test('stocks are not the same', () => {
  expect(stockBill).not.toBe(stockMary)
})
```

:::warning
Bei `Error`-Objekten werden auch nicht aufzählbare Eigenschaften wie `name`, `message`, `cause` und `AggregateError.errors` verglichen. Für `Error.cause` erfolgt der Vergleich asymmetrisch:

```ts
// success
expect(new Error('hi', { cause: 'x' })).toEqual(new Error('hi'))

// fail
expect(new Error('hi')).toEqual(new Error('hi', { cause: 'x' }))
```

Um zu testen, ob etwas geworfen wurde, verwenden Sie die [`toThrow`](#tothrow)-Assertion.
:::

## toStrictEqual

- **Typ:** `(received: any) => Awaitable<void>`

`toStrictEqual` prüft, ob der tatsächliche Wert gleich dem übergebenen ist oder – falls es sich um ein Objekt handelt – dieselbe Struktur hat (der Vergleich erfolgt rekursiv), und ob er vom selben Typ ist.

Unterschiede zu [`.toEqual`](#toequal):

-  Schlüssel mit `undefined`-Eigenschaften werden geprüft. Z. B. entspricht `{a: undefined, b: 2}` bei Verwendung von `.toStrictEqual` nicht `{b: 2}`.
-  Die Lückenhaftigkeit von Arrays wird geprüft. Z. B. entspricht `[, 1]` bei Verwendung von `.toStrictEqual` nicht `[undefined, 1]`.
-  Objekttypen werden auf Gleichheit geprüft. Z. B. ist eine Klasseninstanz mit den Feldern `a` und `b` nicht gleich einem Objektliteral mit den Feldern `a` und `b`.

```ts
import { expect, test } from 'vitest'

class Stock {
  constructor(type) {
    this.type = type
  }
}

test('structurally the same, but semantically different', () => {
  expect(new Stock('apples')).toEqual({ type: 'apples' })
  expect(new Stock('apples')).not.toStrictEqual({ type: 'apples' })
})
```

## toContain

- **Typ:** `(received: string) => Awaitable<void>`

`toContain` prüft, ob der tatsächliche Wert in einem Array enthalten ist. `toContain` kann außerdem prüfen, ob ein String ein Teilstring eines anderen Strings ist. Wenn Sie Tests in einer browserähnlichen Umgebung ausführen, kann diese Assertion auch prüfen, ob eine Klasse in einer `classList` enthalten ist oder ob ein Element innerhalb eines anderen liegt.

```ts
import { expect, test } from 'vitest'
import { getAllFruits } from './stocks.js'

test('the fruit list contains orange', () => {
  expect(getAllFruits()).toContain('orange')
})

test('pineapple contains apple', () => {
  expect('pineapple').toContain('apple')
})

test('the element contains a class and is contained', () => {
  const element = document.querySelector('#el')
  // element has a class
  expect(element.classList).toContain('flex')
  // element is inside another one
  expect(document.querySelector('#wrapper')).toContain(element)
})
```

## toContainEqual

- **Typ:** `(received: any) => Awaitable<void>`

`toContainEqual` prüft, ob ein Element mit einer bestimmten Struktur und bestimmten Werten in einem Array enthalten ist.
Intern arbeitet es für jedes Element wie [`toEqual`](#toequal).

```ts
import { expect, test } from 'vitest'
import { getFruitStock } from './stocks.js'

test('apple available', () => {
  expect(getFruitStock()).toContainEqual({ fruit: 'apple', count: 5 })
})
```

## toHaveLength

- **Typ:** `(received: number) => Awaitable<void>`

`toHaveLength` prüft, ob ein Objekt eine `.length`-Eigenschaft besitzt und diese auf einen bestimmten Zahlenwert gesetzt ist.

```ts
import { expect, test } from 'vitest'

test('toHaveLength', () => {
  expect('abc').toHaveLength(3)
  expect([1, 2, 3]).toHaveLength(3)

  expect('').not.toHaveLength(3) // doesn't have .length of 3
  expect({ length: 3 }).toHaveLength(3)
})
```

## toHaveProperty

- **Typ:** `(key: any, received?: any) => Awaitable<void>`

`toHaveProperty` prüft, ob für ein Objekt eine Eigenschaft unter dem angegebenen Schlüssel `key` existiert.

Sie können zusätzlich ein optionales Wert-Argument angeben – auch als Deep Equality bekannt, wie beim `toEqual`-Matcher –, um den erhaltenen Eigenschaftswert zu vergleichen.

```ts
import { expect, test } from 'vitest'

const invoice = {
  'isActive': true,
  'P.O': '12345',
  'customer': {
    first_name: 'John',
    last_name: 'Doe',
    location: 'China',
  },
  'total_amount': 5000,
  'items': [
    {
      type: 'apples',
      quantity: 10,
    },
    {
      type: 'oranges',
      quantity: 5,
    },
  ],
}

test('John Doe Invoice', () => {
  expect(invoice).toHaveProperty('isActive') // assert that the key exists
  expect(invoice).toHaveProperty('total_amount', 5000) // assert that the key exists and the value is equal

  expect(invoice).not.toHaveProperty('account') // assert that this key does not exist

  // Deep referencing using dot notation
  expect(invoice).toHaveProperty('customer.first_name')
  expect(invoice).toHaveProperty('customer.last_name', 'Doe')
  expect(invoice).not.toHaveProperty('customer.location', 'India')

  // Deep referencing using an array containing the key
  expect(invoice).toHaveProperty('items[0].type', 'apples')
  expect(invoice).toHaveProperty('items.0.type', 'apples') // dot notation also works

  // Deep referencing using an array containing the keyPath
  expect(invoice).toHaveProperty(['items', 0, 'type'], 'apples')
  expect(invoice).toHaveProperty(['items', '0', 'type'], 'apples') // string notation also works

  // Wrap your key in an array to avoid the key from being parsed as a deep reference
  expect(invoice).toHaveProperty(['P.O'], '12345')

  // Deep equality of object property
  expect(invoice).toHaveProperty('items[0]', { type: 'apples', quantity: 10 })
})
```

## toMatch

- **Typ:** `(received: string | regexp) => Awaitable<void>`

`toMatch` prüft, ob ein String einem regulären Ausdruck oder einem String entspricht.

```ts
import { expect, test } from 'vitest'

test('top fruits', () => {
  expect('top fruits include apple, orange and grape').toMatch(/apple/)
  expect('applefruits').toMatch('fruit') // toMatch also accepts a string
})
```

## toMatchObject

- **Typ:** `(received: object | array) => Awaitable<void>`

`toMatchObject` prüft, ob ein Objekt einer Teilmenge der Eigenschaften eines Objekts entspricht.

Sie können auch ein Array von Objekten übergeben. Das ist nützlich, wenn Sie prüfen möchten, ob zwei Arrays in Anzahl und Reihenfolge ihrer Elemente übereinstimmen – im Gegensatz zu `arrayContaining`, das zusätzliche Elemente im erhaltenen Array zulässt.

```ts
import { expect, test } from 'vitest'

const johnInvoice = {
  isActive: true,
  customer: {
    first_name: 'John',
    last_name: 'Doe',
    location: 'China',
  },
  total_amount: 5000,
  items: [
    {
      type: 'apples',
      quantity: 10,
    },
    {
      type: 'oranges',
      quantity: 5,
    },
  ],
}

const johnDetails = {
  customer: {
    first_name: 'John',
    last_name: 'Doe',
    location: 'China',
  },
}

test('invoice has john personal details', () => {
  expect(johnInvoice).toMatchObject(johnDetails)
})

test('the number of elements must match exactly', () => {
  // Assert that an array of object matches
  expect([{ foo: 'bar' }, { baz: 1 }]).toMatchObject([
    { foo: 'bar' },
    { baz: 1 },
  ])
})
```

## toThrow

- **Typ:** `(expected?: any) => Awaitable<void>`

- **Alias:** `toThrowError` <Deprecated />

`toThrow` prüft, ob eine Funktion beim Aufruf einen Fehler wirft.

Sie können ein optionales Argument angeben, um zu testen, dass ein bestimmter Fehler geworfen wird:

- `RegExp`: Die Fehlermeldung entspricht dem Muster
- `string`: Die Fehlermeldung enthält den Teilstring
- jeder andere Wert: Vergleich mit dem geworfenen Wert per Deep Equality (ähnlich wie `toEqual`)

:::tip
Sie müssen den Code in eine Funktion einpacken, sonst wird der Fehler nicht abgefangen und der Test schlägt fehl.

Für asynchrone Aufrufe gilt das nicht, da [rejects](#rejects) das Promise korrekt auspackt:
```ts
test('expect rejects toThrow', async ({ expect }) => {
  const promise = Promise.reject(new Error('Test'))
  await expect(promise).rejects.toThrow()
})
```
:::

Wenn wir zum Beispiel testen möchten, dass `getFruitStock('pineapples')` einen Fehler wirft, könnten wir schreiben:

```ts
import { expect, test } from 'vitest'

function getFruitStock(type: string) {
  if (type === 'pineapples') {
    throw new Error('Pineapples are not in stock')
  }

  // Do some other stuff
}

test('throws on pineapples', () => {
  // Test that the error message says "stock" somewhere: these are equivalent
  expect(() => getFruitStock('pineapples')).toThrow(/stock/)
  expect(() => getFruitStock('pineapples')).toThrow('stock')

  // Test the exact error message
  expect(() => getFruitStock('pineapples')).toThrow(
    /^Pineapples are not in stock$/,
  )

  expect(() => getFruitStock('pineapples')).toThrow(
    new Error('Pineapples are not in stock'),
  )
  expect(() => getFruitStock('pineapples')).toThrow(expect.objectContaining({
    message: 'Pineapples are not in stock',
  }))
})
```

:::tip
Um asynchrone Funktionen zu testen, verwenden Sie es in Kombination mit [rejects](#rejects).

```js
function getAsyncFruitStock() {
  return Promise.reject(new Error('empty'))
}

test('throws on pineapples', async () => {
  await expect(() => getAsyncFruitStock()).rejects.toThrow('empty')
})
```
:::

:::tip
Sie können auch geworfene Werte testen, die keine `Error`-Objekte sind:

```ts
test('throws non-Error values', () => {
  expect(() => { throw 42 }).toThrow(42)
  expect(() => { throw { message: 'error' } }).toThrow({ message: 'error' })
})
```
:::

:::warning Unhandled Rejections with Fake Timers
Bei Verwendung von Fake Timers löst eine asynchrone Funktion, die _während_ eines `vi.advanceTimersByTimeAsync`-Aufrufs rejected, eine [unhandled rejection](https://nodejs.org/api/process.html#event-unhandledrejection) aus – selbst wenn Sie sie später mit `.rejects.toThrow()` prüfen. Das passiert, weil der Fehler geworfen wird, bevor die `expect`-Kette die Chance hat, ihn abzufangen.

```ts
async function foo() {
  await new Promise(resolve => setTimeout(resolve, 100))
  throw new Error('boom')
}

test('rejects', async () => {
  const result = foo()

  await vi.advanceTimersByTimeAsync(100)

  // The assertion passes, but the error was already "unhandled" during advanceTimersByTimeAsync
  await expect(result).rejects.toThrow()
})
```

Um das zu vermeiden, bevorzugen Sie [`vi.setTimerTickMode('nextTimerAsync')`](/api/vi#vi-settimertickmode), damit die Timer automatisch weiterlaufen, während Promises sich auflösen, ohne dass ein manuelles Vorspulen nötig ist:

```ts
beforeEach(() => {
  vi.useFakeTimers()
  vi.setTimerTickMode('nextTimerAsync')
})

test('rejects', async () => {
  // No advanceTimersByTimeAsync needed — the error is caught by rejects.toThrow()
  await expect(foo()).rejects.toThrow('boom')
})
```

Alternativ richten Sie die `.rejects.toThrow()`-Assertion _vor_ dem Vorspulen der Timer ein, damit die Rejection sofort behandelt wird:

```ts
test('rejects', async () => {
  const result = foo()
  const assertion = expect(result).rejects.toThrow('boom')

  await vi.advanceTimersByTimeAsync(100)
  await assertion
})
```
:::

## toMatchSnapshot

- **Typ:** `<T>(shape?: Partial<T> | string, hint?: string) => void`

Dies stellt sicher, dass ein Wert dem aktuellsten Snapshot entspricht.

Sie können ein optionales `hint`-String-Argument angeben, das an den Testnamen angehängt wird. Obwohl Vitest immer eine Zahl an das Ende eines Snapshot-Namens anhängt, können kurze beschreibende Hinweise nützlicher sein als Zahlen, um mehrere Snapshots innerhalb eines einzelnen `it`- oder `test`-Blocks zu unterscheiden. Vitest sortiert Snapshots in der zugehörigen `.snap`-Datei nach Namen.

:::tip
  Wenn ein Snapshot nicht übereinstimmt und der Test dadurch fehlschlägt, können Sie – falls die Abweichung erwartet war – die Taste `u` drücken, um den Snapshot einmalig zu aktualisieren. Oder Sie übergeben die CLI-Optionen `-u` bzw. `--update`, damit Vitest die Tests immer aktualisiert.
:::

```ts
import { expect, test } from 'vitest'

test('matches snapshot', () => {
  const data = { foo: new Set(['bar', 'snapshot']) }
  expect(data).toMatchSnapshot()
})
```

Sie können auch die Form eines Objekts angeben, wenn Sie nur dessen Form testen und keine 100-prozentige Übereinstimmung benötigen:

```ts
import { expect, test } from 'vitest'

test('matches snapshot', () => {
  const data = { foo: new Set(['bar', 'snapshot']) }
  expect(data).toMatchSnapshot({ foo: expect.any(Set) })
})
```

## toMatchInlineSnapshot

- **Typ:** `<T>(shape?: Partial<T> | string, snapshot?: string, hint?: string) => void`

Dies stellt sicher, dass ein Wert dem aktuellsten Snapshot entspricht.

Vitest fügt das inlineSnapshot-String-Argument beim Matcher in der Testdatei hinzu und aktualisiert es dort (statt in einer externen `.snap`-Datei).

```ts
import { expect, test } from 'vitest'

test('matches inline snapshot', () => {
  const data = { foo: new Set(['bar', 'snapshot']) }
  // Vitest will update following content when updating the snapshot
  expect(data).toMatchInlineSnapshot(`
    {
      "foo": Set {
        "bar",
        "snapshot",
      },
    }
  `)
})
```

Sie können auch die Form eines Objekts angeben, wenn Sie nur dessen Form testen und keine 100-prozentige Übereinstimmung benötigen:

```ts
import { expect, test } from 'vitest'

test('matches snapshot', () => {
  const data = { foo: new Set(['bar', 'snapshot']) }
  expect(data).toMatchInlineSnapshot(
    { foo: expect.any(Set) },
    `
    {
      "foo": Any<Set>,
    }
  `
  )
})
```

## toMatchFileSnapshot {#tomatchfilesnapshot}

- **Typ:** `<T>(filepath: string, hint?: string) => Promise<void>`

Vergleicht oder aktualisiert den Snapshot mit dem Inhalt einer explizit angegebenen Datei (statt der `.snap`-Datei).

```ts
import { expect, it } from 'vitest'

it('render basic', async () => {
  const result = renderHTML(h('div', { class: 'foo' }))
  await expect(result).toMatchFileSnapshot('./test/basic.output.html')
})
```

Beachten Sie, dass Dateisystemoperationen asynchron sind und Sie daher `await` mit `toMatchFileSnapshot()` verwenden müssen. Wird `await` nicht verwendet, behandelt Vitest den Aufruf wie `expect.soft`, das heißt, der Code nach der Anweisung läuft auch dann weiter, wenn der Snapshot nicht übereinstimmt. Nach dem Ende des Tests prüft Vitest den Snapshot und lässt den Test bei einer Abweichung fehlschlagen.

## toThrowErrorMatchingSnapshot

- **Typ:** `(hint?: string) => void`

Dasselbe wie [`toMatchSnapshot`](#tomatchsnapshot), erwartet aber denselben Wert wie [`toThrow`](#tothrow).

## toThrowErrorMatchingInlineSnapshot

- **Typ:** `(snapshot?: string, hint?: string) => void`

Dasselbe wie [`toMatchInlineSnapshot`](#tomatchinlinesnapshot), erwartet aber denselben Wert wie [`toThrow`](#tothrow).

## toMatchAriaSnapshot <Version type="experimental">4.1.4</Version> <Experimental /> {#tomatcharisnapshot}

- **Typ:** `() => void`

Erfasst den Accessibility-Baum eines DOM-Elements und erzeugt eine Snapshot-Datei oder vergleicht ihn mit einem gespeicherten Snapshot. Weitere Details finden Sie im [ARIA-Snapshots-Leitfaden](/guide/browser/aria-snapshots).

```ts
import { expect, test } from 'vitest'

test('navigation accessibility', () => {
  document.body.innerHTML = `
    <nav aria-label="Actions">
      <button>Save</button>
      <button>Cancel</button>
    </nav>
  `
  expect(document.querySelector('nav')).toMatchAriaSnapshot()
})
```

## toMatchAriaInlineSnapshot <Version type="experimental">4.1.4</Version> <Experimental /> {#tomatchariainlinesnapshot}

- **Typ:** `(snapshot?: string) => void`

Dasselbe wie [`toMatchAriaSnapshot`](#tomatcharisnapshot), speichert den Snapshot aber inline in der Testdatei. Weitere Details finden Sie im [ARIA-Snapshots-Leitfaden](/guide/browser/aria-snapshots).

```ts
import { expect, test } from 'vitest'

test('user profile', () => {
  expect(document.body).toMatchAriaInlineSnapshot(`
    - heading "Dashboard" [level=1]
    - button /User \\d+/: Profile
  `)
})
```

## toHaveBeenCalled

- **Typ:** `() => Awaitable<void>`

Diese Assertion ist nützlich, um zu testen, dass eine Funktion aufgerufen wurde. Erfordert, dass eine Spy-Funktion an `expect` übergeben wird.

```ts
import { expect, test, vi } from 'vitest'

const market = {
  buy(subject: string, amount: number) {
    // ...
  },
}

test('spy function', () => {
  const buySpy = vi.spyOn(market, 'buy')

  expect(buySpy).not.toHaveBeenCalled()

  market.buy('apples', 10)

  expect(buySpy).toHaveBeenCalled()
})
```

## toHaveBeenCalledTimes

- **Typ:** `(amount: number) => Awaitable<void>`

Diese Assertion prüft, ob eine Funktion eine bestimmte Anzahl von Malen aufgerufen wurde. Erfordert, dass eine Spy-Funktion an `expect` übergeben wird.

```ts
import { expect, test, vi } from 'vitest'

const market = {
  buy(subject: string, amount: number) {
    // ...
  },
}

test('spy function called two times', () => {
  const buySpy = vi.spyOn(market, 'buy')

  market.buy('apples', 10)
  market.buy('apples', 20)

  expect(buySpy).toHaveBeenCalledTimes(2)
})
```

## toHaveBeenCalledWith

- **Typ:** `(...args: any[]) => Awaitable<void>`

Diese Assertion prüft, ob eine Funktion mindestens einmal mit bestimmten Parametern aufgerufen wurde. Erfordert, dass eine Spy-Funktion an `expect` übergeben wird.

```ts
import { expect, test, vi } from 'vitest'

const market = {
  buy(subject: string, amount: number) {
    // ...
  },
}

test('spy function', () => {
  const buySpy = vi.spyOn(market, 'buy')

  market.buy('apples', 10)
  market.buy('apples', 20)

  expect(buySpy).toHaveBeenCalledWith('apples', 10)
  expect(buySpy).toHaveBeenCalledWith('apples', 20)
})
```

## toHaveBeenCalledBefore

- **Typ:** `(mock: MockInstance, failIfNoFirstInvocation?: boolean) => Awaitable<void>`

Diese Assertion prüft, ob ein `Mock` vor einem anderen `Mock` aufgerufen wurde.

```ts
test('calls mock1 before mock2', () => {
  const mock1 = vi.fn()
  const mock2 = vi.fn()

  mock1()
  mock2()
  mock1()

  expect(mock1).toHaveBeenCalledBefore(mock2)
})
```

## toHaveBeenCalledAfter

- **Typ:** `(mock: MockInstance, failIfNoFirstInvocation?: boolean) => Awaitable<void>`

Diese Assertion prüft, ob ein `Mock` nach einem anderen `Mock` aufgerufen wurde.

```ts
test('calls mock1 after mock2', () => {
  const mock1 = vi.fn()
  const mock2 = vi.fn()

  mock2()
  mock1()
  mock2()

  expect(mock1).toHaveBeenCalledAfter(mock2)
})
```

## toHaveBeenCalledExactlyOnceWith

- **Typ:** `(...args: any[]) => Awaitable<void>`

Diese Assertion prüft, ob eine Funktion genau einmal und mit bestimmten Parametern aufgerufen wurde. Erfordert, dass eine Spy-Funktion an `expect` übergeben wird.

```ts
import { expect, test, vi } from 'vitest'

const market = {
  buy(subject: string, amount: number) {
    // ...
  },
}

test('spy function', () => {
  const buySpy = vi.spyOn(market, 'buy')

  market.buy('apples', 10)

  expect(buySpy).toHaveBeenCalledExactlyOnceWith('apples', 10)
})
```

## toHaveBeenLastCalledWith

- **Typ:** `(...args: any[]) => Awaitable<void>`

Diese Assertion prüft, ob eine Funktion bei ihrem letzten Aufruf mit bestimmten Parametern aufgerufen wurde. Erfordert, dass eine Spy-Funktion an `expect` übergeben wird.

```ts
import { expect, test, vi } from 'vitest'

const market = {
  buy(subject: string, amount: number) {
    // ...
  },
}

test('spy function', () => {
  const buySpy = vi.spyOn(market, 'buy')

  market.buy('apples', 10)
  market.buy('apples', 20)

  expect(buySpy).not.toHaveBeenLastCalledWith('apples', 10)
  expect(buySpy).toHaveBeenLastCalledWith('apples', 20)
})
```

## toHaveBeenNthCalledWith

- **Typ:** `(time: number, ...args: any[]) => Awaitable<void>`

Diese Assertion prüft, ob eine Funktion beim angegebenen Aufruf mit bestimmten Parametern aufgerufen wurde. Die Zählung beginnt bei 1. Um also den zweiten Eintrag zu prüfen, würden Sie `.toHaveBeenNthCalledWith(2, ...)` schreiben.

Erfordert, dass eine Spy-Funktion an `expect` übergeben wird.

```ts
import { expect, test, vi } from 'vitest'

const market = {
  buy(subject: string, amount: number) {
    // ...
  },
}

test('first call of spy function called with right params', () => {
  const buySpy = vi.spyOn(market, 'buy')

  market.buy('apples', 10)
  market.buy('apples', 20)

  expect(buySpy).toHaveBeenNthCalledWith(1, 'apples', 10)
})
```

## toHaveReturned

- **Typ:** `() => Awaitable<void>`

Diese Assertion prüft, ob eine Funktion mindestens einmal erfolgreich einen Wert zurückgegeben hat (d. h. keinen Fehler geworfen hat). Erfordert, dass eine Spy-Funktion an `expect` übergeben wird.

```ts
import { expect, test, vi } from 'vitest'

function getApplesPrice(amount: number) {
  const PRICE = 10
  return amount * PRICE
}

test('spy function returned a value', () => {
  const getPriceSpy = vi.fn(getApplesPrice)

  const price = getPriceSpy(10)

  expect(price).toBe(100)
  expect(getPriceSpy).toHaveReturned()
})
```

## toHaveReturnedTimes

- **Typ:** `(amount: number) => Awaitable<void>`

Diese Assertion prüft, ob eine Funktion genau eine bestimmte Anzahl von Malen erfolgreich einen Wert zurückgegeben hat (d. h. keinen Fehler geworfen hat). Erfordert, dass eine Spy-Funktion an `expect` übergeben wird.

```ts
import { expect, test, vi } from 'vitest'

test('spy function returns a value two times', () => {
  const sell = vi.fn((product: string) => ({ product }))

  sell('apples')
  sell('bananas')

  expect(sell).toHaveReturnedTimes(2)
})
```

## toHaveReturnedWith

- **Typ:** `(returnValue: any) => Awaitable<void>`

Sie können diese Assertion aufrufen, um zu prüfen, ob eine Funktion mindestens einmal erfolgreich einen Wert mit bestimmten Parametern zurückgegeben hat. Erfordert, dass eine Spy-Funktion an `expect` übergeben wird.

```ts
import { expect, test, vi } from 'vitest'

test('spy function returns a product', () => {
  const sell = vi.fn((product: string) => ({ product }))

  sell('apples')

  expect(sell).toHaveReturnedWith({ product: 'apples' })
})
```

## toHaveLastReturnedWith

- **Typ:** `(returnValue: any) => Awaitable<void>`

Sie können diese Assertion aufrufen, um zu prüfen, ob eine Funktion bei ihrem letzten Aufruf erfolgreich einen bestimmten Wert zurückgegeben hat. Erfordert, dass eine Spy-Funktion an `expect` übergeben wird.

```ts
import { expect, test, vi } from 'vitest'

test('spy function returns bananas on a last call', () => {
  const sell = vi.fn((product: string) => ({ product }))

  sell('apples')
  sell('bananas')

  expect(sell).toHaveLastReturnedWith({ product: 'bananas' })
})
```

## toHaveNthReturnedWith

- **Typ:** `(time: number, returnValue: any) => Awaitable<void>`

Sie können diese Assertion aufrufen, um zu prüfen, ob eine Funktion bei einem bestimmten Aufruf erfolgreich einen Wert mit bestimmten Parametern zurückgegeben hat. Erfordert, dass eine Spy-Funktion an `expect` übergeben wird.

Die Zählung beginnt bei 1. Um also den zweiten Eintrag zu prüfen, würden Sie `.toHaveNthReturnedWith(2, ...)` schreiben.

```ts
import { expect, test, vi } from 'vitest'

test('spy function returns bananas on second call', () => {
  const sell = vi.fn((product: string) => ({ product }))

  sell('apples')
  sell('bananas')

  expect(sell).toHaveNthReturnedWith(2, { product: 'bananas' })
})
```

## toHaveResolved

- **Typ:** `() => Awaitable<void>`

Diese Assertion prüft, ob eine Funktion mindestens einmal erfolgreich einen Wert resolved hat (d. h. nicht rejected wurde). Erfordert, dass eine Spy-Funktion an `expect` übergeben wird.

Wenn die Funktion ein Promise zurückgegeben hat, dieses aber noch nicht resolved wurde, schlägt die Assertion fehl.

```ts
import { expect, test, vi } from 'vitest'
import db from './db/apples.js'

async function getApplesPrice(amount: number) {
  return amount * await db.get('price')
}

test('spy function resolved a value', async () => {
  const getPriceSpy = vi.fn(getApplesPrice)

  const price = await getPriceSpy(10)

  expect(price).toBe(100)
  expect(getPriceSpy).toHaveResolved()
})
```

## toHaveResolvedTimes

- **Typ:** `(amount: number) => Awaitable<void>`

Diese Assertion prüft, ob eine Funktion genau eine bestimmte Anzahl von Malen erfolgreich einen Wert resolved hat (d. h. nicht rejected wurde). Erfordert, dass eine Spy-Funktion an `expect` übergeben wird.

Es werden nur resolvte Promises gezählt. Wenn die Funktion ein Promise zurückgegeben hat, dieses aber noch nicht resolved wurde, wird es nicht mitgezählt.

```ts
import { expect, test, vi } from 'vitest'

test('spy function resolved a value two times', async () => {
  const sell = vi.fn((product: string) => Promise.resolve({ product }))

  await sell('apples')
  await sell('bananas')

  expect(sell).toHaveResolvedTimes(2)
})
```

## toHaveResolvedWith

- **Typ:** `(returnValue: any) => Awaitable<void>`

Sie können diese Assertion aufrufen, um zu prüfen, ob eine Funktion mindestens einmal erfolgreich einen bestimmten Wert resolved hat. Erfordert, dass eine Spy-Funktion an `expect` übergeben wird.

Wenn die Funktion ein Promise zurückgegeben hat, dieses aber noch nicht resolved wurde, schlägt die Assertion fehl.

```ts
import { expect, test, vi } from 'vitest'

test('spy function resolved a product', async () => {
  const sell = vi.fn((product: string) => Promise.resolve({ product }))

  await sell('apples')

  expect(sell).toHaveResolvedWith({ product: 'apples' })
})
```

## toHaveLastResolvedWith

- **Typ:** `(returnValue: any) => Awaitable<void>`

Sie können diese Assertion aufrufen, um zu prüfen, ob eine Funktion bei ihrem letzten Aufruf erfolgreich einen bestimmten Wert resolved hat. Erfordert, dass eine Spy-Funktion an `expect` übergeben wird.

Wenn die Funktion ein Promise zurückgegeben hat, dieses aber noch nicht resolved wurde, schlägt die Assertion fehl.

```ts
import { expect, test, vi } from 'vitest'

test('spy function resolves bananas on a last call', async () => {
  const sell = vi.fn((product: string) => Promise.resolve({ product }))

  await sell('apples')
  await sell('bananas')

  expect(sell).toHaveLastResolvedWith({ product: 'bananas' })
})
```

## toHaveNthResolvedWith

- **Typ:** `(time: number, returnValue: any) => Awaitable<void>`

Sie können diese Assertion aufrufen, um zu prüfen, ob eine Funktion bei einem bestimmten Aufruf erfolgreich einen bestimmten Wert resolved hat. Erfordert, dass eine Spy-Funktion an `expect` übergeben wird.

Wenn die Funktion ein Promise zurückgegeben hat, dieses aber noch nicht resolved wurde, schlägt die Assertion fehl.

Die Zählung beginnt bei 1. Um also den zweiten Eintrag zu prüfen, würden Sie `.toHaveNthResolvedWith(2, ...)` schreiben.

```ts
import { expect, test, vi } from 'vitest'

test('spy function returns bananas on second call', async () => {
  const sell = vi.fn((product: string) => Promise.resolve({ product }))

  await sell('apples')
  await sell('bananas')

  expect(sell).toHaveNthResolvedWith(2, { product: 'bananas' })
})
```

## toHaveBeenExhausted <Version>5.0.0</Version> {#tohavebeenexhausted}

- **Typ:** `() => void`

Diese Assertion prüft, dass jedes in einer [`vi.when`](/api/vi#vi-when)-Kette registrierte Verhalten aufgebraucht wurde. Ein Verhalten gilt als aufgebraucht, wenn es so oft aufgerufen wurde, wie es seine `times`-Option vorgibt, oder mindestens einmal bei Verhalten, die unbegrenzt gelten.

Erfordert, dass eine von `vi.when` zurückgegebene `When`-Kette an `expect` übergeben wird.

```ts
import { expect, test, vi } from 'vitest'

test('all behaviors were consumed', () => {
  const spy = vi.fn()
  const w = vi.when(spy)
    .calledWith(1)
    .thenReturnOnce('once')
    .calledWith(2)
    .thenReturn('always')

  expect(w).not.toHaveBeenExhausted()

  spy(1) // consumes the `thenReturnOnce` behavior
  spy(2) // satisfies the `thenReturn` behavior (called at least once)

  expect(w).toHaveBeenExhausted()
})
```

::: warning
Eine `When`-Kette ohne registrierte Verhalten gilt niemals als aufgebraucht. `toHaveBeenExhausted` ist nur erfolgreich, wenn mindestens ein `calledWith` mit einer zugehörigen Aktion (`then*`) registriert wurde und jedes registrierte Verhalten vollständig aufgebraucht ist.
:::

## called <Version>4.1.0</Version> {#called}

- **Typ:** `Assertion` (Eigenschaft, keine Methode)

Assertion im Chai-Stil, die prüft, ob ein Spy mindestens einmal aufgerufen wurde. Sie entspricht `toHaveBeenCalled()`.

::: tip
Dies ist eine Eigenschafts-Assertion nach den sinon-chai-Konventionen. Greifen Sie ohne Klammern darauf zu: `expect(spy).to.have.been.called`
:::

```ts
import { expect, test, vi } from 'vitest'

test('spy was called', () => {
  const spy = vi.fn()

  spy()

  expect(spy).to.have.been.called
  expect(spy).to.not.have.been.called // negation
})
```

## callCount <Version>4.1.0</Version> {#callcount}

- **Typ:** `(count: number) => void`

Assertion im Chai-Stil, die prüft, ob ein Spy eine bestimmte Anzahl von Malen aufgerufen wurde. Sie entspricht `toHaveBeenCalledTimes(count)`.

```ts
import { expect, test, vi } from 'vitest'

test('spy call count', () => {
  const spy = vi.fn()

  spy()
  spy()
  spy()

  expect(spy).to.have.callCount(3)
})
```

## calledWith <Version>4.1.0</Version> {#calledwith}

- **Typ:** `(...args: any[]) => void`

Assertion im Chai-Stil, die prüft, ob ein Spy mindestens einmal mit bestimmten Argumenten aufgerufen wurde. Sie entspricht `toHaveBeenCalledWith(...args)`.

```ts
import { expect, test, vi } from 'vitest'

test('spy called with arguments', () => {
  const spy = vi.fn()

  spy('apple', 10)
  spy('banana', 20)

  expect(spy).to.have.been.calledWith('apple', 10)
  expect(spy).to.have.been.calledWith('banana', 20)
})
```

## calledOnce <Version>4.1.0</Version> {#calledonce}

- **Typ:** `Assertion` (Eigenschaft, keine Methode)

Assertion im Chai-Stil, die prüft, ob ein Spy genau einmal aufgerufen wurde. Sie entspricht `toHaveBeenCalledOnce()`.

::: tip
Dies ist eine Eigenschafts-Assertion nach den sinon-chai-Konventionen. Greifen Sie ohne Klammern darauf zu: `expect(spy).to.have.been.calledOnce`
:::

```ts
import { expect, test, vi } from 'vitest'

test('spy called once', () => {
  const spy = vi.fn()

  spy()

  expect(spy).to.have.been.calledOnce
})
```

## calledOnceWith <Version>4.1.0</Version> {#calledoncewith}

- **Typ:** `(...args: any[]) => void`

Assertion im Chai-Stil, die prüft, ob ein Spy genau einmal mit bestimmten Argumenten aufgerufen wurde. Sie entspricht `toHaveBeenCalledExactlyOnceWith(...args)`.

```ts
import { expect, test, vi } from 'vitest'

test('spy called once with arguments', () => {
  const spy = vi.fn()

  spy('apple', 10)

  expect(spy).to.have.been.calledOnceWith('apple', 10)
})
```

## calledTwice <Version>4.1.0</Version> {#calledtwice}

- **Typ:** `Assertion` (Eigenschaft, keine Methode)

Assertion im Chai-Stil, die prüft, ob ein Spy genau zweimal aufgerufen wurde. Sie entspricht `toHaveBeenCalledTimes(2)`.

::: tip
Dies ist eine Eigenschafts-Assertion nach den sinon-chai-Konventionen. Greifen Sie ohne Klammern darauf zu: `expect(spy).to.have.been.calledTwice`
:::

```ts
import { expect, test, vi } from 'vitest'

test('spy called twice', () => {
  const spy = vi.fn()

  spy()
  spy()

  expect(spy).to.have.been.calledTwice
})
```

## calledThrice <Version>4.1.0</Version> {#calledthrice}

- **Typ:** `Assertion` (Eigenschaft, keine Methode)

Assertion im Chai-Stil, die prüft, ob ein Spy genau dreimal aufgerufen wurde. Sie entspricht `toHaveBeenCalledTimes(3)`.

::: tip
Dies ist eine Eigenschafts-Assertion nach den sinon-chai-Konventionen. Greifen Sie ohne Klammern darauf zu: `expect(spy).to.have.been.calledThrice`
:::

```ts
import { expect, test, vi } from 'vitest'

test('spy called thrice', () => {
  const spy = vi.fn()

  spy()
  spy()
  spy()

  expect(spy).to.have.been.calledThrice
})
```

## lastCalledWith

- **Typ:** `(...args: any[]) => void`

Assertion im Chai-Stil, die prüft, ob der letzte Aufruf eines Spy mit bestimmten Argumenten erfolgt ist. Sie entspricht `toHaveBeenLastCalledWith(...args)`.

```ts
import { expect, test, vi } from 'vitest'

test('spy last called with', () => {
  const spy = vi.fn()

  spy('apple', 10)
  spy('banana', 20)

  expect(spy).to.have.been.lastCalledWith('banana', 20)
})
```

## nthCalledWith

- **Typ:** `(n: number, ...args: any[]) => void`

Assertion im Chai-Stil, die prüft, ob der n-te Aufruf eines Spy mit bestimmten Argumenten erfolgt ist. Sie entspricht `toHaveBeenNthCalledWith(n, ...args)`.

```ts
import { expect, test, vi } from 'vitest'

test('spy nth called with', () => {
  const spy = vi.fn()

  spy('apple', 10)
  spy('banana', 20)
  spy('cherry', 30)

  expect(spy).to.have.been.nthCalledWith(2, 'banana', 20)
})
```

## returned <Version>4.1.0</Version> {#returned}

- **Typ:** `(value: any) => void`

Assertion im Chai-Stil, die prüft, ob ein Spy mindestens einmal einen bestimmten Wert zurückgegeben hat. Sie entspricht `toHaveReturnedWith(value)`.

```ts
import { expect, test, vi } from 'vitest'

test('spy returned', () => {
  const spy = vi.fn(() => 'value')

  spy()

  expect(spy).to.have.returned('value')
})
```

## returnedWith <Version>4.1.0</Version> {#returnedwith}

- **Typ:** `(value: any) => void`

Assertion im Chai-Stil, die prüft, ob ein Spy mindestens einmal einen bestimmten Wert zurückgegeben hat. Sie entspricht `toHaveReturnedWith(value)`.

```ts
import { expect, test, vi } from 'vitest'

test('spy returned with value', () => {
  const spy = vi.fn()
    .mockReturnValueOnce('apple')
    .mockReturnValueOnce('banana')

  spy()
  spy()

  expect(spy).to.have.returnedWith('apple')
  expect(spy).to.have.returnedWith('banana')
})
```

## returnedTimes <Version>4.1.0</Version> {#returnedtimes}

- **Typ:** `(count: number) => void`

Assertion im Chai-Stil, die prüft, ob ein Spy eine bestimmte Anzahl von Malen erfolgreich zurückgekehrt ist. Sie entspricht `toHaveReturnedTimes(count)`.

```ts
import { expect, test, vi } from 'vitest'

test('spy returned times', () => {
  const spy = vi.fn(() => 'result')

  spy()
  spy()
  spy()

  expect(spy).to.have.returnedTimes(3)
})
```

## lastReturnedWith

- **Typ:** `(value: any) => void`

Assertion im Chai-Stil, die prüft, ob der letzte Rückgabewert eines Spy dem erwarteten Wert entspricht. Sie entspricht `toHaveLastReturnedWith(value)`.

```ts
import { expect, test, vi } from 'vitest'

test('spy last returned with', () => {
  const spy = vi.fn()
    .mockReturnValueOnce('apple')
    .mockReturnValueOnce('banana')

  spy()
  spy()

  expect(spy).to.have.lastReturnedWith('banana')
})
```

## nthReturnedWith

- **Typ:** `(n: number, value: any) => void`

Assertion im Chai-Stil, die prüft, ob der n-te Rückgabewert eines Spy dem erwarteten Wert entspricht. Sie entspricht `toHaveNthReturnedWith(n, value)`.

```ts
import { expect, test, vi } from 'vitest'

test('spy nth returned with', () => {
  const spy = vi.fn()
    .mockReturnValueOnce('apple')
    .mockReturnValueOnce('banana')
    .mockReturnValueOnce('cherry')

  spy()
  spy()
  spy()

  expect(spy).to.have.nthReturnedWith(2, 'banana')
})
```

## calledBefore <Version>4.1.0</Version> {#calledbefore}

- **Typ:** `(mock: MockInstance, failIfNoFirstInvocation?: boolean) => void`

Assertion im Chai-Stil, die prüft, ob ein Spy vor einem anderen Spy aufgerufen wurde. Sie entspricht `toHaveBeenCalledBefore(mock, failIfNoFirstInvocation)`.

```ts
import { expect, test, vi } from 'vitest'

test('spy called before another', () => {
  const spy1 = vi.fn()
  const spy2 = vi.fn()

  spy1()
  spy2()

  expect(spy1).to.have.been.calledBefore(spy2)
})
```

## calledAfter <Version>4.1.0</Version> {#calledafter}

- **Typ:** `(mock: MockInstance, failIfNoFirstInvocation?: boolean) => void`

Assertion im Chai-Stil, die prüft, ob ein Spy nach einem anderen Spy aufgerufen wurde. Sie entspricht `toHaveBeenCalledAfter(mock, failIfNoFirstInvocation)`.

```ts
import { expect, test, vi } from 'vitest'

test('spy called after another', () => {
  const spy1 = vi.fn()
  const spy2 = vi.fn()

  spy1()
  spy2()

  expect(spy2).to.have.been.calledAfter(spy1)
})
```

::: tip Migration Guide
Eine vollständige Anleitung zur Migration von Mocha+Chai+Sinon zu Vitest finden Sie im [Migrationsleitfaden](/guide/migration#mocha-chai-sinon).
:::

## toSatisfy

- **Typ:** `(predicate: (value: any) => boolean) => Awaitable<void>`

Diese Assertion prüft, ob ein Wert ein bestimmtes Prädikat erfüllt.

```ts
import { describe, expect, it } from 'vitest'

const isOdd = (value: number) => value % 2 !== 0

describe('toSatisfy()', () => {
  it('pass with 0', () => {
    expect(1).toSatisfy(isOdd)
  })

  it('pass with negation', () => {
    expect(2).not.toSatisfy(isOdd)
  })
})
```

## resolves

- **Typ:** `Promisify<Assertions>`

`resolves` soll Boilerplate beim Prüfen von asynchronem Code vermeiden. Verwenden Sie es, um den Wert aus dem ausstehenden Promise auszupacken und ihn mit den üblichen Assertions zu prüfen. Wenn das Promise rejected wird, schlägt die Assertion fehl.

Es gibt dasselbe `Assertions`-Objekt zurück, aber alle Matcher liefern nun ein `Promise` zurück, sodass Sie es awaiten müssen. Funktioniert auch mit `chai`-Assertions.

Wenn Sie zum Beispiel eine Funktion haben, die einen API-Aufruf macht und Daten zurückgibt, können Sie mit diesem Code ihren Rückgabewert prüfen:

```ts
import { expect, test } from 'vitest'

async function buyApples() {
  return fetch('/buy/apples').then(r => r.json())
}

test('buyApples returns new stock id', async () => {
  // toEqual returns a promise now, so you HAVE to await it
  await expect(buyApples()).resolves.toEqual({ id: 1 }) // jest API
  await expect(buyApples()).resolves.to.equal({ id: 1 }) // chai API
})
```

:::warning
Wenn die Assertion nicht awaitet wird, wird der Test am Ende als „failed“ markiert.
:::

## rejects

- **Typ:** `Promisify<Assertions>`

`rejects` soll Boilerplate beim Prüfen von asynchronem Code vermeiden. Verwenden Sie es, um den Grund auszupacken, aus dem das Promise rejected wurde, und ihn mit den üblichen Assertions zu prüfen. Wenn das Promise erfolgreich resolved wird, schlägt die Assertion fehl.

Es gibt dasselbe `Assertions`-Objekt zurück, aber alle Matcher liefern nun ein `Promise` zurück, sodass Sie es awaiten müssen. Funktioniert auch mit `chai`-Assertions.

Wenn Sie zum Beispiel eine Funktion haben, die beim Aufruf fehlschlägt, können Sie mit diesem Code den Grund prüfen:

```ts
import { expect, test } from 'vitest'

async function buyApples(id) {
  if (!id) {
    throw new Error('no id')
  }
}

test('buyApples throws an error when no id provided', async () => {
  // toThrow returns a promise now, so you HAVE to await it
  await expect(buyApples()).rejects.toThrow('no id')
})
```

:::warning
Wenn die Assertion nicht awaitet wird, wird der Test am Ende als „failed“ markiert.
:::

## expect.assertions

- **Typ:** `(count: number) => void`

Prüft nach dem Bestehen oder Fehlschlagen des Tests, dass während des Tests eine bestimmte Anzahl von Assertions aufgerufen wurde. Ein nützlicher Fall wäre zu prüfen, ob asynchroner Code aufgerufen wurde.

Wenn wir zum Beispiel eine Funktion haben, die asynchron zwei Matcher aufruft, können wir prüfen, dass sie tatsächlich aufgerufen wurden.

```ts
import { expect, test } from 'vitest'

async function doAsync(...cbs) {
  await Promise.all(
    cbs.map((cb, index) => cb({ index })),
  )
}

test('all assertions are called', async () => {
  expect.assertions(2)
  function callback1(data) {
    expect(data).toBeTruthy()
  }
  function callback2(data) {
    expect(data).toBeTruthy()
  }

  await doAsync(callback1, callback2)
})
```
::: warning
Bei der Verwendung von `assertions` mit asynchronen nebenläufigen Tests muss das `expect` aus dem lokalen [Test-Kontext](/guide/test-context) verwendet werden, damit der richtige Test erkannt wird.
:::

## expect.hasAssertions

- **Typ:** `() => void`

Prüft nach dem Bestehen oder Fehlschlagen des Tests, dass während des Tests mindestens eine Assertion aufgerufen wurde. Ein nützlicher Fall wäre zu prüfen, ob asynchroner Code aufgerufen wurde.

Wenn Sie zum Beispiel Code haben, der einen Callback aufruft, können wir innerhalb des Callbacks eine Assertion ausführen – der Test wird aber immer bestehen, wenn wir nicht prüfen, ob eine Assertion aufgerufen wurde.

```ts
import { expect, test } from 'vitest'
import { db } from './db.js'

const cbs = []

function onSelect(cb) {
  cbs.push(cb)
}

// after selecting from db, we call all callbacks
function select(id) {
  return db.select({ id }).then((data) => {
    return Promise.all(
      cbs.map(cb => cb(data)),
    )
  })
}

test('callback was called', async () => {
  expect.hasAssertions()
  onSelect((data) => {
    // should be called on select
    expect(data).toBeTruthy()
  })
  // if not awaited, test will fail
  // if you don't have expect.hasAssertions(), test will pass
  await select(3)
})
```

## expect.unreachable

- **Typ:** `(message?: string) => never`

Diese Methode wird verwendet, um zu prüfen, dass eine Zeile niemals erreicht werden sollte.

Wenn wir zum Beispiel testen möchten, dass `build()` einen Fehler wirft, weil es Verzeichnisse ohne `src`-Ordner erhält, und außerdem jeden Fehler einzeln behandeln möchten, könnten wir Folgendes tun:

```ts
import { expect, test } from 'vitest'

async function build(dir) {
  if (dir.includes('no-src')) {
    throw new Error(`${dir}/src does not exist`)
  }
}

const errorDirs = [
  'no-src-folder',
  // ...
]

test.each(errorDirs)('build fails with "%s"', async (dir) => {
  try {
    await build(dir)
    expect.unreachable('Should not pass build')
  }
  catch (err: any) {
    expect(err).toBeInstanceOf(Error)
    expect(err.stack).toContain('build')

    switch (dir) {
      case 'no-src-folder':
        expect(err.message).toBe(`${dir}/src does not exist`)
        break
      default:
        // to exhaust all error tests
        expect.unreachable('All error test must be handled')
        break
    }
  }
})
```

## expect.anything

- **Typ:** `() => any`

Dieser asymmetrische Matcher passt auf alles außer `null` oder `undefined`. Nützlich, wenn Sie nur sicherstellen möchten, dass eine Eigenschaft mit irgendeinem Wert existiert, der weder `null` noch `undefined` ist.

```ts
import { expect, test } from 'vitest'

test('object has "apples" key', () => {
  expect({ apples: 22 }).toEqual({ apples: expect.anything() })
})
```

## expect.any

- **Typ:** `(constructor: unknown) => any`

Dieser asymmetrische Matcher gibt bei Verwendung in einer Gleichheitsprüfung nur dann `true` zurück, wenn der Wert eine Instanz des angegebenen Konstruktors ist. Nützlich, wenn Sie einen Wert haben, der jedes Mal neu erzeugt wird, und Sie nur wissen möchten, dass er mit dem richtigen Typ existiert.

```ts
import { expect, test } from 'vitest'
import { generateId } from './generators.js'

test('"id" is a number', () => {
  expect({ id: generateId() }).toEqual({ id: expect.any(Number) })
})
```

## expect.closeTo {#expect-closeto}

- **Typ:** `(expected: any, precision?: number) => any`

`expect.closeTo` ist nützlich beim Vergleich von Gleitkommazahlen in Objekteigenschaften oder Array-Elementen. Wenn Sie eine Zahl direkt vergleichen müssen, verwenden Sie bitte stattdessen `.toBeCloseTo`.

Das optionale Argument `precision` begrenzt die Anzahl der zu prüfenden Stellen **nach** dem Dezimalpunkt. Beim Standardwert `2` lautet das Testkriterium `Math.abs(expected - received) < 0.005 (that is, 10 ** -2 / 2)`.

Dieser Test besteht zum Beispiel mit einer Genauigkeit von 5 Stellen:

```js
test('compare float in object properties', () => {
  expect({
    title: '0.1 + 0.2',
    sum: 0.1 + 0.2,
  }).toEqual({
    title: '0.1 + 0.2',
    sum: expect.closeTo(0.3, 5),
  })
})
```

## expect.arrayContaining

- **Typ:** `<T>(expected: T[]) => any`

Bei Verwendung in einer Gleichheitsprüfung gibt dieser asymmetrische Matcher `true` zurück, wenn der Wert ein Array ist und die angegebenen Elemente enthält.

```ts
import { expect, test } from 'vitest'

test('basket includes fuji', () => {
  const basket = {
    varieties: [
      'Empire',
      'Fuji',
      'Gala',
    ],
    count: 3
  }
  expect(basket).toEqual({
    count: 3,
    varieties: expect.arrayContaining(['Fuji'])
  })
})
```

:::tip
Sie können `expect.not` mit diesem Matcher verwenden, um den erwarteten Wert zu negieren.
:::

## expect.objectContaining

- **Typ:** `(expected: any) => any`

Bei Verwendung in einer Gleichheitsprüfung gibt dieser asymmetrische Matcher `true` zurück, wenn der Wert eine ähnliche Form hat.

```ts
import { expect, test } from 'vitest'

test('basket has empire apples', () => {
  const basket = {
    varieties: [
      {
        name: 'Empire',
        count: 1,
      }
    ],
  }
  expect(basket).toEqual({
    varieties: [
      expect.objectContaining({ name: 'Empire' }),
    ]
  })
})
```

:::tip
Sie können `expect.not` mit diesem Matcher verwenden, um den erwarteten Wert zu negieren.
:::

## expect.stringContaining

- **Typ:** `(expected: any) => any`

Bei Verwendung in einer Gleichheitsprüfung gibt dieser asymmetrische Matcher `true` zurück, wenn der Wert ein String ist und einen angegebenen Teilstring enthält.

```ts
import { expect, test } from 'vitest'

test('variety has "Emp" in its name', () => {
  const variety = {
    name: 'Empire',
    count: 1,
  }
  expect(variety).toEqual({
    name: expect.stringContaining('Emp'),
    count: 1,
  })
})
```

:::tip
Sie können `expect.not` mit diesem Matcher verwenden, um den erwarteten Wert zu negieren.
:::

## expect.stringMatching

- **Typ:** `(expected: any) => any`

Bei Verwendung in einer Gleichheitsprüfung gibt dieser asymmetrische Matcher `true` zurück, wenn der Wert ein String ist und einen angegebenen Teilstring enthält oder wenn der String einem regulären Ausdruck entspricht.

```ts
import { expect, test } from 'vitest'

test('variety ends with "re"', () => {
  const variety = {
    name: 'Empire',
    count: 1,
  }
  expect(variety).toEqual({
    name: expect.stringMatching(/re$/),
    count: 1,
  })
})
```

:::tip
Sie können `expect.not` mit diesem Matcher verwenden, um den erwarteten Wert zu negieren.
:::

## expect.schemaMatching

- **Typ:** `(expected: StandardSchemaV1) => any`

Bei Verwendung in einer Gleichheitsprüfung gibt dieser asymmetrische Matcher `true` zurück, wenn der Wert dem angegebenen Schema entspricht. Das Schema muss die Spezifikation [Standard Schema v1](https://standardschema.dev/) implementieren.

```ts
import { expect, test } from 'vitest'
import { z } from 'zod'
import * as v from 'valibot'
import { type } from 'arktype'

test('email validation', () => {
  const user = { email: 'john@example.com' }

  // using Zod
  expect(user).toEqual({
    email: expect.schemaMatching(z.string().email()),
  })

  // using Valibot
  expect(user).toEqual({
    email: expect.schemaMatching(v.pipe(v.string(), v.email()))
  })

  // using ArkType
  expect(user).toEqual({
    email: expect.schemaMatching(type('string.email')),
  })
})
```

:::tip
Sie können `expect.not` mit diesem Matcher verwenden, um den erwarteten Wert zu negieren.
:::

## expect.addSnapshotSerializer

- **Typ:** `(plugin: PrettyFormatPlugin) => void`

Diese Methode fügt benutzerdefinierte Serializer hinzu, die beim Erstellen eines Snapshots aufgerufen werden. Das ist ein fortgeschrittenes Feature – wenn Sie mehr erfahren möchten, lesen Sie bitte den [Leitfaden zu benutzerdefinierten Serializern](/guide/snapshot#custom-serializer).

Wenn Sie benutzerdefinierte Serializer hinzufügen, sollten Sie diese Methode innerhalb von [`setupFiles`](/config/setupfiles) aufrufen. Das wirkt sich auf jeden Snapshot aus.

:::tip
Wenn Sie zuvor die Vue CLI mit Jest verwendet haben, möchten Sie vielleicht [jest-serializer-vue](https://npmx.dev/package/jest-serializer-vue) installieren. Andernfalls werden Ihre Snapshots in einen String eingepackt, wodurch `"` maskiert wird.
:::

## expect.extend

- **Typ:** `(matchers: MatchersObject) => void`

Sie können die Standard-Matcher um eigene erweitern. Diese Funktion wird verwendet, um das Matcher-Objekt um benutzerdefinierte Matcher zu erweitern.

Wenn Sie Matcher auf diese Weise definieren, erzeugen Sie außerdem asymmetrische Matcher, die wie `expect.stringContaining` verwendet werden können.

```ts
import { expect, test } from 'vitest'

test('custom matchers', () => {
  expect.extend({
    toBeFoo(received) {
      const { isNot } = this
      return {
        message: () => `expected ${received} is${isNot ? ' not' : ''} foo`,
        pass: received === 'foo',
      }
    },
  })

  expect('foo').toBeFoo()
  expect({ foo: 'foo' }).toEqual({ foo: expect.toBeFoo() })
})
```

::: tip
Wenn Ihre Matcher in jedem Test verfügbar sein sollen, sollten Sie diese Methode innerhalb von [`setupFiles`](/config/setupfiles) aufrufen.
:::

Diese Funktion ist kompatibel mit Jests `expect.extend`, sodass jede Bibliothek, die damit benutzerdefinierte Matcher erstellt, mit Vitest funktioniert.

Wenn Sie TypeScript verwenden, können Sie das Standard-Interface `Matchers` in einer Ambient-Deklarationsdatei (z. B. `vitest.d.ts`) mit dem folgenden Code erweitern:

```ts
import 'vitest'

declare module 'vitest' {
  interface Matchers<R, T> {
    toBeFoo: () => R
  }
}
```

`R` ist der Rückgabetyp der Assertion und `T` ist der Typ des erhaltenen Werts.

::: warning
Vergessen Sie nicht, die Ambient-Deklarationsdatei in Ihrer `tsconfig.json` einzubinden.
:::

:::tip
Wenn Sie mehr erfahren möchten, sehen Sie sich den [Leitfaden zum Erweitern von Matchern](/guide/extending-matchers) an.
:::

## expect.addEqualityTesters {#expect-addequalitytesters}

- **Typ:** `(tester: Array<Tester>) => void`

Mit dieser Methode können Sie benutzerdefinierte Tester definieren – Methoden, die von Matchern verwendet werden, um zu prüfen, ob zwei Objekte gleich sind. Sie ist kompatibel mit Jests `expect.addEqualityTesters`.

```ts
import { expect, test } from 'vitest'

class AnagramComparator {
  public word: string

  constructor(word: string) {
    this.word = word
  }

  equals(other: AnagramComparator): boolean {
    const cleanStr1 = this.word.replace(/ /g, '').toLowerCase()
    const cleanStr2 = other.word.replace(/ /g, '').toLowerCase()

    const sortedStr1 = cleanStr1.split('').sort().join('')
    const sortedStr2 = cleanStr2.split('').sort().join('')

    return sortedStr1 === sortedStr2
  }
}

function isAnagramComparator(a: unknown): a is AnagramComparator {
  return a instanceof AnagramComparator
}

function areAnagramsEqual(a: unknown, b: unknown): boolean | undefined {
  const isAAnagramComparator = isAnagramComparator(a)
  const isBAnagramComparator = isAnagramComparator(b)

  if (isAAnagramComparator && isBAnagramComparator) {
    return a.equals(b)
  }
  else if (isAAnagramComparator === isBAnagramComparator) {
    return undefined
  }
  else {
    return false
  }
}

expect.addEqualityTesters([areAnagramsEqual])

test('custom equality tester', () => {
  expect(new AnagramComparator('listen')).toEqual(new AnagramComparator('silent'))
})
```
