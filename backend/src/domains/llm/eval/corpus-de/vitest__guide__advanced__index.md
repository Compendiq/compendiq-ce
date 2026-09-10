# Erste Schritte <Badge type="danger">advanced</Badge> {#getting-started}

::: warning
Diese Anleitung listet fortgeschrittene APIs auf, um Tests über ein Node.js-Skript auszuführen. Wenn Sie lediglich [Tests ausführen](/guide/) möchten, benötigen Sie das vermutlich nicht. Sie wird vor allem von Autorinnen und Autoren von Bibliotheken genutzt.
:::

Sie können jede Methode über den Entry-Point `vitest/node` importieren.

## startVitest

```ts
function startVitest(
  cliFilters: string[] = [],
  options: CliOptions = {},
  viteOverrides?: ViteUserConfig,
  vitestOptions?: VitestOptions,
): Promise<Vitest>
```

Sie können Vitest-Tests über dessen Node-API starten:

```js
import { startVitest } from 'vitest/node'

const vitest = await startVitest()

await vitest.close()
```

Die Funktion `startVitest` gibt eine [`Vitest`](/api/advanced/vitest)-Instanz zurück, sofern die Tests gestartet werden können.

Ist der Watch-Modus nicht aktiviert, ruft Vitest die Methode `close` automatisch auf.

Ist der Watch-Modus aktiviert und unterstützt das Terminal TTY, registriert Vitest Tastenkürzel für die Konsole.

Als zweites Argument können Sie eine Liste von Filtern übergeben. Vitest führt dann nur Tests aus, deren Dateipfad mindestens einen der übergebenen Strings enthält.

Zusätzlich können Sie über das dritte Argument CLI-Argumente übergeben, die alle Optionen der Testkonfiguration überschreiben. Alternativ können Sie die vollständige Vite-Konfiguration als viertes Argument übergeben; sie hat Vorrang vor allen anderen nutzerdefinierten Optionen.

Nach dem Ausführen der Tests erhalten Sie die Ergebnisse über die API [`state.getTestModules`](/api/advanced/test-module):

```ts
import type { TestModule } from 'vitest/node'

const vitest = await startVitest()

console.log(vitest.state.getTestModules()) // [TestModule]
```

