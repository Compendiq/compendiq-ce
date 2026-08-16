# Benchmarking

Vitest erlaubt es Ihnen, Benchmarks neben Ihren Tests zu schreiben, indem Sie die Fixture `bench` aus dem [Test-Kontext](/guide/test-context) verwenden. Der eingebaute Benchmark-Provider basiert auf [Tinybench](https://github.com/tinylibs/tinybench), und Benchmarks werden innerhalb gewöhnlicher `test()`-Aufrufe definiert, sodass Ihnen die volle Mächtigkeit von Vitests Test-Runner zur Verfügung steht: Retries, Lebenszyklus-Hooks, Filterung und Assertions.

## Einen Benchmark definieren

Verwenden Sie die Fixture `bench`, um einen Benchmark zu definieren. Rufen Sie `.run()` auf, um ihn auszuführen:

```ts
import { expect, test } from 'vitest'

test('parsing performance', async ({ bench }) => {
  const result = await bench('parse', () => {
    JSON.parse('{"key":"value"}')
  }).run()
})
```

Die Funktion `bench()` registriert einen Benchmark, ohne ihn auszuführen. Der Aufruf von `.run()` führt den Benchmark aus und gibt das Ergebnis zurück. Nach Abschluss des Tests gibt Vitest eine einzeilige Version der [Vergleichstabelle](#comparing-benchmarks) aus (ops/sec, mittlere Zeit, Perzentile usw.), sodass Sie für einen einzelnen Benchmark dieselbe Ausgabe erhalten wie für `bench.compare()`.

::: warning
Die Fixture `bench` ist nur in Dateien verfügbar, die von [`benchmark.include`](/config/benchmark#benchmark-include) erfasst werden (Standard: `**/*.{bench,benchmark}.?(c|m)[jt]s?(x)`). Die Verwendung von `{ bench }` in einer gewöhnlichen Testdatei wirft einen Fehler.

Ob eine Datei am Benchmark-Lauf teilnimmt, entscheidet der Dateiname, nicht die Frage, ob der Test die Fixture `bench` verwendet. Das Umbenennen von `parser.test.ts` in `parser.bench.ts` (oder das Anpassen von `benchmark.include`) ist das, was sie in das Benchmark-Projekt verschiebt.
:::

## Benchmarks ausführen

Benchmark-Dateien werden über [`benchmark.include`](/config/benchmark#benchmark-include) erfasst (Standard: `**/*.{bench,benchmark}.?(c|m)[jt]s?(x)`) und laufen in einem eigenen Projekt, getrennt von Ihren regulären Tests. Es gibt drei Wege, sie auszuführen, je nachdem, ob Sie sie überspringen, zusammen mit den Tests oder für sich allein ausführen wollen.

### `vitest` (Standard)

Ohne [`benchmark.enabled`](/config/benchmark#benchmark-enabled) führt der Befehl `vitest` nur reguläre Tests aus. Benchmark-Dateien werden vollständig ignoriert. Das ist der Standard und die richtige Wahl für die tägliche Entwicklung, da Benchmarks langsam und verrauscht sind und nicht bei jedem Speichern laufen sollten.

### `vitest` mit `benchmark.enabled`

Setzen Sie `benchmark.enabled: true` in Ihrer Konfiguration, um Benchmarks zusammen mit regulären Tests auszuführen:

```ts [vitest.config.ts]
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    benchmark: {
      enabled: true,
    },
  },
})
```

Mit dieser Konfiguration führt `vitest` zuerst Ihre regulären Tests aus und danach die Benchmarks in einer separaten, isolierten Gruppe (damit sich die Benchmark-Ausführung nie mit der Testausführung überlappt und Rauschen in die Ergebnisse bringt). Nützlich in der CI, wenn Sie mit einem einzigen Befehl Korrektheit und Performance prüfen wollen.

### `vitest bench`

Der Unterbefehl `bench` führt nur Benchmarks aus und überspringt reguläre Tests:

```bash
vitest bench
```

Damit wird `benchmark.enabled` für diesen Lauf implizit aktiviert, sodass Sie es nicht in der Konfiguration setzen müssen. Wie der Befehl `vitest` akzeptiert er Dateinamensfilter und `-t`/`--testNamePattern`, um den Lauf einzugrenzen:

```bash
# only benchmarks in files matching "parser"
vitest bench parser

# only benchmarks whose test name matches "JSON"
vitest bench -t JSON
```

Um Benchmarks mit einer anderen Benchmarking-Engine oder Ausführungsstrategie laufen zu lassen, siehe den Guide [Custom Benchmark Provider](/guide/advanced/benchmark-provider).

## Benchmarks vergleichen

Verwenden Sie `bench.compare()`, um mehrere Benchmarks miteinander zu vergleichen:

```ts
import { expect, test } from 'vitest'

test('compare JSON libraries', async ({ bench }) => {
  const input = '{"key":"value","nested":{"a":1}}'

  const result = await bench.compare(
    bench('JSON.parse', () => {
      JSON.parse(input)
    }),
    bench('custom parser', () => {
      customParse(input)
    }),
  )
})
```

Beim Vergleichen von Benchmarks führt Vitest sie mit verschränkten Iterationen aus, um Umgebungseinflüsse zu verringern (CPU-Drosselung, GC-Druck usw.), und gibt nach Abschluss des Tests eine Vergleichstabelle aus:

<<< ./snippets/benchmark-table.ansi

### Optionen

Sie können [Optionen](https://tinylibs.github.io/tinybench/interfaces/BenchOptions.html) als letztes Argument an `bench.compare()` übergeben:

```ts
test('compare with options', async ({ bench }) => {
  const result = await bench.compare(
    bench('lib1', () => { lib1() }),
    bench('lib2', () => { lib2() }),
    {
      iterations: 100,
      time: 1000,
    },
  )
})
```

Sie können auch [Optionen](https://tinylibs.github.io/tinybench/interfaces/FnOptions.html) pro Benchmark als zweites Argument übergeben, passend dazu, wie `test()` Optionen entgegennimmt:

```ts
test('benchmarks with setup', async ({ bench }) => {
  const result = await bench.compare(
    bench('with-cache', () => {
      readFromCache()
    }),
    bench(
      'without-cache',
      { beforeEach: () => clearCache() },
      () => { readFromDisk() },
    ),
  )
})
```

## Projektübergreifend vergleichen

Wenn Ihr Workspace mehrere Projekte definiert (z. B. verschiedene Browser oder Laufzeitumgebungen), übergeben Sie `perProject: true` in den Bench-Optionen, um zu vergleichen, wie derselbe Benchmark in allen abschneidet. Vitest gibt das Ergebnis weiterhin inline für das aktuelle Projekt aus und sammelt zusätzlich die Ergebnisse pro Projekt am Ende des Testlaufs in einer einzigen Vergleichstabelle.

```ts
import { test } from 'vitest'

test('simple example', async ({ bench }) => {
  await bench('1 + 1', { perProject: true }, () => {
    1 + 1
  }).run()
})
```

Dieselbe Testdatei läuft in jedem Projekt (chromium, firefox, webkit usw.), und Vitest gruppiert die Ergebnisse:

<<< ./snippets/benchmark-per-project.ansi

Sie können `perProject`-Benchmarks innerhalb von `bench.compare()` auch mit gewöhnlichen mischen:

```ts
test('compare implementations across browsers', async ({ bench }) => {
  await bench.compare(
    bench('JSON.parse', { perProject: true }, () => {
      JSON.parse('{"key":"value"}')
    }),
    bench('custom parser', () => {
      customParse('{"key":"value"}')
    }),
  )
})
```

In diesem Fall erscheint `custom parser` in der normalen Inline-Vergleichstabelle pro Projekt, während `JSON.parse` zusätzlich in die projektübergreifende Vergleichstabelle am Ende aufgenommen wird.

## Performance zusichern

Verwenden Sie die Matcher `toBeFasterThan()` und `toBeSlowerThan()`, um relative Performance zwischen Benchmarks zuzusichern:

```ts
import { expect, test } from 'vitest'

test('lib1 is faster than lib2', async ({ bench }) => {
  const result = await bench.compare(
    bench('lib1', () => { lib1() }),
    bench('lib2', () => { lib2() }),
  )

  expect(result.get('lib1')).toBeFasterThan(result.get('lib2'))
})
```

Die Option `delta` gibt den minimalen relativen Unterschied an, der erforderlich ist, damit die Assertion besteht. Das hilft, instabile Tests durch Benchmark-Rauschen zu vermeiden:

```ts
// lib1 must be at least 10% faster than lib2
expect(result.get('lib1')).toBeFasterThan(result.get('lib2'), {
  delta: 0.1,
})

// lib2 must be at least 20% slower than lib1
expect(result.get('lib2')).toBeSlowerThan(result.get('lib1'), {
  delta: 0.2,
})
```

Sie können mit den Standard-Matchern auch absolute Performance zusichern:

```ts
test('parsing is fast enough', async ({ bench }) => {
  const result = await bench('parse', () => {
    parse(largeInput)
  }).run()

  expect(result.throughput.mean).toBeGreaterThan(10_000)
})
```

## Retries

Da Benchmarks verrauscht sein können, verwenden Sie die Option `retry`, um fehlschlagende Benchmark-Tests automatisch zu wiederholen:

```ts
test('performance comparison', { retry: 3 }, async ({ bench }) => {
  const result = await bench.compare(
    bench('lib1', () => { lib1() }),
    bench('lib2', () => { lib2() }),
  )

  expect(result.get('lib1')).toBeFasterThan(result.get('lib2'))
})
```

## Ergebnisse speichern und erneut verwenden

Zwei Primitive erlauben es Ihnen, Benchmark-Ergebnisse auf die Festplatte zu schreiben und in späteren Läufen dagegen zu vergleichen: Die Option `writeResult` speichert ein Ergebnis, und `bench.from()` liest es wieder ein.

### `writeResult`

Übergeben Sie `writeResult` als Option pro Bench, um das Ergebnis bei jedem Lauf des Benchmarks in eine JSON-Datei zu schreiben. Der Pfad wird relativ zum Projektwurzelverzeichnis aufgelöst:

```ts
test('parse', async ({ bench }) => {
  await bench(
    'parse',
    { writeResult: './benchmarks/parse.json' },
    () => parse(largeInput),
  ).run()
})
```

- Der Benchmark läuft immer. Es gibt kein Überspringen bei vorhandenem Cache und kein CLI-Flag; die Datei wird bei jedem erfolgreichen Lauf überschrieben.
- Wirft die Funktion einen Fehler, wird die Datei nicht geschrieben.
- Checken Sie diese Dateien zusammen mit Ihrem Code ein, damit Reviewer und CI dieselben Referenzpunkte teilen.

::: warning
Wenn Sie diese Dateien einchecken, denken Sie daran, dass Benchmark-Ergebnisse zwischen Umgebungen (Entwicklerrechner, CI-Runner, verschiedene Betriebssysteme) erheblich schwanken. Bestimmen Sie eine einzige Umgebung (typischerweise die CI) zum Erzeugen der Datei und vermeiden Sie es, sie lokal neu zu erzeugen.
:::

### `bench.from()`

`bench.from(name, source)` ist eine Registrierung, die keine Funktion ausführt. Sie liest ein zuvor gespeichertes Ergebnis und speist es in `bench.compare()` ein (oder gibt es direkt zurück, wenn Sie `.run()` aufrufen).

Die Quelle kann ein Pfad (relativ zum Projektwurzelverzeichnis) oder eine Funktion sein, die die Ergebnisdaten zurückgibt, einschließlich eines Promise:

```ts
test('compare against the stored baseline', async ({ bench }) => {
  const result = await bench.compare(
    bench(
      'current',
      { writeResult: './benchmarks/parse.json' },
      () => parse(largeInput),
    ),
    bench.from('previous', './benchmarks/parse.json'),
    bench.from('remote', () => fetch('https://path/to/external/file.json').then(r => r.json())),
  )

  expect(result.get('current')).toBeFasterThan(result.get('previous'))
})
```

Sie können historische Artefakte für ältere Versionen aufbewahren und mit der aktuellen Implementierung vergleichen. Da `bench.from()` die Funktion, die die Datei erzeugt hat, nie aufruft, kann der ursprüngliche Benchmark-Code gelöscht werden, sobald das Artefakt eingecheckt ist:

```ts
test('compare parser versions', async ({ bench }) => {
  const input = '{"key":"value"}'

  await bench.compare(
    bench.from('v1', './benchmarks/parse.v1.json'),
    bench.from('v2', './benchmarks/parse.v2.json'),
    bench(
      'current',
      { writeResult: './benchmarks/parse.current.json' },
      () => customParser(input),
    ),
  )
})
```

Um ein neues historisches Artefakt zu erzeugen, richten Sie ein frisches `bench()` auf die Implementierung dieser Version, setzen `writeResult` auf einen versionierten Pfad (`./benchmarks/parse.v3.json`), führen es einmal aus und ersetzen den Aufruf dann durch `bench.from('v3', './benchmarks/parse.v3.json')`.

Um die Baseline bei Bedarf neu zu erzeugen, machen Sie das Schreiben von einer Umgebungsvariablen abhängig, sodass derselbe Test entweder das Artefakt auffrischt oder dagegen vergleicht:

```ts
test('compare parser versions', async ({ bench }) => {
  if (import.meta.env.VITE_WRITE_BENCH) {
    const baseline = bench('baseline', { writeResult: './my-bench.json' }, () => fn())
    await baseline.run()
  }
  else {
    const baseline = bench.from('baseline', './my-bench.json')
    await bench.compare(bench('current', () => fn()), baseline)
  }
})
```

Führen Sie `VITE_WRITE_BENCH=1 vitest bench` aus, um das gespeicherte Ergebnis aufzufrischen, und `vitest bench`, um die aktuelle Implementierung dagegen zu vergleichen.

### Artefakte pro Projekt

Teilen Sie in einem Workspace mit mehreren Projekten (verschiedene Browser, verschiedene Laufzeitumgebungen) eine Benchmark-Datei projektübergreifend, indem Sie `${projectName}` in den Pfad aufnehmen. Der Platzhalter wird beim Schreiben durch den aktuellen Projektnamen ersetzt:

```ts
test('cross-project baseline', async ({ bench }) => {
  await bench(
    'parse',
    // eslint-disable-next-line no-template-curly-in-string
    { perProject: true, writeResult: './benchmarks/parse.${projectName}.json' },
    () => parse(largeInput),
  ).run()
})
```

Verwenden Sie dieselbe Vorlage in `bench.from()`, damit jedes Projekt sein eigenes Artefakt liest.

## Stabilität

Benchmarks sind von Natur aus instabil: CPU-Last, thermische Drosselung, GC-Druck und Hintergrundprozesse beeinflussen alle die Ergebnisse. Vitest unternimmt mehrere Schritte, um dieses Rauschen zu minimieren:

- **Separates Projekt**: Benchmark-Dateien werden anhand des Musters [`benchmark.include`](/config/benchmark#benchmark-include) in einem eigenen Projekt zusammengefasst. Die Fixture `bench` wird nur in Dateien bereitgestellt, die auf dieses Muster passen. Ihre Verwendung in einer gewöhnlichen Testdatei wirft einen Fehler.
- **Keine Nebenläufigkeit**: Tests innerhalb einer Benchmark-Datei laufen immer sequenziell. Auch die Benchmark-Dateien selbst laufen eine nach der anderen, nie parallel. Das verhindert, dass Benchmarks sich gegenseitig stören.

Zur weiteren Verbesserung der Stabilität:

- Verwenden Sie die Option [`retry`](#retries), um instabile Benchmark-Assertions automatisch erneut auszuführen.
- Verwenden Sie die Option [`delta`](#asserting-performance) in `toBeFasterThan` / `toBeSlowerThan`, um akzeptable Schwankungen zuzulassen.
- Vermeiden Sie es, Benchmarks parallel zu CPU-intensiven Prozessen laufen zu lassen.
- Schließen Sie Browser, IDEs und andere Anwendungen, die um CPU-Zeit konkurrieren.

### Dead Code Elimination

JavaScript-Engines können Code wegoptimieren, der keine beobachtbaren Seiteneffekte hat. Wenn Ihre Benchmark-Funktion ihr Ergebnis nicht verwendet, überspringt die Engine die Berechnung womöglich vollständig und erzeugt irreführend schnelle Zahlen:

```ts
test('parsing', async ({ bench }) => {
  // BAD: the engine may eliminate the work
  await bench('parse', () => {
    JSON.parse(input)
  }).run()

  // GOOD: the result is consumed
  await bench('parse', () => {
    const result = JSON.parse(input)
    doSomething(result)
  }).run()
})
```

Das gilt für alle Engines (V8, JavaScriptCore, SpiderMonkey), ist aber in V8s TurboFan und den FTL-Compilerstufen von JavaScriptCore besonders aggressiv.

### Overhead des Module Runners

Standardmäßig führt Vitest Tests in Node.js mit Vites Module Runner aus (konfiguriert über [`experimental.viteModuleRunner`](/config/experimental#experimental-vitemodulerunner)). Dieser wandelt alle Modul-Exporte in Getter um, sodass jeder Zugriff auf ein importiertes Binding über etwas wie `__vite_ssr_module__.value` läuft. In gewöhnlichen Tests ist dieser Overhead vernachlässigbar, aber in Benchmarks, in denen eine Funktion millionenfach aufgerufen wird, kann der Getter-Aufruf selbst die Messung dominieren.

Vitest gibt eine Warnung aus, wenn es übermäßig viele Getter-Aufrufe erkennt (die Sie über [`benchmark.suppressExportGetterWarnings`](/config/benchmark#benchmark-suppressexportgetterwarnings) unterdrücken können), aber Sie sollten sich dessen beim Benchmarking importierter Funktionen bewusst sein:

```ts
import { parse } from './parser.js'

const _parse = parse

test('parsing', async ({ bench }) => {
  // BAD: every call to `parse` goes through a getter
  await bench('parse', () => {
    parse(input)
  }).run()

  // GOOD: store the reference locally to bypass the getter
  await bench('parse', () => {
    _parse(input)
  }).run()
})
```

Wenn Sie der Autor der Bibliothek sind, gilt derselbe Overhead innerhalb der Bibliothek, die Sie benchmarken: Jeder modulübergreifende Aufruf innerhalb ihres Quellcodes läuft durch dieselbe Getter-Hülle. Wenn Sie Ihre eigene Bibliothek benchmarken, haben Sie zwei Möglichkeiten, das zu beseitigen:

**Benchmarken Sie das fertig gebaute Artefakt.** Importieren Sie die Bibliothek über ihren Paketnamen (der auf ihre Build-Ausgabe auflöst), statt in ihren Quellcode hineinzugreifen. Die gebaute Datei hat interne Importe bereits zu direkten Referenzen zusammengeführt, sodass Vites Module Runner ein einziges Modul ohne interne Getter sieht:

```ts
// BAD: every internal call inside the library goes through a getter
import { parse } from '../src/index.ts'

// GOOD: the published entry has no internal getters
import { parse } from 'my-library'
```

Wenn Sie Ihre Bibliothek mit anderen Paketen vergleichen, benchmarken Sie für jede Implementierung dieselbe Art von Artefakt. Bei Workspace-Paketen stellen Sie sicher, dass der Paketname auf die Build-Ausgabe statt auf den Quellcode auflöst, zum Beispiel indem Sie das Paket in Vite externalisieren oder aus `dist` importieren.

**Deaktivieren Sie den Module Runner für den Benchmark.** Wenn der Benchmark keine Vite-Transformationen, Mocks oder Vitests Modul-Interception benötigt, deaktivieren Sie [`experimental.viteModuleRunner`](/config/experimental#experimental-vitemodulerunner) für das Benchmark-Projekt, damit Node natives ESM direkt ausführt.

Das betrifft nur den Node.js-Modus. Der Browser-Modus verwendet native ESM-Importe und hat diesen Overhead nicht.

### Engine-spezifische Überlegungen

#### V8 (Node.js, Chrome)

- **JIT-Stufen**: V8 kompiliert Funktionen über mehrere Optimierungsstufen (Sparkplug → Maglev → TurboFan). Eine Funktion kann während des Aufwärmens anders schnell laufen als im eingeschwungenen Zustand. Tinybench übernimmt das Aufwärmen automatisch, aber sehr kurze Benchmark-Läufe erreichen möglicherweise nicht die höchste Optimierungsstufe.
- **Deoptimierung**: V8 kann mitten im Benchmark aus optimiertem Code "aussteigen", wenn es auf unerwartete Typen oder Objektformen trifft. Halten Sie die Typen in Ihrer Benchmark-Funktion konsistent:

  ```ts
  test('process items', async ({ bench }) => {
    // BAD: mixed shapes cause deoptimization
    await bench('process', () => {
      for (const item of items) {
        // some items have { name: string }, others have { name: string, id: number }
        process(item)
      }
    }).run()

    // GOOD: consistent object shapes
    await bench('process', () => {
      for (const item of items) {
        // all items have the same shape { name: string, id: number }
        process(item)
      }
    }).run()
  })
  ```

- **Garbage Collection**: Große Allokationen innerhalb der Benchmark-Schleife erzeugen GC-Rauschen. Wenn Sie Berechnungen messen, allokieren Sie die Daten vorab in einem `setup`-Hook statt innerhalb der gemessenen Funktion:

  ```ts
  test('sorting', async ({ bench }) => {
    const original = Array.from({ length: 10000 }, () => Math.random())
    let data: number[]

    // BAD: allocates a new array every iteration, GC adds noise
    await bench('sort', () => {
      const data = Array.from({ length: 10000 }, () => Math.random())
      data.sort()
    }).run()

    // GOOD: pre-allocate, copy in beforeEach
    await bench(
      'sort',
      () => { data.sort() },
      {
        beforeEach() {
          data = [...original]
        },
      },
    ).run()
  })
  ```

#### JavaScriptCore (Bun, Safari)

- **Andere Optimierungsschwellen**: JSC verwendet eigene JIT-Stufen (LLInt → Baseline → DFG → FTL) mit anderen Heuristiken für Inlining und Optimierung. Ein Benchmark, der auf V8 schnell ist, kann sich auf JSC ganz anders verhalten.
- **Asynchrone Benchmarks**: Buns Implementierung der Event-Loop unterscheidet sich von Node.js. Wenn Ihr Benchmark asynchrone Operationen oder Timer umfasst, sind die Ergebnisse zwischen Laufzeitumgebungen möglicherweise nicht direkt vergleichbar.

#### Browser

- **Timer-Auflösung**: Browser können die Präzision von `performance.now()` als Sicherheitsmaßnahme verringern (z. B. auf 100 μs oder sogar 1 ms). Das macht sehr schnelle Operationen schwer genau messbar; erhöhen Sie daher die Zahl der Iterationen zum Ausgleich:

  ```ts
  test('fast operations', async ({ bench }) => {
    await bench.compare(
      bench('fast-op', () => { fastOp() }),
      bench('other-op', () => { otherOp() }),
      {
        // more iterations help overcome low timer resolution
        iterations: 1000,
      },
    )
  })
  ```
- **Unterschiede zwischen Browsern**: V8 (Chrome), SpiderMonkey (Firefox) und JSC (Safari) optimieren unterschiedliche Muster unterschiedlich. Ein Benchmark, in dem eine Bibliothek in Chrome gewinnt, kann in Firefox das Gegenteil zeigen.
