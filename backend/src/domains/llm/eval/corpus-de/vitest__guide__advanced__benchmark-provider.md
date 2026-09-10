# Eigener Benchmark-Provider <Version type="experimental">5.0.0</Version> <Badge type="danger">advanced</Badge> {#custom-benchmark-provider}

::: warning
Dies ist eine fortgeschrittene, experimentelle API. Wenn Sie lediglich Benchmarks mit dem eingebauten Provider von Vitest ausführen möchten, lesen Sie stattdessen den Leitfaden [Benchmarking](/guide/benchmarking).
:::

Vitest verwendet einen Benchmark-Provider, um die mit `bench` registrierten Funktionen auszuführen und ihre Messwerte in Ergebnisse zu überführen, die Vitest berichten kann. Der eingebaute Provider nutzt [Tinybench](https://github.com/tinylibs/tinybench), Sie können ihn jedoch ersetzen, um eine andere Benchmarking-Engine oder Ausführungsstrategie zu verwenden.

## Einrichtung

Setzen Sie [`benchmark.provider`](/config/benchmark#benchmark-provider) auf den Pfad Ihres Provider-Moduls. Relative Pfade werden vom Projekt-Root aus aufgelöst.

```ts [vitest.config.ts]
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    benchmark: {
      provider: './benchmark-provider.ts',
    },
  },
})
```

Das Modul muss einen Default-Export mit einem Objekt besitzen, das `BenchmarkProvider` implementiert. Dieses Beispiel umhüllt Tinybench, um zu zeigen, wie Registrierungen und Ergebnisse durch einen Provider fließen. Wenn Sie Tinybench in Ihrem Provider verwenden, fügen Sie es als direkte Abhängigkeit Ihres Projekts hinzu.

```ts [benchmark-provider.ts]
import type { BenchmarkProvider } from 'vitest'
import { Bench } from 'tinybench'

const provider = {
  async run({ test, config, registrations, options }) {
    const bench = new Bench({
      signal: test.context.signal,
      retainSamples: config.retainSamples,
      ...options,
    })

    for (const { name, fn, fnOpts } of registrations) {
      bench.add(name, fn, fnOpts)
    }

    await bench.run()

    return bench.tasks.map((task) => {
      const result = task.result

      if (result.state === 'errored') {
        throw result.error
      }
      if (result.state !== 'completed') {
        throw new Error(`Benchmark "${task.name}" ended in the "${result.state}" state`)
      }

      return {
        ...result,
        name: task.name,
      }
    })
  },
} satisfies BenchmarkProvider

export default provider
```

## Provider-API

Vitest ruft `provider.run(group)` auf, wenn die Methode `.run()` einer Registrierung aufgerufen wird, oder einmal für alle lauffähigen Registrierungen, die an `bench.compare()` übergeben werden. Die `group` enthält:

- `test`: den Test, der die Benchmarks registriert hat. `test.context.signal` wird abgebrochen, wenn der Lauf abgebrochen wird.
- `config`: die aufgelöste Benchmark-Konfiguration für das aktuelle Projekt.
- `registrations`: lauffähige Benchmarks in der Reihenfolge ihrer Registrierung. Jede Registrierung enthält `name`, `fn` sowie optional `fnOpts` für Lifecycle-Hooks, Abbruch, asynchrones Verhalten und das Aufbewahren von Stichproben.
- `options`: gegebenenfalls die Optionen des Benchmark-Laufs, die an `.run()` oder `bench.compare()` übergeben wurden.

Der Provider ist dafür verantwortlich, die Optionen des Laufs und der Registrierungen zu beachten sowie jede Benchmark-Funktion und deren Hooks `beforeAll`, `beforeEach`, `afterEach` und `afterAll` gemäß dem Lebenszyklus der Benchmarking-Engine auszuführen. Schlägt die Ausführung fehl, werfen Sie den Fehler, damit der Test fehlschlägt.

`run` muss zu genau einem `BenchResult` pro lauffähiger Registrierung auflösen. Ergebnisse werden den Registrierungen über `name` zugeordnet und sind die Grundlage für die Rückgabewerte von `.run()`, für Vergleichstabellen, Reporter und gespeicherte Benchmark-Ergebnisse. Eine eigene Engine muss ihre Messwerte in die von `vitest` exportierte, Tinybench-kompatible `BenchResult`-Struktur überführen.

Registrierungen, die mit `bench.from()` erstellt wurden, werden von Vitest geladen und nicht an den Provider übergeben.

## Lebensdauer des Providers

Vitest importiert das Provider-Modul bei der ersten Verwendung und hält dessen Default-Export für die Lebensdauer des Workers im Cache. Die API besitzt keine separaten Setup- oder Teardown-Hooks; halten Sie worker-bezogenen Zustand bei Bedarf auf dem Provider-Objekt.
