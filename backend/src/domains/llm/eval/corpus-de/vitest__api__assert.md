# assert

Vitest reexportiert die `assert`-Methode aus [`chai`](https://www.chaijs.com/api/assert/), um Invarianten zu überprüfen.

::: warning In-Source-Testing {#in-source-testing}
Wenn du [Assertion-Funktionen](https://www.typescriptlang.org/docs/handbook/release-notes/typescript-3-7.html#assertion-functions) wie `assert` aus `import.meta.vitest` in [In-Source-Tests](/guide/in-source) verwendest, meldet TypeScript den Fehler `TS2775`, weil sie über einen explizit annotierten Namen aufgerufen werden müssen. Annotiere die Variable mit `Chai.Assert` oder rufe sie direkt auf:

::: code-group
```ts [Annotated variable]
if (import.meta.vitest) {
  const { test, assert } = import.meta.vitest // [!code --]
  const { test } = import.meta.vitest // [!code ++]
  const assert: Chai.Assert = import.meta.vitest.assert // [!code ++]

  test('assert', () => {
    assert('foo' !== 'bar', 'foo should not be equal to bar')
  })
}
```
```ts [Direct call]
if (import.meta.vitest) {
  const { test, assert } = import.meta.vitest // [!code --]
  const { test } = import.meta.vitest // [!code ++]

  test('assert', () => {
    assert('foo' !== 'bar', 'foo should not be equal to bar') // [!code --]
    import.meta.vitest!.assert('foo' !== 'bar', 'foo should not be equal to bar') // [!code ++]
  })
}
```
:::

## assert

- **Typ:** `(expression: any, message?: string) => asserts expression`

Stellt sicher, dass der angegebene `expression` truthy ist, andernfalls schlägt die Assertion fehl.

```ts
import { assert, test } from 'vitest'

test('assert', () => {
  assert('foo' !== 'bar', 'foo should not be equal to bar')
})
```

## fail

- **Typ:**
  - `(message?: string) => never`
  - `<T>(actual: T, expected: T, message?: string, operator?: string) => never`

Erzwingt ein Fehlschlagen der Assertion.

```ts
import { assert, test } from 'vitest'

test('assert.fail', () => {
  assert.fail('error message on failure')
  assert.fail('foo', 'bar', 'foo is not bar', '===')
})
```

## isOk

- **Typ:** `<T>(value: T, message?: string) => asserts value`
- **Alias:** `ok`

Stellt sicher, dass der angegebene `value` truthy ist.

```ts
import { assert, test } from 'vitest'

test('assert.isOk', () => {
  assert.isOk('foo', 'every truthy is ok')
  assert.isOk(false, 'this will fail since false is not truthy')
})
```

## isNotOk

- **Typ:** `<T>(value: T, message?: string) => void`
- **Alias:** `notOk`

Stellt sicher, dass der angegebene `value` falsy ist.

```ts
import { assert, test } from 'vitest'

test('assert.isNotOk', () => {
  assert.isNotOk('foo', 'this will fail, every truthy is not ok')
  assert.isNotOk(false, 'this will pass since false is falsy')
})
```

## equal

- **Typ:** `<T>(actual: T, expected: T, message?: string) => void`

Stellt die nicht-strikte Gleichheit (==) von `actual` und `expected` sicher.

```ts
import { assert, test } from 'vitest'

test('assert.equal', () => {
  assert.equal(Math.sqrt(4), '2')
})
```

## notEqual

- **Typ:** `<T>(actual: T, expected: T, message?: string) => void`

Stellt die nicht-strikte Ungleichheit (!=) von `actual` und `expected` sicher.

```ts
import { assert, test } from 'vitest'

test('assert.equal', () => {
  assert.notEqual(Math.sqrt(4), 3)
})
```

## strictEqual

- **Typ:** `<T>(actual: T, expected: T, message?: string) => void`

Stellt die strikte Gleichheit (===) von `actual` und `expected` sicher.

```ts
import { assert, test } from 'vitest'

test('assert.strictEqual', () => {
  assert.strictEqual(Math.sqrt(4), 2)
})
```

## deepEqual

- **Typ:** `<T>(actual: T, expected: T, message?: string) => void`

Stellt sicher, dass `actual` tief gleich `expected` ist.

```ts
import { assert, test } from 'vitest'

test('assert.deepEqual', () => {
  assert.deepEqual({ color: 'green' }, { color: 'green' })
})
```

## notDeepEqual

- **Typ:** `<T>(actual: T, expected: T, message?: string) => void`

Stellt sicher, dass `actual` nicht tief gleich `expected` ist.

```ts
import { assert, test } from 'vitest'

test('assert.notDeepEqual', () => {
  assert.notDeepEqual({ color: 'green' }, { color: 'red' })
})
```

## isAbove

- **Typ:** `(valueToCheck: number, valueToBeAbove: number, message?: string) => void`

Stellt sicher, dass `valueToCheck` strikt größer als (>) `valueToBeAbove` ist.

```ts
import { assert, test } from 'vitest'

test('assert.isAbove', () => {
  assert.isAbove(5, 2, '5 is strictly greater than 2')
})
```

## isAtLeast

- **Typ:** `(valueToCheck: number, valueToBeAtLeast: number, message?: string) => void`

Stellt sicher, dass `valueToCheck` größer als oder gleich (>=) `valueToBeAtLeast` ist.

```ts
import { assert, test } from 'vitest'

test('assert.isAtLeast', () => {
  assert.isAtLeast(5, 2, '5 is greater or equal to 2')
  assert.isAtLeast(3, 3, '3 is greater or equal to 3')
})
```

## isBelow

- **Typ:** `(valueToCheck: number, valueToBeBelow: number, message?: string) => void`

Stellt sicher, dass `valueToCheck` strikt kleiner als (<) `valueToBeBelow` ist.

```ts
import { assert, test } from 'vitest'

test('assert.isBelow', () => {
  assert.isBelow(3, 6, '3 is strictly less than 6')
})
```

## isAtMost

- **Typ:** `(valueToCheck: number, valueToBeAtMost: number, message?: string) => void`

Stellt sicher, dass `valueToCheck` kleiner als oder gleich (<=) `valueToBeAtMost` ist.

```ts
import { assert, test } from 'vitest'

test('assert.isAtMost', () => {
  assert.isAtMost(3, 6, '3 is less than or equal to 6')
  assert.isAtMost(4, 4, '4 is less than or equal to 4')
})
```

## isTrue

- **Typ:** `<T>(value: T, message?: string) => asserts value is true`

Stellt sicher, dass `value` true ist.

```ts
import { assert, test } from 'vitest'

const testPassed = true

test('assert.isTrue', () => {
  assert.isTrue(testPassed)
})
```

## isNotTrue

- **Typ:** `<T>(value: T, message?: string) => asserts value is Exclude<T, true>`

Stellt sicher, dass `value` nicht true ist.

```ts
import { assert, test } from 'vitest'

const testPassed = 'ok'

test('assert.isNotTrue', () => {
  assert.isNotTrue(testPassed)
})
```

## isFalse

- **Typ:** `<T>(value: T, message?: string) => asserts value is false`

Stellt sicher, dass `value` false ist.

```ts
import { assert, test } from 'vitest'

const testPassed = false

test('assert.isFalse', () => {
  assert.isFalse(testPassed)
})
```

## isNotFalse

- **Typ:** `<T>(value: T, message?: string) => asserts value is Exclude<T, false>`

Stellt sicher, dass `value` nicht false ist.

```ts
import { assert, test } from 'vitest'

const testPassed = 'no'

test('assert.isNotFalse', () => {
  assert.isNotFalse(testPassed)
})
```

## isNull

- **Typ:** `<T>(value: T, message?: string) => asserts value is null`

Stellt sicher, dass `value` null ist.

```ts
import { assert, test } from 'vitest'

const error = null

test('assert.isNull', () => {
  assert.isNull(error, 'error is null')
})
```

## isNotNull

- **Typ:** `<T>(value: T, message?: string) => asserts value is Exclude<T, null>`

Stellt sicher, dass `value` nicht null ist.

```ts
import { assert, test } from 'vitest'

const error = { message: 'error was occurred' }

test('assert.isNotNull', () => {
  assert.isNotNull(error, 'error is not null but object')
})
```

## isNaN

- **Typ:** `<T>(value: T, message?: string) => void`

Stellt sicher, dass `value` NaN ist.

```ts
import { assert, test } from 'vitest'

const calculation = 1 * 'vitest'

test('assert.isNaN', () => {
  assert.isNaN(calculation, '1 * "vitest" is NaN')
})
```

## isNotNaN

- **Typ:** `<T>(value: T, message?: string) => void`

Stellt sicher, dass `value` nicht NaN ist.

```ts
import { assert, test } from 'vitest'

const calculation = 1 * 2

test('assert.isNotNaN', () => {
  assert.isNotNaN(calculation, '1 * 2 is Not NaN but 2')
})
```

## exists

- **Typ:** `<T>(value: T, message?: string) => asserts value is NonNullable<T>`

Stellt sicher, dass `value` weder null noch undefined ist.

```ts
import { assert, test } from 'vitest'

const name = 'foo'

test('assert.exists', () => {
  assert.exists(name, 'foo is neither null nor undefined')
})
```

## notExists

- **Typ:** `<T>(value: T, message?: string) => asserts value is null | undefined`

Stellt sicher, dass `value` entweder null oder undefined ist.

```ts
import { assert, test } from 'vitest'

const foo = null
const bar = undefined

test('assert.notExists', () => {
  assert.notExists(foo, 'foo is null so not exist')
  assert.notExists(bar, 'bar is undefined so not exist')
})
```

## isUndefined

- **Typ:** `<T>(value: T, message?: string) => asserts value is undefined`

Stellt sicher, dass `value` undefined ist.

```ts
import { assert, test } from 'vitest'

const name = undefined

test('assert.isUndefined', () => {
  assert.isUndefined(name, 'name is undefined')
})
```

## isDefined

- **Typ:** `<T>(value: T, message?: string) => asserts value is Exclude<T, undefined>`

Stellt sicher, dass `value` nicht undefined ist.

```ts
import { assert, test } from 'vitest'

const name = 'foo'

test('assert.isDefined', () => {
  assert.isDefined(name, 'name is not undefined')
})
```

## isFunction

- **Typ:** `<T>(value: T, message?: string) => void`
- **Alias:** `isCallable`
Stellt sicher, dass `value` eine Funktion ist.

```ts
import { assert, test } from 'vitest'

function name() { return 'foo' };

test('assert.isFunction', () => {
  assert.isFunction(name, 'name is function')
})
```

## isNotFunction

- **Typ:** `<T>(value: T, message?: string) => void`
- **Alias:** `isNotCallable`

Stellt sicher, dass `value` keine Funktion ist.

```ts
import { assert, test } from 'vitest'

const name = 'foo'

test('assert.isNotFunction', () => {
  assert.isNotFunction(name, 'name is not function but string')
})
```

## isObject

- **Typ:** `<T>(value: T, message?: string) => void`

Stellt sicher, dass `value` ein Objekt vom Typ Object ist (wie von Object.prototype.toString ausgewiesen). Die Assertion greift nicht bei Objekten von Unterklassen.

```ts
import { assert, test } from 'vitest'

const someThing = { color: 'red', shape: 'circle' }

test('assert.isObject', () => {
  assert.isObject(someThing, 'someThing is object')
})
```

## isNotObject

- **Typ:** `<T>(value: T, message?: string) => void`

Stellt sicher, dass `value` kein Objekt vom Typ Object ist (wie von Object.prototype.toString ausgewiesen). Die Assertion greift nicht bei Objekten von Unterklassen.

```ts
import { assert, test } from 'vitest'

const someThing = 'redCircle'

test('assert.isNotObject', () => {
  assert.isNotObject(someThing, 'someThing is not object but string')
})
```

## isArray

- **Typ:** `<T>(value: T, message?: string) => void`

Stellt sicher, dass `value` ein Array ist.

```ts
import { assert, test } from 'vitest'

const color = ['red', 'green', 'yellow']

test('assert.isArray', () => {
  assert.isArray(color, 'color is array')
})
```

## isNotArray

- **Typ:** `<T>(value: T, message?: string) => void`

Stellt sicher, dass `value` kein Array ist.

```ts
import { assert, test } from 'vitest'

const color = 'red'

test('assert.isNotArray', () => {
  assert.isNotArray(color, 'color is not array but string')
})
```

## isString

- **Typ:** `<T>(value: T, message?: string) => void`

Stellt sicher, dass `value` ein String ist.

```ts
import { assert, test } from 'vitest'

const color = 'red'

test('assert.isString', () => {
  assert.isString(color, 'color is string')
})
```

## isNotString

- **Typ:** `<T>(value: T, message?: string) => void`

Stellt sicher, dass `value` kein String ist.

```ts
import { assert, test } from 'vitest'

const color = ['red', 'green', 'yellow']

test('assert.isNotString', () => {
  assert.isNotString(color, 'color is not string but array')
})
```

## isNumber

- **Typ:** `<T>(value: T, message?: string) => void`

Stellt sicher, dass `value` eine Zahl ist.

```ts
import { assert, test } from 'vitest'

const colors = 3

test('assert.isNumber', () => {
  assert.isNumber(colors, 'colors is number')
})
```

## isNotNumber

- **Typ:** `<T>(value: T, message?: string) => void`

Stellt sicher, dass `value` keine Zahl ist.

```ts
import { assert, test } from 'vitest'

const colors = '3 colors'

test('assert.isNotNumber', () => {
  assert.isNotNumber(colors, 'colors is not number but strings')
})
```

## isFinite

- **Typ:** `<T>(value: T, message?: string) => void`

Stellt sicher, dass `value` eine endliche Zahl ist (nicht NaN, Infinity).

```ts
import { assert, test } from 'vitest'

const colors = 3

test('assert.isFinite', () => {
  assert.isFinite(colors, 'colors is number not NaN or Infinity')
})
```

## isBoolean

- **Typ:** `<T>(value: T, message?: string) => void`

Stellt sicher, dass `value` ein Boolean ist.

```ts
import { assert, test } from 'vitest'

const isReady = true

test('assert.isBoolean', () => {
  assert.isBoolean(isReady, 'isReady is a boolean')
})
```

## isNotBoolean

- **Typ:** `<T>(value: T, message?: string) => void`

Stellt sicher, dass `value` kein Boolean ist.

```ts
import { assert, test } from 'vitest'

const isReady = 'sure'

test('assert.isBoolean', () => {
  assert.isBoolean(isReady, 'isReady is not a boolean but string')
})
```

## typeOf

- **Typ:** `<T>(value: T, name: string, message?: string) => void`

Stellt sicher, dass der Typ von `value` gleich `name` ist, ermittelt über Object.prototype.toString.

```ts
import { assert, test } from 'vitest'

test('assert.typeOf', () => {
  assert.typeOf({ color: 'red' }, 'object', 'we have an object')
  assert.typeOf(['red', 'green'], 'array', 'we have an array')
  assert.typeOf('red', 'string', 'we have a string')
  assert.typeOf(/red/, 'regexp', 'we have a regular expression')
  assert.typeOf(null, 'null', 'we have a null')
  assert.typeOf(undefined, 'undefined', 'we have an undefined')
})
```

## notTypeOf

- **Typ:** `<T>(value: T, name: string, message?: string) => void`

Stellt sicher, dass der Typ von `value` nicht gleich `name` ist, ermittelt über Object.prototype.toString.

```ts
import { assert, test } from 'vitest'

test('assert.notTypeOf', () => {
  assert.notTypeOf('red', 'number', '"red" is not a number')
})
```

## instanceOf

- **Typ:** `<T>(value: T, constructor: Function, message?: string) => asserts value is T`

Stellt sicher, dass `value` eine Instanz von `constructor` ist.

```ts
import { assert, test } from 'vitest'

function Person(name) { this.name = name }
const foo = new Person('foo')

class Tea {
  constructor(name) {
    this.name = name
  }
}
const coffee = new Tea('coffee')

test('assert.instanceOf', () => {
  assert.instanceOf(foo, Person, 'foo is an instance of Person')
  assert.instanceOf(coffee, Tea, 'coffee is an instance of Tea')
})
```

## notInstanceOf

- **Typ:** `<T>(value: T, constructor: Function, message?: string) => asserts value is Exclude<T, U>`

Stellt sicher, dass `value` keine Instanz von `constructor` ist.

```ts
import { assert, test } from 'vitest'

function Person(name) { this.name = name }
const foo = new Person('foo')

class Tea {
  constructor(name) {
    this.name = name
  }
}
const coffee = new Tea('coffee')

test('assert.instanceOf', () => {
  assert.instanceOf(foo, Tea, 'foo is not an instance of Tea')
})
```

## include

- **Typ:**
  - `(haystack: string, needle: string, message?: string) => void`
  - `<T>(haystack: readonly T[] | ReadonlySet<T> | ReadonlyMap<any, T>, needle: T, message?: string) => void`
  - `<T extends object>(haystack: WeakSet<T>, needle: T, message?: string) => void`
  - `<T>(haystack: T, needle: Partial<T>, message?: string) => void`

Stellt sicher, dass `haystack` den Wert `needle` enthält. Kann verwendet werden, um das Enthaltensein eines Werts in einem Array, eines Teilstrings in einem String oder einer Teilmenge von Eigenschaften in einem Objekt sicherzustellen.

```ts
import { assert, test } from 'vitest'

test('assert.include', () => {
  assert.include([1, 2, 3], 2, 'array contains value')
  assert.include('foobar', 'foo', 'string contains substring')
  assert.include({ foo: 'bar', hello: 'universe' }, { foo: 'bar' }, 'object contains property')
})
```

## notInclude

- **Typ:**
  - `(haystack: string, needle: string, message?: string) => void`
  - `<T>(haystack: readonly T[] | ReadonlySet<T> | ReadonlyMap<any, T>, needle: T, message?: string) => void`
  - `<T extends object>(haystack: WeakSet<T>, needle: T, message?: string) => void`
  - `<T>(haystack: T, needle: Partial<T>, message?: string) => void`

Stellt sicher, dass `haystack` den Wert `needle` nicht enthält. Kann verwendet werden, um die Abwesenheit eines Werts in einem Array, eines Teilstrings in einem String oder einer Teilmenge von Eigenschaften in einem Objekt sicherzustellen.

```ts
import { assert, test } from 'vitest'

test('assert.notInclude', () => {
  assert.notInclude([1, 2, 3], 4, 'array doesn\'t contain 4')
  assert.notInclude('foobar', 'baz', 'foobar doesn\'t contain baz')
  assert.notInclude({ foo: 'bar', hello: 'universe' }, { foo: 'baz' }, 'object doesn\'t contain property')
})
```

## deepInclude

- **Typ:**
- `(haystack: string, needle: string, message?: string) => void`
- `<T>(haystack: readonly T[] | ReadonlySet<T> | ReadonlyMap<any, T>, needle: T, message?: string) => void`
- `<T>(haystack: T, needle: T extends WeakSet<any> ? never : Partial<T>, message?: string) => void`

Stellt sicher, dass `haystack` den Wert `needle` enthält. Kann verwendet werden, um das Enthaltensein eines Werts in einem Array oder einer Teilmenge von Eigenschaften in einem Objekt sicherzustellen. Dabei wird tiefe Gleichheit verwendet.

```ts
import { assert, test } from 'vitest'

const obj1 = { a: 1 }
const obj2 = { b: 2 }

test('assert.deepInclude', () => {
  assert.deepInclude([obj1, obj2], { a: 1 })
  assert.deepInclude({ foo: obj1, bar: obj2 }, { foo: { a: 1 } })
})
```

## notDeepInclude

- **Typ:**
  - `(haystack: string, needle: string, message?: string) => void`
  - `<T>(haystack: readonly T[] | ReadonlySet<T> | ReadonlyMap<any, T>, needle: T, message?: string) => void`
  - `<T>(haystack: T, needle: T extends WeakSet<any> ? never : Partial<T>, message?: string) => void`

Stellt sicher, dass `haystack` den Wert `needle` nicht enthält. Kann verwendet werden, um die Abwesenheit eines Werts in einem Array oder einer Teilmenge von Eigenschaften in einem Objekt sicherzustellen. Dabei wird tiefe Gleichheit verwendet.

```ts
import { assert, test } from 'vitest'

const obj1 = { a: 1 }
const obj2 = { b: 2 }

test('assert.notDeepInclude', () => {
  assert.notDeepInclude([obj1, obj2], { a: 10 })
  assert.notDeepInclude({ foo: obj1, bar: obj2 }, { foo: { a: 10 } })
})
```

## nestedInclude

- **Typ:** `(haystack: any, needle: any, message?: string) => void`

Stellt sicher, dass `haystack` den Wert `needle` enthält. Kann verwendet werden, um das Enthaltensein einer Teilmenge von Eigenschaften in einem Objekt sicherzustellen. Ermöglicht die Verwendung von Punkt- und Klammernotation, um auf verschachtelte Eigenschaften zu verweisen. ‘[]’ und ‘.’ in Eigenschaftsnamen können mit doppelten Backslashes escaped werden.

```ts
import { assert, test } from 'vitest'

test('assert.nestedInclude', () => {
  assert.nestedInclude({ '.a': { b: 'x' } }, { '\\.a.[b]': 'x' })
  assert.nestedInclude({ a: { '[b]': 'x' } }, { 'a.\\[b\\]': 'x' })
})
```

## notNestedInclude

- **Typ:** `(haystack: any, needle: any, message?: string) => void`

Stellt sicher, dass `haystack` den Wert `needle` nicht enthält. Kann verwendet werden, um das Enthaltensein einer Teilmenge von Eigenschaften in einem Objekt sicherzustellen. Ermöglicht die Verwendung von Punkt- und Klammernotation, um auf verschachtelte Eigenschaften zu verweisen. ‘[]’ und ‘.’ in Eigenschaftsnamen können mit doppelten Backslashes escaped werden.

```ts
import { assert, test } from 'vitest'

test('assert.nestedInclude', () => {
  assert.notNestedInclude({ '.a': { b: 'x' } }, { '\\.a.b': 'y' })
  assert.notNestedInclude({ a: { '[b]': 'x' } }, { 'a.\\[b\\]': 'y' })
})
```

## deepNestedInclude

- **Typ:** `(haystack: any, needle: any, message?: string) => void`

Stellt sicher, dass `haystack` den Wert `needle` enthält. Kann verwendet werden, um das Enthaltensein einer Teilmenge von Eigenschaften in einem Objekt sicherzustellen, wobei auf tiefe Gleichheit geprüft wird. Ermöglicht die Verwendung von Punkt- und Klammernotation, um auf verschachtelte Eigenschaften zu verweisen. ‘[]’ und ‘.’ in Eigenschaftsnamen können mit doppelten Backslashes escaped werden.

```ts
import { assert, test } from 'vitest'

test('assert.deepNestedInclude', () => {
  assert.deepNestedInclude({ a: { b: [{ x: 1 }] } }, { 'a.b[0]': { x: 1 } })
  assert.deepNestedInclude({ '.a': { '[b]': { x: 1 } } }, { '\\.a.\\[b\\]': { x: 1 } })
})
```

## notDeepNestedInclude

- **Typ:** `(haystack: any, needle: any, message?: string) => void`

Stellt sicher, dass `haystack` den Wert `needle` nicht enthält. Kann verwendet werden, um die Abwesenheit einer Teilmenge von Eigenschaften in einem Objekt sicherzustellen, wobei auf tiefe Gleichheit geprüft wird. Ermöglicht die Verwendung von Punkt- und Klammernotation, um auf verschachtelte Eigenschaften zu verweisen. ‘[]’ und ‘.’ in Eigenschaftsnamen können mit doppelten Backslashes escaped werden.

```ts
import { assert, test } from 'vitest'

test('assert.notDeepNestedInclude', () => {
  assert.notDeepNestedInclude({ a: { b: [{ x: 1 }] } }, { 'a.b[0]': { y: 1 } })
  assert.notDeepNestedInclude({ '.a': { '[b]': { x: 1 } } }, { '\\.a.\\[b\\]': { y: 2 } })
})
```

## ownInclude

- **Typ:** `(haystack: any, needle: any, message?: string) => void`

Stellt sicher, dass `haystack` den Wert `needle` enthält. Kann verwendet werden, um das Enthaltensein einer Teilmenge von Eigenschaften in einem Objekt sicherzustellen, wobei geerbte Eigenschaften ignoriert werden.

```ts
import { assert, test } from 'vitest'

test('assert.ownInclude', () => {
  assert.ownInclude({ a: 1 }, { a: 1 })
})
```

## notOwnInclude

- **Typ:** `(haystack: any, needle: any, message?: string) => void`

Stellt sicher, dass `haystack` den Wert `needle` enthält. Kann verwendet werden, um die Abwesenheit einer Teilmenge von Eigenschaften in einem Objekt sicherzustellen, wobei geerbte Eigenschaften ignoriert werden.

```ts
import { assert, test } from 'vitest'

const obj1 = {
  b: 2
}

const obj2 = object.create(obj1)
obj2.a = 1

test('assert.notOwnInclude', () => {
  assert.notOwnInclude(obj2, { b: 2 })
})
```

## deepOwnInclude

- **Typ:** `(haystack: any, needle: any, message?: string) => void`

Stellt sicher, dass `haystack` den Wert `needle` enthält. Kann verwendet werden, um das Enthaltensein einer Teilmenge von Eigenschaften in einem Objekt sicherzustellen, wobei geerbte Eigenschaften ignoriert und auf tiefe Gleichheit geprüft wird.

```ts
import { assert, test } from 'vitest'

test('assert.deepOwnInclude', () => {
  assert.deepOwnInclude({ a: { b: 2 } }, { a: { b: 2 } })
})
```

## notDeepOwnInclude

- **Typ:** `(haystack: any, needle: any, message?: string) => void`

Stellt sicher, dass `haystack` den Wert `needle` nicht enthält. Kann verwendet werden, um die Abwesenheit einer Teilmenge von Eigenschaften in einem Objekt sicherzustellen, wobei geerbte Eigenschaften ignoriert und auf tiefe Gleichheit geprüft wird.

```ts
import { assert, test } from 'vitest'

test('assert.notDeepOwnInclude', () => {
  assert.notDeepOwnInclude({ a: { b: 2 } }, { a: { c: 3 } })
})
```

## match

- **Typ:** `(value: string, regexp: RegExp, message?: string) => void`

Stellt sicher, dass `value` auf den regulären Ausdruck `regexp` passt.

```ts
import { assert, test } from 'vitest'

test('assert.match', () => {
  assert.match('foobar', /^foo/, 'regexp matches')
})
```

## notMatch

- **Typ:** `(value: string, regexp: RegExp, message?: string) => void`

Stellt sicher, dass `value` nicht auf den regulären Ausdruck `regexp` passt.

```ts
import { assert, test } from 'vitest'

test('assert.notMatch', () => {
  assert.notMatch('foobar', /^foo/, 'regexp does not match')
})
```

## property

- **Typ:** `<T>(object: T, property: string, message?: string) => void`

Stellt sicher, dass `object` eine direkte oder geerbte Eigenschaft mit dem Namen `property` besitzt

```ts
import { assert, test } from 'vitest'

test('assert.property', () => {
  assert.property({ tea: { green: 'matcha' } }, 'tea')
  assert.property({ tea: { green: 'matcha' } }, 'toString')
})
```

## notProperty

- **Typ:** `<T>(object: T, property: string, message?: string) => void`

Stellt sicher, dass `object` keine direkte oder geerbte Eigenschaft mit dem Namen `property` besitzt

```ts
import { assert, test } from 'vitest'

test('assert.notProperty', () => {
  assert.notProperty({ tea: { green: 'matcha' } }, 'coffee')
})
```

## propertyVal

- **Typ:** `<T, V>(object: T, property: string, value: V, message?: string) => void`

Stellt sicher, dass `object` eine direkte oder geerbte Eigenschaft mit dem Namen `property` und dem durch `value` gegebenen Wert besitzt. Verwendet eine strikte Gleichheitsprüfung (===).

```ts
import { assert, test } from 'vitest'

test('assert.notPropertyVal', () => {
  assert.propertyVal({ tea: 'is good' }, 'tea', 'is good')
})
```

## notPropertyVal

- **Typ:** `<T, V>(object: T, property: string, value: V, message?: string) => void`

Stellt sicher, dass `object` keine direkte oder geerbte Eigenschaft mit dem Namen `property` und dem durch `value` gegebenen Wert besitzt. Verwendet eine strikte Gleichheitsprüfung (===).

```ts
import { assert, test } from 'vitest'

test('assert.notPropertyVal', () => {
  assert.notPropertyVal({ tea: 'is good' }, 'tea', 'is bad')
  assert.notPropertyVal({ tea: 'is good' }, 'coffee', 'is good')
})
```

## deepPropertyVal

- **Typ:** `<T, V>(object: T, property: string, value: V, message?: string) => void`

Stellt sicher, dass `object` eine direkte oder geerbte Eigenschaft mit dem Namen `property` und dem durch `value` gegebenen Wert besitzt. Verwendet eine tiefe Gleichheitsprüfung.

```ts
import { assert, test } from 'vitest'

test('assert.deepPropertyVal', () => {
  assert.deepPropertyVal({ tea: { green: 'matcha' } }, 'tea', { green: 'matcha' })
})
```

## notDeepPropertyVal

- **Typ:** `<T, V>(object: T, property: string, value: V, message?: string) => void`

Stellt sicher, dass `object` keine direkte oder geerbte Eigenschaft mit dem Namen `property` und dem durch `value` gegebenen Wert besitzt. Verwendet eine tiefe Gleichheitsprüfung.

```ts
import { assert, test } from 'vitest'

test('assert.deepPropertyVal', () => {
  assert.notDeepPropertyVal({ tea: { green: 'matcha' } }, 'tea', { black: 'matcha' })
  assert.notDeepPropertyVal({ tea: { green: 'matcha' } }, 'tea', { green: 'oolong' })
  assert.notDeepPropertyVal({ tea: { green: 'matcha' } }, 'coffee', { green: 'matcha' })
})
```

## nestedProperty

- **Typ:** `<T>(object: T, property: string, message?: string) => void`

Stellt sicher, dass `object` eine direkte oder geerbte Eigenschaft mit dem Namen `property` besitzt, wobei dieser ein String sein kann, der Punkt- und Klammernotation für verschachtelte Verweise verwendet.

```ts
import { assert, test } from 'vitest'

test('assert.deepPropertyVal', () => {
  assert.nestedProperty({ tea: { green: 'matcha' } }, 'tea.green')
})
```

## notNestedProperty

- **Typ:** `<T>(object: T, property: string, message?: string) => void`

Stellt sicher, dass `object` keine direkte oder geerbte Eigenschaft mit dem Namen `property` besitzt, wobei dieser ein String sein kann, der Punkt- und Klammernotation für verschachtelte Verweise verwendet.

```ts
import { assert, test } from 'vitest'

test('assert.deepPropertyVal', () => {
  assert.notNestedProperty({ tea: { green: 'matcha' } }, 'tea.oolong')
})
```

## nestedPropertyVal

- **Typ:** `<T>(object: T, property: string, value: any, message?: string) => void`

Stellt sicher, dass `object` eine Eigenschaft mit dem Namen `property` und dem durch `value` gegebenen Wert besitzt. `property` kann Punkt- und Klammernotation für verschachtelte Verweise verwenden. Verwendet eine strikte Gleichheitsprüfung (===).

```ts
import { assert, test } from 'vitest'

test('assert.nestedPropertyVal', () => {
  assert.nestedPropertyVal({ tea: { green: 'matcha' } }, 'tea.green', 'matcha')
})
```

## notNestedPropertyVal

- **Typ:** `<T>(object: T, property: string, value: any, message?: string) => void`

Stellt sicher, dass `object` keine Eigenschaft mit dem Namen `property` und dem durch `value` gegebenen Wert besitzt. `property` kann Punkt- und Klammernotation für verschachtelte Verweise verwenden. Verwendet eine strikte Gleichheitsprüfung (===).

```ts
import { assert, test } from 'vitest'

test('assert.notNestedPropertyVal', () => {
  assert.notNestedPropertyVal({ tea: { green: 'matcha' } }, 'tea.green', 'konacha')
  assert.notNestedPropertyVal({ tea: { green: 'matcha' } }, 'coffee.green', 'matcha')
})
```

## deepNestedPropertyVal

- **Typ:** `<T>(object: T, property: string, value: any, message?: string) => void`

Stellt sicher, dass `object` eine Eigenschaft mit dem Namen `property` und dem durch `value` gegebenen Wert besitzt. `property` kann Punkt- und Klammernotation für verschachtelte Verweise verwenden. Verwendet eine tiefe Gleichheitsprüfung (===).

```ts
import { assert, test } from 'vitest'

test('assert.notNestedPropertyVal', () => {
  assert.notNestedPropertyVal({ tea: { green: 'matcha' } }, 'tea.green', 'konacha')
  assert.notNestedPropertyVal({ tea: { green: 'matcha' } }, 'coffee.green', 'matcha')
})
```

## notDeepNestedPropertyVal

- **Typ:** `<T>(object: T, property: string, value: any, message?: string) => void`

Stellt sicher, dass `object` keine Eigenschaft mit dem Namen `property` und dem durch `value` gegebenen Wert besitzt. `property` kann Punkt- und Klammernotation für verschachtelte Verweise verwenden. Verwendet eine tiefe Gleichheitsprüfung.

```ts
import { assert, test } from 'vitest'

test('assert.notDeepNestedPropertyVal', () => {
  assert.notDeepNestedPropertyVal({ tea: { green: { matcha: 'yum' } } }, 'tea.green', { oolong: 'yum' })
  assert.notDeepNestedPropertyVal({ tea: { green: { matcha: 'yum' } } }, 'tea.green', { matcha: 'yuck' })
  assert.notDeepNestedPropertyVal({ tea: { green: { matcha: 'yum' } } }, 'tea.black', { matcha: 'yum' })
})
```

## lengthOf

- **Typ:** `<T extends { readonly length?: number | undefined } | { readonly size?: number | undefined }>(object: T, length: number, message?: string) => void`

Stellt sicher, dass `object` ein `length` oder `size` mit dem erwarteten Wert besitzt.

```ts
import { assert, test } from 'vitest'

test('assert.lengthOf', () => {
  assert.lengthOf([1, 2, 3], 3, 'array has length of 3')
  assert.lengthOf('foobar', 6, 'string has length of 6')
  assert.lengthOf(new Set([1, 2, 3]), 3, 'set has size of 3')
  assert.lengthOf(new Map([['a', 1], ['b', 2], ['c', 3]]), 3, 'map has size of 3')
})
```

## hasAnyKeys

- **Typ:** `<T>(object: T, keys: Array<Object | string> | { [key: string]: any }, message?: string) => void`

Stellt sicher, dass `object` mindestens einen der angegebenen `keys` besitzt. Du kannst statt eines Key-Arrays auch ein einzelnes Objekt übergeben; dessen Keys werden dann als erwartete Key-Menge verwendet.

```ts
import { assert, test } from 'vitest'

test('assert.hasAnyKeys', () => {
  assert.hasAnyKeys({ foo: 1, bar: 2, baz: 3 }, ['foo', 'iDontExist', 'baz'])
  assert.hasAnyKeys({ foo: 1, bar: 2, baz: 3 }, { foo: 30, iDontExist: 99, baz: 1337 })
  assert.hasAnyKeys(new Map([[{ foo: 1 }, 'bar'], ['key', 'value']]), [{ foo: 1 }, 'key'])
  assert.hasAnyKeys(new Set([{ foo: 'bar' }, 'anotherKey']), [{ foo: 'bar' }, 'anotherKey'])
})
```

## hasAllKeys

- **Typ:** `<T>(object: T, keys: Array<Object | string> | { [key: string]: any }, message?: string) => void`

Stellt sicher, dass `object` alle und ausschließlich die angegebenen `keys` besitzt. Du kannst statt eines Key-Arrays auch ein einzelnes Objekt übergeben; dessen Keys werden dann als erwartete Key-Menge verwendet.

```ts
import { assert, test } from 'vitest'

test('assert.hasAllKeys', () => {
  assert.hasAllKeys({ foo: 1, bar: 2, baz: 3 }, ['foo', 'bar', 'baz'])
  assert.hasAllKeys({ foo: 1, bar: 2, baz: 3 }, { foo: 30, bar: 99, baz: 1337 })
  assert.hasAllKeys(new Map([[{ foo: 1 }, 'bar'], ['key', 'value']]), [{ foo: 1 }, 'key'])
  assert.hasAllKeys(new Set([{ foo: 'bar' }, 'anotherKey'], [{ foo: 'bar' }, 'anotherKey']))
})
```

## containsAllKeys

- **Typ:** `<T>(object: T, keys: Array<Object | string> | { [key: string]: any }, message?: string) => void`

Stellt sicher, dass `object` alle angegebenen `keys` besitzt, aber darüber hinaus weitere, nicht aufgeführte Keys haben darf. Du kannst statt eines Key-Arrays auch ein einzelnes Objekt übergeben; dessen Keys werden dann als erwartete Key-Menge verwendet.

```ts
import { assert, test } from 'vitest'

test('assert.containsAllKeys', () => {
  assert.containsAllKeys({ foo: 1, bar: 2, baz: 3 }, ['foo', 'baz'])
  assert.containsAllKeys({ foo: 1, bar: 2, baz: 3 }, ['foo', 'bar', 'baz'])
  assert.containsAllKeys({ foo: 1, bar: 2, baz: 3 }, { foo: 30, baz: 1337 })
  assert.containsAllKeys({ foo: 1, bar: 2, baz: 3 }, { foo: 30, bar: 99, baz: 1337 })
  assert.containsAllKeys(new Map([[{ foo: 1 }, 'bar'], ['key', 'value']]), [{ foo: 1 }])
  assert.containsAllKeys(new Map([[{ foo: 1 }, 'bar'], ['key', 'value']]), [{ foo: 1 }, 'key'])
  assert.containsAllKeys(new Set([{ foo: 'bar' }, 'anotherKey'], [{ foo: 'bar' }]))
  assert.containsAllKeys(new Set([{ foo: 'bar' }, 'anotherKey'], [{ foo: 'bar' }, 'anotherKey']))
})
```

## doesNotHaveAnyKeys

- **Typ:** `<T>(object: T, keys: Array<Object | string> | { [key: string]: any }, message?: string) => void`

Stellt sicher, dass `object` keinen der angegebenen `keys` besitzt. Du kannst statt eines Key-Arrays auch ein einzelnes Objekt übergeben; dessen Keys werden dann als erwartete Key-Menge verwendet.

```ts
import { assert, test } from 'vitest'

test('assert.doesNotHaveAnyKeys', () => {
  assert.doesNotHaveAnyKeys({ foo: 1, bar: 2, baz: 3 }, ['one', 'two', 'example'])
  assert.doesNotHaveAnyKeys({ foo: 1, bar: 2, baz: 3 }, { one: 1, two: 2, example: 'foo' })
  assert.doesNotHaveAnyKeys(new Map([[{ foo: 1 }, 'bar'], ['key', 'value']]), [{ one: 'two' }, 'example'])
  assert.doesNotHaveAnyKeys(new Set([{ foo: 'bar' }, 'anotherKey'], [{ one: 'two' }, 'example']))
})
```

## doesNotHaveAllKeys

- **Typ:** `<T>(object: T, keys: Array<Object | string> | { [key: string]: any }, message?: string) => void`

Stellt sicher, dass `object` mindestens einen der angegebenen `keys` nicht besitzt. Du kannst statt eines Key-Arrays auch ein einzelnes Objekt übergeben; dessen Keys werden dann als erwartete Key-Menge verwendet.

```ts
import { assert, test } from 'vitest'

test('assert.hasAnyKeys', () => {
  assert.doesNotHaveAnyKeys({ foo: 1, bar: 2, baz: 3 }, ['one', 'two', 'example'])
  assert.doesNotHaveAnyKeys({ foo: 1, bar: 2, baz: 3 }, { one: 1, two: 2, example: 'foo' })
  assert.doesNotHaveAnyKeys(new Map([[{ foo: 1 }, 'bar'], ['key', 'value']]), [{ one: 'two' }, 'example'])
  assert.doesNotHaveAnyKeys(new Set([{ foo: 'bar' }, 'anotherKey']), [{ one: 'two' }, 'example'])
})
```

## hasAnyDeepKeys

- **Typ:** `<T>(object: T, keys: Array<Object | string> | { [key: string]: any }, message?: string) => void`

Stellt sicher, dass `object` mindestens einen der angegebenen `keys` besitzt. Da Sets und Maps Objekte als Keys haben können, kannst du diese Assertion für einen tiefen Vergleich nutzen. Du kannst statt eines Key-Arrays auch ein einzelnes Objekt übergeben; dessen Keys werden dann als erwartete Key-Menge verwendet.

```ts
import { assert, test } from 'vitest'

test('assert.hasAnyDeepKeys', () => {
  assert.hasAnyDeepKeys(new Map([[{ one: 'one' }, 'valueOne'], [1, 2]]), { one: 'one' })
  assert.hasAnyDeepKeys(new Map([[{ one: 'one' }, 'valueOne'], [1, 2]]), [{ one: 'one' }, { two: 'two' }])
  assert.hasAnyDeepKeys(new Map([[{ one: 'one' }, 'valueOne'], [{ two: 'two' }, 'valueTwo']]), [{ one: 'one' }, { two: 'two' }])
  assert.hasAnyDeepKeys(new Set([{ one: 'one' }, { two: 'two' }]), { one: 'one' })
  assert.hasAnyDeepKeys(new Set([{ one: 'one' }, { two: 'two' }]), [{ one: 'one' }, { three: 'three' }])
  assert.hasAnyDeepKeys(new Set([{ one: 'one' }, { two: 'two' }]), [{ one: 'one' }, { two: 'two' }])
})
```

## hasAllDeepKeys

- **Typ:** `<T>(object: T, keys: Array<Object | string> | { [key: string]: any }, message?: string) => void`

Stellt sicher, dass `object` alle und ausschließlich die angegebenen `keys` besitzt. Da Sets und Maps Objekte als Keys haben können, kannst du diese Assertion für einen tiefen Vergleich nutzen. Du kannst statt eines Key-Arrays auch ein einzelnes Objekt übergeben; dessen Keys werden dann als erwartete Key-Menge verwendet.

```ts
import { assert, test } from 'vitest'

test('assert.hasAnyDeepKeys', () => {
  assert.hasAllDeepKeys(new Map([[{ one: 'one' }, 'valueOne']]), { one: 'one' })
  assert.hasAllDeepKeys(new Map([[{ one: 'one' }, 'valueOne'], [{ two: 'two' }, 'valueTwo']]), [{ one: 'one' }, { two: 'two' }])
  assert.hasAllDeepKeys(new Set([{ one: 'one' }]), { one: 'one' })
  assert.hasAllDeepKeys(new Set([{ one: 'one' }, { two: 'two' }]), [{ one: 'one' }, { two: 'two' }])
})
```

## containsAllDeepKeys

- **Typ:** `<T>(object: T, keys: Array<Object | string> | { [key: string]: any }, message?: string) => void`

Stellt sicher, dass `object` alle angegebenen `keys` enthält. Da Sets und Maps Objekte als Keys haben können, kannst du diese Assertion für einen tiefen Vergleich nutzen. Du kannst statt eines Key-Arrays auch ein einzelnes Objekt übergeben; dessen Keys werden dann als erwartete Key-Menge verwendet.

```ts
import { assert, test } from 'vitest'

test('assert.containsAllDeepKeys', () => {
  assert.containsAllDeepKeys(new Map([[{ one: 'one' }, 'valueOne'], [1, 2]]), { one: 'one' })
  assert.containsAllDeepKeys(new Map([[{ one: 'one' }, 'valueOne'], [{ two: 'two' }, 'valueTwo']]), [{ one: 'one' }, { two: 'two' }])
  assert.containsAllDeepKeys(new Set([{ one: 'one' }, { two: 'two' }]), { one: 'one' })
  assert.containsAllDeepKeys(new Set([{ one: 'one' }, { two: 'two' }]), [{ one: 'one' }, { two: 'two' }])
})
```

## doesNotHaveAnyDeepKeys

- **Typ:** `<T>(object: T, keys: Array<Object | string> | { [key: string]: any }, message?: string) => void`

Stellt sicher, dass `object` keinen der angegebenen `keys` besitzt. Da Sets und Maps Objekte als Keys haben können, kannst du diese Assertion für einen tiefen Vergleich nutzen. Du kannst statt eines Key-Arrays auch ein einzelnes Objekt übergeben; dessen Keys werden dann als erwartete Key-Menge verwendet.

```ts
import { assert, test } from 'vitest'

test('assert.doesNotHaveAnyDeepKeys', () => {
  assert.doesNotHaveAnyDeepKeys(new Map([[{ one: 'one' }, 'valueOne'], [1, 2]]), { thisDoesNot: 'exist' })
  assert.doesNotHaveAnyDeepKeys(new Map([[{ one: 'one' }, 'valueOne'], [{ two: 'two' }, 'valueTwo']]), [{ twenty: 'twenty' }, { fifty: 'fifty' }])
  assert.doesNotHaveAnyDeepKeys(new Set([{ one: 'one' }, { two: 'two' }]), { twenty: 'twenty' })
  assert.doesNotHaveAnyDeepKeys(new Set([{ one: 'one' }, { two: 'two' }]), [{ twenty: 'twenty' }, { fifty: 'fifty' }])
})
```

## doesNotHaveAllDeepKeys

- **Typ:** `<T>(object: T, keys: Array<Object | string> | { [key: string]: any }, message?: string) => void`

Stellt sicher, dass `object` mindestens einen der angegebenen `keys` nicht besitzt. Da Sets und Maps Objekte als Keys haben können, kannst du diese Assertion für einen tiefen Vergleich nutzen. Du kannst statt eines Key-Arrays auch ein einzelnes Objekt übergeben; dessen Keys werden dann als erwartete Key-Menge verwendet.

```ts
import { assert, test } from 'vitest'

test('assert.doesNotHaveAllDeepKeys', () => {
  assert.doesNotHaveAllDeepKeys(new Map([[{ one: 'one' }, 'valueOne'], [1, 2]]), { thisDoesNot: 'exist' })
  assert.doesNotHaveAllDeepKeys(new Map([[{ one: 'one' }, 'valueOne'], [{ two: 'two' }, 'valueTwo']]), [{ twenty: 'twenty' }, { one: 'one' }])
  assert.doesNotHaveAllDeepKeys(new Set([{ one: 'one' }, { two: 'two' }]), { twenty: 'twenty' })
  assert.doesNotHaveAllDeepKeys(new Set([{ one: 'one' }, { two: 'two' }]), [{ one: 'one' }, { fifty: 'fifty' }])
})
```

## throws

- **Typ:**
  - `(fn: () => void, errMsgMatcher?: RegExp | string, ignored?: any, message?: string) => void`
  - `(fn: () => void, errorLike?: ErrorConstructor | Error | null, errMsgMatcher?: RegExp | string | null, message?: string) => void`
- **Alias:**
  - `throw`
  - `Throw`

Ist `errorLike` ein Error-Konstruktor, wird sichergestellt, dass `fn` einen Fehler wirft, der eine Instanz von `errorLike` ist. Ist errorLike eine Error-Instanz, wird sichergestellt, dass der geworfene Fehler dieselbe Instanz wie `errorLike` ist. Wird `errMsgMatcher` angegeben, wird zusätzlich sichergestellt, dass der geworfene Fehler eine Nachricht besitzt, die auf `errMsgMatcher` passt.

```ts
import { assert, test } from 'vitest'

test('assert.throws', () => {
  assert.throws(fn, 'Error thrown must have this msg')
  assert.throws(fn, /Error thrown must have a msg that matches this/)
  assert.throws(fn, ReferenceError)
  assert.throws(fn, errorInstance)
  assert.throws(fn, ReferenceError, 'Error thrown must be a ReferenceError and have this msg')
  assert.throws(fn, errorInstance, 'Error thrown must be the same errorInstance and have this msg')
  assert.throws(fn, ReferenceError, /Error thrown must be a ReferenceError and match this/)
  assert.throws(fn, errorInstance, /Error thrown must be the same errorInstance and match this/)
})
```

## doesNotThrow

- **Typ:** `(fn: () => void, errMsgMatcher?: RegExp | string, ignored?: any, message?: string) => void`
- **Typ:** `(fn: () => void, errorLike?: ErrorConstructor | Error | null, errMsgMatcher?: RegExp | string | null, message?: string) => void`

Ist `errorLike` ein Error-Konstruktor, wird sichergestellt, dass `fn` keinen Fehler wirft, der eine Instanz von `errorLike` ist. Ist errorLike eine Error-Instanz, wird sichergestellt, dass der geworfene Fehler nicht dieselbe Instanz wie `errorLike` ist. Wird `errMsgMatcher` angegeben, wird zusätzlich sichergestellt, dass der geworfene Fehler keine Nachricht besitzt, die auf `errMsgMatcher` passt.

```ts
import { assert, test } from 'vitest'

test('assert.doesNotThrow', () => {
  assert.doesNotThrow(fn, 'Any Error thrown must not have this message')
  assert.doesNotThrow(fn, /Any Error thrown must not match this/)
  assert.doesNotThrow(fn, Error)
  assert.doesNotThrow(fn, errorInstance)
  assert.doesNotThrow(fn, Error, 'Error must not have this message')
  assert.doesNotThrow(fn, errorInstance, 'Error must not have this message')
  assert.doesNotThrow(fn, Error, /Error must not match this/)
  assert.doesNotThrow(fn, errorInstance, /Error must not match this/)
})
```

## operator

- **Typ:** `(val1: OperatorComparable, operator: Operator, val2: OperatorComparable, message?: string) => void`

Vergleicht `val1` und `val2` mithilfe von `operator`.

```ts
import { assert, test } from 'vitest'

test('assert.operator', () => {
  assert.operator(1, '<', 2, 'everything is ok')
})
```

## closeTo

- **Typ:** `(actual: number, expected: number, delta: number, message?: string) => void`
- **Alias:** `approximately`

Stellt sicher, dass `actual` gleich `expected` ist, innerhalb eines Bereichs von +/- `delta`.

```ts
import { assert, test } from 'vitest'

test('assert.closeTo', () => {
  assert.closeTo(1.5, 1, 0.5, 'numbers are close')
})
```

## sameMembers

- **Typ:** `<T>(set1: T[], set2: T[], message?: string) => void`

Stellt sicher, dass `set1` und `set2` dieselben Elemente in beliebiger Reihenfolge enthalten. Verwendet eine strikte Gleichheitsprüfung (===).

```ts
import { assert, test } from 'vitest'

test('assert.sameMembers', () => {
  assert.sameMembers([1, 2, 3], [2, 1, 3], 'same members')
})
```

## notSameMembers

- **Typ:** `<T>(set1: T[], set2: T[], message?: string) => void`

Stellt sicher, dass `set1` und `set2` nicht dieselben Elemente in beliebiger Reihenfolge enthalten. Verwendet eine strikte Gleichheitsprüfung (===).

```ts
import { assert, test } from 'vitest'

test('assert.sameMembers', () => {
  assert.notSameMembers([1, 2, 3], [5, 1, 3], 'not same members')
})
```

## sameDeepMembers

- **Typ:** `<T>(set1: T[], set2: T[], message?: string) => void`

Stellt sicher, dass `set1` und `set2` dieselben Elemente in beliebiger Reihenfolge enthalten. Verwendet eine tiefe Gleichheitsprüfung.

```ts
import { assert, test } from 'vitest'

test('assert.sameDeepMembers', () => {
  assert.sameDeepMembers([{ a: 1 }, { b: 2 }, { c: 3 }], [{ b: 2 }, { a: 1 }, { c: 3 }], 'same deep members')
})
```

## notSameDeepMembers

- **Typ:** `<T>(set1: T[], set2: T[], message?: string) => void`

Stellt sicher, dass `set1` und `set2` nicht dieselben Elemente in beliebiger Reihenfolge enthalten. Verwendet eine tiefe Gleichheitsprüfung.

```ts
import { assert, test } from 'vitest'

test('assert.sameDeepMembers', () => {
  assert.sameDeepMembers([{ a: 1 }, { b: 2 }, { c: 3 }], [{ b: 2 }, { a: 1 }, { c: 3 }], 'same deep members')
})
```

## sameOrderedMembers

- **Typ:** `<T>(set1: T[], set2: T[], message?: string) => void`

Stellt sicher, dass `set1` und `set2` dieselben Elemente in derselben Reihenfolge enthalten. Verwendet eine strikte Gleichheitsprüfung (===).

```ts
import { assert, test } from 'vitest'

test('assert.sameOrderedMembers', () => {
  assert.sameOrderedMembers([1, 2, 3], [1, 2, 3], 'same ordered members')
})
```

## notSameOrderedMembers

- **Typ:** `<T>(set1: T[], set2: T[], message?: string) => void`

Stellt sicher, dass `set1` und `set2` dieselben Elemente in derselben Reihenfolge enthalten. Verwendet eine strikte Gleichheitsprüfung (===).

```ts
import { assert, test } from 'vitest'

test('assert.notSameOrderedMembers', () => {
  assert.notSameOrderedMembers([1, 2, 3], [2, 1, 3], 'not same ordered members')
})
```

## sameDeepOrderedMembers

- **Typ:** `<T>(set1: T[], set2: T[], message?: string) => void`

Stellt sicher, dass `set1` und `set2` dieselben Elemente in derselben Reihenfolge enthalten. Verwendet eine tiefe Gleichheitsprüfung.

```ts
import { assert, test } from 'vitest'

test('assert.sameDeepOrderedMembers', () => {
  assert.sameDeepOrderedMembers([{ a: 1 }, { b: 2 }, { c: 3 }], [{ a: 1 }, { b: 2 }, { c: 3 }], 'same deep ordered members')
})
```

## notSameDeepOrderedMembers

- **Typ:** `<T>(set1: T[], set2: T[], message?: string) => void`

Stellt sicher, dass `set1` und `set2` nicht dieselben Elemente in derselben Reihenfolge enthalten. Verwendet eine tiefe Gleichheitsprüfung.

```ts
import { assert, test } from 'vitest'

test('assert.notSameDeepOrderedMembers', () => {
  assert.notSameDeepOrderedMembers([{ a: 1 }, { b: 2 }, { c: 3 }], [{ a: 1 }, { b: 2 }, { z: 5 }], 'not same deep ordered members')
  assert.notSameDeepOrderedMembers([{ a: 1 }, { b: 2 }, { c: 3 }], [{ b: 2 }, { a: 1 }, { c: 3 }], 'not same deep ordered members')
})
```

## includeMembers

- **Typ:** `<T>(superset: T[], subset: T[], message?: string) => void`

Stellt sicher, dass `subset` in beliebiger Reihenfolge in `superset` enthalten ist. Verwendet eine strikte Gleichheitsprüfung (===). Duplikate werden ignoriert.

```ts
import { assert, test } from 'vitest'

test('assert.includeMembers', () => {
  assert.includeMembers([1, 2, 3], [2, 1, 2], 'include members')
})
```

## notIncludeMembers

- **Typ:** `<T>(superset: T[], subset: T[], message?: string) => void`

Stellt sicher, dass `subset` in keiner Reihenfolge in `superset` enthalten ist. Verwendet eine strikte Gleichheitsprüfung (===). Duplikate werden ignoriert.

```ts
import { assert, test } from 'vitest'

test('assert.notIncludeMembers', () => {
  assert.notIncludeMembers([1, 2, 3], [5, 1], 'not include members')
})
```

## includeDeepMembers

- **Typ:** `<T>(superset: T[], subset: T[], message?: string) => void`

Stellt sicher, dass `subset` in beliebiger Reihenfolge in `superset` enthalten ist. Verwendet eine tiefe Gleichheitsprüfung. Duplikate werden ignoriert.

```ts
import { assert, test } from 'vitest'

test('assert.includeDeepMembers', () => {
  assert.includeDeepMembers([{ a: 1 }, { b: 2 }, { c: 3 }], [{ b: 2 }, { a: 1 }, { b: 2 }], 'include deep members')
})
```

## notIncludeDeepMembers

- **Typ:** `<T>(superset: T[], subset: T[], message?: string) => void`

Stellt sicher, dass `subset` in keiner Reihenfolge in `superset` enthalten ist. Verwendet eine tiefe Gleichheitsprüfung. Duplikate werden ignoriert.

```ts
import { assert, test } from 'vitest'

test('assert.notIncludeDeepMembers', () => {
  assert.notIncludeDeepMembers([{ a: 1 }, { b: 2 }, { c: 3 }], [{ b: 2 }, { f: 5 }], 'not include deep members')
})
```

## includeOrderedMembers

- **Typ:** `<T>(superset: T[], subset: T[], message?: string) => void`

Stellt sicher, dass `subset` in derselben Reihenfolge in `superset` enthalten ist, beginnend mit dem ersten Element von `superset`. Verwendet eine strikte Gleichheitsprüfung (===).

```ts
import { assert, test } from 'vitest'

test('assert.includeOrderedMembers', () => {
  assert.includeOrderedMembers([1, 2, 3], [1, 2], 'include ordered members')
})
```

## notIncludeOrderedMembers

- **Typ:** `<T>(superset: T[], subset: T[], message?: string) => void`

Stellt sicher, dass `subset` nicht in derselben Reihenfolge in `superset` enthalten ist, beginnend mit dem ersten Element von `superset`. Verwendet eine strikte Gleichheitsprüfung (===).

```ts
import { assert, test } from 'vitest'

test('assert.notIncludeOrderedMembers', () => {
  assert.notIncludeOrderedMembers([1, 2, 3], [2, 1], 'not include ordered members')
  assert.notIncludeOrderedMembers([1, 2, 3], [2, 3], 'not include ordered members')
})
```

## includeDeepOrderedMembers

- **Typ:** `<T>(superset: T[], subset: T[], message?: string) => void`

Stellt sicher, dass `subset` in derselben Reihenfolge in `superset` enthalten ist, beginnend mit dem ersten Element von `superset`. Verwendet eine tiefe Gleichheitsprüfung.

```ts
import { assert, test } from 'vitest'

test('assert.includeDeepOrderedMembers', () => {
  assert.includeDeepOrderedMembers([{ a: 1 }, { b: 2 }, { c: 3 }], [{ a: 1 }, { b: 2 }], 'include deep ordered members')
})
```

## notIncludeDeepOrderedMembers

- **Typ:** `<T>(superset: T[], subset: T[], message?: string) => void`

Stellt sicher, dass `subset` nicht in derselben Reihenfolge in `superset` enthalten ist, beginnend mit dem ersten Element von superset. Verwendet eine tiefe Gleichheitsprüfung.

```ts
import { assert, test } from 'vitest'

test('assert.includeDeepOrderedMembers', () => {
  assert.notIncludeDeepOrderedMembers([{ a: 1 }, { b: 2 }, { c: 3 }], [{ a: 1 }, { f: 5 }], 'not include deep ordered members')
  assert.notIncludeDeepOrderedMembers([{ a: 1 }, { b: 2 }, { c: 3 }], [{ b: 2 }, { a: 1 }], 'not include deep ordered members')
  assert.notIncludeDeepOrderedMembers([{ a: 1 }, { b: 2 }, { c: 3 }], [{ b: 2 }, { c: 3 }], 'not include deep ordered members')
})
```

## oneOf

- **Typ:** `<T>(inList: T, list: T[], message?: string) => void`

Stellt sicher, dass der Wert `inList`, der weder Objekt noch Array ist, im flachen Array `list` vorkommt.

```ts
import { assert, test } from 'vitest'

test('assert.oneOf', () => {
  assert.oneOf(1, [2, 1], 'Not found in list')
})
```

## changes

- **Typ:** `<T>(modifier: Function, object: T, property: string, message?: string) => void`

Stellt sicher, dass ein `modifier` das `object` einer `property` verändert.

```ts
import { assert, test } from 'vitest'

test('assert.changes', () => {
  const obj = { val: 10 }
  function fn() { obj.val = 22 };
  assert.changes(fn, obj, 'val')
})
```

## changesBy

- **Typ:** `<T>(modifier: Function, object: T, property: string, change: number, message?: string) => void`

Stellt sicher, dass ein `modifier` das `object` einer `property` um `change` verändert.

```ts
import { assert, test } from 'vitest'

test('assert.changesBy', () => {
  const obj = { val: 10 }
  function fn() { obj.val += 2 };
  assert.changesBy(fn, obj, 'val', 2)
})
```

## doesNotChange

- **Typ:** `<T>(modifier: Function, object: T, property: string, message?: string) => void`

Stellt sicher, dass ein `modifier` das `object` einer `property` nicht verändert.

```ts
import { assert, test } from 'vitest'

test('assert.doesNotChange', () => {
  const obj = { val: 10 }
  function fn() { obj.val += 2 };
  assert.doesNotChange(fn, obj, 'val', 2)
})
```

## changesButNotBy

- **Typ:** `<T>(modifier: Function, object: T, property: string, change:number, message?: string) => void`

Stellt sicher, dass ein `modifier` das `object` einer `property` oder den Rückgabewert eines `modifier` nicht um `change` verändert.

```ts
import { assert, test } from 'vitest'

test('assert.changesButNotBy', () => {
  const obj = { val: 10 }
  function fn() { obj.val += 10 };
  assert.changesButNotBy(fn, obj, 'val', 5)
})
```

## increases

- **Typ:** `<T>(modifier: Function, object: T, property: string, message?: string) => void`

Stellt sicher, dass ein `modifier` die numerische `property` eines `object` erhöht.

```ts
import { assert, test } from 'vitest'

test('assert.increases', () => {
  const obj = { val: 10 }
  function fn() { obj.val = 13 };
  assert.increases(fn, obj, 'val')
})
```

## increasesBy

- **Typ:** `<T>(modifier: Function, object: T, property: string, change: number, message?: string) => void`

Stellt sicher, dass ein `modifier` die numerische `property` eines `object` oder den Rückgabewert eines `modifier` um `change` erhöht.

```ts
import { assert, test } from 'vitest'

test('assert.increasesBy', () => {
  const obj = { val: 10 }
  function fn() { obj.val += 10 };
  assert.increasesBy(fn, obj, 'val', 10)
})
```

## doesNotIncrease

- **Typ:** `<T>(modifier: Function, object: T, property: string, message?: string) => void`

Stellt sicher, dass ein `modifier` die numerische `property` eines `object` nicht erhöht.

```ts
import { assert, test } from 'vitest'

test('assert.doesNotIncrease', () => {
  const obj = { val: 10 }
  function fn() { obj.val = 8 }
  assert.doesNotIncrease(fn, obj, 'val')
})
```

## increasesButNotBy

- **Typ:** `<T>(modifier: Function, object: T, property: string, change: number, message?: string) => void`

Stellt sicher, dass ein `modifier` die numerische `property` eines `object` oder den Rückgabewert eines `modifier` nicht um `change` erhöht.

```ts
import { assert, test } from 'vitest'

test('assert.increasesButNotBy', () => {
  const obj = { val: 10 }
  function fn() { obj.val += 15 };
  assert.increasesButNotBy(fn, obj, 'val', 10)
})
```

## decreases

- **Typ:** `<T>(modifier: Function, object: T, property: string, message?: string) => void`

Stellt sicher, dass ein `modifier` die numerische `property` eines `object` verringert.

```ts
import { assert, test } from 'vitest'

test('assert.decreases', () => {
  const obj = { val: 10 }
  function fn() { obj.val = 5 };
  assert.decreases(fn, obj, 'val')
})
```

## decreasesBy

- **Typ:** `<T>(modifier: Function, object: T, property: string, change: number, message?: string) => void`

Stellt sicher, dass ein `modifier` die numerische `property` eines `object` oder den Rückgabewert eines `modifier` um `change` verringert.

```ts
import { assert, test } from 'vitest'

test('assert.decreasesBy', () => {
  const obj = { val: 10 }
  function fn() { obj.val -= 5 };
  assert.decreasesBy(fn, obj, 'val', 5)
})
```

## doesNotDecrease

- **Typ:** `<T>(modifier: Function, object: T, property: string, message?: string) => void`

Stellt sicher, dass ein `modifier` die numerische `property` eines `object` nicht verringert.

```ts
import { assert, test } from 'vitest'

test('assert.doesNotDecrease', () => {
  const obj = { val: 10 }
  function fn() { obj.val = 15 }
  assert.doesNotDecrease(fn, obj, 'val')
})
```

## doesNotDecreaseBy

- **Typ:** `<T>(modifier: Function, object: T, property: string, change: number, message?: string) => void`

Stellt sicher, dass ein `modifier` die numerische `property` eines `object` oder den Rückgabewert eines `modifier` nicht um `change` verringert.

```ts
import { assert, test } from 'vitest'

test('assert.doesNotDecreaseBy', () => {
  const obj = { val: 10 }
  function fn() { obj.val = 5 };
  assert.doesNotDecreaseBy(fn, obj, 'val', 1)
})
```

## decreasesButNotBy

- **Typ:** `<T>(modifier: Function, object: T, property: string, change: number, message?: string) => void`

Stellt sicher, dass ein `modifier` die numerische `property` eines `object` oder den Rückgabewert eines `modifier` nicht um `change` verringert.

```ts
import { assert, test } from 'vitest'

test('assert.decreasesButNotBy', () => {
  const obj = { val: 10 }
  function fn() { obj.val = 5 };
  assert.decreasesButNotBy(fn, obj, 'val', 1)
})
```

## ifError

- **Typ:** `<T>(object: T, message?: string) => void`

Prüft, ob `object` kein falscher Wert ist, und wirft einen Fehler, wenn es ein wahrer Wert ist. Dies wurde ergänzt, damit chai als direkter Ersatz für die assert-Klasse von Node dienen kann.

```ts
import { assert, test } from 'vitest'

test('assert.ifError', () => {
  const err = new Error('I am a custom error')
  assert.ifError(err) // Rethrows err!
})
```

## isExtensible

- **Typ:** `<T>(object: T, message?: string) => void`
- **Alias:** `extensible`

Stellt sicher, dass `object` erweiterbar ist (dass ihm neue Eigenschaften hinzugefügt werden können).

```ts
import { assert, test } from 'vitest'

test('assert.isExtensible', () => {
  assert.isExtensible({})
})
```

## isNotExtensible

- **Typ:** `<T>(object: T, message?: string) => void`
- **Alias:** `notExtensible`

Stellt sicher, dass `object` nicht erweiterbar ist (dass ihm keine neuen Eigenschaften hinzugefügt werden können).

```ts
import { assert, test } from 'vitest'

test('assert.isNotExtensible', () => {
  const nonExtensibleObject = Object.preventExtensions({})
  const sealedObject = Object.seal({})
  const frozenObject = Object.freeze({})

  assert.isNotExtensible(nonExtensibleObject)
  assert.isNotExtensible(sealedObject)
  assert.isNotExtensible(frozenObject)
})
```

## isSealed

- **Typ:** `<T>(object: T, message?: string) => void`
- **Alias:** `sealed`

Stellt sicher, dass `object` versiegelt ist (dass ihm keine neuen Eigenschaften hinzugefügt und seine vorhandenen Eigenschaften nicht entfernt werden können).

```ts
import { assert, test } from 'vitest'

test('assert.isSealed', () => {
  const sealedObject = Object.seal({})
  const frozenObject = Object.seal({})

  assert.isSealed(sealedObject)
  assert.isSealed(frozenObject)
})
```

## isNotSealed

- **Typ:** `<T>(object: T, message?: string) => void`
- **Alias:** `notSealed`

Stellt sicher, dass `object` nicht versiegelt ist (dass ihm neue Eigenschaften hinzugefügt und seine vorhandenen Eigenschaften entfernt werden können).

```ts
import { assert, test } from 'vitest'

test('assert.isNotSealed', () => {
  assert.isNotSealed({})
})
```

## isFrozen

- **Typ:** `<T>(object: T, message?: string) => void`
- **Alias:** `frozen`

Stellt sicher, dass object eingefroren ist (dass ihm keine neuen Eigenschaften hinzugefügt und seine vorhandenen Eigenschaften nicht geändert werden können).

```ts
import { assert, test } from 'vitest'

test('assert.isFrozen', () => {
  const frozenObject = Object.freeze({})
  assert.frozen(frozenObject)
})
```

## isNotFrozen

- **Typ:** `<T>(object: T, message?: string) => void`
- **Alias:** `notFrozen`

Stellt sicher, dass `object` nicht eingefroren ist (dass ihm neue Eigenschaften hinzugefügt und seine vorhandenen Eigenschaften geändert werden können).

```ts
import { assert, test } from 'vitest'

test('assert.isNotFrozen', () => {
  assert.isNotFrozen({})
})
```

## isEmpty

- **Typ:** `<T>(target: T, message?: string) => void`
- **Alias:** `empty`

Stellt sicher, dass `target` keine Werte enthält. Bei Arrays und Strings wird die Eigenschaft length geprüft. Bei Map- und Set-Instanzen wird die Eigenschaft size geprüft. Bei Objekten, die keine Funktionen sind, wird die Anzahl ihrer eigenen aufzählbaren String-Keys ermittelt.

```ts
import { assert, test } from 'vitest'

test('assert.isEmpty', () => {
  assert.isEmpty([])
  assert.isEmpty('')
  assert.isEmpty(new Map())
  assert.isEmpty({})
})
```

## isNotEmpty

- **Typ:** `<T>(object: T, message?: string) => void`
- **Alias:** `notEmpty`

Stellt sicher, dass `target` Werte enthält. Bei Arrays und Strings wird die Eigenschaft length geprüft. Bei Map- und Set-Instanzen wird die Eigenschaft size geprüft. Bei Objekten, die keine Funktionen sind, wird die Anzahl ihrer eigenen aufzählbaren String-Keys ermittelt.

```ts
import { assert, test } from 'vitest'

test('assert.isNotEmpty', () => {
  assert.isNotEmpty([1, 2])
  assert.isNotEmpty('34')
  assert.isNotEmpty(new Set([5, 6]))
  assert.isNotEmpty({ key: 7 })
})
```
