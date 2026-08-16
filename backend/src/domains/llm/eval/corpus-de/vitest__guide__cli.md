# Kommandozeilenschnittstelle

## Befehle

### `vitest`

Startet Vitest im aktuellen Verzeichnis. Wechselt in der Entwicklungsumgebung automatisch in den Watch-Modus und in der CI (oder in einem nicht-interaktiven Terminal) in den Run-Modus.

Sie können ein zusätzliches Argument als Filter für die auszuführenden Testdateien übergeben. Zum Beispiel:

```bash
vitest foobar
```

Führt nur die Testdateien aus, die `foobar` in ihrem Pfad enthalten. Dieser Filter prüft ausschließlich auf Enthaltensein und unterstützt weder reguläre Ausdrücke noch Glob-Muster (es sei denn, Ihr Terminal verarbeitet sie, bevor Vitest den Filter erhält).

Seit Vitest 3 können Sie den Test auch über Dateinamen und Zeilennummer angeben:

```bash
$ vitest basic/foo.test.ts:10
```

::: warning
Beachten Sie, dass Vitest für dieses Feature den vollständigen Dateinamen benötigt. Er kann relativ zum aktuellen Arbeitsverzeichnis oder ein absoluter Dateipfad sein.

```bash
$ vitest basic/foo.js:10 # ✅
$ vitest ./basic/foo.js:10 # ✅
$ vitest /users/project/basic/foo.js:10 # ✅
$ vitest foo:10 # ❌
$ vitest ./basic/foo:10 # ❌
```

Derzeit unterstützt Vitest außerdem keine Bereiche:

```bash
$ vitest basic/foo.test.ts:10, basic/foo.test.ts:25 # ✅
$ vitest basic/foo.test.ts:10-25 # ❌
```
:::

### `vitest run`

Führt einen einzelnen Durchlauf ohne Watch-Modus aus.

### `vitest watch`

Führt alle Test-Suites aus, beobachtet aber Änderungen und startet die Tests erneut, wenn sich etwas ändert. Entspricht dem Aufruf von `vitest` ohne Argument. Fällt in der CI oder wenn stdin kein TTY ist (nicht-interaktive Umgebung) auf `vitest run` zurück.

### `vitest dev`

Alias für `vitest watch`.

### `vitest related`

Führt nur Tests aus, die eine Liste von Quelldateien abdecken. Funktioniert mit statischen Importen (z. B. `import('./index.js')` oder `import index from './index.js`), nicht jedoch mit dynamischen (z. B. `import(filepath)`). Alle Dateien sollten relativ zum Wurzelverzeichnis angegeben werden.

