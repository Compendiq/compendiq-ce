# Plugin-API <Version>3.1.0</Version> {#plugin-api}

::: warning
Dies ist eine fortgeschrittene API. Wenn du lediglich [Tests ausführen](/guide/) möchtest, brauchst du sie wahrscheinlich nicht. Sie richtet sich in erster Linie an Autoren von Bibliotheken.

Dieser Leitfaden setzt voraus, dass du weißt, wie man mit [Vite-Plugins](https://vite.dev/guide/api-plugin.html) arbeitet.
:::

Vitest unterstützt seit Version 3.1 einen `configureVitest`-[Plugin](https://vite.dev/guide/api-plugin.html)-Hook.

::: code-group
```ts [only vitest]
import type { Vite, VitestPluginContext } from 'vitest/node'

export function plugin(): Vite.Plugin {
  return {
    name: 'vitest:my-plugin',
    configureVitest(context: VitestPluginContext) {
      // ...
    }
  }
}
```
```ts [vite and vitest]
/// <reference types="vitest/config" />

import type { Plugin } from 'vite'

export function plugin(): Plugin {
  return {
    name: 'vitest:my-plugin',
    transform() {
      // ...
    },
    configureVitest(context) {
      // ...
    }
  }
}
```
:::

::: tip TypeScript
Vitest re-exportiert alle reinen Typ-Imports von Vite über einen `Vite`-Namespace, mit dem du deine Versionen synchron halten kannst. Wenn du jedoch ein Plugin sowohl für Vite als auch für Vitest schreibst, kannst du weiterhin den Typ `Plugin` aus dem `vite`-Einstiegspunkt verwenden. Stelle nur sicher, dass irgendwo `vitest/config` referenziert wird, damit `configureVitest` korrekt erweitert wird:

```ts
/// <reference types="vitest/config" />
```
:::

Anders als [`reporter.onInit`](/api/advanced/reporters#oninit) läuft dieser Hook früh im Lebenszyklus von Vitest und erlaubt dir daher, Änderungen an der Konfiguration wie `coverage` und `reporters` vorzunehmen. Eine noch bemerkenswertere Änderung ist, dass du die globale Konfiguration aus einem [Testprojekt](/guide/projects) heraus manipulieren kannst, wenn dein Plugin im Projekt und nicht in der globalen Konfiguration definiert ist.

## Context

### project

Das aktuelle [Testprojekt](./test-project), zu dem das Plugin gehört.

::: warning Browser-Modus
Beachte: Wenn du dich auf ein Browser-Feature verlässt, ist das Feld `project.browser` noch nicht gesetzt. Verwende stattdessen das Event [`reporter.onBrowserInit`](./reporters#onbrowserinit).
:::

### vitest

Die globale [Vitest](./vitest)-Instanz. Du kannst die globale Konfiguration ändern, indem du die Eigenschaft `vitest.config` direkt mutierst:

```ts
vitest.config.coverage.enabled = false
vitest.config.reporters.push([['my-reporter', {}]])
```

::: warning Die Konfiguration ist bereits aufgelöst
Beachte, dass Vitest die Konfiguration bereits aufgelöst hat, sodass einige Typen von der gewohnten Benutzerkonfiguration abweichen können. Das bedeutet außerdem, dass manche Eigenschaften nicht erneut aufgelöst werden, etwa `setupFile`. Wenn du neue Dateien hinzufügst, achte darauf, sie vorher aufzulösen.

Zu diesem Zeitpunkt sind die Reporter noch nicht erzeugt worden, weshalb eine Änderung an `vitest.reporters` wirkungslos bleibt — sie würde überschrieben. Wenn du einen eigenen Reporter einschleusen musst, ändere stattdessen die Konfiguration.
:::

### injectTestProjects

```ts
function injectTestProjects(
  config: TestProjectConfiguration | TestProjectConfiguration[]
): Promise<TestProject[]>
```

Diese Methode akzeptiert ein Glob-Muster für die Konfiguration, einen Dateipfad zur Konfiguration oder eine Inline-Konfiguration. Sie gibt ein Array aufgelöster [Testprojekte](./test-project) zurück.

```ts
// inject a single project with a custom alias
const newProjects = await injectTestProjects({
  // you can inherit the current project config by referencing `extends`
  // note that you cannot have a project with the name that already exists,
  // so it's a good practice to define a custom name
  extends: project.vite.config.configFile,
  test: {
    name: 'my-custom-alias',
    alias: {
      customAlias: resolve('./custom-path.js'),
    },
  },
})
```

::: warning Projekte werden gefiltert
Vitest filtert Projekte während der Auflösung der Konfiguration. Wenn der Benutzer also einen Filter definiert hat, wird ein eingeschleustes Projekt möglicherweise nicht aufgelöst, sofern es nicht [dem Filter entspricht](./vitest#matchesprojectfilter). Du kannst den Filter über die Option `vitest.config.project` anpassen, sodass dein Testprojekt immer eingeschlossen wird:

```ts
vitest.config.project.push('my-project-name')
```

Beachte, dass sich das nur auf Projekte auswirkt, die mit der Methode [`injectTestProjects`](#injecttestprojects) eingeschleust wurden.
:::

::: tip Verweis auf die aktuelle Konfiguration
Inline-Konfigurationen erben standardmäßig die Root-Konfiguration. Wenn du stattdessen eine bestimmte Konfigurationsdatei erben möchtest, setze die Eigenschaft `extends` auf deren Pfad. Alle übrigen Eigenschaften werden mit der benutzerdefinierten Konfiguration zusammengeführt.

Die `configFile` des Projekts ist in der Vite-Konfiguration erreichbar: `project.vite.config.configFile`.

Beachte, dass `name` niemals vererbt wird, weil Vitest mehrere Projekte mit demselben Namen nicht zulässt. Stelle sicher, dass jedes Projekt einen eindeutigen Namen hat. Den aktuellen Namen erreichst du über die Eigenschaft `project.name`, und alle verwendeten Namen stehen im Array `vitest.projects`.
:::

### defineCacheKeyGenerator <Version>5.0.0</Version> {#definecachekeygenerator}

```ts
interface CacheKeyIdGeneratorContext {
  environment: DevEnvironment
  id: string
  sourceCode: string
}

function defineCacheKeyGenerator(
  callback: (context: CacheKeyIdGeneratorContext) => string | undefined | null | false
): void
```

Definiert einen Generator, der vor dem Hashen des Cache-Keys angewendet wird.

Damit stellst du sicher, dass Vitest den korrekten Hash erzeugt. Es ist eine gute Idee, diese Funktion zu definieren, wenn dein Plugin mit unterschiedlichen Optionen registriert werden kann.

Sie wird nur aufgerufen, wenn [`fsModuleCache`](/config/fsmodulecache) aktiviert ist.

```ts
interface PluginOptions {
  replacePropertyKey: string
  replacePropertyValue: string
}

export function plugin(options: PluginOptions) {
  return {
    name: 'plugin-that-replaces-property',
    transform(code) {
      return code.replace(
        options.replacePropertyKey,
        options.replacePropertyValue
      )
    },
    configureVitest({ defineCacheKeyGenerator }) {
      defineCacheKeyGenerator(() => {
        // since these options affect the transform result,
        // return them together as a unique string
        return options.replacePropertyKey + options.replacePropertyValue
      })
    }
  }
}
```

Wird `false` zurückgegeben, wird das Modul nicht im Dateisystem gecacht.
