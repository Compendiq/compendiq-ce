# Migrationsleitfaden

[Migration zu Vitest 4.0](https://v4.vitest.dev/guide/migration) | [Migration zu Vitest 3.0](https://v3.vitest.dev/guide/migration)

## Migration zu Vitest 5.0 {#vitest-5}

::: warning In Arbeit
Vitest 5.0 befindet sich derzeit in der Beta-Phase. Dieser Abschnitt verfolgt Breaking Changes, während sie gemergt werden, und kann sich vor dem stabilen Release noch ändern.
:::

::: warning Voraussetzungen
Vitest 5.0 setzt Vite >= 6.4.0 und Node.js >= 22.12.0 voraus. Stellen Sie sicher, dass Ihre Umgebung diese Anforderungen erfüllt, bevor Sie mit weiteren Migrationsschritten fortfahren. Vitest 5.0 auf älteren Versionen von Vite oder Node.js auszuführen wird nicht unterstützt und kann zu unerwarteten Fehlern führen.
:::

### `clearMocks` ist standardmäßig aktiviert

[`clearMocks`](/config/#clearmocks) ist nun standardmäßig `true`. Vitest ruft vor jedem Test [`vi.clearAllMocks()`](/api/vi#vi-clearallmocks) auf und setzt damit `mock.calls`, `mock.instances`, `mock.contexts` und `mock.results` jedes Mocks zurück. Mock-Implementierungen bleiben unangetastet, betroffen ist also nur die aufgezeichnete Historie.

In der Praxis bedeutet das, dass ein Mock Aufrufe nicht mehr von einem Test in den nächsten mitnimmt:

```ts
import { expect, test, vi } from 'vitest'

const fn = vi.fn()

test('first', () => {
  fn()
  expect(fn).toHaveBeenCalledTimes(1)
})

test('second', () => {
  fn()
  // v4: the call from "first" was kept, so this was 2 // [!code --]
  expect(fn).toHaveBeenCalledTimes(2) // [!code --]
  // v5: history is cleared before each test, so only this test's call counts // [!code ++]
  expect(fn).toHaveBeenCalledTimes(1) // [!code ++]
})
```

Am stärksten betroffen sind Tests, die Aufrufe außerhalb des Testkörpers aufzeichnen (etwa in einer Setup-Datei, auf oberster Ebene eines Moduls oder in einem `beforeAll`-Hook), weil diese Historie gelöscht wird, bevor der Test läuft, der darauf prüft.

Um das bisherige Verhalten beizubehalten, setzen Sie `clearMocks` zurück auf `false`:

```ts [vitest.config.ts]
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    clearMocks: false, // [!code ++]
  },
})
```

### `testNamePattern` passt auf den mit `>` verbundenen vollständigen Namen

[`testNamePattern`](/config/testnamepattern) (das CLI-Flag `-t`) wird nun gegen den vollständigen Namen des Tests geprüft, bei dem Suite-Kette und Testname mit `' > '` verbunden sind – derselbe String, der in der Reporter-Ausgabe erscheint. Zuvor wurden die Segmente mit einem einzelnen Leerzeichen verbunden, analog zu Jest.

Das betrifft nur Muster, die die Grenze zwischen einer Suite und einem Test (oder zwischen verschachtelten Suites) überspannen. Muster, die innerhalb eines einzelnen Namenssegments passen, sowie Muster, die `.`/`.*` zwischen Segmenten verwenden, sind nicht betroffen.

```ts
describe('math', () => {
  test('adds', () => {})
})
```

```bash
vitest -t 'math adds' # [!code --]
vitest -t 'math > adds' # [!code ++]
```

Damit ein Muster unabhängig vom Trennzeichen funktioniert, prüfen Sie ein einzelnes Segment (`-t adds`) oder verwenden Sie zwischen den Segmenten eine Wildcard (`-t 'math.*adds'`).

### Inline-Projekte erben standardmäßig die Root-Konfiguration

Die Option [`extends`](/guide/projects#configuration) ist nun standardmäßig `true`: Jedes als Inline-Konfiguration in [`test.projects`](/guide/projects) definierte Projekt erbt alle Optionen der Root-Konfiguration, einschließlich Vite-Optionen wie `plugins` oder `resolve.alias`. Die Optionen werden nach denselben Regeln gemergt, die in Vitest 4 für ein explizites `extends: true` galten:

```ts [vitest.config.ts]
import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  test: {
    projects: [
      {
        // v4: this project didn't apply the react plugin
        // v5: the plugin is inherited from the root config
        test: {
          name: 'unit',
          include: ['**/*.unit.test.ts'],
        },
      },
    ],
  },
})
```

Einige Optionen sind ausgenommen, weil sie stets auf ein einzelnes Projekt oder auf den gesamten Testlauf beschränkt sind:

- `name` und `projects` werden nie vererbt.
- `globalSetup` wird nicht aus der Root-Konfiguration vererbt: Das `globalSetup` auf Root-Ebene läuft ohnehin einmal pro Testlauf, sodass eine Vererbung dieselben Dateien für jedes Projekt erneut ausführen würde. Beim Erweitern einer Nicht-Root-Konfigurationsdatei wird es weiterhin vererbt.
- Die eigenen `tags` des Projekts ersetzen das geerbte Array, statt damit gemergt zu werden.

Projekte, die als Konfigurationsdateien oder Verzeichnisse referenziert werden, sind nicht betroffen; sie erben weiterhin keine Optionen aus der Root-Konfiguration.

Bedenken Sie, dass Arrays gemergt und nicht überschrieben werden. Definiert die Root-Konfiguration beispielsweise `setupFiles`, werden die eigenen `setupFiles` des Projekts an die geerbten angehängt. Wenn Sie das bisherige Verhalten benötigen, setzen Sie in der Projektkonfiguration `extends: false`:

```ts [vitest.config.ts]
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    setupFiles: ['./setup.global.ts'],
    projects: [
      {
        extends: false, // [!code ++]
        test: {
          name: 'unit',
          setupFiles: ['./setup.unit.ts'],
        },
      },
    ],
  },
})
```

### Referenzierte Konfigurationsdateien können eigene Projekte definieren

Eine in [`test.projects`](/guide/projects) referenzierte Konfigurationsdatei, die selbst `projects` deklariert, wird nun wie die Root-Konfiguration behandelt: Sie führt selbst keine Tests aus, sondern stellt lediglich die von ihr deklarierten [verschachtelten Projekte](/guide/projects#nested-projects) bereit. Deren Namen werden mit dem Namen der deklarierenden Konfiguration präfixiert, z. B. `app (unit)`.

In Vitest 4 wurde das Feld `projects` einer referenzierten Konfiguration stillschweigend ignoriert und die Konfiguration lief als einzelnes Projekt. Prüfen Sie, dass Ihre Projektkonfigurationen nicht unbemerkt ein `projects`-Feld tragen. Am häufigsten geschieht das durch das Mergen einer Konfiguration, die es definiert:

```ts [packages/app/vitest.config.ts]
import { defineProject, mergeConfig } from 'vitest/config'
import rootConfig from '../../vitest.config' // [!code --]
import sharedConfig from '../../vitest.shared' // [!code ++]

export default mergeConfig(
  // the root config defines `test.projects`, so merging it
  // would turn this project into a container for those projects
  rootConfig, // [!code --]
  sharedConfig, // [!code ++]
  defineProject({
    test: {
      environment: 'jsdom',
    },
  }),
)
```

Da die geerbten `projects`-Pfade relativ zur referenzierten Konfiguration aufgelöst werden, schlägt diese Fehlkonfiguration in der Regel schon beim Start deutlich fehl – mit `Projects definition references a non-existing file or a directory`, `No projects were found in "..."` oder einem Fehler wegen einer zirkulären `projects`-Definition.

Inline-Konfigurationen ignorieren das Feld `projects` zur Laufzeit weiterhin, doch es ist nun auch aus ihrem Typ `ProjectConfig` ausgeschlossen.

### Gehobene Mocking-Aufrufe müssen auf oberster Ebene stehen

[`vi.mock`](/api/vi#vi-mock), [`vi.unmock`](/api/vi#vi-unmock) und [`vi.hoisted`](/api/vi#vi-hoisted) werden an den Anfang der Datei gehoben und laufen vor jedem umgebenden Code. Sie innerhalb einer Funktion, eines Blocks oder eines `describe`/`test`-Callbacks aufzurufen, führte bislang nur zu einer Warnung. Vitest 5.0 wirft nun einen Fehler, weil der Aufruf nicht dort ausgeführt wird, wo er steht:

```ts
describe('calculator', () => {
  vi.mock('./calculator') // [!code --]
})

vi.mock('./calculator') // [!code ++]

describe('calculator', () => {
  // ...
})
```

Der Fehler meldet jeden betroffenen Aufruf samt Position:

```
1 call in "calculator.test.ts" was defined outside of the module's top level scope:

- vi.mock("./calculator") at calculator.test.ts:2:3

Although it appears nested, it will be hoisted and executed before anything in this file. Move it to the top level to reflect its actual execution order.
```

Die dynamischen Varianten [`vi.doMock`](/api/vi#vi-domock) und [`vi.doUnmock`](/api/vi#vi-dounmock) werden nicht gehoben und dürfen weiterhin überall aufgerufen werden.

### Automatisch gemockte Module bleiben im Browser automatisch gemockt

Im Browser-Modus werden Mock-Metadaten zwischen Vitest und dem Test-Iframe serialisiert. Ein automatisch gemocktes Modul (ein [`vi.mock`](/api/vi#vi-mock)-Aufruf ohne Factory) wurde auf der anderen Seite fälschlich als Spy wiederhergestellt, sodass seine Exporte weiterhin die echte Implementierung aufriefen statt der automatisch erzeugten Stubs.

Automocks werden nun als Automocks wiederhergestellt. Verließ sich ein Browser-Test darauf, dass die ursprüngliche Implementierung durch ein automatisch gemocktes Modul lief, geben dessen Exporte nun standardmäßig `undefined` zurück. Übergeben Sie [`{ spy: true }`](/api/vi#vi-mock), um weiterhin die echte Implementierung aufzurufen und dabei Aufrufe mitzuschreiben, oder stellen Sie eine Factory mit dem gewünschten Verhalten bereit.

### Neuschreibung der Benchmarking-API

Die Benchmarking-API wurde neu geschrieben. `bench` ist kein Top-Level-Import aus `vitest` mehr; es ist eine [Test-Context-Fixture](/guide/test-context#bench), die aus einem gewöhnlichen `test()` heraus angesprochen wird. Die neue API beschreibt der [Benchmarking-Leitfaden](/guide/benchmarking).

Entfernt, mit Ersatz, sofern vorhanden:

- **`bench(name, fn)` auf Modulebene**: Destrukturieren Sie stattdessen `bench` aus dem Testkontext.

```ts
// v4
import { bench } from 'vitest' // [!code --]

bench('sort', () => { // [!code --]
  [3, 1, 2].sort() // [!code --]
}) // [!code --]

// v5
import { test } from 'vitest' // [!code ++]

test('sort', async ({ bench }) => { // [!code ++]
  await bench('sort', () => { [3, 1, 2].sort() }).run() // [!code ++]
}) // [!code ++]
```

- **`bench.skip`, `bench.only`, `bench.todo`** wurden entfernt. Verwenden Sie stattdessen die gewöhnlichen `test.skip`, `test.only`, `test.todo` am umgebenden `test()`.
- **`benchmark.reporters` / `benchmark.outputFile`** wurden entfernt. Die Benchmark-Ausgabe ist nun Teil des Standard-Reporters und des `json`-Reporters; konfigurieren Sie diese stattdessen auf oberster Ebene über `test.reporters`.
- **Die Konfiguration `benchmark.compare` und das CLI-Flag `--compare`** wurden entfernt. Übergeben Sie [`writeResult`](/guide/benchmarking#storing-and-replaying-results) als Option pro Bench, um ein Ergebnis zu persistieren, und lesen Sie es mit [`bench.from()`](/guide/benchmarking#bench-from) innerhalb von `bench.compare()` wieder ein.
- **Die Konfiguration `benchmark.outputJson` und das CLI-Flag `--outputJson`** wurden entfernt. Verwenden Sie `--reporter=json --outputFile=<path>`, um Benchmark-Ergebnisse festzuhalten; der JSON-Reporter enthält nun für jeden Testfall ein Feld `benchmarks`.
- **Die Eigenschaft `mode` der `Vitest`-Instanz** ist nun immer `'test'`. Der bisherige Wert `'benchmark'` wird nicht mehr verwendet; Benchmarks laufen in einem eigenen Projekt derselben `Vitest`-Instanz.

### Vitest UI verlangt eine authentifizierte URL

Vitest UI verlangt nun Token-Authentifizierung für die HTML-Seite und den API-Zugriff. Die URL `/__vitest__/` zeigt einen Fehler, bis der Browser authentifiziert ist. Zur Authentifizierung öffnen Sie die URL mit einem von Vitest ausgegebenen Token, wie unten gezeigt. Nach der Authentifizierung funktioniert die direkte URL `/__vitest__/` korrekt.

```bash
vitest --ui
# UI started at http://localhost:51204/__vitest__/?token=...
```

### Fake Timers mocken nun `Temporal`

Vitest mockt bei aktivierten Fake Timers nun neben `Date` auch die API [`Temporal`](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Temporal), im Anschluss an das [Update von `@sinonjs/fake-timers` auf v15.4](https://github.com/sinonjs/fake-timers/blob/main/CHANGELOG.md#1540--2026-05-05). Das greift nur, wenn `Temporal` am globalen Objekt verfügbar ist – entweder nativ (Node.js >= 26 standardmäßig, in älteren Versionen hinter `--harmony-temporal`, sowie in unterstützenden Browsern) oder über ein global installiertes Polyfill wie `import 'temporal-polyfill/global'`.

Zuvor gab `Temporal.Now` weiterhin die echte Uhrzeit zurück, selbst wenn [`vi.useFakeTimers()`](/api/vi#vi-usefaketimers) aktiv war. Nun folgt es der gemockten Uhr:

```ts
vi.useFakeTimers({ now: 0 })

Temporal.Now.instant().epochMilliseconds // 0 (was the real time in v4)
```

`Temporal` gehört zum Standardsatz gefakter APIs und wird daher über [`fakeTimers.toFake`](/config/#faketimers-tofake) und [`fakeTimers.toNotFake`](/config/#faketimers-tonotfake) gesteuert. Um `Temporal` nativ zu belassen, fügen Sie es zu `toNotFake` hinzu:

```ts
vi.useFakeTimers({ toNotFake: ['Temporal'] })
```

### `setSystemTime` mockt nun Temporal

Zuvor mockte `vi.setSystemTime` ohne Fake Timers nur `Date`, nun mockt es zusätzlich Methoden von `Temporal.Now`.

```ts
vi.setSystemTime(0)
Temporal.Now.instant().epochMilliseconds // 0 (was the real time in v4)
```

### `toThrow("")` passt auf jede Fehlermeldung

[`toThrow`](/api/expect#tothrow) (und sein Alias `toThrowError`) behandelt ein String-Argument als Teilstring der Fehlermeldung. In Vitest 4 wurde ein leerer String als Sonderfall auf das Muster `/^$/` abgebildet, sodass er nur auf einen Fehler mit leerer Meldung passte. Er verhält sich nun wie jeder andere Teilstring, und ein leerer String ist in jeder Meldung enthalten:

```ts
expect(() => { throw new Error('boom') }).not.toThrow('') // [!code --]
expect(() => { throw new Error('boom') }).toThrow('') // [!code ++]
```

Um zu prüfen, dass ein geworfener Fehler eine leere Meldung hat, prüfen Sie das Muster explizit:

```ts
expect(() => { throw new Error('boom') }).not.toThrow(/^$/)
```

### Assertion-Typen legen Rückgabe- und Empfangstyp offen

Assertion-Interfaces verwenden nun zwei Typparameter: `R` ist der Rückgabetyp des Matchers und `T` der Typ des empfangenen Werts. Synchrone Assertions verwenden `void`, während Assertions, auf die über `.resolves`, `.rejects`, [`expect.poll`](/api/expect#poll) oder [`expect.element`](/api/browser/assertions) zugegriffen wird, `Promise<void>` verwenden.

Wenn Sie eigene Matcher deklarieren, erweitern Sie das Interface `Matchers<R, T>`. Es fügt den Matcher zu Instanz-Assertions, asymmetrischen Matchern und dem von `expect.extend` akzeptierten Typ hinzu:

```ts [vitest.d.ts]
import 'vitest'

interface CustomMatchers<R = unknown, T = unknown> {
  toBeFoo: () => R
  toEqualTyped: (expected: T) => R
}

declare module 'vitest' {
  interface Matchers<R, T> extends CustomMatchers<R, T> {}
}
```

Dadurch spiegeln die Rückgabetypen eigener Matcher wider, wie der Matcher verwendet wird:

```ts
const syncResult = expect('value').toEqualTyped('other') // void
const asyncResult = expect(Promise.resolve('value')).resolves.toEqualTyped('other') // Promise<void>
await asyncResult
```

Code, der Assertion-Typen direkt referenziert, muss ebenfalls zuerst den Rückgabetyp angeben:

```ts
Assertion<string> // [!code --]
Assertion<void, string> // [!code ++]
Assertion<Promise<void>, string> // asynchronous assertion
```

Vitest liest Deklarationen eigener Matcher nicht mehr aus dem globalen Interface `jest.Matchers`. Bibliotheken, die sowohl Jest als auch Vitest unterstützen, sollten `jest.Matchers` und `vitest.Matchers` getrennt erweitern. Das betrifft nur TypeScript-Deklarationen; das Registrieren von Matchern mit `expect.extend` funktioniert wie zuvor.

### `expect.poll` schlägt bei Timeout fehl

[`expect.poll`](/api/expect#poll) wird nun abgelehnt, wenn sein Callback oder die gepollte Assertion nicht innerhalb von `timeout` zur Ruhe kommt. Zuvor konnte ein Callback, das nach der Frist auflöste, oder eine Assertion, die erst bei einem späten Versuch bestand, dennoch erfolgreich sein. Der Callback erhält nun außerdem ein `AbortSignal`, das beim Ablauf des Timeouts abbricht, sodass Sie laufende Arbeit abbrechen können:

```ts
await expect.poll(async ({ signal }) => {
  const response = await fetch('/api/status', { signal })
  return response.status
}, { timeout: 1000 }).toBe(200)
```

Ein Poll, der berechtigterweise mehr Zeit braucht, sollte sein `timeout` erhöhen. Andernfalls schlägt er mit `expect.poll() function didn't resolve in time.` (oder `expect.poll() assertion didn't resolve in time.`) fehl.

### Nicht awaitete asynchrone Assertions lassen den Test fehlschlagen

Asynchrone Assertions wie `resolves`, `rejects` und `toMatchFileSnapshot` lassen den Test nun fehlschlagen, wenn sie nicht awaitet werden. Zuvor hat Vitest sie am Ende des Tests automatisch awaitet und eine Warnung ausgegeben:

```ts
test('unawaited assertion', async () => {
  // v4: prints a warning, the test passes // [!code --]
  // v5: the test fails // [!code ++]
  expect(promise).resolves.toBe(1) // [!code --]
  await expect(promise).resolves.toBe(1) // [!code ++]
})
```

Der gemeldete Fehler verweist auf die Assertion, die nicht awaitet wurde.

### Testtitel und inspizierte Werte verwenden `pretty-format`

Vitest formatiert Werte bei der Inspektion nun mit [`pretty-format`](https://www.npmjs.com/package/pretty-format) statt mit `loupe`, einschließlich der Werte, die in Titel von [`test.each`](/api/test#test-each) und [`test.for`](/api/test#test-for) interpoliert werden. Die Darstellung mancher Werte ändert sich, sodass Snapshots oder Assertions, die inspizierte Ausgaben festhalten, möglicherweise aktualisiert werden müssen.

Zwei Änderungen betreffen speziell erzeugte Testtitel:

- Ein über einen `$`-Platzhalter interpolierter String-Wert wird nicht mehr in Anführungszeichen gesetzt:

```ts
test.for([{ id: 'a1' }])('case $id', ({ id }) => { /* ... */ })
// v4 title: case 'a1' // [!code --]
// v5 title: case a1   // [!code ++]
```

- Die Längenbegrenzung interpolierter Werte wird nun über die neue Option [`taskTitleValueFormatTruncate`](/config/tasktitlevalueformattruncate) gesteuert (Standard `40`).

### Entfernte Optionen `test.sequential`, `describe.sequential` und `sequential`

Vitest 5.0 entfernt die deprecateten Testoptionen `test.sequential`, `describe.sequential` und `sequential`. Verwenden Sie `concurrent: false`, wenn ein Test oder eine Suite geerbte oder global konfigurierte Nebenläufigkeit abwählen soll.

```ts
test.sequential('example', async () => { /* ... */ }) // [!code --]
test('example', { concurrent: false }, async () => { /* ... */ }) // [!code ++]
```

```ts
describe.sequential('suite', () => { /* ... */ }) // [!code --]
describe('suite', { concurrent: false }, () => { /* ... */ }) // [!code ++]
```

Derselbe Ersatz gilt für Options-Objekte:

```ts
test('example', { sequential: true }, async () => { /* ... */ }) // [!code --]
test('example', { concurrent: false }, async () => { /* ... */ }) // [!code ++]
```

### Locators in Commands werden als Objekte serialisiert

An [Browser-Commands](/api/browser/commands) weitergereichte Locators werden nun als Objekt `SerializedLocator` statt als bloßer Selektor-String serialisiert. Das Objekt legt zwei Felder offen:

- `selector`: der provider-spezifische Selektor-String (derselbe Wert, den Commands zuvor erhielten).
- `locator`: eine menschenlesbare Darstellung des Locators (z. B. `getByRole('button')`), die für Fehlermeldungen und Tracing verwendet wird.

Passen Sie alle eigenen Commands, die einen Locator entgegennehmen, so an, dass sie `selector` aus dem neuen Objekt destrukturieren:

```ts
import type { SerializedLocator } from '@vitest/browser'
import type { BrowserCommandContext } from 'vitest/node'

export async function customClick(
  context: BrowserCommandContext,
  selector: string, // [!code --]
  { selector }: SerializedLocator, // [!code ++]
) {
  await context.page.locator(selector).click()
}
```

### Locators sind standardmäßig strikt

Browser-Locators prüfen den Text nun standardmäßig exakt und verlangen eine vollständige Übereinstimmung unter Beachtung der Groß-/Kleinschreibung. Um das bisherige Verhalten beizubehalten, können Sie [`browser.locators.exact`](/config/browser/locators#browser-locators-exact) auf `false` setzen.

```ts
// With exact: true (default), this only matches the string "Hello, World" exactly.
// With exact: false, this matches "Hello, World!", "Say Hello, World", etc.
const locator = page.getByText('Hello, World', { exact: true })
await locator.click()
```

### `toHaveTextContent` prüft nun strikte Gleichheit

Der Matcher [`toHaveTextContent`](/api/browser/assertions#tohavetextcontent) im Browser-Modus prüft nun, dass der Textinhalt eines Elements exakt dem erwarteten String entspricht, statt eine teilweise Übereinstimmung unter Beachtung der Groß-/Kleinschreibung durchzuführen. Reguläre Ausdrücke werden nicht mehr akzeptiert. Das bisherige Verhalten einschließlich `RegExp`-Unterstützung ist in den neuen Matcher [`toMatchTextContent`](/api/browser/assertions#tomatchtextcontent) umgezogen.

```ts
// Partial or regex matches:
await expect.element(banner).toHaveTextContent('Error') // [!code --]
await expect.element(banner).toHaveTextContent(/error/i) // [!code --]
await expect.element(banner).toMatchTextContent('Error') // [!code ++]
await expect.element(banner).toMatchTextContent(/error/i) // [!code ++]

// Exact matches stay on `toHaveTextContent`:
await expect.element(banner).toHaveTextContent('Error!')
```

### `render` ist in `vitest-browser-vue` und `vitest-browser-svelte` asynchron

Die begleitenden Pakete für Komponententests [`vitest-browser-vue`](https://npmx.dev/package/vitest-browser-vue) und [`vitest-browser-svelte`](https://npmx.dev/package/vitest-browser-svelte) geben aus `render` nun ein Promise zurück, sodass der Aufruf awaitet werden muss, bevor Sie die gerenderte Ausgabe abfragen:

```ts
import { render } from 'vitest-browser-vue'
import Component from './Component.vue'

test('renders', async () => {
  const screen = render(Component) // [!code --]
  const screen = await render(Component) // [!code ++]

  await expect.element(screen.getByRole('heading')).toBeVisible()
})
```

### Glob-Coverage-Schwellwerte erben `perFile` nicht mehr

`coverage.thresholds.perFile` galt bislang für jedes Schwellwert-Set, einschließlich der über Glob-Muster erfassten Dateien. Glob-Muster steuern ihre Prüfung pro Datei nun selbst und erben das `perFile` der obersten Ebene nicht mehr – setzen Sie `perFile` an jedem Glob, das es benötigt.

```ts [vitest.config.ts]
export default defineConfig({
  test: {
    coverage: {
      thresholds: {
        'perFile': true,

        'src/utils/**': {
          lines: 80,
          perFile: true, // [!code ++]
        },
      },
    },
  },
})
```

### `include` und `exclude` der Coverage passen präziser

`coverage.include` und `coverage.exclude` wurden gegen absolute Pfade mit picomatchs Option `contains` geprüft, wodurch weit mehr Dateien erfasst wurden als beabsichtigt. So konnte ein Muster auf eine Datei passen, weil ein übergeordnetes Verzeichnis in ihrem absoluten Pfad zufällig dasselbe Segment enthielt. Muster werden nun gegen den Pfad jeder Datei relativ zum Projekt-Root geprüft, ohne `contains`.

Ein Muster ohne Glob-Wildcard wird als Verzeichnis behandelt und so erweitert, dass es alles darin erfasst:

```ts [vitest.config.ts]
export default defineConfig({
  test: {
    coverage: {
      include: ['src'], // matches src/**, not every path that contains "src"
    },
  },
})
```

Überprüfen Sie Ihre `include`- und `exclude`-Muster nach dem Upgrade und bestätigen Sie, dass die gemeldete Dateimenge Ihren Erwartungen entspricht. Dateien, die zuvor nur durch das lockerere Verhalten erfasst wurden, sind möglicherweise nicht mehr enthalten.

### Konfigurationsdateien werden nicht mehr in übergeordneten Verzeichnissen gesucht

Vitest durchsucht übergeordnete Verzeichnisse nicht mehr nach Konfigurationsdateien. Wenn Sie sich bislang darauf verlassen haben, `vitest` aus einem Unterverzeichnis auszuführen und dabei eine Konfigurationsdatei aus einem übergeordneten Verzeichnis zu verwenden, übergeben Sie die Konfiguration explizit und grenzen Sie die Testsuche mit `--dir` ein. Zum Beispiel:

```bash
$ cd subdir && vitest # [!code --]
$ cd subdir && vitest --config ../vitest.config.ts # [!code ++]
```

### Globale Zuweisungen in DOM-Environments aktualisieren nun das zugrunde liegende Window

Zuweisungen an Eigenschaften von `globalThis` oder `window` in den Environments `jsdom` und `happy-dom` werden nun an die zugrunde liegende DOM-Implementierung weitergereicht. Veränderbare Eigenschaften wie `innerWidth` können APIs beeinflussen, die vom DOM-Environment implementiert werden, zum Beispiel `matchMedia` in `happy-dom`.

### `populateGlobal` gibt in `originals` Deskriptoren zurück

Die von [`populateGlobal`](/guide/environment#custom-environment) zurückgegebene Map `originals` enthält nun [Property-Deskriptoren](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Object/getOwnPropertyDescriptor) statt einfacher Werte. Damit werden native Lazy Getter (etwa Nodes `localStorage`) beim Erfassen des Originals nicht ausgelöst und beim Teardown originalgetreu wiederhergestellt.

Wenn Sie sie in einem eigenen Environment manuell wiederherstellen, verwenden Sie `Object.defineProperty` statt einer Zuweisung:

```ts
originals.forEach((value, key) => (global[key] = value)) // [!code --]
originals.forEach((descriptor, key) => Object.defineProperty(global, key, descriptor)) // [!code ++]
```

### Die URL des Browser-Orchestrators verlangt eine Session

Vitest liefert die UI des Browser-Orchestrators nicht mehr unter einer bloßen URL `/__vitest_test__/` aus. URLs des Browser-Runners sind nun an eine Session gebunden und müssen die von Vitest erzeugte `sessionId` enthalten, zum Beispiel `/__vitest_test__/?sessionId=...`.

Wenn Sie die Browser-Vorschau bislang manuell geöffnet haben, indem Sie die URL des Vite-Servers kopiert oder `/__vitest_test__/` direkt aufgerufen haben, verwenden Sie stattdessen die von Vitest geöffnete oder ausgegebene URL.

### Erzeugte Reports und Artefakte verwenden das Verzeichnis `.vitest`

Vitest verwendet nun ein einziges Verzeichnis `.vitest` im Projekt-Root als gemeinsames Artefakt-Root, sodass ein `.vitest`-Eintrag in der `.gitignore` genügt. In diesem Major verschobene Standardwerte:

- **Anhänge** ([`attachmentsDir`](/config/attachmentsdir)): `.vitest-attachements/` → `.vitest/attachments/`
- **Blob-Reporter** und `--merge-reports`: `.vitest-reports/blob-*.json` → `.vitest/blob/blob-*.json`
- **HTML-Reporter** ([`html`](/guide/reporters#html-reporter)): `html/index.html` → `.vitest/index.html`, und seine Option wechselte von `outputFile` (eine Datei) zu `outputDir` (ein Verzeichnis)
- **JSON-Reporter** ([`json`](/guide/reporters#json-reporter)): stdout → `.vitest/json/output.json`
- **JUnit-Reporter** ([`junit`](/guide/reporters#junit-reporter)): stdout → `.vitest/junit/output.xml`

Die Reporter `json` und `junit` schreiben nun standardmäßig in eine Datei, statt auf stdout auszugeben. Wenn Sie sich zuvor darauf verlassen haben, dass der Report auf stdout ausgegeben wird (etwa `vitest --reporter=json > out.json` oder `vitest --reporter=json | jq`), lesen Sie entweder die erzeugte Artefaktdatei (zum Beispiel `jq . .vitest/json/output.json`) oder aktivieren Sie stdout wieder über die Option `stdout` des Reporters (`reporters: [['json', { stdout: true }]]`). Ein explizit gesetztes `outputFile` wird weiterhin respektiert und bleibt unverändert.

### `toMatchScreenshot` verwendet nun eine eigene Konfiguration für das Screenshot-Verzeichnis

Zuvor respektierten Referenz-Screenshots für `toMatchScreenshot` `browser.screenshotDirectory` nicht korrekt. In der Folge wurden Screenshots an einem unbeabsichtigten Ort abgelegt, wenn ein eigenes Verzeichnis konfiguriert war.

Das ist nun durch Einführung einer eigenen Option behoben: `browser.expect.toMatchScreenshot.screenshotDirectory`. Ihr Standardwert ist `__screenshots__`.

- Wenn Sie `browser.screenshotDirectory` nicht gesetzt haben, sind keine Änderungen nötig.
- Wenn Sie `browser.screenshotDirectory` gesetzt haben, müssen Sie die neue Option nun explizit konfigurieren:

    ```ts [vitest.config.ts]
    export default defineConfig({
      test: {
        browser: {
          screenshotDirectory: 'my-screenshots',
          expect: { // [!code ++]
            toMatchScreenshot: { // [!code ++]
              screenshotDirectory: 'my-screenshots', // [!code ++]
            }, // [!code ++]
          }, // [!code ++]
        },
      },
    })
    ```

    Verschieben Sie anschließend vorhandene Referenz-Screenshots an den neuen Ort oder erzeugen Sie sie neu.

### Worker- und Concurrency-IDs sind 1-basiert

Worker- und Pool-Bezeichner beginnen nun bei `1` statt bei `0`. Das ändert die Werte der Umgebungsvariablen `VITEST_POOL_ID` und `VITEST_WORKER_ID`, die nun von `1` bis zur Worker-Anzahl reichen. Passen Sie jede Logik an, die einen Wert aus diesen IDs ableitet, etwa einen Datenbanknamen pro Worker oder einen Array-Index.

Für eigene Reporter legen die Diagnosen von [`TestModule`](/api/advanced/test-module#diagnostic) nun beide IDs offen: die bestehende `workerId` (jetzt 1-basiert) und eine neue `concurrencyId`.

```ts
import type { Reporter, TestModule } from 'vitest/node'

class MyReporter implements Reporter {
  onTestModuleEnd(testModule: TestModule) {
    const { workerId, concurrencyId } = testModule.diagnostic()
  }
}
```

Node.js- und Browser-Tests laufen in getrennten Pools und teilen sich diese IDs nicht, sodass derselbe Wert in beiden auftreten kann.

### Paket-Migration

Die folgenden Pakete sind mit diesem Release deprecated. Sie erhalten keine Feature-Updates mehr, doch Sicherheitskorrekturen werden weiterhin zurückportiert:

- [`@vitest/runner`](https://npmx.dev/package/@vitest/runner)
- [`@vitest/ws-client`](https://npmx.dev/package/@vitest/ws-client)

Der Provider [`@vitest/browser-webdriverio`](https://npmx.dev/package/@vitest/browser-webdriverio) ist in die Organisation [vitest-community](https://github.com/vitest-community/vitest-webdriverio) umgezogen. Künftig wird die WebdriverIO-Unterstützung von der Community gepflegt und pro Issue bearbeitet. Wenn Sie sie verwenden, aktualisieren Sie Ihre Abhängigkeit auf das neue Paket und melden Sie Probleme im neuen Repository.

### Entfernte deprecatete Entry-Points

Mehrere Entry-Points wurden in Vitest 4.1 als deprecated markiert. Dieses Release entfernt sie vollständig.

- `vitest/coverage`: verwenden Sie stattdessen `vitest/node`
- `vitest/reporters`: verwenden Sie stattdessen `vitest/node`
- `vitest/environments`: verwenden Sie stattdessen `vitest/runtime`
- `vitest/snapshot`: verwenden Sie stattdessen `vitest/runtime`
- `vitest/runners`: verwenden Sie stattdessen `TestRunner` aus `vitest`
- `vitest/suite`: verwenden Sie stattdessen statische Methoden auf `TestRunner` aus vitest (zum Beispiel `TestRunner.getCurrentTest()`)
- `vitest/mocker` wurde vollständig entfernt, verwenden Sie direkt das Paket `@vitest/mocker` (es wurde einmal versehentlich veröffentlicht und nie entfernt)
- `vitest/internal/module-runner` wurde entfernt

## Migration von Jest {#jest}

Vitest wurde mit einer Jest-kompatiblen API entworfen, um die Migration von Jest so einfach wie möglich zu machen. Trotz dieser Bemühungen können Ihnen die folgenden Unterschiede begegnen:

### Globals als Standard

Jest hat seine [Globals-API](https://jestjs.io/docs/api) standardmäßig aktiviert. Vitest nicht. Sie können Globals entweder über [die Konfigurationseinstellung `globals`](/config/globals) aktivieren oder Ihren Code so anpassen, dass er stattdessen Importe aus dem Modul `vitest` verwendet.

Wenn Sie sich entscheiden, Globals deaktiviert zu lassen, beachten Sie, dass verbreitete Bibliotheken wie [`testing-library`](https://testing-library.com/) kein automatisches DOM-[Cleanup](https://testing-library.com/docs/svelte-testing-library/api/#cleanup) durchführen.

### `mock.mockReset`

Jests [`mockReset`](https://jestjs.io/docs/mock-function-api#mockfnmockreset) ersetzt die Mock-Implementierung durch eine
leere Funktion, die `undefined` zurückgibt.

Vitests [`mockReset`](/api/mock#mockreset) setzt die Mock-Implementierung auf ihr Original zurück.
Das heißt, das Zurücksetzen eines mit `vi.fn(impl)` erzeugten Mocks setzt die Mock-Implementierung auf `impl` zurück.

### `mock.mock` ist persistent

Jest erzeugt den Mock-Zustand beim Aufruf von `.mockClear` neu, weshalb Sie stets über einen Getter darauf zugreifen müssen. Vitest hingegen hält eine persistente Referenz auf den Zustand, sodass Sie ihn wiederverwenden können:

```ts
const mock = vi.fn()
const state = mock.mock
mock.mockClear()

expect(state).toBe(mock.mock) // fails in Jest
```

### Modul-Mocks

Beim Mocken eines Moduls in Jest ist der Rückgabewert des Factory-Arguments der Default-Export. In Vitest muss das Factory-Argument ein Objekt zurückgeben, in dem jeder Export explizit definiert ist. Das folgende `jest.mock` müsste zum Beispiel wie folgt angepasst werden:

```ts
jest.mock('./some-path', () => 'hello') // [!code --]
vi.mock('./some-path', () => ({ // [!code ++]
  default: 'hello', // [!code ++]
})) // [!code ++]
```

Weitere Details finden Sie im [API-Abschnitt zu `vi.mock`](/api/vi#vi-mock).

### Verhalten des Auto-Mockings

Anders als in Jest werden gemockte Module in `<root>/__mocks__` nicht geladen, sofern `vi.mock()` nicht aufgerufen wird. Wenn sie wie in Jest in jedem Test gemockt sein sollen, können Sie sie innerhalb von [`setupFiles`](/config/setupfiles) mocken.

### Das Original eines gemockten Pakets importieren

Wenn Sie ein Paket nur teilweise mocken, haben Sie zuvor vielleicht Jests Funktion `requireActual` verwendet. In Vitest sollten Sie diese Aufrufe durch `vi.importActual` ersetzen.

```ts
const { cloneDeep } = jest.requireActual('lodash/cloneDeep') // [!code --]
const { cloneDeep } = await vi.importActual('lodash/cloneDeep') // [!code ++]
```

### Mocking auf externe Bibliotheken ausdehnen

Wo Jest das standardmäßig tut, müssen Sie beim Mocken eines Moduls – wenn dieses Mocking auch für andere externe Bibliotheken gelten soll, die dasselbe Modul verwenden – explizit angeben, welche Drittanbieter-Bibliothek gemockt werden soll, damit die externe Bibliothek Teil Ihres Quellcodes wird; nutzen Sie dafür [server.deps.inline](/config/server#inline).

```
server.deps.inline: ["lib-name"]
```

### expect.getState().currentTestName

Vitests `test`-Namen werden mit einem `>`-Symbol verbunden, um Tests leichter von Suites unterscheiden zu können, während Jest ein Leerzeichen (` `) verwendet.

```diff
- `${describeTitle} ${testTitle}`
+ `${describeTitle} > ${testTitle}`
```

Dasselbe gilt für [`testNamePattern`](/config/testnamepattern) (das Flag `-t`): Vitest prüft gegen den mit `>` verbundenen vollständigen Namen, Jest gegen den mit Leerzeichen verbundenen Namen. Passen Sie Muster, die eine Suite und einen Test überspannen, entsprechend an, prüfen Sie ein einzelnes Segment (`-t adds`) oder verwenden Sie zwischen den Segmenten eine Wildcard (`-t 'math.*adds'`).

```diff
- vitest -t 'math adds'
+ vitest -t 'math > adds'
```

### Umgebungsvariablen

Genau wie Jest setzt Vitest `NODE_ENV` auf `test`, sofern es nicht bereits gesetzt war. Vitest hat außerdem ein Gegenstück zu `JEST_WORKER_ID` namens `VITEST_POOL_ID` (stets kleiner oder gleich `maxWorkers`); wenn Sie sich darauf stützen, vergessen Sie nicht, es umzubenennen. Vitest stellt zudem `VITEST_WORKER_ID` bereit, eine eindeutige ID eines laufenden Workers – diese Zahl wird von `maxWorkers` nicht beeinflusst und erhöht sich mit jedem erzeugten Worker.

### Eigenschaften ersetzen

Wenn Sie das Objekt verändern möchten, verwenden Sie in Jest die [replaceProperty-API](https://jestjs.io/docs/jest-object#jestreplacepropertyobject-propertykey-value); in Vitest erreichen Sie dasselbe mit [`vi.stubEnv`](/api/vi#vi-stubenv) oder [`vi.spyOn`](/api/vi#vi-spyon).

### Done-Callback

Vitest unterstützt den Callback-Stil zur Deklaration von Tests nicht. Sie können sie so umschreiben, dass sie `async`/`await`-Funktionen verwenden, oder mit einem Promise den Callback-Stil nachbilden.

<!--@include: ./examples/promise-done.md-->

### Hooks

`beforeAll`/`beforeEach`-Hooks dürfen in Vitest eine [Teardown-Funktion](/api/hooks#beforeach) zurückgeben. Deshalb müssen Sie Ihre Hook-Deklarationen möglicherweise umschreiben, wenn sie etwas anderes als `undefined` oder `null` zurückgeben:

```ts
beforeEach(() => setActivePinia(createTestingPinia())) // [!code --]
beforeEach(() => { setActivePinia(createTestingPinia()) }) // [!code ++]
```

In Jest werden Hooks sequenziell aufgerufen (einer nach dem anderen). Standardmäßig führt Vitest Hooks als Stack aus. Um Jests Verhalten zu erhalten, passen Sie die Option [`sequence.hooks`](/config/sequence#sequence-hooks) an:

```ts
export default defineConfig({
  test: {
    sequence: { // [!code ++]
      hooks: 'list', // [!code ++]
    } // [!code ++]
  }
})
```

### Typen

Vitest hat kein Gegenstück zum `jest`-Namensraum, daher müssen Sie Typen direkt aus `vitest` importieren:

```ts
let fn: jest.Mock<(name: string) => number> // [!code --]
import type { Mock } from 'vitest' // [!code ++]
let fn: Mock<(name: string) => number> // [!code ++]
```

### Timer

Vitest unterstützt Jests Legacy-Timer nicht.

### Timeout

Wenn Sie `jest.setTimeout` verwendet haben, müssen Sie zu `vi.setConfig` migrieren:

```ts
jest.setTimeout(5_000) // [!code --]
vi.setConfig({ testTimeout: 5_000 }) // [!code ++]
```

### Vue-Snapshots

Das ist keine Jest-spezifische Funktion, doch wenn Sie zuvor Jest mit dem vue-cli-Preset verwendet haben, müssen Sie das Paket [`jest-serializer-vue`](https://github.com/eddyerburgh/jest-serializer-vue) installieren und es in [`snapshotSerializers`](/config/snapshotserializers) angeben:

```js [vitest.config.js]
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    snapshotSerializers: ['jest-serializer-vue']
  }
})
```

Andernfalls enthalten Ihre Snapshots viele escapte `"`-Zeichen.

### Eigene Snapshot-Matcher <Experimental /> <Version>4.1.3</Version> {#custom-snapshot-matcher}

Jest importiert Snapshot-Composables aus `jest-snapshot`. Verwenden Sie in Vitest stattdessen `Snapshots` aus `vitest`:

```ts
const { toMatchSnapshot } = require('jest-snapshot') // [!code --]
import { Snapshots } from 'vitest' // [!code ++]
const { toMatchSnapshot } = Snapshots // [!code ++]

expect.extend({
  toMatchTrimmedSnapshot(received: string, length: number) {
    return toMatchSnapshot.call(this, received.slice(0, length))
  },
})
```

Für Inline-Snapshots gilt dasselbe:

```ts
const { toMatchInlineSnapshot } = require('jest-snapshot') // [!code --]
import { Snapshots } from 'vitest' // [!code ++]
const { toMatchInlineSnapshot } = Snapshots // [!code ++]

expect.extend({
  toMatchTrimmedInlineSnapshot(received: string, inlineSnapshot?: string) {
    return toMatchInlineSnapshot.call(this, received.slice(0, 10), inlineSnapshot)
  },
})
```

Den vollständigen Leitfaden finden Sie unter [Eigene Snapshot-Matcher](/guide/snapshot#custom-snapshot-matchers).

## Migration von Mocha + Chai + Sinon {#mocha-chai-sinon}

Vitest bietet ausgezeichnete Unterstützung für die Migration von Test-Suites aus Mocha+Chai+Sinon. Zwar verwendet Vitest standardmäßig eine Jest-kompatible API, es stellt aber auch Chai-artige Assertions für Spy-/Mock-Tests bereit, was die Migration erleichtert.

### Teststruktur

Mocha und Vitest haben ähnliche Teststrukturen, mit einigen Unterschieden:

```ts
// Mocha
describe('suite', () => {
  before(() => { /* setup */ })
  after(() => { /* teardown */ })
  beforeEach(() => { /* setup */ })
  afterEach(() => { /* teardown */ })

  it('test', () => {
    // test code
  })
})

// Vitest - same structure works!
import { afterAll, afterEach, beforeAll, beforeEach, describe, it } from 'vitest'

describe('suite', () => {
  beforeAll(() => { /* setup */ })
  afterAll(() => { /* teardown */ })
  beforeEach(() => { /* setup */ })
  afterEach(() => { /* teardown */ })

  it('test', () => {
    // test code
  })
})
```

### Assertions

Vitest bindet Chai-Assertions standardmäßig ein, sodass Chai-Assertions unverändert funktionieren:

```ts
// Both Mocha+Chai and Vitest
import { expect } from 'vitest' // or 'chai' in Mocha

expect(value).to.equal(42)
expect(value).to.be.true
expect(array).to.have.lengthOf(3)
expect(obj).to.have.property('key')
```

### Spy-/Mock-Assertions

Vitest bietet **Chai-artige Assertions** für Spies und Mocks, sodass Sie von Sinon migrieren können, ohne Assertions umzuschreiben:

```ts
// Before (Mocha + Chai + Sinon)
const sinon = require('sinon')
const chai = require('chai')
const sinonChai = require('sinon-chai')
chai.use(sinonChai)

const spy = sinon.spy(obj, 'method')
obj.method('arg1', 'arg2')

expect(spy).to.have.been.called
expect(spy).to.have.been.calledOnce
expect(spy).to.have.been.calledWith('arg1', 'arg2')

// After (Vitest) - same assertion syntax!
import { expect, vi } from 'vitest'

const spy = vi.spyOn(obj, 'method')
obj.method('arg1', 'arg2')

expect(spy).to.have.been.called
expect(spy).to.have.been.calledOnce
expect(spy).to.have.been.calledWith('arg1', 'arg2')
```

#### Vollständige Unterstützung Chai-artiger Assertions

Vitest unterstützt alle gängigen sinon-chai-Assertions:

| Sinon-Chai | Vitest | Beschreibung |
|------------|--------|-------------|
| `spy.called` | `called` | Spy wurde mindestens einmal aufgerufen |
| `spy.calledOnce` | `calledOnce` | Spy wurde genau einmal aufgerufen |
| `spy.calledTwice` | `calledTwice` | Spy wurde genau zweimal aufgerufen |
| `spy.calledThrice` | `calledThrice` | Spy wurde genau dreimal aufgerufen |
| `spy.callCount(n)` | `callCount(n)` | Spy wurde n-mal aufgerufen |
| `spy.calledWith(...)` | `calledWith(...)` | Spy wurde mit bestimmten Argumenten aufgerufen |
| `spy.calledOnceWith(...)` | `calledOnceWith(...)` | Spy wurde einmal mit bestimmten Argumenten aufgerufen |
| `spy.returned(value)` | `returned` | Spy gab einen bestimmten Wert zurück |

Die vollständige Liste finden Sie in der Dokumentation zu [Chai-artigen Spy-Assertions](/api/expect#chai-style-spy-assertions).

### Spies und Mocks erzeugen

Ersetzen Sie Sinons Erzeugung von Spies/Stubs/Mocks durch Vitests `vi`-Werkzeuge:

```ts
// Sinon
const sinon = require('sinon')
const spy = sinon.spy()
const stub = sinon.stub(obj, 'method')
const mock = sinon.mock(obj)

// Vitest
import { vi } from 'vitest'
const spy = vi.fn()
const stub = vi.spyOn(obj, 'method')
// Vitest doesn't have "mocks" - use spies instead
```

### Rückgabewerte stubben

```ts
// Sinon
stub.returns(42)
stub.onFirstCall().returns(1)
stub.onSecondCall().returns(2)

// Vitest
stub.mockReturnValue(42)
stub.mockReturnValueOnce(1)
stub.mockReturnValueOnce(2)
```

### Implementierungen stubben

```ts
// Sinon
stub.callsFake(arg => arg * 2)

// Vitest
stub.mockImplementation(arg => arg * 2)
```

### Spies wiederherstellen

```ts
// Sinon
spy.restore()
sinon.restore() // restore all

// Vitest
spy.mockRestore()
vi.restoreAllMocks() // restore all
```

### Timer

Sowohl Sinon als auch Vitest verwenden intern `@sinonjs/fake-timers`:

```ts
// Sinon
const clock = sinon.useFakeTimers()
clock.tick(1000)
clock.restore()

// Vitest
import { vi } from 'vitest'
vi.useFakeTimers()
vi.advanceTimersByTime(1000)
vi.useRealTimers()
```

### Wesentliche Unterschiede

1. **Globals**: Mocha stellt Globals standardmäßig bereit. Importieren Sie in Vitest entweder aus `vitest` oder aktivieren Sie die Konfiguration [`globals`](/config/globals)
2. **Assertion-Stil**: Sie können sowohl den Chai-Stil (`expect(spy).to.have.been.called`) als auch den Jest-Stil (`expect(spy).toHaveBeenCalled()`) verwenden
3. **Parallele Ausführung**: Vitest führt Tests standardmäßig parallel aus, Mocha sequenziell

Weitere Informationen finden Sie unter:
- [Chai-artige Spy-Assertions](/api/expect#chai-style-spy-assertions)
- [Mocking-Leitfaden](/guide/mocking)
- [Vi-API](/api/vi)
