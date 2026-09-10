# Tests schreiben

Im Leitfaden [Erste Schritte](/guide/) hast du Vitest installiert und deinen ersten Test ausgeführt. Diese Seite geht genauer darauf ein, wie du Tests in Vitest schreibst und organisierst.

## Dein erster Test

Ein Test prüft, ob ein Stück Code das erwartete Ergebnis liefert. In Vitest definierst du einen Test mit der Funktion [`test`](/api/test) und formulierst Assertions mit [`expect`](/api/expect). Jeder Test hat einen Namen (eine Zeichenkette, die beschreibt, was er prüft) und eine Funktion, die eine oder mehrere Assertions enthält. Schlägt eine Assertion fehl, schlägt der Test fehl.

```js
import { expect, test } from 'vitest'

test('Math.sqrt works for perfect squares', () => {
  expect(Math.sqrt(4)).toBe(2)
  expect(Math.sqrt(144)).toBe(12)
  expect(Math.sqrt(0)).toBe(0)
})
```

::: details `test` oder `it` verwenden?
Du wirst möglicherweise auch Tests sehen, die mit [`it`](/api/test) statt `test` geschrieben sind. Beide verhalten sich identisch. `it` ist lediglich ein Alias, den manche bevorzugen, weil er sich mit einem beschreibenden Namen natürlicher liest:

```js
import { expect, it } from 'vitest'

it('should compute square roots', () => {
  expect(Math.sqrt(4)).toBe(2)
})
```

