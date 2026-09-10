# Vitest

## mode <Deprecated /> {#mode}

Seit Vitest 5 ist diese Eigenschaft immer `'test'`.

## config

Die Root-Konfiguration (oder globale Konfiguration). Wenn Projekte definiert sind, referenzieren sie diese als `globalConfig`.

::: warning
Das ist die Vitest-Konfiguration; sie erweitert nicht die _Vite_-Konfiguration. Sie enthält nur aufgelöste Werte aus der Eigenschaft `test`.
:::

## vite

Dies ist ein globaler [`ViteDevServer`](https://vite.dev/guide/api-javascript#vitedevserver).

## state <Experimental /> {#state}

::: warning
Das öffentliche `state` ist eine experimentelle API (außer `vitest.state.getReportedEntity`). Breaking Changes folgen möglicherweise nicht SemVer; pinnen Sie bei der Verwendung bitte die Vitest-Version.
:::

Der globale Zustand speichert Informationen über die aktuellen Tests. Er verwendet standardmäßig die interne, serialisierbare Task-API, aber wir empfehlen stattdessen die [Reported Tasks API](/api/advanced/reporters#reported-tasks) über den Aufruf von `state.getReportedEntity()`:

```ts
const task = vitest.state.idMap.get(taskId) // old API
const testCase = vitest.state.getReportedEntity(task) // new API
```

In Zukunft wird die alte API nicht mehr bereitgestellt.

## snapshot

Der globale Snapshot-Manager. Vitest verfolgt alle Snapshots über die Methode `snapshot.add`.

Die aktuellste Zusammenfassung der Snapshots erhalten Sie über die Eigenschaft `vitest.snapshot.summary`.

## cache

Cache-Manager, der Informationen über die letzten Testergebnisse und Statistiken zu Testdateien speichert. In Vitest selbst wird er nur vom Standard-Sequencer verwendet, um Tests zu sortieren.

## watcher <Version>4.0.0</Version> {#watcher}

Die Instanz eines Vitest-Watchers mit nützlichen Methoden, um Dateiänderungen zu verfolgen und Tests erneut auszuführen. Sie können `onFileChange`, `onFileDelete` oder `onFileCreate` mit Ihrem eigenen Watcher verwenden, wenn der eingebaute Watcher deaktiviert ist.

## projects

Ein Array von [Testprojekten](/api/advanced/test-project), die zu den Projekten des Anwenders gehören. Wenn der Anwender keine angegeben hat, enthält dieses Array nur ein [Root-Projekt](#getrootproject).

Vitest stellt sicher, dass sich immer mindestens ein Projekt in diesem Array befindet. Gibt der Anwender einen nicht existierenden `--project`-Namen an, wirft Vitest einen Fehler, bevor dieses Array definiert ist.

## getRootProject

```ts
function getRootProject(): TestProject
```

Dies gibt das Root-Testprojekt zurück. Das Root-Projekt führt in der Regel keine Tests aus und ist nicht in `vitest.projects` enthalten, es sei denn, der Anwender bindet die Root-Konfiguration ausdrücklich in seine Konfiguration ein oder es sind überhaupt keine Projekte definiert.

Das Hauptziel des Root-Projekts ist es, die globale Konfiguration einzurichten. Tatsächlich referenziert `rootProject.config` direkt `rootProject.globalConfig` und `vitest.config`:

```ts
rootProject.config === rootProject.globalConfig === rootProject.vitest.config
```

## provide

```ts
function provide<T extends keyof ProvidedContext & string>(
  key: T,
  value: ProvidedContext[T],
): void
```

Vitest stellt die Methode `provide` bereit, eine Kurzform für `vitest.getRootProject().provide`. Mit dieser Methode können Sie Werte vom Hauptthread an die Tests weiterreichen. Alle Werte werden vor dem Speichern mit `structuredClone` geprüft, die Werte selbst werden jedoch nicht geklont.

Um die Werte im Test zu empfangen, müssen Sie die Methode `inject` aus dem `vitest`-Einstiegspunkt importieren:

```ts
import { inject } from 'vitest'
const port = inject('wsPort') // 3000
```

Für bessere Typsicherheit empfehlen wir Ihnen, den Typ von `ProvidedContext` zu erweitern:

```ts
import { createVitest } from 'vitest/node'

const vitest = await createVitest('test', {
  watch: false,
})
vitest.provide('wsPort', 3000)

declare module 'vitest' {
  export interface ProvidedContext {
    wsPort: number
  }
}
```

::: warning
Technisch gesehen ist `provide` eine Methode von [`TestProject`](/api/advanced/test-project) und damit auf das jeweilige Projekt beschränkt. Alle Projekte erben jedoch die Werte des Root-Projekts, was `vitest.provide` zu einem universellen Weg macht, Werte an Tests weiterzureichen.
:::

## getProvidedContext

```ts
function getProvidedContext(): ProvidedContext
```

Dies gibt das Root-Kontextobjekt zurück. Es ist eine Kurzform für `vitest.getRootProject().getProvidedContext`.

## getProjectByName

```ts
function getProjectByName(name: string): TestProject
```

Diese Methode gibt das Projekt anhand seines Namens zurück. Ähnlich wie der Aufruf von `vitest.projects.find`.

::: warning
Falls das Projekt nicht existiert, gibt diese Methode das Root-Projekt zurück – prüfen Sie die Namen noch einmal, um sicherzugehen, dass das zurückgegebene Projekt das gesuchte ist.

Hat der Anwender keinen Namen festgelegt, weist Vitest eine leere Zeichenkette als Namen zu.
:::

## globTestSpecifications

```ts
function globTestSpecifications(
  filters?: string[],
): Promise<TestSpecification[]>
```

Diese Methode konstruiert neue [Test-Specifications](/api/advanced/test-specification), indem sie mit [`project.globTestFiles`](/api/advanced/test-project#globtestfiles) jeden Test in allen Projekten erfasst. Sie akzeptiert String-Filter zum Abgleich der Testdateien – es sind dieselben Filter, die auch [die CLI unterstützt](/guide/filtering#cli).

Diese Methode cacht alle Test-Specifications automatisch. Wenn Sie das nächste Mal [`getModuleSpecifications`](#getmodulespecifications) aufrufen, gibt sie dieselben Specifications zurück, sofern nicht zuvor [`clearSpecificationsCache`](#clearspecificationscache) aufgerufen wurde.

::: warning
Seit Vitest 3 ist es möglich, mehrere Test-Specifications mit derselben Modul-ID (Dateipfad) zu haben, wenn `poolMatchGlob` mehrere Pools hat oder wenn `typecheck` aktiviert ist. Diese Möglichkeit wird in Vitest 4 entfernt.
:::

```ts
const specifications = await vitest.globTestSpecifications(['my-filter'])
// [TestSpecification{ moduleId: '/tests/my-filter.test.ts' }]
console.log(specifications)
```

## getRelevantTestSpecifications

```ts
function getRelevantTestSpecifications(
  filters?: string[]
): Promise<TestSpecification[]>
```

Diese Methode löst jede Test-Specification auf, indem sie [`project.globTestFiles`](/api/advanced/test-project#globtestfiles) aufruft. Sie akzeptiert String-Filter zum Abgleich der Testdateien – es sind dieselben Filter, die auch [die CLI unterstützt](/guide/filtering#cli). Wurde das Flag `--changed` angegeben, wird die Liste so gefiltert, dass sie nur geänderte Dateien enthält. `getRelevantTestSpecifications` führt keine Testdateien aus.

::: warning
Diese Methode kann langsam sein, weil sie `--changed`-Flags filtern muss. Verwenden Sie sie nicht, wenn Sie nur eine Liste der Testdateien brauchen.

- Wenn Sie die Liste der Specifications für bekannte Testdateien brauchen, verwenden Sie stattdessen [`getModuleSpecifications`](#getmodulespecifications).
- Wenn Sie die Liste aller möglichen Testdateien brauchen, verwenden Sie [`globTestSpecifications`](#globtestspecifications).
:::

## mergeReports

```ts
function mergeReports(directory?: string): Promise<TestRunResult>
```

Führt Berichte mehrerer Läufe zusammen, die im angegebenen Verzeichnis liegen (Wert aus `--merge-reports`, falls nicht angegeben). Dieser Wert kann auch über `config.mergeReports` gesetzt werden (standardmäßig wird der Ordner `.vitest/blob/` gelesen).

Beachten Sie, dass `directory` immer relativ zum Arbeitsverzeichnis aufgelöst wird.

Diese Methode wird von [`startVitest`](/guide/advanced/tests) automatisch aufgerufen, wenn `config.mergeReports` gesetzt ist.

## collect

```ts
function collect(filters?: string[]): Promise<TestRunResult>
```

Führt Testdateien aus, ohne die Test-Callbacks laufen zu lassen. `collect` gibt unbehandelte Fehler und ein Array von [Testmodulen](/api/advanced/test-module) zurück. Es akzeptiert String-Filter zum Abgleich der Testdateien – es sind dieselben Filter, die auch [die CLI unterstützt](/guide/filtering#cli).

Diese Methode löst Test-Specifications anhand der Konfigurationswerte `include`, `exclude` und `includeSource` auf. Mehr dazu unter [`project.globTestFiles`](/api/advanced/test-project#globtestfiles). Wurde das Flag `--changed` angegeben, wird die Liste so gefiltert, dass sie nur geänderte Dateien enthält.

::: warning
Beachten Sie, dass Vitest keine statische Analyse verwendet, um Tests zu erfassen. Vitest führt jede Testdatei isoliert aus, genau wie es reguläre Tests ausführt.

Das macht diese Methode sehr langsam, sofern Sie die Isolation vor dem Erfassen der Tests nicht deaktivieren.
:::

## start

```ts
function start(filters?: string[]): Promise<TestRunResult>
```

Initialisiert Reporter und den Coverage-Provider und führt die Tests aus. Diese Methode akzeptiert String-Filter zum Abgleich der Testdateien – es sind dieselben Filter, die auch [die CLI unterstützt](/guide/filtering#cli).

::: warning
Diese Methode sollte nicht aufgerufen werden, wenn auch [`vitest.standalone()`](#standalone) aufgerufen wird. Verwenden Sie stattdessen [`runTestSpecifications`](#runtestspecifications) oder [`rerunTestSpecifications`](#reruntestspecifications), wenn Sie Tests ausführen müssen, nachdem Vitest initialisiert wurde.
:::

Diese Methode wird von [`startVitest`](/guide/advanced/tests) automatisch aufgerufen, wenn `config.mergeReports` und `config.standalone` nicht gesetzt sind.

## standalone <Version type="experimental">4.1.1</Version> {#standalone}

```ts
function standalone(): Promise<void>
```

- **Alias:** `init` <Deprecated />

Initialisiert Reporter und den Coverage-Provider. Diese Methode führt keine Tests aus. Ist das Flag `--watch` angegeben, führt Vitest geänderte Tests dennoch aus, selbst wenn diese Methode nicht aufgerufen wurde.

Intern wird diese Methode nur aufgerufen, wenn das Flag [`--standalone`](/guide/cli#standalone) aktiviert ist.

::: warning
Diese Methode sollte nicht aufgerufen werden, wenn auch [`vitest.start()`](#start) aufgerufen wird.
:::

Diese Methode wird von [`startVitest`](/guide/advanced/tests) automatisch aufgerufen, wenn `config.standalone` gesetzt ist.

## getModuleSpecifications

```ts
function getModuleSpecifications(moduleId: string): TestSpecification[]
```

Gibt eine Liste von Test-Specifications zurück, die zu der Modul-ID gehören. Die ID sollte bereits zu einem absoluten Dateipfad aufgelöst sein. Passt die ID nicht auf die Muster `include` oder `includeSource`, ist das zurückgegebene Array leer.

Diese Methode kann bereits gecachte Specifications auf Basis von `moduleId` und `pool` zurückgeben. Beachten Sie aber, dass [`project.createSpecification`](/api/advanced/test-project#createspecification) immer eine neue Instanz zurückgibt und nicht automatisch gecacht wird. Specifications werden jedoch automatisch gecacht, wenn [`runTestSpecifications`](#runtestspecifications) aufgerufen wird.

::: warning
Seit Vitest 3 verwendet diese Methode einen Cache, um zu prüfen, ob die Datei ein Test ist. Um sicherzustellen, dass der Cache nicht leer ist, rufen Sie [`globTestSpecifications`](#globtestspecifications) mindestens einmal auf.
:::

## clearSpecificationsCache

```ts
function clearSpecificationsCache(moduleId?: string): void
```

Vitest cacht Test-Specifications für jede Datei automatisch, wenn [`globTestSpecifications`](#globtestspecifications) oder [`runTestSpecifications`](#runtestspecifications) aufgerufen wird. Diese Methode leert den Cache für die angegebene Datei oder – abhängig vom ersten Argument – den gesamten Cache.

## runTestSpecifications

```ts
function runTestSpecifications(
  specifications: TestSpecification[],
  allTestsRun = false
): Promise<TestRunResult>
```

Diese Methode führt jeden Test auf Basis der übergebenen [Specifications](/api/advanced/test-specification) aus. Das zweite Argument, `allTestsRun`, wird vom Coverage-Provider verwendet, um zu entscheiden, ob nicht abgedeckte Dateien in den Bericht aufgenommen werden müssen.

::: warning
Diese Methode löst die Callbacks `onWatcherRerun`, `onWatcherStart` und `onTestsRerun` nicht aus. Wenn Sie Tests aufgrund einer Dateiänderung erneut ausführen, erwägen Sie stattdessen [`rerunTestSpecifications`](#reruntestspecifications).
:::

## rerunTestSpecifications

```ts
function rerunTestSpecifications(
  specifications: TestSpecification[],
  allTestsRun = false
): Promise<TestRunResult>
```

Diese Methode löst die Events `reporter.onWatcherRerun` und `onTestsRerun` aus und führt die Tests dann mit [`runTestSpecifications`](#runtestspecifications) aus. Gab es im Hauptprozess keine Fehler, löst sie das Event `reporter.onWatcherStart` aus.

## runTestFiles <Version>4.1.0</Version> {#runtestfiles}

```ts
function runTestFiles(
  filepaths: string[],
  allTestsRun = false
): Promise<TestRunResult>
```

Dies erzeugt automatisch die auszuführenden Specifications auf Basis von Dateipfadfiltern.

Das unterscheidet sich von [`start`](#start), weil es keinen Coverage-Provider erzeugt, die Events `onInit` und `onWatcherStart` nicht auslöst und keinen Fehler wirft, wenn es keine Dateien zum Ausführen gibt (in diesem Fall gibt die Funktion leere Arrays zurück, ohne einen Testlauf auszulösen).

Diese Funktion akzeptiert dieselben Filter wie [`start`](#start) und die CLI.

## updateSnapshot

```ts
function updateSnapshot(files?: string[]): Promise<TestRunResult>
```

Aktualisiert Snapshots in den angegebenen Dateien. Werden keine Dateien angegeben, werden Dateien mit fehlgeschlagenen Tests und veralteten Snapshots aktualisiert.

## collectTests

```ts
function collectTests(
  specifications: TestSpecification[]
): Promise<TestRunResult>
```

Führt Testdateien aus, ohne die Test-Callbacks laufen zu lassen. `collectTests` gibt unbehandelte Fehler und ein Array von [Testmodulen](/api/advanced/test-module) zurück.

Diese Methode funktioniert genau wie [`collect`](#collect), Sie müssen die Test-Specifications jedoch selbst bereitstellen.

::: warning
Beachten Sie, dass Vitest keine statische Analyse verwendet, um Tests zu erfassen. Vitest führt jede Testdatei isoliert aus, genau wie es reguläre Tests ausführt.

Das macht diese Methode sehr langsam, sofern Sie die Isolation vor dem Erfassen der Tests nicht deaktivieren.
:::

## cancelCurrentRun

```ts
function cancelCurrentRun(reason: CancelReason): Promise<void>
```

Diese Methode bricht alle laufenden Tests kontrolliert ab. Sie stoppt die laufenden Tests und führt keine Tests aus, die zwar eingeplant waren, aber noch nicht begonnen haben.

## setGlobalTestNamePattern

```ts
function setGlobalTestNamePattern(pattern: string | RegExp): void
```

Diese Methode überschreibt das globale [Testnamen-Muster](/config/testnamepattern).

::: warning
Diese Methode startet keinen Testlauf. Um Tests mit dem aktualisierten Muster auszuführen, rufen Sie [`runTestSpecifications`](#runtestspecifications) auf.
:::

## getGlobalTestNamePattern <Version>4.0.0</Version> {#getglobaltestnamepattern}

```ts
function getGlobalTestNamePattern(): RegExp | undefined
```

Gibt den regulären Ausdruck zurück, der für das globale Testnamen-Muster verwendet wird.

## resetGlobalTestNamePattern

```ts
function resetGlobalTestNamePattern(): void
```

Diese Methode setzt das [Testnamen-Muster](/config/testnamepattern) zurück. Das bedeutet, dass Vitest nun keine Tests mehr überspringt.

::: warning
Diese Methode startet keinen Testlauf. Um Tests ohne Muster auszuführen, rufen Sie [`runTestSpecifications`](#runtestspecifications) auf.
:::

## enableSnapshotUpdate

```ts
function enableSnapshotUpdate(): void
```

Aktiviert den Modus, in dem Snapshots beim Ausführen von Tests aktualisiert werden dürfen. Jeder Test, der nach dem Aufruf dieser Methode läuft, aktualisiert Snapshots. Um den Modus zu deaktivieren, rufen Sie [`resetSnapshotUpdate`](#resetsnapshotupdate) auf.

::: warning
Diese Methode startet keinen Testlauf. Um Snapshots zu aktualisieren, führen Sie Tests mit [`runTestSpecifications`](#runtestspecifications) aus.
:::

## resetSnapshotUpdate

```ts
function resetSnapshotUpdate(): void
```

Deaktiviert den Modus, in dem Snapshots beim Ausführen von Tests aktualisiert werden dürfen. Diese Methode startet keinen Testlauf.

## invalidateFile

```ts
function invalidateFile(filepath: string): void
```

Diese Methode invalidiert die Datei im Cache jedes Projekts. Sie ist vor allem nützlich, wenn Sie sich auf Ihren eigenen Watcher verlassen, weil Vites Cache im Speicher bestehen bleibt.

::: danger
Wenn Sie Vitests Watcher deaktivieren, Vitest aber weiterlaufen lassen, ist es wichtig, den Cache mit dieser Methode manuell zu leeren, da es keine Möglichkeit gibt, den Cache zu deaktivieren. Diese Methode invalidiert auch die Importeure der Datei.
:::

## import

<!--@include: ./import-example.md-->

Importiert eine Datei mit Vites Module Runner. Die Datei wird von Vite mit der globalen Konfiguration transformiert und in einem separaten Kontext ausgeführt. Beachten Sie, dass `moduleId` relativ zu `config.root` ist.

::: danger
`project.import` verwendet Vites Modulgraphen wieder, sodass das Importieren desselben Moduls per gewöhnlichem Import ein anderes Modul zurückgibt:

```ts
import * as staticExample from './example.js'
const dynamicExample = await vitest.import('./example.js')

dynamicExample !== staticExample // ✅
```
:::

::: info
Intern verwendet Vitest diese Methode, um globale Setups, eigene Coverage-Provider und eigene Reporter zu importieren, was bedeutet, dass sie alle denselben Modulgraphen teilen, solange sie zum selben Vite-Server gehören.
:::

## close

```ts
function close(): Promise<void>
```

Schließt alle Projekte und die zugehörigen Ressourcen. Dies kann nur einmal aufgerufen werden; das Schließ-Promise wird gecacht, bis der Server neu startet.

## exit

```ts
function exit(force = false): Promise<void>
```

Schließt alle Projekte und beendet den Prozess. Ist `force` auf `true` gesetzt, wird der Prozess unmittelbar nach dem Schließen der Projekte beendet.

Diese Methode ruft außerdem zwangsweise `process.exit()` auf, wenn der Prozess nach [`config.teardownTimeout`](/config/teardowntimeout) Millisekunden noch aktiv ist.

## shouldKeepServer

```ts
function shouldKeepServer(): boolean
```

Diese Methode gibt `true` zurück, wenn der Server nach Abschluss der Tests weiterlaufen soll. Das bedeutet in der Regel, dass der `watch`-Modus aktiviert war.

## onServerRestart

```ts
function onServerRestart(fn: OnServerRestartHandler): void
```

Registriert einen Handler, der aufgerufen wird, wenn der Server aufgrund einer Konfigurationsänderung neu startet.

## onCancel

```ts
function onCancel(fn: (reason: CancelReason) => Awaitable<void>): () => void
```

Registriert einen Handler, der aufgerufen wird, wenn der Testlauf mit [`vitest.cancelCurrentRun`](#cancelcurrentrun) abgebrochen wird.

Seit 4.0.10 gibt `onCancel` experimentell eine Teardown-Funktion zurück, die den Listener entfernt. Seit 4.1.0 gilt dieses Verhalten als stabil.

## onClose

```ts
function onClose(fn: () => Awaitable<void>): void
```

Registriert einen Handler, der aufgerufen wird, wenn der Server geschlossen wird.

## onTestsRerun

```ts
function onTestsRerun(fn: OnTestsRerunHandler): void
```

Registriert einen Handler, der aufgerufen wird, wenn die Tests erneut ausgeführt werden. Tests können erneut laufen, wenn [`rerunTestSpecifications`](#reruntestspecifications) manuell aufgerufen wird oder wenn eine Datei geändert wird und der eingebaute Watcher einen erneuten Lauf einplant.

## onFilterWatchedSpecification

```ts
function onFilterWatchedSpecification(
  fn: (specification: TestSpecification) => boolean
): void
```
Registriert einen Handler, der aufgerufen wird, wenn eine Datei geändert wird. Dieser Callback sollte `true` oder `false` zurückgeben und damit angeben, ob die Testdatei erneut ausgeführt werden muss.

Mit dieser Methode können Sie sich in die Standardlogik des Watchers einklinken, um Tests zu verzögern oder zu verwerfen, die der Anwender im Moment nicht verfolgen möchte:

```ts
const continuesTests: string[] = []

myCustomWrapper.onContinuesRunEnabled(testItem =>
  continuesTests.push(item.fsPath)
)

vitest.onFilterWatchedSpecification(specification =>
  continuesTests.includes(specification.moduleId)
)
```

Vitest kann je nach den Optionen `pool` oder `locations` unterschiedliche Specifications für dieselbe Datei erzeugen; verlassen Sie sich daher nicht auf die Referenz. Vitest kann auch eine gecachte Specification aus [`vitest.getModuleSpecifications`](#getmodulespecifications) zurückgeben – der Cache basiert auf `moduleId` und `pool`. Beachten Sie, dass [`project.createSpecification`](/api/advanced/test-project#createspecification) immer eine neue Instanz zurückgibt.

## matchesProjectFilter <Version>3.1.0</Version> {#matchesprojectfilter}

```ts
function matchesProjectFilter(name: string): boolean
```

Prüft, ob der Name auf den aktuellen [Projektfilter](/guide/cli#project) passt. Gibt es keinen Projektfilter, gibt dies immer `true` zurück.

Es ist nicht möglich, die CLI-Option `--project` programmatisch zu ändern.

## waitForTestRunEnd <Version>4.0.0</Version> {#waitfortestrunend}

```ts
function waitForTestRunEnd(): Promise<void>
```

Läuft gerade ein Testlauf, gibt dies ein Promise zurück, das erfüllt wird, wenn der Testlauf abgeschlossen ist.

## createCoverageProvider <Version>4.0.0</Version> {#createcoverageprovider}

```ts
function createCoverageProvider(): Promise<CoverageProvider | null>
```

Erzeugt einen Coverage-Provider, wenn `coverage` in der Konfiguration aktiviert ist. Das geschieht automatisch, wenn Sie Tests mit den Methoden [`start`](#start) oder [`standalone`](#standalone) ausführen.

::: warning
Diese Methode löscht außerdem alle vorherigen Berichte, wenn [`coverage.clean`](/config/coverage#coverage-clean) nicht auf `false` gesetzt ist.
:::

## enableCoverage <Version>4.0.0</Version> {#enablecoverage}

```ts
function enableCoverage(): Promise<void>
```

Diese Methode aktiviert Coverage für Tests, die nach diesem Aufruf laufen. `enableCoverage` führt keine Tests aus; es richtet Vitest lediglich für das Sammeln von Coverage ein.

Sie erzeugt einen neuen Coverage-Provider, falls noch keiner existiert.

## disableCoverage <Version>4.0.0</Version> {#disablecoverage}

```ts
function disableCoverage(): void
```

Diese Methode deaktiviert das Sammeln von Coverage für Tests, die danach laufen.

## getSeed <Version>4.0.0</Version> {#getseed}

```ts
function getSeed(): number | null
```

Gibt den Seed zurück, wenn Tests in zufälliger Reihenfolge laufen.

## experimental_parseSpecification <Version type="experimental">4.0.0</Version> <Experimental /> {#parsespecification}

```ts
function experimental_parseSpecification(
  specification: TestSpecification
): Promise<TestModule>
```

Diese Funktion erfasst alle Tests innerhalb der Datei, ohne sie auszuführen. Sie verwendet Rollups Funktion `parseAst` auf Basis von Vites `ssrTransform`, um die Datei statisch zu analysieren und alle Tests zu erfassen, die sie erfassen kann.

::: warning
Konnte Vitest den Namen des Tests nicht analysieren, fügt es dem Test oder der Suite die Eigenschaft `dynamic: true` hinzu. Die `id` erhält außerdem den Zusatz `-dynamic`, um korrekt erfasste Tests nicht zu beschädigen.

Vitest fügt diese Eigenschaft immer bei Tests mit dem Modifikator `for` oder `each` sowie bei Tests mit dynamischem Namen ein (etwa `hello ${property}` oder `'hello' + ${property}`). Vitest weist dem Test dennoch einen Namen zu, aber dieser kann nicht zum Filtern von Tests verwendet werden.

Vitest kann nichts tun, um das Filtern dynamischer Tests zu ermöglichen, aber Sie können einen Test mit dem Modifikator `for` oder `each` mit der Funktion `escapeTestName` in ein Namensmuster verwandeln:

```ts
import { escapeTestName } from 'vitest/node'

// turns into /hello, .+?/
const escapedPattern = new RegExp(escapeTestName('hello, %s', true))
```
:::

::: warning
Vitest erfasst nur Tests, die in der Datei definiert sind. Es folgt niemals Importen zu anderen Dateien.

Vitest erfasst alle Definitionen von `it`, `test`, `suite` und `describe`, selbst wenn sie nicht aus dem `vitest`-Einstiegspunkt importiert wurden.
:::

## experimental_parseSpecifications <Version type="experimental">4.0.0</Version> <Experimental /> {#parsespecifications}

```ts
function experimental_parseSpecifications(
  specifications: TestSpecification[],
  options?: {
    concurrency?: number
  }
): Promise<TestModule[]>
```

Diese Methode [erfasst Tests](#parsespecification) aus einem Array von Specifications. Standardmäßig verarbeitet Vitest nur `os.availableParallelism()` viele Specifications gleichzeitig, um mögliche Leistungseinbußen zu verringern. Sie können im zweiten Argument eine andere Zahl angeben.

## experimental_clearCache <Version type="experimental">4.0.11</Version> <Experimental /> {#clearcache}

```ts
function experimental_clearCache(): Promise<void>
```

Löscht alle Vitest-Caches, einschließlich [`fsModuleCache`](/config/fsmodulecache).

## experimental_getSourceModuleDiagnostic <Version type="experimental">4.0.15</Version> <Experimental /> {#getsourcemodulediagnostic}

```ts
export function experimental_getSourceModuleDiagnostic(
  moduleId: string,
  testModule?: TestModule,
): Promise<SourceModuleDiagnostic>
```

::: details Typen
```ts
export interface ModuleDefinitionLocation {
  line: number
  column: number
}

export interface SourceModuleLocations {
  modules: ModuleDefinitionDiagnostic[]
  untracked: ModuleDefinitionDiagnostic[]
}

export interface ModuleDefinitionDiagnostic {
  start: ModuleDefinitionLocation
  end: ModuleDefinitionLocation
  startIndex: number
  endIndex: number
  url: string
  resolvedId: string
}

export interface ModuleDefinitionDurationsDiagnostic extends ModuleDefinitionDiagnostic {
  selfTime: number
  totalTime: number
  external?: boolean
}

export interface UntrackedModuleDefinitionDiagnostic {
  url: string
  resolvedId: string
  selfTime: number
  totalTime: number
  external?: boolean
}

export interface SourceModuleDiagnostic {
  modules: ModuleDefinitionDurationsDiagnostic[]
  untrackedModules: UntrackedModuleDefinitionDiagnostic[]
}
```
:::

Gibt die Diagnose des Moduls zurück. Wird [`testModule`](/api/advanced/test-module) nicht angegeben, werden `selfTime` und `totalTime` über alle Tests aggregiert, die beim letzten Mal liefen. Wurde das Modul nicht transformiert oder ausgeführt, ist die Diagnose leer.

::: warning
Derzeit werden die [Browser](/guide/browser/)-Module nicht unterstützt.
:::

## createReport <Version>5.0.0</Version> {#createreport}

```ts
function createReport(scope: string): Report
```

Erzeugt einen Report, der auf den angegebenen Scope beschränkt ist. `Report` folgt Vitests Regeln zum [Speichern von Artefakten im Dateisystem](/guide/advanced/reporters.html#storing-artifacts-on-file-system).

`Report` bietet eine Sammlung von Hilfsfunktionen zum Schreiben von Testergebnissen, temporären Dateien und anderen Artefakten im Dateisystem. Es ist besonders für Integrationen von Drittanbietern wie eigene Reporter gedacht.

Alle Operationen von `Report` sind auf den angegebenen `scope` beschränkt. Ein einzelner Report kann andere Reports nicht beeinflussen. Intern erzeugt Vitest ein Verzeichnis `.vitest`, in dem jeder `scope` sein eigenes Verzeichnis anlegt. Diese Konvention eines `.vitest`-Verzeichnisses reduziert die Zahl der Einträge, die Endanwender in ihrer `.gitignore` angeben müssen.

```ts
import type { Report } from 'vitest/node'

const scope = 'example-yaml-reporter'

// Automatically creates `<project-root>/.vitest/example-yaml-reporter/`
// directory if it does not exist already
const report: Report = vitest.createReport(scope)
```

### Report.root

```ts
const root: string
```

Das Wurzelverzeichnis für diesen Scope.

```ts
const report = vitest.createReport('my-json-reporter')

// Is <project-root>/.vitest/my-json-reporter
const root = report.root
```


### Report.clean

```ts
function clean(): Promise<void>
```

Räumt das Report-Verzeichnis für diesen Scope auf.

```ts
const report = vitest.createReport('my-json-reporter')

// Removes everything inside <project-root>/.vitest/my-json-reporter/
await report.clean()
```

### Report.writeFile

```ts
function writeFile(
  filename: string,
  content: string | Uint8Array,
  encoding?: BufferEncoding
): Promise<void>
```

Schreibt eine Datei in das Report-Verzeichnis dieses Scopes. Standardmäßig wird die Datei mit UTF-8-Kodierung geschrieben. Der Dateiname ist relativ zum Scope-Verzeichnis.

```ts
const report = vitest.createReport('my-json-reporter')

// Writes file to .vitest/my-json-reporter/test-report.json
await report.writeFile('test-report.json', JSON.stringify(results))
```

### Report.readFile

```ts
function readFile(filename: string, encoding?: BufferEncoding): Promise<string>
```

Liest eine Datei aus dem Report-Verzeichnis dieses Scopes.

```ts
const report = vitest.createReport('my-json-reporter')

// Reads file from .vitest/my-json-reporter/test-report.json
const content: string = await report.readFile('test-report.json')
```

### Report.readdir

```ts
function readdir(): Promise<string[]>
```

Liest den Inhalt des Report-Verzeichnisses dieses Scopes.

```ts
const report = vitest.createReport('my-json-reporter')

// Reads contents from .vitest/my-json-reporter
const filenames: string[] = await report.readdir()
```

### Report.delete

<!-- eslint-skip -->
```ts
function delete(filename: string): Promise<void>
```

Löscht eine Datei aus dem Report-Verzeichnis dieses Scopes.

```ts
const report = vitest.createReport('my-json-reporter')

// Deletes file from .vitest/my-json-reporter/test-report.json
await report.delete('test-report.json')
```

