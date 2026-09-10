# Performance verbessern

## Zuerst profilieren

Die Zeile `Duration` der Zusammenfassung schlüsselt den Lauf in Phasen auf, jeweils als Prozentanteil der gesamten erfassten Zeit:

```
Duration  3.76s (environment 79%, import 13%, transform 6%, tests 1%, setup 1%)
```

Die Prozentwerte beziehen sich auf die Summe aller erfassten Phasen, nicht auf die Wanduhrzeit: Phasen laufen in parallelen Workern, sodass ihre Summe üblicherweise größer ist als der Lauf selbst. In einem Setup mit mehreren Projekten aggregieren die Prozentwerte über alle [Projekte](/guide/projects), sodass eine Phase, die ein Projekt dominiert, durch die übrigen verwässert werden kann; die Performance-Hinweise unten analysieren jedes Projekt einzeln.

Die Phasen entsprechen Konfigurationsoptionen:

- `environment` – Erzeugen der Testumgebung (etwa `jsdom`, `happy-dom`) für Testdateien. Siehe [Testumgebungen](#test-environments).
- `transform` – Warten darauf, dass Vite importierte Module auflöst und transformiert. Siehe [Caching zwischen Wiederholungsläufen](#caching-between-reruns).
- `import` – Auswerten der Testdateien und ihrer Module, ohne die oben erfasste Transform-Wartezeit. Wenn Dateien größtenteils dieselben Module importieren (typisch bei Barrel-File-Imports), wertet die Isolation diesen geteilten Graphen für jede Datei erneut aus. Siehe [Testisolation](#test-isolation).
- `setup` – Ausführen der [`setupFiles`](/config/setupfiles).
- `worker` – Vorbereiten des Test-Runners in jedem Worker. Bei Isolation fällt dieser Aufwand für jede Testdatei an. Siehe [Testisolation](#test-isolation).
- `tests` – Ausführen der Tests selbst. Ein Lauf, der von dieser Phase dominiert wird, gewinnt durch Konfigurationsänderungen wenig.

Wenn die erfassten Zeiten zeigen, dass eine Konfigurationsänderung den Lauf deutlich beschleunigen würde, gibt Vitest nach der Zusammenfassung zusätzlich einen Hinweis aus, siehe [`experimental.diagnostics`](/config/experimental#experimental-diagnostics). Hinweise schlagen nie vor, eine Option zu ändern, die explizit gesetzt wurde.

[`vitest doctor`](/guide/cli#vitest-doctor) misst die alternativen Konfigurationen, statt sie zu schätzen: Es führt die Suite unter jedem Kandidaten aus und berichtet den Vergleich, einschließlich der Frage, ob die Tests mit `isolate: false` bestehen.

## Testisolation

Standardmäßig führt Vitest jede Testdatei in einer isolierten Umgebung aus, abhängig vom [Pool](/config/pool):

- Der Pool `threads` führt jede Testdatei in einem eigenen [`Worker`](https://nodejs.org/api/worker_threads.html#class-worker) aus
- Der Pool `forks` führt jede Testdatei in einem eigenen [geforkten Kindprozess](https://nodejs.org/api/child_process.html#child_processforkmodulepath-args-options) aus
- Der Pool `vmThreads` führt jede Testdatei in einem eigenen [VM-Kontext](https://nodejs.org/api/vm.html#vmcreatecontextcontextobject-options) aus, nutzt für die Parallelität aber Worker

Das erhöht die Testlaufzeiten erheblich, was für Projekte, die nicht auf Seiteneffekte setzen und ihren Zustand ordentlich aufräumen (was bei Projekten mit `node`-Umgebung meist der Fall ist), unerwünscht sein kann. In diesem Fall verbessert das Deaktivieren der Isolation die Geschwindigkeit Ihrer Tests. Dazu können Sie das Flag `--no-isolate` an die CLI übergeben oder die Eigenschaft [`test.isolate`](/config/isolate) in der Konfiguration auf `false` setzen.

::: code-group
```bash [CLI]
vitest --no-isolate
```
```ts [vitest.config.js]
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    isolate: false,
  },
})
```
:::

Sie können die Isolation über `projects` auch nur für bestimmte Dateien deaktivieren:

```ts [vitest.config.js]
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'Isolated',
          isolate: true, // (default value)
          exclude: ['**.non-isolated.test.ts'],
        },
      },
      {
        test: {
          name: 'Non-isolated',
          isolate: false,
          include: ['**.non-isolated.test.ts'],
        },
      },
    ],
  },
})
```

:::tip
Wenn Sie den Pool `vmThreads` verwenden, können Sie die Isolation nicht deaktivieren. Nutzen Sie stattdessen den Pool `threads`, um die Performance Ihrer Tests zu verbessern.
:::

Bei manchen Projekten kann es außerdem sinnvoll sein, die Parallelität zu deaktivieren, um die Startzeit zu verbessern. Übergeben Sie dazu das Flag `--no-file-parallelism` an die CLI oder setzen Sie die Eigenschaft [`test.fileParallelism`](/config/fileparallelism) in der Konfiguration auf `false`.

::: code-group
```bash [CLI]
vitest --no-file-parallelism
```
```ts [vitest.config.js]
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    fileParallelism: false,
  },
})
```
:::

## Testumgebungen

DOM-Umgebungen sind teuer zu erzeugen: `jsdom` kostet grob 200–500 ms pro Import und `happy-dom` grob 90–200 ms, zuzüglich der Zeit für den Aufbau des Window-Objekts. Mit einem isolierenden Pool (dem Standard) fällt dieser Aufwand für jede Testdatei an, weil jede Datei einen frischen Worker bekommt. Bei DOM-lastigen Suites ist das oft der größte Kostenpunkt des Laufs; er erscheint als `environment`-Anteil in der `Duration`-Aufschlüsselung.

Drei Konfigurationen senken diesen Aufwand:

| Konfiguration | Umgebung erzeugt | Isolation | Kompromiss |
|---|---|---|---|
| `pool: 'forks'`/`'threads'` + `isolate: true` (Standard) | einmal pro Datei | frischer Prozess/Thread und frische Umgebung pro Datei | am sichersten, am langsamsten |
| `pool: 'vmThreads'` | einmal pro Worker | frischer VM-Kontext und frisches `window` pro Datei | Testcode läuft in einem VM-Realm: Grenzfälle bei realm-übergreifendem `instanceof` mit externalisierten Paketen, und Speicher wird weniger zuverlässig freigegeben (siehe [`vmMemoryLimit`](/config/vmmemorylimit)) |
| `isolate: false` | einmal pro Worker | keine – Dateien im selben Worker teilen sich Umgebung und Modulzustand | Tests dürfen nicht auf ein sauberes `window` oder einen sauberen Modulzustand angewiesen sein; prüfen Sie das mit `vitest doctor` |

```ts [vitest.config.js]
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'jsdom',
    pool: 'vmThreads', // environment per worker, fresh window per file
  },
})
```

Bevorzugen Sie `isolate: false` mit `threads`, wenn die Tests geteilten Zustand vertragen: Das ist die schnellste Option und hält das Speicherverhalten einfach. Nutzen Sie `vmThreads`, wenn jede Datei ein frisches `window` benötigt und die Umgebungskosten pro Datei den Lauf dominieren. `happy-dom` ist in jedem Setup günstiger zu erzeugen als `jsdom`.

## Verzeichnissuche einschränken

Mit der Option [`test.dir`](/config/dir) können Sie das Arbeitsverzeichnis einschränken, in dem Vitest nach Dateien sucht. Das sollte die Suche beschleunigen, wenn Sie im Wurzelverzeichnis nicht zugehörige Ordner und Dateien haben.

## Caching zwischen Wiederholungsläufen

Im Watch-Modus hält Vitest alle transformierten Dateien im Arbeitsspeicher vor, wodurch Wiederholungsläufe schnell sind. Dieser Cache wird jedoch verworfen, sobald der Testlauf endet. Wenn Sie [`fsModuleCache`](/config/fsmodulecache) aktivieren, schreibt Vitest diesen Cache ins Dateisystem, sodass er über Wiederholungsläufe hinweg wiederverwendet werden kann.

Diese Verbesserung ist am deutlichsten spürbar, wenn Sie wenige Tests erneut ausführen, die von einem großen Modulgraphen abhängen. Bei kompletten Testsuiten mildert die Parallelisierung die Kosten bereits ab, weil andere Tests den In-Memory-Cache füllen, während frühere Tests noch laufen. Beispiel für eine Testdatei mit riesigem Modulgraphen (>900 Module):

```shell
# the first run
Duration  8.75s (import 43%, transform 32%, tests 20%, setup 5%)

# the second run
Duration  5.90s (tests 44%, import 35%, transform 13%, setup 8%)
```

## Node-Compile-Cache

Vitest unterstützt Nodes [Compile-Cache auf der Festplatte](https://nodejs.org/api/cli.html#node_compile_cachedir): Zeigt die Umgebungsvariable `NODE_COMPILE_CACHE` auf ein Verzeichnis, wird der V8-Bytecode von Vitests eigenen Modulen und Ihren externalisierten Abhängigkeiten auf die Festplatte geschrieben und von späteren Läufen wiederverwendet, statt neu kompiliert zu werden. Vitest propagiert die Variable an jeden Worker, und Worker persistieren beim Herunterfahren die von ihnen kompilierten Module.

```shell
NODE_COMPILE_CACHE=node_modules/.cache/node-compile-cache vitest
```

Der erste Lauf mit einem leeren Verzeichnis zahlt für das Serialisieren der kompilierten Module, weshalb sich das nur lohnt, wenn das Verzeichnis zwischen Läufen erhalten bleibt: bei lokalen Läufen oder in CI-Pipelines, die das Verzeichnis cachen. `NODE_DISABLE_COMPILE_CACHE=1` deaktiviert den Cache vollständig und hat Vorrang vor `NODE_COMPILE_CACHE`.

Beachten Sie, dass Vitest den Compile-Cache in Workern automatisch deaktiviert, wenn der Coverage-Provider `v8` aktiviert ist — V8 serialisiert gecachte Skripte ohne die Quellcodepositionen, auf die eine präzise Coverage angewiesen ist.

## Pool

Standardmäßig führt Vitest Tests mit `pool: 'forks'` aus. Der Pool `'forks'` ist zwar besser bei Kompatibilitätsproblemen ([hängender Prozess](/guide/common-errors.html#failed-to-terminate-worker) und [Segfaults](/guide/common-errors.html#segfaults-and-native-code-errors)), kann in größeren Projekten aber etwas langsamer sein als `pool: 'threads'`.

Sie können versuchen, die Testlaufzeit zu verbessern, indem Sie die Option `pool` in der Konfiguration umstellen:

::: code-group
```bash [CLI]
vitest --pool=threads
```
```ts [vitest.config.js]
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    pool: 'threads',
  },
})
```
:::

## Sharding

Test-Sharding bezeichnet das Aufteilen Ihrer Testsuite in Gruppen, sogenannte Shards. Das kann nützlich sein, wenn Sie eine große Testsuite und mehrere Maschinen haben, die Teilmengen dieser Suite gleichzeitig ausführen können.

Um Vitest-Tests auf mehrere verschiedene Läufe aufzuteilen, verwenden Sie die Option [`--shard`](/guide/cli#shard) zusammen mit der Option [`--reporter=blob`](/guide/reporters#blob-reporter):

```sh
vitest run --reporter=blob --shard=1/3 # 1st machine
vitest run --reporter=blob --shard=2/3 # 2nd machine
vitest run --reporter=blob --shard=3/3 # 3rd machine
```

> Vitest teilt Ihre _Testdateien_ in Shards auf, nicht Ihre Testfälle. Wenn Sie 1000 Testdateien haben, führt die Option `--shard=1/4` 250 Testdateien aus, unabhängig davon, wie viele Testfälle die einzelnen Dateien enthalten.

Sammeln Sie die im Verzeichnis `.vitest/blob/` abgelegten Ergebnisse von jeder Maschine ein und führen Sie sie mit der Option [`--merge-reports`](/guide/cli#merge-reports) zusammen:

```sh
vitest run --merge-reports
```

Wenn Sie dieselben Shards in mehreren Umgebungen ausführen, setzen Sie die Umgebungsvariable `VITEST_BLOB_LABEL`, damit zusammengeführte Berichte sie getrennt darstellen können:

```sh
VITEST_BLOB_LABEL=linux vitest run --reporter=blob --shard=1/3
```

::: details Beispiel für GitHub Actions
Dieses Setup wird auch unter https://github.com/vitest-tests/test-sharding verwendet.

```yaml
# Inspired from https://playwright.dev/docs/test-sharding
name: Tests
on:
  push:
    branches:
      - main
jobs:
  tests:
    runs-on: ${{ matrix.os }}
    strategy:
      matrix:
        os: [ubuntu-latest, macos-latest]
        shardIndex: [1, 2, 3, 4]
        shardTotal: [4]
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 24

      - name: Install pnpm
        uses: pnpm/action-setup@a7487c7e89a18df4991f7f222e4898a00d66ddda # v4.1.0

      - name: Install dependencies
        run: pnpm i

      - name: Run tests
        run: pnpm run test --reporter=blob --shard=${{ matrix.shardIndex }}/${{ matrix.shardTotal }}
        env:
          VITEST_BLOB_LABEL: ${{ matrix.os }}

      - name: Upload Vitest results GitHub Actions Artifacts
        if: ${{ !cancelled() }}
        uses: actions/upload-artifact@v4
        with:
          name: vitest-results-${{ matrix.os }}-${{ matrix.shardIndex }}
          path: .vitest
          include-hidden-files: true
          retention-days: 1

  merge-reports:
    if: ${{ !cancelled() }}
    needs: [tests]

    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 24

      - name: Install pnpm
        uses: pnpm/action-setup@a7487c7e89a18df4991f7f222e4898a00d66ddda # v4.1.0

      - name: Install dependencies
        run: pnpm i

      - name: Download Vitest results from GitHub Actions Artifacts
        uses: actions/download-artifact@v4
        with:
          path: .vitest
          merge-multiple: true

      - name: Merge reports
        run: npx vitest --merge-reports
```

Wenn Ihre Tests dateibasierte Anhänge erzeugen (etwa über `context.annotate` oder eigene Artefakte), laden Sie [`attachmentsDir`](/config/attachmentsdir) wie oben gezeigt im Merge-Job hoch und stellen es dort wieder her.

:::

:::tip
Test-Sharding kann auch auf Maschinen mit vielen CPU-Kernen nützlich werden.

Vitest führt in seinem Hauptthread nur einen einzigen Vite-Server aus. Die übrigen Threads werden zum Ausführen der Testdateien genutzt.
Auf einer Maschine mit vielen CPU-Kernen kann der Hauptthread zum Engpass werden, weil er nicht alle Anfragen aus den Threads bedienen kann. Auf einer Maschine mit 32 CPUs muss der Hauptthread etwa die Last von 31 Test-Threads bewältigen.

Um die Last auf dem Vite-Server des Hauptthreads zu senken, können Sie Test-Sharding einsetzen. Die Last lässt sich so auf mehrere Vite-Server verteilen.

```sh
# Example for splitting tests on 32 CPU to 4 shards.
# As each process needs 1 main thread, there's 7 threads for test runners (1+7)*4 = 32
# Use VITEST_MAX_WORKERS:
VITEST_MAX_WORKERS=7 vitest run --reporter=blob --shard=1/4 & \
VITEST_MAX_WORKERS=7 vitest run --reporter=blob --shard=2/4 & \
VITEST_MAX_WORKERS=7 vitest run --reporter=blob --shard=3/4 & \
VITEST_MAX_WORKERS=7 vitest run --reporter=blob --shard=4/4 & \
wait # https://man7.org/linux/man-pages/man2/waitpid.2.html

vitest run --merge-reports
```

:::