::: tip
Die Anleitung [„Tests ausführen“](/guide/advanced/tests#startvitest) enthält ein Anwendungsbeispiel.
:::

## createVitest

```ts
function createVitest(
  options: CliOptions,
  viteOverrides: ViteUserConfig = {},
  vitestOptions: VitestOptions = {},
): Promise<Vitest>
```

Mit der Funktion `createVitest` können Sie eine Vitest-Instanz erzeugen. Sie gibt dieselbe [`Vitest`](/api/advanced/vitest)-Instanz zurück wie `startVitest`, startet jedoch keine Tests und validiert die installierten Pakete nicht.

```js
import { createVitest } from 'vitest/node'

const vitest = await createVitest('test', {
  watch: false,
})
```

::: tip
Die Anleitung [„Tests ausführen“](/guide/advanced/tests#createvitest) enthält ein Anwendungsbeispiel.
:::

## resolveConfig

```ts
function resolveConfig(
  options: UserConfig = {},
  viteOverrides: ViteUserConfig = {},
  harness?: PluginHarness,
): Promise<ResolvedViteConfig>
```

Diese Methode löst die Konfiguration mit eigenen Parametern auf, ohne einen Vite-Server zu erzeugen. Werden keine Parameter angegeben, ist `root` gleich `process.cwd()`.

Sie gibt die aufgelöste Vite-Konfiguration zurück. Die vollständig aufgelöste Vitest-Konfiguration, einschließlich jedes Projekts, liegt in deren Eigenschaft `test`.

```ts
import { resolveConfig } from 'vitest/node'

const viteConfig = await resolveConfig({
  mode: 'custom',
  configFile: false,
  resolve: {
    conditions: ['custom']
  },
  test: {
    setupFiles: ['/my-setup-file.js'],
    pool: 'threads',
  },
})

viteConfig.test.pool // 'threads'
```

::: info
Dies ist dieselbe Methode, die Vitest intern verwendet, um die Konfiguration vor dem Erzeugen des Servers aufzulösen. Wenn Sie die Optionen an `startVitest` oder `createVitest` weiterreichen, löst Vitest sie erneut auf.

Sie können als drittes Argument ein gemeinsam genutztes [`PluginHarness`](#pluginharness) übergeben, um Logger und Package-Installer über mehrere Aufrufe hinweg wiederzuverwenden.
:::

## Auflösung der Projektkonfiguration

Dieser Abschnitt beschreibt, wie die Argumente von `startVitest`, `createVitest` und `resolveConfig` mit [Testprojekten](/guide/projects) zusammenspielen. Ohne Projekte gelten alle aufgelösten Optionen für das einzige Root-Projekt und nichts davon spielt eine Rolle.

Die Root-Konfiguration wird aus drei Quellen aufgelöst, in aufsteigender Priorität:

1. der Root-Konfigurationsdatei
2. `viteOverrides`, die über die Werte der Konfigurationsdatei gemergt werden
3. CLI-Optionen (`options`), die über allem anderen angewendet werden

Jedes Projekt löst anschließend seine eigene Vite-Konfiguration unabhängig auf:

- Ein Projekt, das als Konfigurationsdatei oder als Verzeichnis referenziert wird, löst nur seine eigene Datei auf. Es erbt keine Optionen aus der Root-Konfiguration.
- Ein Inline-Projekt erbt standardmäßig die Root-Konfiguration (siehe [`extends`](/guide/projects#configuration)): Die Root-Konfigurationsdatei wird für das Projekt erneut ausgeführt, `viteOverrides` werden darüber gemergt und die eigenen Optionen des Projekts zuletzt. Die Vererbung funktioniert auch dann, wenn es keine Root-Konfigurationsdatei gibt, weil `viteOverrides` Teil der effektiven Root-Konfiguration sind.
- Mit `extends: false` löst ein Inline-Projekt nur seine eigenen Optionen auf. Mit `extends: './path'` wird die referenzierte Datei anstelle der Root-Konfigurationsdatei erneut ausgeführt, und `viteOverrides` werden nicht gemergt.

Einige Optionen sind von der Vererbung ausgenommen:

- `plugins` aus `viteOverrides` werden nie vererbt. Eine Konfigurationsdatei wird für jedes Projekt erneut ausgeführt, wodurch frische Plugin-Instanzen entstehen; in `viteOverrides` übergebene Plugin-Instanzen gehören jedoch zum Root-Vite-Server und lassen sich nicht mit den Projekt-Servern teilen.
- `test.browser` und `test.tagsFilter` aus `viteOverrides` werden nie vererbt: `browser` beschreibt die Instanzen eines einzelnen Projekts, und `tagsFilter` gilt für den gesamten Lauf.
- `name` und `projects` werden nie vererbt; das Root-`globalSetup` wird nicht vererbt, weil es ohnehin einmal pro Testlauf ausgeführt wird.
- Die eigenen `tags` eines Projekts ersetzen stets das aus einer erweiterten Konfiguration gemergte `tags`-Array, statt damit verkettet zu werden, sodass dieselben Tag-Namen neu definiert werden können.

Unabhängig von `extends` erreichen zwei Gruppen von Optionen jedes Projekt:

- Eine feste Teilmenge von CLI-Optionen, die konfigurieren, wie Tests laufen (`--testTimeout`, `--retry`, `--pool` und ähnliche), wird auf jedes Projekt mit höchster Priorität angewendet und spiegelt damit die Root-Auflösung.
- Optionen auf Lauf-Ebene ergeben nur für den Testlauf als Ganzes Sinn: Jedes Projekt erhält die aufgelösten Werte des Roots für `coverage`, `attachmentsDir` und `mergeReportsLabel`.

## parseCLI

```ts
function parseCLI(argv: string | string[], config: CliParseOptions = {}): {
  filter: string[]
  options: CliOptions
}
```

Mit dieser Methode können Sie CLI-Argumente parsen. Sie akzeptiert einen String (in dem Argumente durch ein einzelnes Leerzeichen getrennt sind) oder ein String-Array von CLI-Argumenten im selben Format, das die Vitest-CLI verwendet. Sie gibt einen Filter sowie `options` zurück, die Sie später an die Methoden `createVitest` oder `startVitest` weiterreichen können.

```ts
import { parseCLI } from 'vitest/node'

const result = parseCLI('vitest ./files.ts --coverage --browser=chrome')

result.options
// {
//   coverage: { enabled: true },
//   browser: { name: 'chrome', enabled: true }
// }

result.filter
// ['./files.ts']
```

## createCLI

```ts
function createCLI(options?: CliParseOptions): CAC
```

Erzeugt die Kommandozeilenschnittstelle von Vitest: eine [`cac`](https://github.com/cacjs/cac)-Instanz mit allen registrierten Befehlen und Optionen von Vitest. [`parseCLI`](#parsecli) baut darauf auf; verwenden Sie `createCLI` direkt, wenn Sie den rohen Parser benötigen.

```ts
import { createCLI } from 'vitest/node'

const cli = createCLI()
```

## PluginHarness

```ts
class PluginHarness {
  vitest?: Vitest
  version: string
  logger: Logger
  packageInstaller: VitestPackageInstaller
  getVitest(): Vitest
}
```

Ein Container, den Vitest während der Auflösung der Konfiguration an seine internen Plugins übergibt, bevor eine [`Vitest`](/api/advanced/vitest)-Instanz existiert. Er hält den [`Logger`](#logger), den Package-Installer und die aufgelöste Version und stellt die `Vitest`-Instanz über `getVitest()` bereit, sobald sie erzeugt wurde (ein früherer Aufruf wirft einen Fehler).

Dies ist eine fortgeschrittene, an Plugins gerichtete API. Sie erzeugen selten selbst eine Instanz, können aber eine gemeinsam genutzte Instanz an [`resolveConfig`](#resolveconfig) übergeben, um Logger und Package-Installer wiederzuverwenden.

## Logger

```ts
class Logger {
  constructor(
    outputStream?: Writable,
    errorStream?: Writable,
  )
}
```

Der Terminal-Logger von Vitest, verfügbar als [`vitest.logger`](/api/advanced/vitest). Er kümmert sich um formatierte Ausgaben, die Fehlerzusammenfassung, das Run-Banner und das Löschen des Bildschirms. Erzeugen Sie eine Instanz mit eigenen `stdout`/`stderr`-Streams, um Vitests Ausgabe bei programmatischer Ausführung abzufangen oder umzuleiten.

```ts
import { Logger } from 'vitest/node'

const logger = new Logger(process.stdout, process.stderr)
```