Nützlich in Kombination mit [`lint-staged`](https://github.com/okonet/lint-staged) oder Ihrem CI-Setup.

```bash
vitest related /src/index.ts /src/hello-world.js
```

::: tip
Vergessen Sie nicht, dass Vitest standardmäßig mit aktiviertem Watch-Modus läuft. Wenn Sie Werkzeuge wie `lint-staged` verwenden, sollten Sie zusätzlich die Option `--run` übergeben, damit der Befehl regulär beendet werden kann.

```js [.lintstagedrc.js]
export default {
  '*.{js,ts}': 'vitest related --run',
}
```
:::

### `vitest bench`

Führt nur [Benchmark](/guide/features.html#benchmarking)-Tests aus, die Performance-Ergebnisse vergleichen.

### `vitest init`

`vitest init <name>` kann verwendet werden, um die Projektkonfiguration einzurichten. Derzeit wird nur der Wert [`browser`](/guide/browser/) unterstützt:

```bash
vitest init browser
```

### `vitest list`

Der Befehl `vitest list` übernimmt alle `vitest`-Optionen, um die Liste aller passenden Tests auszugeben. Dieser Befehl ignoriert die Option `reporters`. Standardmäßig gibt er die Namen aller Tests aus, die auf den Dateifilter und das Namensmuster passen:

```shell
vitest list filename.spec.ts -t="some-test"
```

```txt
describe > some-test
describe > some-test > test 1
describe > some-test > test 2
```

Sie können das Flag `--json` übergeben, um die Tests im JSON-Format auszugeben oder in einer separaten Datei zu speichern:

```bash
vitest list filename.spec.ts -t="some-test" --json=./file.json
```

Erhält das Flag `--json` keinen Wert, wird das JSON nach stdout ausgegeben.

Sie können außerdem das Flag `--filesOnly` übergeben, um nur die Testdateien auszugeben:

```bash
vitest list --filesOnly
```

```txt
tests/test1.test.ts
tests/test2.test.ts
```

Seit Vitest 4.1 können Sie `--static-parse` übergeben, um [Testdateien zu parsen](/api/advanced/vitest#parsespecifications), statt sie auszuführen, um die Tests zu sammeln. Vitest parst Testdateien mit begrenzter Nebenläufigkeit, standardmäßig `os.availableParallelism()`. Sie können das über die Option `--static-parse-concurrency` ändern.

### `vitest doctor`

`vitest doctor` misst, wie viel schneller die Test-Suite unter alternativen Konfigurationen laufen würde, indem sie unter jeder davon ausgeführt wird. Die Kandidaten werden anhand der aktuellen Konfiguration ausgewählt:

```bash
vitest doctor
```

```
Results (min of 3 runs each)

  baseline (pool: forks · isolate: true)  4.08s
  pool: 'threads'                         3.64s (-11%)
  pool: 'vmThreads'                       1.33s (-67%)
  isolate: false                          1.28s (-69%)

Recommendation: pool: 'vmThreads' (-67%)

  // vitest.config.ts
  import { defineConfig } from 'vitest/config'

  export default defineConfig({
    test: {
      pool: 'vmThreads', // measured -67% on this suite
    },
  })
```

Der Kandidat `isolate: false` wird zusätzlich validiert, indem die Suite zweimal mit gemischter Dateireihenfolge ausgeführt wird: Hängt irgendein Test von der Isolation ab, wird der Kandidat als fehlgeschlagen gemeldet statt empfohlen. Liegen mehrere Kandidaten nahe am schnellsten, bevorzugt doctor denjenigen, der die Isolation pro Datei erhält.

Doctor prüft außerdem niedrigere Werte für [`maxWorkers`](/config/maxworkers) auf Basis der siegreichen Konfiguration: Jeder Worker leitet seine Transform-Anfragen durch den einen Vite-Server im Main-Thread, sodass ab einer bestimmten Anzahl mehr Worker den Lauf verlangsamen statt beschleunigen. Ausgehend von der Hälfte der aktuellen Worker-Anzahl halbiert doctor weiter, solange die Suite mindestens 5 % schneller wird, und nimmt den siegreichen Wert in die Empfehlung auf.

Suites, die in einer DOM-Umgebung laufen, werden unter beiden vm-Pools gemessen, `vmThreads` und `vmForks`: Sie amortisieren die Kosten der Umgebungserzeugung, indem pro Worker eine Umgebung bestehen bleibt, während jede Datei dennoch einen frischen VM-Kontext erhält. `vmForks` verwendet Kindprozesse statt Worker-Threads: Jedes Kind bekommt seinen eigenen Heap und Garbage Collector, sodass je nach Suite jeder der beiden Pools schneller sein kann; `vmForks` ist die vm-Option für Suites, die nicht in Worker-Threads laufen können.

Projekte, die `jsdom` verwenden, werden zusätzlich mit `environment: 'happy-dom'` gemessen, sofern das Paket installiert ist. Der Austausch wird pro Projekt angewendet; Projekte mit anderen Umgebungen behalten diese. happy-dom implementiert das DOM anders als jsdom, daher sollten Tests, die von Layout oder Navigation abhängen, vor der Übernahme geprüft werden. Ist der [fs-Modulcache](/config/fsmodulecache) deaktiviert, misst doctor `fsModuleCache: true` nach einem ungemessenen Aufwärmlauf, der den Cache füllt, sodass die gemeldete Zeit dem entspricht, was wiederholte Läufe kosten.

Jede Messung führt die vollständige Suite aus, einschließlich Browser-Projekten: `isolate: false` wirkt sich auch auf den Browser-Modus aus. Kandidaten, die Browser-Projekte nicht beeinflussen können (`pool`, `environment`, der fs-Modulcache), werden allein anhand der node-seitigen Projekte ausgewählt.

Fehlgeschlagene Kandidaten werden mit einem Auszug ihrer Fehler gemeldet. Schlägt die Suite unter der aktuellen Konfiguration fehl, bricht doctor ab und zeigt die Fehler an: Es wird eine erfolgreiche Baseline zum Vergleich benötigt.

Kurze Suites werden mehrfach gemessen und die beste Zeit wird gemeldet, sodass der Vergleich einen warmen, eingeschwungenen Zustand widerspiegelt. Doctor führt die vollständige Suite mehrmals aus und benötigt daher ein Vielfaches der Zeit eines normalen Laufs. Die Kompromisse hinter jedem Kandidaten finden Sie unter [Performance verbessern](/guide/improving-performance).

Doctor misst und meldet die Baseline auch dann, wenn es keine Kandidaten zum Vergleich gibt. Konfigurationen auf einem `vm`-Pool werden zusätzlich mit `pool: 'threads'` und `isolate: false` verglichen, das ebenfalls Worker wiederverwendet, den Modulzustand aber zwischen Dateien teilt; eine Konfiguration, die bereits auf einem vm-Pool läuft, wird trotzdem unter dem jeweils anderen gemessen.

## Autovervollständigung in der Shell

Vitest bietet Shell-Autovervollständigung für Befehle, Optionen und Optionswerte, angetrieben von [`@bomb.sh/tab`](https://github.com/bombshell-dev/tab).

### Einrichtung

Für eine dauerhafte Einrichtung in zsh fügen Sie dies in Ihre `~/.zshrc` ein:

```bash
# Add to ~/.zshrc for permanent autocompletions (same can be done for other shells)
source <(vitest complete zsh)
```

### Integration mit Paketmanagern

`@bomb.sh/tab` integriert sich mit [Paketmanagern](https://github.com/bombshell-dev/tab?tab=readme-ov-file#package-manager-completions). Die Autovervollständigung funktioniert, wenn vitest direkt ausgeführt wird:

::: code-group

```bash [npm]
npm vitest <Tab>
```

```bash [npm]
npm exec vitest <Tab>
```

```bash [pnpm]
pnpm vitest <Tab>
```

```bash [yarn]
yarn vitest <Tab>
```

```bash [bun]
bun vitest <Tab>
```

:::

Für die Autovervollständigung der Paketmanager sollten Sie [tabs Paketmanager-Vervollständigungen](https://github.com/bombshell-dev/tab?tab=readme-ov-file#package-manager-completions) separat installieren.

## Optionen

::: tip
Vitest unterstützt für [CLI-Argumente](https://github.com/cacjs/cac#dot-nested-options) sowohl camelCase als auch kebab-case. Zum Beispiel funktionieren `--passWithNoTests` und `--pass-with-no-tests` beide (`--no-color` und `--inspect-brk` sind die Ausnahmen).

Vitest unterstützt außerdem verschiedene Schreibweisen für den Wert: `--reporter dot` und `--reporter=dot` sind beide gültig.

Wenn eine Option ein Array von Werten unterstützt, müssen Sie die Option mehrfach übergeben:

```
vitest --reporter=dot --reporter=default
```

Boolesche Optionen lassen sich mit dem Präfix `no-` negieren. Die Angabe des Werts `false` funktioniert ebenfalls:

```
vitest --no-api
vitest --api=false
```
:::

<!--@include: ./cli-generated.md-->

### shard

- **Typ:** `string`
- **Standard:** deaktiviert

Der auszuführende Shard der Test-Suite im Format `<index>`/`<count>`, wobei

- `count` eine positive ganze Zahl ist, die Anzahl der aufgeteilten Teile
- `index` eine positive ganze Zahl ist, der Index des aufgeteilten Teils

Dieser Befehl teilt alle Tests in `count` gleich große Teile auf und führt nur diejenigen aus, die im Teil `index` liegen. Um Ihre Test-Suite zum Beispiel in drei Teile zu zerlegen, verwenden Sie:

```sh
vitest run --shard=1/3
vitest run --shard=2/3
vitest run --shard=3/3
```

:::warning
Sie können diese Option nicht mit aktiviertem `--watch` verwenden (in der Entwicklung standardmäßig aktiviert).
:::

::: tip
Wird `--reporter=blob` ohne Ausgabedatei verwendet, enthält der Standardpfad die aktuelle Shard-Konfiguration und das Blob-Label aus `VITEST_BLOB_LABEL` bzw. der Option `label` des Blob-Reporters, um Kollisionen mit anderen Vitest-Prozessen zu vermeiden.
:::

### merge-reports

- **Typ:** `boolean | string`

Führt jeden Blob-Report im angegebenen Ordner zusammen (standardmäßig `.vitest/blob/`). Sie können mit diesem Befehl beliebige Reporter verwenden (außer [`blob`](/guide/reporters#blob-reporter)):

```sh
vitest --merge-reports --reporter=junit
```
