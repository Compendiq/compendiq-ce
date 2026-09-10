# Typen testen

::: tip Beispielprojekt

[GitHub](https://github.com/vitest-dev/vitest/tree/main/examples/typecheck) - [Play Online](https://stackblitz.com/fork/github/vitest-dev/vitest/tree/main/examples/typecheck?initialPath=__vitest__/)

:::

Vitest ermöglicht es dir, Tests für deine Typen zu schreiben – mit der Syntax von `expectTypeOf` oder `assertType`. Standardmäßig gelten alle Tests in `*.test-d.ts`-Dateien als Typtests, aber du kannst das mit der Konfigurationsoption [`typecheck.include`](/config/typecheck#typecheck-include) ändern.

Intern ruft Vitest je nach Konfiguration `tsc` oder `vue-tsc` auf und wertet die Ergebnisse aus. Vitest gibt außerdem Typfehler in deinem Quellcode aus, falls es welche findet. Du kannst das mit der Konfigurationsoption [`typecheck.ignoreSourceErrors`](/config/typecheck#typecheck-ignoresourceerrors) deaktivieren.

Denk daran, dass Vitest diese Dateien nicht ausführt; sie werden lediglich statisch vom Compiler analysiert. Das bedeutet: Wenn du einen dynamischen Namen oder `test.each` bzw. `test.for` verwendest, wird der Testname nicht ausgewertet – er wird unverändert angezeigt.

::: warning
Vor Vitest 2.1 hat dein `typecheck.include` das `include`-Muster überschrieben, sodass deine Laufzeittests gar nicht ausgeführt, sondern nur typgeprüft wurden.

Seit Vitest 2.1 meldet Vitest Typtests und Laufzeittests als separate Einträge, wenn sich `include` und `typecheck.include` überschneiden.
:::

CLI-Flags wie `--allowOnly` und `-t` werden für die Typprüfung ebenfalls unterstützt.

```ts [mount.test-d.ts]
import { assertType, expectTypeOf } from 'vitest'
import { mount } from './mount.js'

test('my types work properly', () => {
  expectTypeOf(mount).toBeFunction()
  expectTypeOf(mount).parameter(0).toExtend<{ name: string }>()

  // @ts-expect-error name is a string
  assertType(mount({ name: 42 }))
})
```

Jeder Typfehler, der innerhalb einer Testdatei ausgelöst wird, wird als Testfehler behandelt, sodass du jeden beliebigen Typ-Trick verwenden kannst, um die Typen deines Projekts zu testen.

Eine Liste möglicher Matcher findest du im [API-Abschnitt](/api/expect-typeof).

## Fehlermeldungen lesen

Wenn du die `expectTypeOf`-API verwendest, sieh dir die [expect-type-Dokumentation zu ihren Fehlermeldungen](https://github.com/mmkal/expect-type#error-messages) an.

Wenn Typen nicht übereinstimmen, verwenden `.toEqualTypeOf` und `.toExtend` einen speziellen Hilfstyp, um möglichst gut verwertbare Fehlermeldungen zu erzeugen. Es gibt dabei allerdings eine Feinheit zu verstehen. Da die Assertions „fluent“ geschrieben werden, muss der Fehler beim „expected“-Typ auftreten, nicht beim „actual“-Typ (`expect<Actual>().toEqualTypeOf<Expected>()`). Das führt dazu, dass Typfehler etwas verwirrend sein können – deshalb erzeugt diese Bibliothek einen `MismatchInfo`-Typ, um explizit zu machen, was erwartet wird. Zum Beispiel:

```ts
expectTypeOf({ a: 1 }).toEqualTypeOf<{ a: string }>()
```

Das ist eine Assertion, die fehlschlagen wird, da `{a: 1}` den Typ `{a: number}` hat und nicht `{a: string}`.  Die Fehlermeldung lautet in diesem Fall etwa so:

```
test/test.ts:999:999 - error TS2344: Type '{ a: string; }' does not satisfy the constraint '{ a: \\"Expected: string, Actual: number\\"; }'.
  Types of property 'a' are incompatible.
    Type 'string' is not assignable to type '\\"Expected: string, Actual: number\\"'.

999 expectTypeOf({a: 1}).toEqualTypeOf<{a: string}>()
```

Beachte, dass die gemeldete Typeinschränkung eine für Menschen lesbare Meldung ist, die sowohl den „expected“- als auch den „actual“-Typ nennt. Statt den Satz `Types of property 'a' are incompatible // Type 'string' is not assignable to type "Expected: string, Actual: number"` wörtlich zu nehmen, sieh dir einfach den Eigenschaftsnamen (`'a'`) und die Meldung an: `Expected: string, Actual: number`. Das sagt dir in den meisten Fällen, was falsch ist. Extrem komplexe Typen sind natürlich aufwendiger zu debuggen und erfordern womöglich etwas Experimentieren. Bitte [erstelle ein Issue](https://github.com/mmkal/expect-type), falls die Fehlermeldungen tatsächlich irreführend sind.

Die `toBe...`-Methoden (wie `toBeString`, `toBeNumber`, `toBeVoid` usw.) schlagen fehl, indem sie zu einem nicht aufrufbaren Typ aufgelöst werden, wenn der geprüfte `Actual`-Typ nicht passt. Zum Beispiel sieht der Fehlschlag einer Assertion wie `expectTypeOf(1).toBeString()` etwa so aus:

```
test/test.ts:999:999 - error TS2349: This expression is not callable.
  Type 'ExpectString<number>' has no call signatures.

999 expectTypeOf(1).toBeString()
                    ~~~~~~~~~~
```

Der Teil `This expression is not callable` ist nicht besonders hilfreich – die aussagekräftige Fehlermeldung ist die nächste Zeile: `Type 'ExpectString<number> has no call signatures`. Das bedeutet im Wesentlichen, dass du eine Zahl übergeben, aber behauptet hast, es solle ein String sein.

Wenn TypeScript Unterstützung für [„throw“-Typen](https://github.com/microsoft/TypeScript/pull/40468) hinzufügen würde, ließen sich diese Fehlermeldungen deutlich verbessern. Bis dahin erfordern sie ein gewisses Maß an Zusammenkneifen der Augen.

### Konkrete „expected“-Objekte vs. Typargumente

Fehlermeldungen für eine Assertion wie diese:

```ts
expectTypeOf({ a: 1 }).toEqualTypeOf({ a: '' })
```

werden weniger hilfreich sein als die für eine Assertion wie diese:

```ts
expectTypeOf({ a: 1 }).toEqualTypeOf<{ a: string }>()
```

Der Grund ist, dass der TypeScript-Compiler bei der Schreibweise `.toEqualTypeOf({a: ''})` das Typargument herleiten muss und diese Bibliothek es nur als Fehlschlag markieren kann, indem sie es mit einem generischen `Mismatch`-Typ vergleicht. Verwende daher, wo immer möglich, ein Typargument statt eines konkreten Typs für `.toEqualTypeOf` und `.toExtend`. Wenn es deutlich bequemer ist, zwei konkrete Typen zu vergleichen, kannst du `typeof` verwenden:

```ts
const one = valueFromFunctionOne({ some: { complex: inputs } })
const two = valueFromFunctionTwo({ some: { other: inputs } })

expectTypeOf(one).toEqualTypeOf<typeof two>()
```

Wenn dir der Umgang mit der `expectTypeOf`-API und das Deuten von Fehlern schwerfällt, kannst du jederzeit die einfachere `assertType`-API verwenden:

```ts
const answer = 42

assertType<number>(answer)
// @ts-expect-error answer is not a string
assertType<string>(answer)
```

::: tip
Wenn du die `@ts-expect-error`-Syntax verwendest, solltest du sicherstellen, dass dir kein Tippfehler unterlaufen ist. Das gelingt dir, indem du deine Typdateien in die Konfigurationsoption [`test.include`](/config/include) aufnimmst, sodass Vitest diese Tests auch tatsächlich *ausführt* und mit einem `ReferenceError` fehlschlägt.

Folgendes wird durchgehen, weil ein Fehler erwartet wird, aber das Wort „answer“ enthält einen Tippfehler, sodass es sich um einen falsch-positiven Fehler handelt:

```ts
// @ts-expect-error answer is not a string
assertType<string>(answr)
```
:::

## Typprüfung ausführen

Um die Typprüfung zu aktivieren, füge einfach das Flag [`--typecheck`](/config/typecheck) zu deinem Vitest-Befehl in der `package.json` hinzu:

```json [package.json]
{
  "scripts": {
    "test": "vitest --typecheck"
  }
}
```

Jetzt kannst du die Typprüfung ausführen:

::: code-group
```bash [npm]
npm run test
```
```bash [yarn]
yarn test
```
```bash [pnpm]
pnpm run test
```
```bash [bun]
bun test
```
:::

Vitest verwendet je nach Konfiguration `tsc --noEmit` oder `vue-tsc --noEmit`, sodass du diese Skripte aus deiner Pipeline entfernen kannst.
