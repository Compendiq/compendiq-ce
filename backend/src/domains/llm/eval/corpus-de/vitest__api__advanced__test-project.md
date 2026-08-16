# TestProject <Version>3.0.0</Version> {#testproject}

::: warning
Dieser Leitfaden beschreibt die fortgeschrittene Node.js-API. Wenn Sie lediglich Projekte definieren möchten, folgen Sie dem Leitfaden ["Testprojekte"](/guide/projects).
:::

## name

Der Name ist eine eindeutige Zeichenkette, die vom Nutzer vergeben oder von Vitest ermittelt wird. Hat der Nutzer keinen Namen angegeben, versucht Vitest, eine `package.json` im Wurzelverzeichnis des Projekts zu laden, und übernimmt von dort die Eigenschaft `name`. Gibt es keine `package.json`, verwendet Vitest standardmäßig den Namen des Ordners. Inline-Projekte verwenden Zahlen als Namen (in einen String umgewandelt).

::: code-group
```ts [node.js]
import { createVitest } from 'vitest/node'

const vitest = await createVitest('test')
vitest.projects.map(p => p.name) === [
  '@pkg/server',
  'utils',
  '2',
  'custom'
]
```
```ts [vitest.config.js]
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    projects: [
      './packages/server', // has package.json with "@pkg/server"
      './utils', // doesn't have a package.json file
      {
        // doesn't customize the name
        test: {
          pool: 'threads',
        },
      },
      {
        // customized the name
        test: {
          name: 'custom',
        },
      },
    ],
  },
})
```
:::

