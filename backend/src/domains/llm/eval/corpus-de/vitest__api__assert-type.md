# assertType

::: warning
Zur Laufzeit tut diese Funktion nichts. Um die [Typprüfung zu aktivieren](/guide/testing-types#run-typechecking), vergiss nicht, das Flag `--typecheck` zu übergeben.
:::

- **Typ:** `<T>(value: T): void`

Du kannst diese Funktion als Alternative zu [`expectTypeOf`](/api/expect-typeof) verwenden, um bequem zu prüfen, dass der Argumenttyp dem angegebenen Generic entspricht.

```ts
import { assertType } from 'vitest'

function concat(a: string, b: string): string
function concat(a: number, b: number): number
function concat(a: string | number, b: string | number): string | number

assertType<string>(concat('a', 'b'))
assertType<number>(concat(1, 2))
// @ts-expect-error wrong types
assertType(concat('a', 2))
```
