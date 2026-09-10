# expectTypeOf

::: warning
Zur Laufzeit tut diese Funktion nichts. Um die [Typprüfung zu aktivieren](/guide/testing-types#run-typechecking), vergessen Sie nicht, das Flag `--typecheck` zu übergeben.
:::

- **Typ:** `<T>(a: unknown) => ExpectTypeOf`

## not

- **Typ:** `ExpectTypeOf`

Mit der Eigenschaft `.not` können Sie alle Assertions negieren.

## toEqualTypeOf

- **Typ:** `<T>(expected: T) => void`

Dieser Matcher prüft, ob die Typen vollständig übereinstimmen. Er schlägt nicht fehl, wenn zwei Objekte unterschiedliche Werte, aber denselben Typ haben. Er schlägt allerdings fehl, wenn einem Objekt eine Eigenschaft fehlt.

```ts
import { expectTypeOf } from 'vitest'

expectTypeOf({ a: 1 }).toEqualTypeOf<{ a: number }>()
expectTypeOf({ a: 1 }).toEqualTypeOf({ a: 1 })
expectTypeOf({ a: 1 }).toEqualTypeOf({ a: 2 })
expectTypeOf({ a: 1, b: 1 }).not.toEqualTypeOf<{ a: number }>()
```

## toMatchTypeOf

- **Typ:** `<T>(expected: T) => void`

::: warning VERALTET
Dieser Matcher gilt seit expect-type v1.2.0 als veraltet. Verwenden Sie stattdessen [`toExtend`](#toextend).
:::
Dieser Matcher prüft, ob der erwartete Typ den angegebenen Typ erweitert. Er unterscheidet sich von `toEqual` und ähnelt eher `toMatchObject()` von [expect](/api/expect). Mit diesem Matcher können Sie prüfen, ob ein Objekt zu einem Typ „passt“.

```ts
import { expectTypeOf } from 'vitest'

expectTypeOf({ a: 1, b: 1 }).toMatchTypeOf({ a: 1 })
expectTypeOf<number>().toMatchTypeOf<string | number>()
expectTypeOf<string | number>().not.toMatchTypeOf<number>()
```

## toExtend

- **Typ:** `<T>(expected: T) => void`

Dieser Matcher prüft, ob der erwartete Typ den angegebenen Typ erweitert. Er unterscheidet sich von `toEqual` und ähnelt eher `toMatchObject()` von [expect](/api/expect). Mit diesem Matcher können Sie prüfen, ob ein Objekt zu einem Typ „passt“.

```ts
import { expectTypeOf } from 'vitest'

expectTypeOf({ a: 1, b: 1 }).toExtend({ a: 1 })
expectTypeOf<number>().toExtend<string | number>()
expectTypeOf<string | number>().not.toExtend<number>()
```

## toMatchObjectType

- **Typ:** `() => void`

Dieser Matcher führt eine strikte Prüfung von Objekttypen durch und stellt sicher, dass der erwartete Typ zum angegebenen Objekttyp passt. Er ist strenger als [`toExtend`](#toextend) und die empfohlene Wahl bei Objekttypen, weil er Probleme wie schreibgeschützte Eigenschaften eher aufdeckt.

```ts
import { expectTypeOf } from 'vitest'

expectTypeOf({ a: 1, b: 2 }).toMatchObjectType<{ a: number }>() // preferred
expectTypeOf({ a: 1, b: 2 }).toExtend<{ a: number }>() // works but less strict

// Supports nested object checking
const user = {
  name: 'John',
  address: { city: 'New York', zip: '10001' }
}
expectTypeOf(user).toMatchObjectType<{ name: string; address: { city: string } }>()
```

::: warning
Dieser Matcher funktioniert nur mit einfachen Objekttypen. Bei Union-Typen und anderen komplexen Typen schlägt er fehl. Verwenden Sie in diesen Fällen stattdessen [`toExtend`](#toextend).
:::

## extract

- **Typ:** `ExpectTypeOf<ExtractedUnion>`

Mit `.extract` können Sie Typen für weitere Prüfungen eingrenzen.

```ts
import { expectTypeOf } from 'vitest'

type ResponsiveProp<T> = T | T[] | { xs?: T; sm?: T; md?: T }

interface CSSProperties { margin?: string; padding?: string }

function getResponsiveProp<T>(_props: T): ResponsiveProp<T> {
  return {}
}

const cssProperties: CSSProperties = { margin: '1px', padding: '2px' }

expectTypeOf(getResponsiveProp(cssProperties))
  .extract<{ xs?: any }>() // extracts the last type from a union
  .toEqualTypeOf<{ xs?: CSSProperties; sm?: CSSProperties; md?: CSSProperties }>()

expectTypeOf(getResponsiveProp(cssProperties))
  .extract<unknown[]>() // extracts an array from a union
  .toEqualTypeOf<CSSProperties[]>()
```

::: warning
Wird in der Union kein Typ gefunden, gibt `.extract` `never` zurück.
:::

## exclude

- **Typ:** `ExpectTypeOf<NonExcludedUnion>`

Mit `.exclude` können Sie Typen für weitere Prüfungen aus einer Union entfernen.

```ts
import { expectTypeOf } from 'vitest'

type ResponsiveProp<T> = T | T[] | { xs?: T; sm?: T; md?: T }

interface CSSProperties { margin?: string; padding?: string }

function getResponsiveProp<T>(_props: T): ResponsiveProp<T> {
  return {}
}

const cssProperties: CSSProperties = { margin: '1px', padding: '2px' }

expectTypeOf(getResponsiveProp(cssProperties))
  .exclude<unknown[]>()
  .exclude<{ xs?: unknown }>() // or just .exclude<unknown[] | { xs?: unknown }>()
  .toEqualTypeOf<CSSProperties>()
```

::: warning
Wird in der Union kein Typ gefunden, gibt `.exclude` `never` zurück.
:::

## returns

- **Typ:** `ExpectTypeOf<ReturnValue>`

Mit `.returns` können Sie den Rückgabewert eines Funktionstyps extrahieren.

```ts
import { expectTypeOf } from 'vitest'

expectTypeOf(() => {}).returns.toBeVoid()
expectTypeOf((a: number) => [a, a]).returns.toEqualTypeOf([1, 2])
```

::: warning
Auf einen Nicht-Funktionstyp angewendet, gibt es `never` zurück, sodass Sie es nicht mit anderen Matchern verketten können.
:::

## parameters

- **Typ:** `ExpectTypeOf<Parameters>`

Mit `.parameters` können Sie Funktionsargumente extrahieren, um Assertions auf ihren Wert auszuführen. Die Parameter werden als Array zurückgegeben.

```ts
import { expectTypeOf } from 'vitest'

type NoParam = () => void
type HasParam = (s: string) => void

expectTypeOf<NoParam>().parameters.toEqualTypeOf<[]>()
expectTypeOf<HasParam>().parameters.toEqualTypeOf<[string]>()
```

::: warning
Auf einen Nicht-Funktionstyp angewendet, gibt es `never` zurück, sodass Sie es nicht mit anderen Matchern verketten können.
:::

::: tip
Sie können auch den Matcher [`.toBeCallableWith`](#tobecallablewith) als ausdrucksstärkere Assertion verwenden.
:::

## parameter

- **Typ:** `(nth: number) => ExpectTypeOf`

Mit dem Aufruf `.parameter(number)` können Sie ein bestimmtes Funktionsargument extrahieren, um weitere Assertions darauf auszuführen.

```ts
import { expectTypeOf } from 'vitest'

function foo(a: number, b: string) {
  return [a, b]
}

expectTypeOf(foo).parameter(0).toBeNumber()
expectTypeOf(foo).parameter(1).toBeString()
```

::: warning
Auf einen Nicht-Funktionstyp angewendet, gibt es `never` zurück, sodass Sie es nicht mit anderen Matchern verketten können.
:::

## constructorParameters

- **Typ:** `ExpectTypeOf<ConstructorParameters>`

Mit dieser Methode können Sie Konstruktorparameter als Array von Werten extrahieren und Assertions darauf ausführen.

```ts
import { expectTypeOf } from 'vitest'

expectTypeOf(Date).constructorParameters.toEqualTypeOf<[] | [string | number | Date]>()
```

::: warning
Auf einen Nicht-Funktionstyp angewendet, gibt es `never` zurück, sodass Sie es nicht mit anderen Matchern verketten können.
:::

::: tip
Sie können auch den Matcher [`.toBeConstructibleWith`](#tobeconstructiblewith) als ausdrucksstärkere Assertion verwenden.
:::

## instance

- **Typ:** `ExpectTypeOf<ConstructableInstance>`

Diese Eigenschaft gibt Zugriff auf Matcher, die auf einer Instanz der angegebenen Klasse ausgeführt werden können.

```ts
import { expectTypeOf } from 'vitest'

expectTypeOf(Date).instance.toHaveProperty('toISOString')
```

::: warning
Auf einen Nicht-Funktionstyp angewendet, gibt es `never` zurück, sodass Sie es nicht mit anderen Matchern verketten können.
:::

## items

- **Typ:** `ExpectTypeOf<T>`

Mit `.items` erhalten Sie den Elementtyp eines Arrays, um weitere Assertions auszuführen.

```ts
import { expectTypeOf } from 'vitest'

expectTypeOf([1, 2, 3]).items.toEqualTypeOf<number>()
expectTypeOf([1, 2, 3]).items.not.toEqualTypeOf<string>()
```

## resolves

- **Typ:** `ExpectTypeOf<ResolvedPromise>`

Dieser Matcher extrahiert den aufgelösten Wert eines `Promise`, sodass Sie weitere Assertions darauf ausführen können.

```ts
import { expectTypeOf } from 'vitest'

async function asyncFunc() {
  return 123
}

expectTypeOf(asyncFunc).returns.resolves.toBeNumber()
expectTypeOf(Promise.resolve('string')).resolves.toBeString()
```

::: warning
Auf einen Nicht-Promise-Typ angewendet, gibt es `never` zurück, sodass Sie es nicht mit anderen Matchern verketten können.
:::

## guards

- **Typ:** `ExpectTypeOf<Guard>`

Dieser Matcher extrahiert den Guard-Wert (z. B. `v is number`), sodass Sie Assertions darauf ausführen können.

```ts
import { expectTypeOf } from 'vitest'

function isString(v: any): v is string {
  return typeof v === 'string'
}
expectTypeOf(isString).guards.toBeString()
```

::: warning
Gibt `never` zurück, wenn der Wert keine Guard-Funktion ist, sodass Sie es nicht mit anderen Matchern verketten können.
:::

## asserts

- **Typ:** `ExpectTypeOf<Assert>`

Dieser Matcher extrahiert den Assert-Wert (z. B. `assert v is number`), sodass Sie Assertions darauf ausführen können.

```ts
import { expectTypeOf } from 'vitest'

function assertNumber(v: any): asserts v is number {
  if (typeof v !== 'number') {
    throw new TypeError('Nope !')
  }
}

expectTypeOf(assertNumber).asserts.toBeNumber()
```

::: warning
Gibt `never` zurück, wenn der Wert keine Assert-Funktion ist, sodass Sie es nicht mit anderen Matchern verketten können.
:::

## toBeAny

- **Typ:** `() => void`

Mit diesem Matcher können Sie prüfen, ob der angegebene Typ der Typ `any` ist. Ist der Typ zu spezifisch, schlägt der Test fehl.

```ts
import { expectTypeOf } from 'vitest'

expectTypeOf<any>().toBeAny()
expectTypeOf({} as any).toBeAny()
expectTypeOf('string').not.toBeAny()
```

## toBeUnknown

- **Typ:** `() => void`

Dieser Matcher prüft, ob der angegebene Typ der Typ `unknown` ist.

```ts
import { expectTypeOf } from 'vitest'

expectTypeOf().toBeUnknown()
expectTypeOf({} as unknown).toBeUnknown()
expectTypeOf('string').not.toBeUnknown()
```

## toBeNever

- **Typ:** `() => void`

Dieser Matcher prüft, ob der angegebene Typ ein `never`-Typ ist.

```ts
import { expectTypeOf } from 'vitest'

expectTypeOf<never>().toBeNever()
expectTypeOf((): never => {}).returns.toBeNever()
```

## toBeFunction

- **Typ:** `() => void`

Dieser Matcher prüft, ob der angegebene Typ eine `function` ist.

```ts
import { expectTypeOf } from 'vitest'

expectTypeOf(42).not.toBeFunction()
expectTypeOf((): never => {}).toBeFunction()
```

## toBeObject

- **Typ:** `() => void`

Dieser Matcher prüft, ob der angegebene Typ ein `object` ist.

```ts
import { expectTypeOf } from 'vitest'

expectTypeOf(42).not.toBeObject()
expectTypeOf({}).toBeObject()
```

## toBeArray

- **Typ:** `() => void`

Dieser Matcher prüft, ob der angegebene Typ `Array<T>` ist.

```ts
import { expectTypeOf } from 'vitest'

expectTypeOf(42).not.toBeArray()
expectTypeOf([]).toBeArray()
expectTypeOf([1, 2]).toBeArray()
expectTypeOf([{}, 42]).toBeArray()
```

## toBeString

- **Typ:** `() => void`

Dieser Matcher prüft, ob der angegebene Typ ein `string` ist.

```ts
import { expectTypeOf } from 'vitest'

expectTypeOf(42).not.toBeString()
expectTypeOf('').toBeString()
expectTypeOf('a').toBeString()
```

## toBeBoolean

- **Typ:** `() => void`

Dieser Matcher prüft, ob der angegebene Typ `boolean` ist.

```ts
import { expectTypeOf } from 'vitest'

expectTypeOf(42).not.toBeBoolean()
expectTypeOf(true).toBeBoolean()
expectTypeOf<boolean>().toBeBoolean()
```

## toBeVoid

- **Typ:** `() => void`

Dieser Matcher prüft, ob der angegebene Typ `void` ist.

```ts
import { expectTypeOf } from 'vitest'

expectTypeOf(() => {}).returns.toBeVoid()
expectTypeOf<void>().toBeVoid()
```

## toBeSymbol

- **Typ:** `() => void`

Dieser Matcher prüft, ob der angegebene Typ ein `symbol` ist.

```ts
import { expectTypeOf } from 'vitest'

expectTypeOf(Symbol(1)).toBeSymbol()
expectTypeOf<symbol>().toBeSymbol()
```

## toBeNull

- **Typ:** `() => void`

Dieser Matcher prüft, ob der angegebene Typ `null` ist.

```ts
import { expectTypeOf } from 'vitest'

expectTypeOf(null).toBeNull()
expectTypeOf<null>().toBeNull()
expectTypeOf(undefined).not.toBeNull()
```

## toBeUndefined

- **Typ:** `() => void`

Dieser Matcher prüft, ob der angegebene Typ `undefined` ist.

```ts
import { expectTypeOf } from 'vitest'

expectTypeOf(undefined).toBeUndefined()
expectTypeOf<undefined>().toBeUndefined()
expectTypeOf(null).not.toBeUndefined()
```

## toBeNullable

- **Typ:** `() => void`

Dieser Matcher prüft, ob Sie `null` oder `undefined` mit dem angegebenen Typ verwenden können.

```ts
import { expectTypeOf } from 'vitest'

expectTypeOf<undefined | 1>().toBeNullable()
expectTypeOf<null | 1>().toBeNullable()
expectTypeOf<undefined | null | 1>().toBeNullable()
```

## toBeCallableWith

- **Typ:** `() => void`

Dieser Matcher stellt sicher, dass Sie die angegebene Funktion mit einem bestimmten Satz von Parametern aufrufen können.

```ts
import { expectTypeOf } from 'vitest'

type NoParam = () => void
type HasParam = (s: string) => void

expectTypeOf<NoParam>().toBeCallableWith()
expectTypeOf<HasParam>().toBeCallableWith('some string')
```

::: warning
Auf einen Nicht-Funktionstyp angewendet, gibt es `never` zurück, sodass Sie es nicht mit anderen Matchern verketten können.
:::

## toBeConstructibleWith

- **Typ:** `() => void`

Dieser Matcher stellt sicher, dass Sie mit einem bestimmten Satz von Konstruktorparametern eine neue Instanz erzeugen können.

```ts
import { expectTypeOf } from 'vitest'

expectTypeOf(Date).toBeConstructibleWith(new Date())
expectTypeOf(Date).toBeConstructibleWith('01-01-2000')
```

::: warning
Auf einen Nicht-Funktionstyp angewendet, gibt es `never` zurück, sodass Sie es nicht mit anderen Matchern verketten können.
:::

## toHaveProperty

- **Typ:** `<K extends keyof T>(property: K) => ExpectTypeOf<T[K>`

Dieser Matcher prüft, ob eine Eigenschaft am angegebenen Objekt existiert. Existiert sie, gibt er außerdem denselben Satz von Matchern für den Typ dieser Eigenschaft zurück, sodass Sie Assertions aneinanderreihen können.

```ts
import { expectTypeOf } from 'vitest'

const obj = { a: 1, b: '' }

expectTypeOf(obj).toHaveProperty('a')
expectTypeOf(obj).not.toHaveProperty('c')

expectTypeOf(obj).toHaveProperty('a').toBeNumber()
expectTypeOf(obj).toHaveProperty('b').toBeString()
expectTypeOf(obj).toHaveProperty('a').not.toBeString()
```

## branded

- **Typ:** `ExpectTypeOf<BrandedType>`

Mit `.branded` können Sie erreichen, dass Typ-Assertions auch für Typen erfolgreich sind, die semantisch gleichwertig sind, sich in ihrer Darstellung aber unterscheiden.

```ts
import { expectTypeOf } from 'vitest'

// Without .branded, this fails even though the types are effectively the same
expectTypeOf<{ a: { b: 1 } & { c: 1 } }>().toEqualTypeOf<{ a: { b: 1; c: 1 } }>()

// With .branded, the assertion succeeds
expectTypeOf<{ a: { b: 1 } & { c: 1 } }>().branded.toEqualTypeOf<{ a: { b: 1; c: 1 } }>()
```

::: warning
Dieser Helfer geht mit Performance-Einbußen einher und kann dazu führen, dass der TypeScript-Compiler bei übermäßig tiefen Typen „aufgibt“. Setzen Sie ihn sparsam und nur bei Bedarf ein.
:::