::: info
Ist das [Root-Projekt](/api/advanced/vitest#getrootproject) nicht Teil der Nutzerprojekte, wird dessen `name` nicht aufgelöst.
:::

## vitest

`vitest` verweist auf den globalen [`Vitest`](/api/advanced/vitest)-Prozess.

## serializedConfig

Dies ist die Konfiguration, die die Testprozesse erhalten. Vitest [serialisiert die Konfiguration](https://github.com/vitest-dev/vitest/blob/main/packages/vitest/src/node/config/serializeConfig.ts) manuell, indem es alle Funktionen und Eigenschaften entfernt, die sich nicht serialisieren lassen. Da dieser Wert sowohl in Tests als auch in node verfügbar ist, wird sein Typ vom Haupteinstiegspunkt exportiert.

```ts
import type { SerializedConfig } from 'vitest'

const config: SerializedConfig = vitest.projects[0].serializedConfig
```

::: warning
Die Eigenschaft `serializedConfig` ist ein Getter. Bei jedem Zugriff serialisiert Vitest die Konfiguration erneut, falls sie geändert wurde. Das bedeutet auch, dass sie stets eine andere Referenz zurückgibt:

```ts
project.serializedConfig === project.serializedConfig // ❌
```
:::

## globalConfig

Die Testkonfiguration, mit der [`Vitest`](/api/advanced/vitest) initialisiert wurde. Handelt es sich um das [Root-Projekt](/api/advanced/vitest#getrootproject), verweisen `globalConfig` und `config` auf dasselbe Objekt. Diese Konfiguration ist nützlich für Werte, die sich nicht auf Projektebene setzen lassen, etwa `coverage` oder `reporters`.

```ts
import type { ResolvedConfig } from 'vitest/node'

vitest.config === vitest.projects[0].globalConfig
```

## config

Dies ist die aufgelöste Testkonfiguration des Projekts.

## hash <Version>3.2.0</Version> {#hash}

Der eindeutige Hash dieses Projekts. Dieser Wert bleibt über wiederholte Läufe hinweg gleich.

Er basiert auf dem Wurzelverzeichnis des Projekts und dessen Namen. Beachten Sie, dass der Wurzelpfad über verschiedene Betriebssysteme hinweg nicht identisch ist, sodass sich auch der Hash unterscheidet.

## vite

Dies ist der [`ViteDevServer`](https://vite.dev/guide/api-javascript#vitedevserver) des Projekts. Alle Projekte haben ihren eigenen Vite-Server.

## browser

Dieser Wert wird nur gesetzt, wenn Tests im Browser laufen. Ist `browser` aktiviert, aber es wurden noch keine Tests ausgeführt, ist der Wert `undefined`. Wenn Sie prüfen müssen, ob das Projekt Browser-Tests unterstützt, verwenden Sie die Methode `project.isBrowserEnabled()`.

::: warning
Die Browser-API ist noch experimenteller und folgt nicht SemVer. Die Browser-API wird getrennt von den übrigen APIs standardisiert.
:::

## provide

```ts
function provide<T extends keyof ProvidedContext & string>(
  key: T,
  value: ProvidedContext[T],
): void
```

Eine Möglichkeit, Tests zusätzlich zum Feld [`config.provide`](/config/provide) eigene Werte bereitzustellen. Alle Werte werden vor dem Speichern mit [`structuredClone`](https://developer.mozilla.org/en-US/docs/Web/API/Window/structuredClone) validiert, die Werte auf `providedContext` selbst werden jedoch nicht geklont.

::: code-group
```ts [node.js]
import { createVitest } from 'vitest/node'

const vitest = await createVitest('test')
const project = vitest.projects.find(p => p.name === 'custom')
project.provide('key', 'value')
await vitest.start()
```
```ts [test.spec.js]
import { inject } from 'vitest'
const value = inject('key')
```
:::

Die Werte können dynamisch bereitgestellt werden. Ein bereitgestellter Wert wird in Tests bei deren nächstem Lauf aktualisiert.

::: tip
Diese Methode steht auch [Global-Setup-Dateien](/config/globalsetup) zur Verfügung, für Fälle, in denen Sie die öffentliche API nicht verwenden können:

```js
export default function setup({ provide }) {
  provide('wsPort', 3000)
}
```
:::

## getProvidedContext

```ts
function getProvidedContext(): ProvidedContext
```

Gibt das Kontextobjekt zurück. Jedes Projekt erbt zusätzlich den globalen Kontext, der über `vitest.provide` gesetzt wurde.

```ts
import { createVitest } from 'vitest/node'

const vitest = await createVitest('test')
vitest.provide('global', true)
const project = vitest.projects.find(p => p.name === 'custom')
project.provide('key', 'value')

// { global: true, key: 'value' }
const context = project.getProvidedContext()
```

::: tip
Kontextwerte eines Projekts überschreiben immer den Kontext des Root-Projekts.
:::

## createSpecification

```ts
function createSpecification(
  moduleId: string,
  locations?: number[],
): TestSpecification
```

Erzeugt eine [Testspezifikation](/api/advanced/test-specification), die in [`vitest.runTestSpecifications`](/api/advanced/vitest#runtestspecifications) verwendet werden kann. Die Spezifikation begrenzt die Testdatei auf ein bestimmtes `project` und optional auf bestimmte `locations`. Test-[Locations](/api/advanced/test-case#location) sind Codezeilen, in denen der Test im Quellcode definiert ist. Werden Locations angegeben, führt Vitest nur die in diesen Zeilen definierten Tests aus. Beachten Sie, dass ein definiertes [`testNamePattern`](/config/testnamepattern) ebenfalls angewendet wird.

```ts
import { createVitest } from 'vitest/node'
import { resolve } from 'node:path/posix'

const vitest = await createVitest('test')
const project = vitest.projects[0]
const specification = project.createSpecification(
  resolve('./example.test.ts'),
  [20, 40], // optional test lines
)
await vitest.runTestSpecifications([specification])
```

::: warning
`createSpecification` erwartet eine aufgelöste [Modul-ID](/api/advanced/test-specification#moduleid). Die Datei wird weder automatisch aufgelöst noch wird geprüft, ob sie im Dateisystem existiert.

Beachten Sie außerdem, dass `project.createSpecification` stets eine neue Instanz zurückgibt.
:::

## isRootProject

```ts
function isRootProject(): boolean
```

Prüft, ob das aktuelle Projekt das Root-Projekt ist. Sie können das Root-Projekt auch über den Aufruf von [`vitest.getRootProject()`](/api/advanced/vitest#getrootproject) erhalten.

## globTestFiles

```ts
function globTestFiles(filters?: string[]): {
  /**
   * Test files that match the filters.
   */
  testFiles: string[]
  /**
   * Typecheck test files that match the filters. This will be empty unless `typecheck.enabled` is `true`.
   */
  typecheckTestFiles: string[]
}
```

Ermittelt per Glob alle Testdateien. Diese Funktion gibt ein Objekt mit regulären Tests und Typecheck-Tests zurück.

Diese Methode akzeptiert `filters`. Filter dürfen anders als bei anderen Methoden der [`Vitest`](/api/advanced/vitest)-Instanz nur ein Teil des Dateipfads sein:

```js
project.globTestFiles(['foo']) // ✅
project.globTestFiles(['basic/foo.js:10']) // ❌
```

::: tip
Vitest verwendet [fast-glob](https://npmx.dev/package/fast-glob), um Testdateien zu finden. `test.dir`, `test.root`, `root` oder `process.cwd()` bestimmen die Option `cwd`.

Diese Methode berücksichtigt mehrere Konfigurationsoptionen:

- `test.include`, `test.exclude`, um reguläre Testdateien zu finden
- `test.includeSource`, `test.exclude`, um In-Source-Tests zu finden
- `test.typecheck.include`, `test.typecheck.exclude`, um Typecheck-Tests zu finden
:::

## matchesTestGlob

```ts
function matchesTestGlob(
  moduleId: string,
  source?: () => string
): boolean
```

Diese Methode prüft, ob die Datei eine reguläre Testdatei ist. Sie verwendet zur Validierung dieselben Konfigurationseigenschaften wie `globTestFiles`.

Diese Methode akzeptiert außerdem einen zweiten Parameter, den Quellcode. Er dient dazu, zu prüfen, ob die Datei ein In-Source-Test ist. Wenn Sie diese Methode mehrfach für mehrere Projekte aufrufen, empfiehlt es sich, die Datei einmal zu lesen und direkt weiterzureichen. Ist die Datei keine Testdatei, passt aber auf das Glob `includeSource`, liest Vitest die Datei synchron, sofern `source` nicht angegeben ist.

```ts
import { createVitest } from 'vitest/node'
import { resolve } from 'node:path/posix'

const vitest = await createVitest('test')
const project = vitest.projects[0]

project.matchesTestGlob(resolve('./basic.test.ts')) // true
project.matchesTestGlob(resolve('./basic.ts')) // false
project.matchesTestGlob(resolve('./basic.ts'), () => `
if (import.meta.vitest) {
  // ...
}
`) // true if `includeSource` is set
```

## import

<!--@include: ./import-example.md-->

Importiert eine Datei über den Module Runner von Vite. Die Datei wird von Vite mit der Konfiguration des angegebenen Projekts transformiert und in einem separaten Kontext ausgeführt. Beachten Sie, dass `moduleId` relativ zu `config.root` ist.

::: danger
`project.import` verwendet Vites Modulgraphen wieder, sodass der Import desselben Moduls über einen regulären Import ein anderes Modul liefert:

```ts
import * as staticExample from './example.js'
const dynamicExample = await project.import('./example.js')

dynamicExample !== staticExample // ✅
```
:::

::: info
Intern verwendet Vitest diese Methode, um Global-Setups, eigene Coverage-Provider und eigene Reporter zu importieren, das heißt, sie alle teilen sich denselben Modulgraphen, solange sie zum selben Vite-Server gehören.
:::

## onTestsRerun

```ts
function onTestsRerun(cb: OnTestsRerunHandler): void
```

Dies ist eine Kurzform für [`project.vitest.onTestsRerun`](/api/advanced/vitest#ontestsrerun). Sie akzeptiert einen Callback, der awaited wird, wenn die Tests für einen erneuten Lauf eingeplant wurden (üblicherweise aufgrund einer Dateiänderung).

```ts
project.onTestsRerun((specs) => {
  console.log(specs)
})
```

## isBrowserEnabled

```ts
function isBrowserEnabled(): boolean
```

Gibt `true` zurück, wenn dieses Projekt Tests im Browser ausführt.

## close

```ts
function close(): Promise<void>
```

Schließt das Projekt und alle zugehörigen Ressourcen. Das kann nur einmal aufgerufen werden; das Promise des Schließens wird zwischengespeichert, bis der Server neu startet. Werden die Ressourcen erneut benötigt, legen Sie ein neues Projekt an.

Im Detail schließt diese Methode den Vite-Server, stoppt den Typechecker-Dienst, schließt den Browser, sofern er läuft, löscht das temporäre Verzeichnis mit dem Quellcode und setzt den bereitgestellten Kontext zurück.
