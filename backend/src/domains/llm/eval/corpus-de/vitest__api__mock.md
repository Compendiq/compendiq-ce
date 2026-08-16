# Mocks

Mit der Methode `vi.fn` können Sie eine Mock-Funktion oder -Klasse erstellen, um deren Ausführung nachzuverfolgen. Wenn Sie eine Eigenschaft eines bereits erstellten Objekts nachverfolgen möchten, können Sie die Methode `vi.spyOn` verwenden:

```js
import { vi } from 'vitest'

const fn = vi.fn()
fn('hello world')
fn.mock.calls[0] === ['hello world']

const market = {
  getApples: () => 100
}

const getApplesSpy = vi.spyOn(market, 'getApples')
market.getApples()
getApplesSpy.mock.calls.length === 1
```

Um Mock-Ergebnisse zu prüfen, sollten Sie Mock-Assertions (z. B. [`toHaveBeenCalled`](/api/expect#tohavebeencalled)) auf [`expect`](/api/expect) verwenden. Diese API-Referenz beschreibt die verfügbaren Eigenschaften und Methoden, um das Verhalten von Mocks zu steuern.

::: warning WICHTIG
Vitest-Spies erben beim Initialisieren die Eigenschaft [`length`](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Function/length) der Implementierung, überschreiben sie aber nicht, wenn die Implementierung später geändert wird:

::: code-group
```ts [vi.fn]
const fn = vi.fn((arg1) => {})
fn.length // == 1

fn.mockImplementation(() => {})
fn.length // == 1
```
```ts [vi.spyOn]
const example = {
  fn(arg1, arg2) {
    // ...
  }
}

const fn = vi.spyOn(example, 'fn')
fn.length // == 2

fn.mockImplementation(() => {})
fn.length // == 2
```
:::

::: tip
Die eigene Funktionsimplementierung ist in den folgenden Typen mit einem generischen `<T>` gekennzeichnet.
:::

::: warning Unterstützung von Klassen {#class-support}
Kurzformmethoden wie `mockReturnValue`, `mockReturnValueOnce`, `mockResolvedValue` und andere können nicht auf einer gemockten Klasse verwendet werden. Klassenkonstruktoren verhalten sich hinsichtlich des Rückgabewerts [wenig intuitiv](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Classes/constructor):

```ts {2,7}
const CorrectDogClass = vi.fn(class {
  constructor(public name: string) {}
})

const IncorrectDogClass = vi.fn(class {
  constructor(public name: string) {
    return { name }
  }
})

const Marti = new CorrectDogClass('Marti')
const Newt = new IncorrectDogClass('Newt')

Marti instanceof CorrectDogClass // ✅ true
Newt instanceof IncorrectDogClass // ❌ false!
```

Obwohl die Formen identisch sind, wird `Newt` der _Rückgabewert_ des Konstruktors zugewiesen — ein einfaches Objekt, keine Instanz eines Mocks. Vitest schützt Sie in den Kurzformmethoden vor diesem Verhalten (allerdings nicht in `mockImplementation`!) und wirft stattdessen einen Fehler.

Wenn Sie die konstruierte Instanz einer Klasse mocken müssen, ziehen Sie stattdessen die `class`-Syntax mit `mockImplementation` in Betracht:

```ts
mock.mockReturnValue({ hello: () => 'world' }) // [!code --]
mock.mockImplementation(class { hello = () => 'world' }) // [!code ++]
```

Wenn Sie das Verhalten testen müssen, weil es in Ihrem Fall ein gültiger Anwendungsfall ist, können Sie `mockImplementation` mit einem `constructor` verwenden:

```ts
mock.mockImplementation(class {
  constructor(name: string) {
    return { name }
  }
})
```
:::

## getMockImplementation

```ts
function getMockImplementation(): T | undefined
```

Gibt die aktuelle Mock-Implementierung zurück, sofern es eine gibt.

Wurde der Mock mit [`vi.fn`](/api/vi#vi-fn) erstellt, wird die übergebene Methode als Mock-Implementierung verwendet.

Wurde der Mock mit [`vi.spyOn`](/api/vi#vi-spyon) erstellt, wird `undefined` zurückgegeben, sofern keine eigene Implementierung angegeben wurde.

## getMockName

```ts
function getMockName(): string
```

Damit geben Sie den Namen zurück, der dem Mock mit der Methode `.mockName(name)` zugewiesen wurde. Standardmäßig geben `vi.fn()`-Mocks `'vi.fn()'` zurück, während mit `vi.spyOn` erstellte Spies ihren ursprünglichen Namen behalten.

## mockClear

```ts
function mockClear(): Mock<T>
```

Löscht alle Informationen über jeden Aufruf. Nach dem Aufruf kehren alle Eigenschaften auf `.mock` in ihren Ausgangszustand zurück. Diese Methode setzt keine Implementierungen zurück. Sie ist nützlich, um Mocks zwischen verschiedenen Assertions aufzuräumen.

```ts
const person = {
  greet: (name: string) => `Hello ${name}`,
}
const spy = vi.spyOn(person, 'greet').mockImplementation(() => 'mocked')
expect(person.greet('Alice')).toBe('mocked')
expect(spy.mock.calls).toEqual([['Alice']])

// clear call history but keep mock implementation
spy.mockClear()
expect(spy.mock.calls).toEqual([])
expect(person.greet('Bob')).toBe('mocked')
expect(spy.mock.calls).toEqual([['Bob']])
```

Um diese Methode automatisch vor jedem Test aufzurufen, aktivieren Sie in der Konfiguration die Einstellung [`clearMocks`](/config/clearmocks).

## mockName

```ts
function mockName(name: string): Mock<T>
```

Setzt den internen Namen des Mocks. Das hilft dabei, den Mock zu identifizieren, wenn eine Assertion fehlschlägt.

## mockImplementation

```ts
function mockImplementation(fn: T): Mock<T>
```

Nimmt eine Funktion entgegen, die als Mock-Implementierung verwendet wird. TypeScript erwartet, dass Argumente und Rückgabetyp denen der ursprünglichen Funktion entsprechen.

```ts
const mockFn = vi.fn().mockImplementation((apples: number) => apples + 1)
// or: vi.fn(apples => apples + 1);

const NelliesBucket = mockFn(0)
const BobsBucket = mockFn(1)

NelliesBucket === 1 // true
BobsBucket === 2 // true

mockFn.mock.calls[0][0] === 0 // true
mockFn.mock.calls[1][0] === 1 // true
```

## mockImplementationOnce

```ts
function mockImplementationOnce(fn: T): Mock<T>
```

Nimmt eine Funktion entgegen, die als Mock-Implementierung verwendet wird. TypeScript erwartet, dass Argumente und Rückgabetyp denen der ursprünglichen Funktion entsprechen. Diese Methode lässt sich verketten, um für mehrere Funktionsaufrufe unterschiedliche Ergebnisse zu erzeugen.

```ts
const myMockFn = vi
  .fn()
  .mockImplementationOnce(() => true) // 1st call
  .mockImplementationOnce(() => false) // 2nd call

myMockFn() // 1st call: true
myMockFn() // 2nd call: false
```

Gehen der gemockten Funktion die Implementierungen aus, ruft sie die Standardimplementierung auf, die mit `vi.fn(() => defaultValue)` oder `.mockImplementation(() => defaultValue)` gesetzt wurde, sofern diese aufgerufen wurden:

```ts
const myMockFn = vi
  .fn(() => 'default')
  .mockImplementationOnce(() => 'first call')
  .mockImplementationOnce(() => 'second call')

// 'first call', 'second call', 'default', 'default'
console.log(myMockFn(), myMockFn(), myMockFn(), myMockFn())
```

## withImplementation

```ts
function withImplementation(
  fn: T,
  cb: () => void
): Mock<T>
function withImplementation(
  fn: T,
  cb: () => Promise<void>
): Promise<Mock<T>>
```

Überschreibt die ursprüngliche Mock-Implementierung vorübergehend, während der Callback ausgeführt wird.

```js
const myMockFn = vi.fn(() => 'original')

myMockFn.withImplementation(() => 'temp', () => {
  myMockFn() // 'temp'
})

myMockFn() // 'original'
```

Kann mit einem asynchronen Callback verwendet werden. Die Methode muss mit `await` abgewartet werden, damit anschließend wieder die ursprüngliche Implementierung greift.

```ts
test('async callback', () => {
  const myMockFn = vi.fn(() => 'original')

  // We await this call since the callback is async
  await myMockFn.withImplementation(
    () => 'temp',
    async () => {
      myMockFn() // 'temp'
    },
  )

  myMockFn() // 'original'
})
```

Beachten Sie, dass diese Methode Vorrang vor [`mockImplementationOnce`](#mockimplementationonce) hat.

## mockRejectedValue

```ts
function mockRejectedValue(value: unknown): Mock<T>
```

Nimmt einen Fehler entgegen, mit dem das Promise abgelehnt wird, wenn eine asynchrone Funktion aufgerufen wird.

```ts
const asyncMock = vi.fn().mockRejectedValue(new Error('Async error'))

await asyncMock() // throws Error<'Async error'>
```

## mockRejectedValueOnce

```ts
function mockRejectedValueOnce(value: unknown): Mock<T>
```

Nimmt einen Wert entgegen, mit dem das Promise beim nächsten Funktionsaufruf abgelehnt wird. Bei Verkettung lehnt jeder weitere Aufruf mit dem jeweils angegebenen Wert ab.

```ts
const asyncMock = vi
  .fn()
  .mockResolvedValueOnce('first call')
  .mockRejectedValueOnce(new Error('Async error'))

await asyncMock() // 'first call'
await asyncMock() // throws Error<'Async error'>
```

## mockReset

```ts
function mockReset(): Mock<T>
```

Tut dasselbe wie [`mockClear`](#mockClear) und setzt zusätzlich die Mock-Implementierung zurück. Damit werden auch alle „once“-Implementierungen zurückgesetzt.

Beachten Sie, dass das Zurücksetzen eines Mocks aus `vi.fn()` die Implementierung auf eine leere Funktion setzt, die `undefined` zurückgibt.
Das Zurücksetzen eines Mocks aus `vi.fn(impl)` setzt die Implementierung auf `impl` zurück.

Das ist nützlich, wenn Sie einen Mock in seinen Ausgangszustand zurückversetzen möchten.

```ts
const person = {
  greet: (name: string) => `Hello ${name}`,
}
const spy = vi.spyOn(person, 'greet').mockImplementation(() => 'mocked')
expect(person.greet('Alice')).toBe('mocked')
expect(spy.mock.calls).toEqual([['Alice']])

// clear call history and reset implementation, but method is still spied
spy.mockReset()
expect(spy.mock.calls).toEqual([])
expect(person.greet).toBe(spy)
expect(person.greet('Bob')).toBe('Hello Bob')
expect(spy.mock.calls).toEqual([['Bob']])
```

Um diese Methode automatisch vor jedem Test aufzurufen, aktivieren Sie in der Konfiguration die Einstellung [`mockReset`](/config/mockreset).

## mockRestore

```ts
function mockRestore(): Mock<T>
```

Tut dasselbe wie [`mockReset`](#mockreset) und stellt zusätzlich die ursprünglichen Deskriptoren der bespitzelten Objekte wieder her, sofern der Mock mit [`vi.spyOn`](/api/vi#vi-spyon) erstellt wurde.

`mockRestore` auf einem `vi.fn()`-Mock ist identisch mit [`mockReset`](#mockreset).

```ts
const person = {
  greet: (name: string) => `Hello ${name}`,
}
const spy = vi.spyOn(person, 'greet').mockImplementation(() => 'mocked')
expect(person.greet('Alice')).toBe('mocked')
expect(spy.mock.calls).toEqual([['Alice']])

// clear call history and restore spied object method
spy.mockRestore()
expect(spy.mock.calls).toEqual([])
expect(person.greet).not.toBe(spy)
expect(person.greet('Bob')).toBe('Hello Bob')
expect(spy.mock.calls).toEqual([])
```

Um diese Methode automatisch vor jedem Test aufzurufen, aktivieren Sie in der Konfiguration die Einstellung [`restoreMocks`](/config/restoremocks).

## mockResolvedValue

```ts
function mockResolvedValue(value: Awaited<ReturnType<T>>): Mock<T>
```

Nimmt einen Wert entgegen, mit dem das Promise aufgelöst wird, wenn die asynchrone Funktion aufgerufen wird. TypeScript akzeptiert nur Werte, die zum Rückgabetyp der ursprünglichen Funktion passen.

```ts
const asyncMock = vi.fn().mockResolvedValue(42)

await asyncMock() // 42
```

## mockResolvedValueOnce

```ts
function mockResolvedValueOnce(value: Awaited<ReturnType<T>>): Mock<T>
```

Nimmt einen Wert entgegen, mit dem das Promise beim nächsten Funktionsaufruf aufgelöst wird. TypeScript akzeptiert nur Werte, die zum Rückgabetyp der ursprünglichen Funktion passen. Bei Verkettung löst jeder weitere Aufruf mit dem jeweils angegebenen Wert auf.

```ts
const asyncMock = vi
  .fn()
  .mockResolvedValue('default')
  .mockResolvedValueOnce('first call')
  .mockResolvedValueOnce('second call')

await asyncMock() // first call
await asyncMock() // second call
await asyncMock() // default
await asyncMock() // default
```

## mockReturnThis

```ts
function mockReturnThis(): Mock<T>
```

Verwenden Sie das, wenn Sie den `this`-Kontext der Methode zurückgeben möchten, ohne die tatsächliche Implementierung aufzurufen. Es ist eine Kurzform für:

```ts
spy.mockImplementation(function () {
  return this
})
```

## mockReturnValue

```ts
function mockReturnValue(value: ReturnType<T>): Mock<T>
```

Nimmt einen Wert entgegen, der bei jedem Aufruf der Mock-Funktion zurückgegeben wird. TypeScript akzeptiert nur Werte, die zum Rückgabetyp der ursprünglichen Funktion passen.

```ts
const mock = vi.fn()
mock.mockReturnValue(42)
mock() // 42
mock.mockReturnValue(43)
mock() // 43
```

## mockReturnValueOnce

```ts
function mockReturnValueOnce(value: ReturnType<T>): Mock<T>
```

Nimmt einen Wert entgegen, der bei jedem Aufruf der Mock-Funktion zurückgegeben wird. TypeScript akzeptiert nur Werte, die zum Rückgabetyp der ursprünglichen Funktion passen.

Gehen der gemockten Funktion die Implementierungen aus, ruft sie die Standardimplementierung auf, die mit `vi.fn(() => defaultValue)` oder `.mockImplementation(() => defaultValue)` gesetzt wurde, sofern diese aufgerufen wurden:

```ts
const myMockFn = vi
  .fn()
  .mockReturnValue('default')
  .mockReturnValueOnce('first call')
  .mockReturnValueOnce('second call')

// 'first call', 'second call', 'default', 'default'
console.log(myMockFn(), myMockFn(), myMockFn(), myMockFn())
```

## mockThrow <Version>4.1.0</Version> {#mockthrow}

```ts
function mockThrow(value: unknown): Mock<T>
```

Nimmt einen Wert entgegen, der bei jedem Aufruf der Mock-Funktion geworfen wird.

```ts
const myMockFn = vi.fn()
myMockFn.mockThrow(new Error('error message'))
myMockFn() // throws Error<'error message'>
```

## mockThrowOnce <Version>4.1.0</Version> {#mockthrowonce}

```ts
function mockThrowOnce(value: unknown): Mock<T>
```

Nimmt einen Wert entgegen, der beim nächsten Funktionsaufruf geworfen wird. Bei Verkettung wirft jeder weitere Aufruf den jeweils angegebenen Wert.

```ts
const myMockFn = vi
  .fn()
  .mockReturnValue('default')
  .mockThrowOnce(new Error('first call error'))
  .mockThrowOnce('second call error')

expect(() => myMockFn()).toThrow('first call error')
expect(() => myMockFn()).toThrow('second call error')
expect(myMockFn()).toEqual('default')
```

## mock.calls

```ts
const calls: Parameters<T>[]
```

Das ist ein Array mit allen Argumenten für jeden Aufruf. Ein Element des Arrays entspricht den Argumenten des jeweiligen Aufrufs.

```js
const fn = vi.fn()

fn('arg1', 'arg2')
fn('arg3')

fn.mock.calls === [
  ['arg1', 'arg2'], // first call
  ['arg3'], // second call
]
```

:::warning Objekte werden als Referenz gespeichert
Beachten Sie, dass Vitest Objekte in allen Eigenschaften des `mock`-Zustands stets als Referenz speichert. Wenn die Eigenschaften also von Ihrem Code verändert werden, schlagen manche Assertions wie [`.toHaveBeenCalledWith`](/api/expect#tohavebeencalledwith) fehl:

```ts
const argument = {
  value: 0,
}
const fn = vi.fn()
fn(argument) // { value: 0 }

argument.value = 10

expect(fn).toHaveBeenCalledWith({ value: 0 }) // [!code --]

// The equality check is done against the original argument,
// but its property was changed between the call and assertion
expect(fn).toHaveBeenCalledWith({ value: 10 }) // [!code ++]
```

In diesem Fall können Sie das Argument selbst klonen:

```ts{6}
const calledArguments = []
const fn = vi.fn((arg) => {
  calledArguments.push(structuredClone(arg))
})

expect(calledArguments[0]).toEqual({ value: 0 })
```
:::

## mock.lastCall

```ts
const lastCall: Parameters<T> | undefined
```

Enthält die Argumente des letzten Aufrufs. Wurde der Mock nicht aufgerufen, wird `undefined` zurückgegeben.

## mock.results

```ts
interface MockResultReturn<T> {
  type: 'return'
  /**
   * The value that was returned from the function.
   * If the function returned a Promise, then this will be a resolved value.
   */
  value: T
}

interface MockResultIncomplete {
  type: 'incomplete'
  value: undefined
}

interface MockResultThrow {
  type: 'throw'
  /**
   * An error that was thrown during function execution.
   */
  value: any
}

type MockResult<T>
  = | MockResultReturn<T>
    | MockResultThrow
    | MockResultIncomplete

const results: MockResult<ReturnType<T>>[]
```

Das ist ein Array mit allen Werten, die von der Funktion `zurückgegeben` wurden. Ein Element des Arrays ist ein Objekt mit den Eigenschaften `type` und `value`. Verfügbare Typen sind:

- `'return'` – Funktion hat zurückgegeben, ohne zu werfen.
- `'throw'` – Funktion hat einen Wert geworfen.
- `'incomplete'` – die Funktion ist noch nicht fertig ausgeführt.

Die Eigenschaft `value` enthält den zurückgegebenen Wert bzw. den geworfenen Fehler. Gab die Funktion ein `Promise` zurück, ist `result` stets `'return'`, selbst wenn das Promise abgelehnt wurde.

```js
const fn = vi.fn()
  .mockReturnValueOnce('result')
  .mockImplementationOnce(() => { throw new Error('thrown error') })

const result = fn() // returned 'result'

try {
  fn() // threw Error
}
catch {}

fn.mock.results === [
  // first result
  {
    type: 'return',
    value: 'result',
  },
  // last result
  {
    type: 'throw',
    value: Error,
  },
]
```

## mock.settledResults

```ts
interface MockSettledResultIncomplete {
  type: 'incomplete'
  value: undefined
}

interface MockSettledResultFulfilled<T> {
  type: 'fulfilled'
  value: T
}

interface MockSettledResultRejected {
  type: 'rejected'
  value: any
}

export type MockSettledResult<T>
  = | MockSettledResultFulfilled<T>
    | MockSettledResultRejected
    | MockSettledResultIncomplete

const settledResults: MockSettledResult<Awaited<ReturnType<T>>>[]
```

Ein Array mit allen Werten, die von der Funktion aufgelöst oder abgelehnt wurden.

Gab die Funktion Werte zurück, die keine Promises sind, bleibt `value` unverändert, `type` lautet aber dennoch `fulfilled` oder `rejected`.

Solange der Wert weder aufgelöst noch abgelehnt ist, hat `settledResult` den Typ `incomplete`.

```js
const fn = vi.fn().mockResolvedValueOnce('result')

const result = fn()

fn.mock.settledResults === [
  {
    type: 'incomplete',
    value: undefined,
  },
]

await result

fn.mock.settledResults === [
  {
    type: 'fulfilled',
    value: 'result',
  },
]
```

## mock.invocationCallOrder

```ts
const invocationCallOrder: number[]
```

Diese Eigenschaft gibt die Ausführungsreihenfolge der Mock-Funktion zurück. Es ist ein Array von Zahlen, das von allen definierten Mocks gemeinsam genutzt wird.

```js
const fn1 = vi.fn()
const fn2 = vi.fn()

fn1()
fn2()
fn1()

fn1.mock.invocationCallOrder === [1, 3]
fn2.mock.invocationCallOrder === [2]
```

## mock.contexts

```ts
const contexts: ThisParameterType<T>[]
```

Diese Eigenschaft ist ein Array der `this`-Werte, die bei jedem Aufruf der Mock-Funktion verwendet wurden.

```js
const fn = vi.fn()
const context = {}

fn.apply(context)
fn.call(context)

fn.mock.contexts[0] === context
fn.mock.contexts[1] === context
```

## mock.instances

```ts
const instances: ReturnType<T>[]
```

Diese Eigenschaft ist ein Array mit allen Instanzen, die erzeugt wurden, als der Mock mit dem Schlüsselwort `new` aufgerufen wurde. Beachten Sie, dass es sich um den tatsächlichen Kontext (`this`) der Funktion handelt, nicht um einen Rückgabewert.

::: warning
Wurde der Mock mit `new MyClass()` instanziiert, ist `mock.instances` ein Array mit einem Wert:

```js
const MyClass = vi.fn()
const a = new MyClass()

MyClass.mock.instances[0] === a
```

Wenn Sie aus dem Konstruktor einen Wert zurückgeben, landet dieser nicht im Array `instances`, sondern in `results`:

```js
const Spy = vi.fn(function () {
  return { method: vi.fn() }
})
const a = new Spy()

Spy.mock.instances[0] !== a
Spy.mock.results[0] === a
```
:::
