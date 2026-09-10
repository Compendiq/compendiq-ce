# TestSpecification

Die Klasse `TestSpecification` beschreibt, welches Modul als Test ausgeführt werden soll, und dessen Parameter.

Eine Specification kannst du nur erzeugen, indem du die Methode [`createSpecification`](/api/advanced/test-project#createspecification) auf einem Testprojekt aufrufst:

```ts
const specification = project.createSpecification(
  resolve('./example.test.ts'),
  {
    testLines: [20, 40],
    testNamePattern: /hello world/,
    testIds: ['1223128da3_0_0_0', '1223128da3_0_0'],
    testTagsFilter: ['frontend and backend'],
  } // optional test filters
)
```

`createSpecification` erwartet einen aufgelösten Modul-Identifier. Die Datei wird nicht automatisch aufgelöst und es wird nicht geprüft, ob sie im Dateisystem existiert.

## taskId

Der Identifier des [Testmoduls](/api/advanced/test-suite#id).

## project

Verweist auf das [`TestProject`](/api/advanced/test-project), zu dem das Testmodul gehört.

## moduleId

Die ID des Moduls im Modulgraphen von Vite. Üblicherweise ist das ein absoluter Dateipfad mit POSIX-Trennzeichen:

```ts
'C:/Users/Documents/project/example.test.ts' // ✅
'/Users/mac/project/example.test.ts' // ✅
'C:\\Users\\Documents\\project\\example.test.ts' // ❌
```

## testModule

Die Instanz von [`TestModule`](/api/advanced/test-module), die zur Specification gehört. Wurde der Test noch nicht eingereiht, ist dieser Wert `undefined`.

## pool {#pool}

Der [`pool`](/config/pool), in dem das Testmodul ausgeführt wird.

::: danger
Mit [`typecheck.enabled`](/config/typecheck#typecheck-enabled) ist es möglich, mehrere Pools in einem einzigen Testprojekt zu haben. Das bedeutet, dass es mehrere Specifications mit derselben `moduleId`, aber unterschiedlichem `pool` geben kann. In späteren Versionen wird das Projekt nur noch einen einzigen Pool unterstützen.
:::

## testLines

Dies ist ein Array von Zeilen im Quellcode, in denen die Testdateien definiert sind. Dieses Feld ist nur dann definiert, wenn die Methode `createSpecification` ein Array erhalten hat.

Beachte: Steht auf mindestens einer der Zeilen kein Test, schlägt die gesamte Suite fehl. Ein Beispiel für eine korrekte `testLines`-Konfiguration:

::: code-group
```ts [script.js]
const specification = project.createSpecification(
  resolve('./example.test.ts'),
  [3, 8, 9],
)
```
```ts:line-numbers{3,8,9} [example.test.js]
import { test, describe } from 'vitest'

test('verification works')

describe('a group of tests', () => { // [!code error]
  // ...

  test('nested test')
  test.skip('skipped test')
})
```
:::

## testNamePattern <Version>4.1.0</Version> {#testnamepattern}

Eine Regexp, die auf den Namen des Tests in diesem Modul passt. Dieser Wert überschreibt die globale Option [`testNamePattern`](/config/testnamepattern), sofern diese gesetzt ist.

## testIds <Version>4.1.0</Version> {#testids}

Die IDs der Tasks innerhalb dieser Specification, die ausgeführt werden sollen.

## testTagsFilter <Version>4.1.0</Version> {#testtagsfilter}

Der [Tag-Filter](/guide/test-tags#syntax), den ein Test bestehen muss, um in den Lauf aufgenommen zu werden. Mehrere Filter werden als `AND` behandelt.

## toJSON

```ts
function toJSON(): SerializedTestSpecification
```

`toJSON` erzeugt ein JSON-freundliches Objekt, das vom [Browser Mode](/guide/browser/) oder von der [Vitest-UI](/guide/ui) verarbeitet werden kann.
