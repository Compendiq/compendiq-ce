# Profiling der Test-Performance

Wenn du Vitest ausführst, meldet es mehrere Zeitmetriken deiner Tests:

> ```bash
> RUN  v2.1.1 /x/vitest/examples/profiling
>
> ✓ test/prime-number.test.ts (1) 4517ms
>   ✓ generate prime number 4517ms
>
> Test Files  1 passed (1)
>      Tests  1 passed (1)
>   Start at  09:32:53
>   Duration  4.80s (transform 44ms, setup 0ms, import 35ms, tests 4.52s, environment 0ms)
>   # Time metrics ^^
> ```

- Transform: Wie viel Zeit für das Transformieren der Dateien aufgewendet wurde. Siehe [Datei-Transformation](#file-transform).
- Setup: Zeit, die für das Ausführen der [`setupFiles`](/config/setupfiles)-Dateien aufgewendet wurde.
- Import: Zeit, die das Importieren deiner Testdateien und ihrer Abhängigkeiten gedauert hat. Das schließt auch die Zeit für das Einsammeln aller Tests ein. Beachte, dass dynamische Imports innerhalb von Tests hier nicht enthalten sind.
- Tests: Zeit, die für das tatsächliche Ausführen der Testfälle aufgewendet wurde.
- Environment: Zeit, die für das Aufsetzen des Test-[`environment`](/config/environment) aufgewendet wurde, zum Beispiel JSDOM.

## Test-Runner

Wenn die Ausführungszeit deiner Tests hoch ist, kannst du ein Profil des Test-Runners erzeugen. Siehe die NodeJS-Dokumentation zu den folgenden Optionen:

- [`--cpu-prof`](https://nodejs.org/api/cli.html#--cpu-prof)
- [`--heap-prof`](https://nodejs.org/api/cli.html#--heap-prof)
- [`--prof`](https://nodejs.org/api/cli.html#--prof)

:::warning
Die Option `--prof` funktioniert aufgrund von Einschränkungen in `node:worker_threads` nicht mit `pool: 'threads'`.
:::

Um diese Optionen an den Test-Runner von Vitest zu übergeben, definiere `execArgv` in deiner Vitest-Konfiguration:

```ts
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    fileParallelism: false,
    execArgv: [
      '--cpu-prof',
      '--cpu-prof-dir=test-runner-profile',
      '--heap-prof',
      '--heap-prof-dir=test-runner-profile'
    ],
  },
})
```

Nachdem die Tests gelaufen sind, sollten die Dateien `test-runner-profile/*.cpuprofile` und `test-runner-profile/*.heapprofile` erzeugt worden sein. Unter [Profiling-Aufzeichnungen untersuchen](#inspecting-profiling-records) findest du eine Anleitung zur Analyse dieser Dateien.

Ein Beispiel findest du unter [Profiling | Examples](https://github.com/vitest-dev/vitest/tree/main/examples/profiling).

## Haupt-Thread

Das Profiling des Haupt-Threads ist nützlich, um die Vite-Nutzung von Vitest und [`globalSetup`](/config/globalsetup)-Dateien zu debuggen.
Dort laufen auch deine Vite-Plugins.

:::tip
Weitere Tipps zum Vite-spezifischen Profiling findest du unter [Performance | Vite](https://vitejs.dev/guide/performance.html).

Für das Profiling der Performance deiner Vite-Plugins empfehlen wir [`vite-plugin-inspect`](https://github.com/antfu-collective/vite-plugin-inspect).
:::

Dazu musst du dem Node-Prozess, der Vitest ausführt, Argumente übergeben.

```bash
$ node --cpu-prof --cpu-prof-dir=main-profile ./node_modules/vitest/vitest.mjs --run
#      ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^                                  ^^^^^
#               NodeJS arguments                                           Vitest arguments
```

Nachdem die Tests gelaufen sind, sollte eine Datei `main-profile/*.cpuprofile` erzeugt worden sein. Unter [Profiling-Aufzeichnungen untersuchen](#inspecting-profiling-records) findest du eine Anleitung zur Analyse dieser Dateien.

## Datei-Transformation

Diese Profiling-Strategie ist ein guter Weg, um unnötige Transformationen durch [Barrel-Dateien](https://vitejs.dev/guide/performance.html#avoid-barrel-files) zu identifizieren.
Wenn diese Logs Dateien enthalten, die beim Testlauf gar nicht geladen werden sollten, hast du möglicherweise Barrel-Dateien, die unnötig Dateien importieren.

Du kannst auch die [Vitest-UI](/guide/ui) verwenden, um durch Barrel-Dateien verursachte Langsamkeit zu debuggen.
Das Beispiel unten zeigt, wie das Importieren von Dateien ohne Barrel-Datei die Anzahl der transformierten Dateien um etwa 85 % reduziert.

::: code-group
``` [File tree]
├── src
│   └── utils
│       ├── currency.ts
│       ├── formatters.ts  <-- File to test
│       ├── index.ts
│       ├── location.ts
│       ├── math.ts
│       ├── time.ts
│       └── users.ts
├── test
│   └── formatters.test.ts
└── vitest.config.ts
```
```ts [example.test.ts]
import { expect, test } from 'vitest'
import { formatter } from '../src/utils' // [!code --]
import { formatter } from '../src/utils/formatters' // [!code ++]

test('formatter works', () => {
  expect(formatter).not.toThrow()
})
```
:::

<img src="/module-graph-barrel-file.png" alt="Vitest UI demonstrating barrel file issues" />

Um zu sehen, wie Dateien transformiert werden, kannst du in der UI die Ansicht "Module Info" öffnen:

<img alt="The module info view for an inlined module" img-light src="/ui/light-module-info.png">
<img alt="The module info view for an inlined module" img-dark src="/ui/dark-module-info.png">

## Datei-Import

Manche Module brauchen einfach lange zum Laden. Um herauszufinden, welche Module am langsamsten sind, aktiviere [`experimental.importDurations`](/config/experimental#experimental-importdurations) in deiner Konfiguration:

```ts [vitest.config.ts]
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    experimental: {
      importDurations: {
        print: true,
      },
    },
  },
})
```

Damit wird nach Abschluss deiner Tests eine Aufschlüsselung der langsamsten Imports ausgegeben:

```bash
Import Duration Breakdown (Top 10)

Module                      Self     Total
my-test.test.ts              5ms    620ms [████████████████████]
date-fns/index.js          500ms    500ms [████████████████░░░░] # [!code error]
src/utils/helpers.ts        10ms    120ms [████████░░░░░░░░░░░░]
```

Du kannst auch `--experimental.importDurations.print` über die CLI verwenden, ohne deine Konfiguration zu ändern:

```bash
vitest --experimental.importDurations.print
```

Sobald du die langsamen Module identifiziert hast, gibt es mehrere Strategien, um Imports zu beschleunigen:

### Spezifische Einstiegspunkte verwenden

Viele Bibliotheken liefern mehrere Einstiegspunkte aus. Der Import des Haupt-Einstiegspunkts (oft eine [Barrel-Datei](https://vitejs.dev/guide/performance.html#avoid-barrel-files)) kann weit mehr Code hereinziehen, als du brauchst.

`date-fns` re-exportiert zum Beispiel Hunderte von Funktionen über seinen Haupt-Einstiegspunkt. Statt vom Top-Level-Modul zu importieren, importiere direkt von der spezifischen Funktion:

```ts
import { format } from 'date-fns' // [!code --]
import { format } from 'date-fns/format' // [!code ++]
```

### Imports mit `resolve.alias` umleiten

Wenn eine Abhängigkeit keine feingranularen Einstiegspunkte bereitstellt oder wenn Fremdcode den schweren Einstiegspunkt importiert, kannst du mit [`resolve.alias`](https://vite.dev/config/shared-options#resolve-alias) Imports auf eine leichtere Alternative umleiten:

```ts [vitest.config.ts]
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: [
      {
        find: /^date-fns$/,
        replacement: join(dirname(require.resolve('date-fns/package.json')), 'index.cjs'),
      },
    ]
  },
})
```

### Den Dependency Optimizer verwenden

Vitest kann externe Bibliotheken mit [`deps.optimizer`](/config/deps#deps-optimizer) in eine einzige Datei bündeln, was den Overhead beim Import von Paketen mit vielen internen Modulen reduziert:

```ts [vitest.config.ts]
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    deps: {
      optimizer: {
        ssr: {
          enabled: true,
          include: ['date-fns'],
        },
      },
    },
  },
})
```

Das ist besonders wirksam bei UI-Bibliotheken und Paketen mit tiefen Import-Bäumen. Verwende `optimizer.ssr` für `node`/`edge`-Umgebungen und `optimizer.client` für `jsdom`/`happy-dom`-Umgebungen.

## Code Coverage

Wenn die Erzeugung der Code Coverage in deinem Projekt langsam ist, kannst du mit der Umgebungsvariablen `DEBUG=vitest:coverage` das Performance-Logging aktivieren.

```bash
$ DEBUG=vitest:coverage vitest --run --coverage

 RUN  v3.1.1 /x/vitest-example

  vitest:coverage Reading coverage results 2/2
  vitest:coverage Converting 1/2
  vitest:coverage 4 ms /x/src/multiply.ts
  vitest:coverage Converting 2/2
  vitest:coverage 552 ms /x/src/add.ts
  vitest:coverage Uncovered files 1/2
  vitest:coverage File "/x/src/large-file.ts" is taking longer than 3s # [!code error]
  vitest:coverage 3027 ms /x/src/large-file.ts
  vitest:coverage Uncovered files 2/2
  vitest:coverage 4 ms /x/src/untested-file.ts
  vitest:coverage Generate coverage total time 3521 ms
```

Dieser Profiling-Ansatz eignet sich hervorragend, um große Dateien zu entdecken, die versehentlich von Coverage-Providern erfasst werden.
Wenn deine Konfiguration zum Beispiel versehentlich große, gebaute und minifizierte JavaScript-Dateien in die Code Coverage einbezieht, sollten diese in den Logs auftauchen.
In solchen Fällen möchtest du eventuell deine Optionen [`coverage.include`](/config/coverage#coverage-include) und [`coverage.exclude`](/config/coverage#coverage-exclude) anpassen.

## Profiling-Aufzeichnungen untersuchen

Den Inhalt von `*.cpuprofile` und `*.heapprofile` kannst du mit verschiedenen Werkzeugen untersuchen. Die Liste unten enthält Beispiele.

- [Speedscope](https://www.speedscope.app/)
- [Performance Profiling JavaScript in Visual Studio Code](https://code.visualstudio.com/docs/nodejs/profiling#_analyzing-a-profile)
- [Profile Node.js performance with the Performance panel | developer.chrome.com](https://developer.chrome.com/docs/devtools/performance/nodejs#analyze)
- [Memory panel overview | developer.chrome.com](https://developer.chrome.com/docs/devtools/memory-problems/heap-snapshots#view_snapshots)
