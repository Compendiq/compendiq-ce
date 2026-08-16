# Tests filtern

Wenn Ihre Test-Suite wächst, wird es langsam und störend, bei jeder Änderung sämtliche Tests auszuführen. Wenn Sie einen Fehler in einem einzelnen Modul beheben, müssen Sie nicht warten, bis Hunderte nicht zusammenhängender Tests fertig sind. Mit Testfiltern grenzen Sie ein, welche Tests laufen, sodass Sie sich auf den Code konzentrieren können, an dem Sie gerade arbeiten.

Vitest bietet mehrere Möglichkeiten, Tests zu filtern: über die Kommandozeile, innerhalb Ihrer Testdateien und über Tags. Jeder Ansatz ist in unterschiedlichen Situationen nützlich.

::: tip Hinweis zur Performance
Filter wie `-t`, `--tags-filter`, `.only` und `.skip` werden *pro Testdatei* angewendet – Vitest muss jede Testdatei trotzdem ausführen, um herauszufinden, welche Tests passen. In einem großen Projekt summiert sich dieser Overhead, selbst wenn am Ende nur wenige Tests tatsächlich ausgeführt werden.

Um das zu vermeiden, geben Sie zusätzlich zum Filter immer einen Dateipfad an, damit Vitest nur die Dateien lädt, die Sie interessieren:

```bash
vitest utils.test.ts -t "handles empty input"
```