Verwende, was dir lieber ist. Beide funktionieren gleich, und du kannst sie in einem Projekt frei mischen. Wenn du eine einheitliche Entscheidung in deiner Codebasis erzwingen möchtest, hilft die ESLint-Regel [`consistent-test-it`](https://github.com/vitest-dev/eslint-plugin-vitest/blob/main/docs/rules/consistent-test-it.md) (auch in [oxlint](https://oxc.rs/docs/guide/usage/linter/rules/jest/consistent-test-it.html) verfügbar).
:::

## Tests mit `describe` gruppieren

Wenn deine Testdateien wachsen, möchtest du verwandte Tests zusammen organisieren. [`describe`](/api/describe) erzeugt eine Test-Suite, also eine benannte Gruppe von Tests:

```js
import { describe, expect, test } from 'vitest'

describe('Math.sqrt', () => {
  test('returns the square root of perfect squares', () => {
    expect(Math.sqrt(4)).toBe(2)
    expect(Math.sqrt(9)).toBe(3)
  })

  test('returns NaN for negative numbers', () => {
    expect(Math.sqrt(-1)).toBeNaN()
  })

  test('returns 0 for 0', () => {
    expect(Math.sqrt(0)).toBe(0)
  })
})
```

Du kannst `describe`-Blöcke zur weiteren Strukturierung verschachteln, solltest die Verschachtelung aber flach halten. Tief verschachtelte Tests sind schwerer zu lesen. Für einfache Module reicht oft eine flache Liste von Tests, und `describe` wird vor allem dann nützlich, wenn eine Datei mehrere Funktionen oder Methoden testet, die jeweils eine eigene Gruppe brauchen.

## Testdateien

Standardmäßig sucht Vitest nach jeder Datei, die `.test.` oder `.spec.` im Namen enthält, etwa `utils.test.js`, `app.spec.js` oder `math.test.jsx`. Die Suche erfolgt in allen Unterverzeichnissen, es spielt also keine Rolle, wo du sie ablegst.

Die genauen Muster sind:

- `**/*.test.{ts,js,mjs,cjs,tsx,jsx}`
- `**/*.spec.{ts,js,mjs,cjs,tsx,jsx}`

Es gibt keinen einzig "richtigen" Weg, Testdateien zu organisieren. Manche Teams legen Tests direkt neben den getesteten Quellcode, andere halten sie in einem eigenen Verzeichnis. Vitest findet sie in beiden Fällen:

```
src/
  utils.js
  utils.test.js       # co-located with the source
  __tests__/
    utils.test.js      # in a test directory
```

Wenn die Standardmuster für dein Projekt nicht passen, kannst du mit den Konfigurationsoptionen [`include`](/config/include) und [`exclude`](/config/exclude) anpassen, welche Dateien einbezogen werden.

## TypeScript testen

Da Vitest auf Vite aufsetzt, funktioniert TypeScript ohne Zusatzaufwand. Es gibt keinen weiteren Compiler zu installieren, kein `ts-jest` zu konfigurieren und keinen separaten Build-Schritt für deine Tests. Benenne deine Testdatei einfach `.test.ts` statt `.test.js` und leg los:

```ts
import { expect, test } from 'vitest'

interface User {
  name: string
  age: number
}

function createUser(name: string, age: number): User {
  return { name, age }
}

test('creates a user with the correct fields', () => {
  const user = createUser('Alice', 30)

  expect(user).toEqual({ name: 'Alice', age: 30 })
  expect(user.name).toBe('Alice')
})
```

Du kannst deine Produktionstypen importieren, Generics verwenden und typisierte Test-Utilities schreiben, genau wie im Rest deiner Codebasis. Vite transformiert TypeScript im laufenden Betrieb, sodass Tests selbst in großen Projekten schnell starten.

::: tip
Vitest transformiert TypeScript für die Ausführung, führt während des Testlaufs aber **keine** Typprüfung deiner Tests durch. Das ist dieselbe Abwägung, die Vite zugunsten der Geschwindigkeit trifft: Du bekommst schnelles Feedback im Terminal und führst `tsc` oder `vitest typecheck` separat aus, wenn du eine vollständige Typprüfung möchtest. Weitere Details findest du im Leitfaden [Typen testen](/guide/testing-types).
:::

## Die Testausgabe lesen

Wenn du `vitest` ausführst und nur eine einzige Testdatei passt, wird die Ausgabe zu einer Baumstruktur aufgeklappt, die `describe`-Gruppen und einzelne Tests samt ihrer Dauer zeigt:

<<< ./snippets/test-output-single.ansi

Laufen mehrere Testdateien, klappt Vitest jede Datei auf eine einzelne Zeile zusammen, damit die Ausgabe überschaubar bleibt:

<<< ./snippets/test-output-multiple.ansi

Wenn ein Test fehlschlägt, zeigt dir Vitest genau, was schiefgelaufen ist. Du siehst den erwarteten Wert, den tatsächlichen Wert, einen Diff, der den Unterschied hervorhebt, und einen Code-Ausschnitt der umliegenden Zeilen mit der fehlgeschlagenen Assertion hervorgehoben. Außerdem werden Datei und Zeilennummer angegeben, sodass du direkt zur Quelle springen kannst:

<<< ./snippets/test-output-fail.ansi

Zwischen dem Diff und dem Code-Ausschnitt lässt sich meist verstehen, was schiefgelaufen ist, ohne zusätzliche `console.log`-Anweisungen einzufügen oder die Datei selbst zu öffnen.

## Tests überspringen und fokussieren

Während der Entwicklung möchtest du oft nur eine Teilmenge der Tests ausführen. Vitest stellt dafür Modifier bereit:

[`.only`](/api/test#only) weist Vitest an, nur diesen Test (oder diese Suite) auszuführen und alles andere in der Datei zu überspringen. Das ist nützlich, wenn du an einem bestimmten Test arbeitest und nicht auf den Durchlauf der gesamten Suite warten möchtest:

```js
test.only('focus on this test', () => {
  // only this test runs in the file
})
```

[`.skip`](/api/test#skip) macht das Gegenteil. Es überspringt einen Test, ohne ihn zu entfernen, was praktisch ist, wenn ein Test vorübergehend defekt ist oder du ihn ignorieren möchtest, während du an etwas anderem arbeitest:

```js
test.skip('not ready yet', () => {
  // this test is skipped
})
```

Mit [`.todo`](/api/test#todo) kannst du einen Platzhalter für einen noch nicht geschriebenen Test markieren. Vitest listet ihn in der Ausgabe auf, damit du ihn nicht vergisst:

```js
test.todo('implement validation later')
```

Diese Modifier eignen sich hervorragend für schnelle, lokale Änderungen während der Entwicklung. Dauerhaftere Wege, Tests zu filtern (nach Dateiname, Zeilennummer oder Tags), findest du im Leitfaden [Tests filtern](/guide/filtering).

## Parametrisierte Tests

Wenn du mehrere Testfälle hast, die sich nur in ihren Eingaben und erwarteten Ausgaben unterscheiden, wird es repetitiv, für jeden einzelnen ein eigenes `test` zu schreiben. Mit [`test.for`](/api/test#test-for) definierst du die Fälle als Daten und führst dieselbe Testlogik für alle aus:

```js
import { expect, test } from 'vitest'

test.for([
  [1, 1, 2],
  [1, 2, 3],
  [2, 1, 3],
])('add(%i, %i) -> %i', ([a, b, expected]) => {
  expect(a + b).toBe(expected)
})
```

Im obigen Beispiel werden die Platzhalter %i durch die Ganzzahlwerte aus jeder Datenzeile ersetzt. Vitest unterstützt auch andere Platzhaltertypen, etwa %s für Zeichenketten und %f für Gleitkommazahlen. Der Test-Runner erzeugt daraus Testnamen wie add(1, 1) -> 2, add(1, 2) -> 3 und add(2, 1) -> 3.

Wenn deine Fälle mehr als zwei oder drei Werte haben, ist die Übergabe von Objekten besser lesbar. Verwende `$property` im Namen, um Felder zu interpolieren:

```js
test.for([
  { a: 1, b: 1, expected: 2 },
  { a: 1, b: 2, expected: 3 },
  { a: 2, b: 1, expected: 3 },
])('add($a, $b) -> $expected', ({ a, b, expected }) => {
  expect(a + b).toBe(expected)
})
```

Das zweite Argument der Testfunktion ist der [Test-Kontext](/guide/test-context), der dir Zugriff auf Fixtures, ein testspezifisches `expect` und weitere Utilities gibt. Das ist besonders bei [`test.concurrent`](/api/test#concurrent) nützlich, wo nebenläufige Tests parallel laufen und das globale `expect` einen Snapshot nicht zuverlässig dem richtigen Test zuordnen kann. Das kontextgebundene `expect` löst das:

```js
test.concurrent.for([
  [1, 1],
  [1, 2],
  [2, 1],
])('add(%i, %i)', ([a, b], { expect }) => {
  expect(a + b).toMatchSnapshot()
})
```

[`describe.for`](/api/describe#describe-for) funktioniert genauso, erzeugt aber für jeden Parametersatz eine eigene Suite — nützlich, wenn sich mehrere Tests dasselbe parametrisierte Setup teilen.

::: tip
Vitest bietet außerdem [`test.each`](/api/test#each), das du vielleicht von Jest kennst. Es funktioniert ähnlich, spreizt Array-Argumente jedoch, statt sie als einen einzelnen Wert zu übergeben, und gibt keinen Zugriff auf den Test-Kontext. Es existiert hauptsächlich aus Kompatibilitätsgründen zu Jest. Bevorzuge in neuem Code `test.for`.
:::

## Globale Imports verwenden

Standardmäßig importierst du `test`, `expect`, `describe` und andere Funktionen am Anfang jeder Testdatei aus `vitest`. Wenn du sie lieber ohne Import als Globals verwenden möchtest (ähnlich wie bei Jest), kannst du in deiner Konfiguration die Option [`globals`](/config/globals) aktivieren:

```js [vitest.config.js]
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globals: true,
  },
})
```

Damit kannst du Tests ohne die Importzeile schreiben:

```js
test('no import needed', () => {
  expect(1 + 1).toBe(2)
})
```

::: tip
Wenn du TypeScript verwendest, füge `"types": ["vitest/globals"]` zu den `compilerOptions` deiner `tsconfig.json` hinzu, damit die Typunterstützung korrekt funktioniert.
:::

## Tests ausführen

Vitest führt alle Testdateien standardmäßig **parallel** aus und verwendet dafür [Kindprozesse](/config/pool). Jede Testdatei läuft in ihrem eigenen isolierten Kontext, sodass deine Testdateien keinen Zustand miteinander teilen. Das verhindert, dass sich Tests in verschiedenen Dateien versehentlich gegenseitig beeinflussen.

Tests **innerhalb** einer einzelnen Datei laufen standardmäßig sequenziell, was in der Regel gewünscht ist, da Tests in derselben Datei oft Setup-Code teilen. Wenn deine Tests wirklich unabhängig sind, kannst du sie mit [`test.concurrent`](/api/test#concurrent) nebenläufig ausführen lassen, um Zeit zu sparen. Weitere Details zur Steuerung der Testausführung findest du im Leitfaden [Parallelität](/guide/parallelism).