Alternativ können Sie das Flag [`--experimental.preParse`](/config/experimental#experimental-preparse) verwenden, das Testdateien parst, um Testnamen zu ermitteln, ohne sie vollständig auszuführen:

```bash
vitest --experimental.preParse -t "handles empty input"
```
:::

## Nach Dateiname filtern

Der einfachste Weg, eine Teilmenge der Tests auszuführen, ist die Übergabe eines Dateinamensmusters als CLI-Argument. Vitest führt dann nur Testdateien aus, deren Pfad die angegebene Zeichenkette enthält:

```bash
vitest basic
```

Das trifft auf jede Testdatei zu, die `basic` in ihrem Pfad enthält:

```
basic.test.ts
basic-foo.test.ts
basic/foo.test.ts
```

Das ist nützlich, wenn Sie wissen, an welcher Datei Sie arbeiten müssen, und alles andere überspringen wollen.

## Nach Testname filtern

Manchmal ist der Test, der Sie interessiert, in einer Datei mit vielen anderen Tests vergraben. Die Option `-t` (oder `--testNamePattern`) filtert nach dem Namen des Tests statt nach dem Dateinamen. Sie akzeptiert ein Regex-Muster und vergleicht es mit dem vollständigen Testnamen, also den Namen der umschließenden `describe`-Blöcke und dem Testnamen, verbunden mit `' > '` (zum Beispiel `math > adds`):

```bash
vitest -t "handles empty input"
```

Sie können das mit einem Dateifilter kombinieren, um die Auswahl weiter einzugrenzen:

```bash
vitest utils -t "handles empty input"
```

Damit werden nur Tests ausgeführt, deren Name auf `"handles empty input"` passt, und zwar in Dateien, die auf `utils` passen.

## Nach Zeilennummer filtern

Wenn Sie sich in Ihrem Editor einen bestimmten Test ansehen, wollen Sie oft einfach nur *diesen einen Test* ausführen. Sie können direkt auf eine Zeilennummer verweisen:

```bash
vitest basic/foo.test.ts:10
```

Vitest führt dann den Test aus, der Zeile 10 enthält. Dafür ist der vollständige Dateiname (relativ oder absolut) erforderlich:

```bash
vitest basic/foo.test.ts:10 # ✅
vitest ./basic/foo.test.ts:10 # ✅
vitest /users/project/basic/foo.test.ts:10 # ✅
vitest foo:10 # ❌ partial name won't work
vitest ./basic/foo:10 # ❌ missing file extension
```

Um mehrere bestimmte Tests auszuführen, trennen Sie sie durch Leerzeichen:

```bash
vitest basic/foo.test.ts:10 basic/foo.test.ts:25 # ✅
vitest basic/foo.test.ts:10-25 # ❌ ranges are not supported
```

## Nach Tags filtern

Bei größeren Projekten möchten Sie Tests vielleicht kategorisieren und nach Kategorie ausführen. Mit [Tags](/guide/test-tags) können Sie Tests kennzeichnen und anschließend über die CLI nach diesen Kennzeichnungen filtern:

```ts
test('renders a form', { tags: ['frontend'] }, () => {
  // ...
})

test('calls an external API', { tags: ['backend'] }, () => {
  // ...
})
```

```bash
vitest --tags-filter=frontend
```

Das ist besonders in CI-Pipelines hilfreich, wenn Sie Frontend- und Backend-Tests in getrennten Jobs ausführen oder langsame Integrationstests bei schnellen Prüfungen überspringen möchten.

## Mit `.only` auf bestimmte Tests fokussieren

Wenn Sie einen fehlschlagenden Test debuggen, wollen Sie nur diesen Test ausführen, ohne jedes Mal die CLI-Argumente anzupassen. Ein `.only` an einem Test oder einer Suite weist Vitest an, alles andere in der Datei zu überspringen:

```ts
import { describe, expect, it } from 'vitest'

describe.only('suite', () => {
  it('test', () => {
    // This runs because the suite is marked with .only
    expect(Math.sqrt(4)).toBe(2)
  })
})

describe('another suite', () => {
  it('skipped test', () => {
    // This does not run
    expect(Math.sqrt(4)).toBe(2)
  })

  it.only('focused test', () => {
    // This also runs because it is marked with .only
    expect(Math.sqrt(4)).toBe(2)
  })
})
```

Sie können `.only` sowohl auf `describe`-Blöcke als auch auf einzelne Tests anwenden. Sobald irgendein Test oder eine Suite in einer Datei mit `.only` markiert ist, werden alle nicht markierten Tests dieser Datei übersprungen.

::: warning
Denken Sie daran, `.only` vor dem Commit zu entfernen. Standardmäßig lässt Vitest den gesamten Testlauf fehlschlagen, wenn es in der CI (wenn `process.env.CI` gesetzt ist) auf `.only` stößt, damit Sie nicht versehentlich Tests in Ihrer Pipeline überspringen. Dieses Verhalten wird über die Option [`allowOnly`](/config/allowonly) gesteuert.

Um `.only` noch früher abzufangen, kann die ESLint-Regel [`no-focused-tests`](https://github.com/vitest-dev/eslint-plugin-vitest/blob/main/docs/rules/no-focused-tests.md) (auch in [oxlint](https://oxc.rs/docs/guide/usage/linter/rules/jest/no-focused-tests.html) verfügbar) es bereits im Editor markieren, bevor Sie committen.
:::

## Tests mit `.skip` überspringen

Das Gegenstück zu `.only` ist `.skip`. Verwenden Sie es, um einen Test oder eine Suite vorübergehend zu deaktivieren, ohne sie zu löschen. Übersprungene Tests erscheinen weiterhin im Bericht, damit Sie sie nicht vergessen:

```ts
import { describe, expect, it } from 'vitest'

describe.skip('skipped suite', () => {
  it('test', () => {
    // This entire suite is skipped
    expect(Math.sqrt(4)).toBe(2)
  })
})

describe('suite', () => {
  it.skip('skipped test', () => {
    // Just this one test is skipped
    expect(Math.sqrt(4)).toBe(2)
  })
})
```

Das ist nützlich, wenn ein Test instabil ist oder von einem externen Dienst abhängt, der vorübergehend nicht erreichbar ist. So bleibt der Test als Erinnerung erhalten, während der Rest der Suite nicht blockiert wird.

## Platzhalter-Tests mit `.todo`

Beim Planen neuer Funktionen wissen Sie vielleicht schon, welche Tests Sie brauchen, bevor Sie die eigentliche Implementierung schreiben. `.todo` markiert einen Test als geplant, aber noch nicht geschrieben. Er erscheint als Erinnerung im Bericht:

```ts
import { describe, it } from 'vitest'

describe.todo('unimplemented suite')

describe('suite', () => {
  it.todo('unimplemented test')
})
```

Anders als `.skip` hat ein `.todo`-Test keinen Testrumpf. Er ist reiner Platzhalter für künftige Arbeit.
