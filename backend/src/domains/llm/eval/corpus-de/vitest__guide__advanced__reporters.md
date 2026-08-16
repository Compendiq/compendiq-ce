# Reporter erweitern <Badge type="danger">advanced</Badge> {#extending-reporters}

::: warning
Dies ist eine fortgeschrittene API. Wenn Sie lediglich die eingebauten Reporter konfigurieren möchten, lesen Sie den Guide ["Reporters"](/guide/reporters).
:::

Sie können Reporter aus `vitest/node` importieren und sie erweitern, um eigene Reporter zu erstellen.

## Eingebaute Reporter erweitern

Im Allgemeinen müssen Sie Ihren Reporter nicht von Grund auf neu schreiben. `vitest` bringt mehrere Standard-Reporting-Programme mit, die Sie erweitern können.

```ts
import { DefaultReporter } from 'vitest/node'

export default class MyDefaultReporter extends DefaultReporter {
  // do something
}
```

::: warning
Beachten Sie jedoch, dass die offengelegten Reporter nicht als stabil gelten und die Form ihrer API innerhalb einer Minor-Version ändern können.
:::

Natürlich können Sie Ihren Reporter auch von Grund auf neu schreiben. Implementieren Sie einfach das Interface [`Reporter`](/api/advanced/reporters):

Und hier ist ein Beispiel für einen eigenen Reporter:

```ts [custom-reporter.js]
import type { Reporter } from 'vitest/node'

export default class CustomReporter implements Reporter {
  onTestModuleCollected(testModule) {
    console.log(testModule.moduleId, 'is finished')

    for (const test of testModule.children.allTests()) {
      console.log(test.name, test.result().state)
    }
  }
}
```

Anschließend können Sie Ihren eigenen Reporter in der Datei `vitest.config.ts` verwenden:

```ts [vitest.config.ts]
import { defineConfig } from 'vitest/config'
import CustomReporter from './custom-reporter.js'

export default defineConfig({
  test: {
    reporters: [new CustomReporter()],
  },
})
```

## Gemeldete Tasks

Gemeldete [Events](/api/advanced/reporters) erhalten Tasks für [Tests](/api/advanced/test-case), [Suites](/api/advanced/test-suite) und [Module](/api/advanced/test-module):

```ts twoslash
import type { Reporter, TestModule } from 'vitest/node'

class MyReporter implements Reporter {
  onTestRunEnd(testModules: ReadonlyArray<TestModule>) {
    for (const testModule of testModules) {
      for (const task of testModule.children) {
        //                          ^?
        console.log('test run end', task.type, task.fullName)
      }
    }
  }
}
```

## Artefakte im Dateisystem ablegen

::: tip
Vitest stellt [`vitest.createReport`](/api/advanced/vitest.html#createreport) bereit, das eine Sammlung von Hilfsmitteln zum bequemen Schreiben von Artefakten ins Dateisystem bietet.
:::

Wenn Ihr eigener Reporter Artefakte im Dateisystem ablegen muss, sollte er sie im Verzeichnis `.vitest` unterbringen. Dieses Verzeichnis ist eine Konvention, die Vitest-Reporter und Integrationen von Drittanbietern nutzen können, um ihre Ergebnisse in einem einzigen Verzeichnis zu bündeln. So müssen Nutzer Ihres eigenen Reporters nicht mehrere Ausschlüsse in ihre `.gitignore` eintragen. Nur `.vitest` wird benötigt.

Reporter und andere Integrationen sollten folgende Regeln rund um das Verzeichnis `.vitest` beachten:

- Das Verzeichnis `.vitest` liegt im [`root` des Projekts](/config/root)
- Ein Reporter darf das Verzeichnis `.vitest` anlegen, falls es noch nicht existiert
- Ein Reporter darf das Verzeichnis `.vitest` niemals entfernen
- Ein Reporter sollte innerhalb von `.vitest` ein eigenes Verzeichnis anlegen, zum Beispiel `.vitest/yaml-reporter/`
- Ein Reporter darf sein eigenes Verzeichnis innerhalb von `.vitest` entfernen, zum Beispiel `.vitest/yaml-reporter/`

```ansi
.vitest
│
├── yaml-reporter
│   ├── results.yaml
│   └── summary.yaml
│
└── junit-reporter
    └── report.xml
```

## Exportierte Reporter

`vitest` bringt einige [eingebaute Reporter](/guide/reporters) mit, die Sie sofort verwenden können.

### Eingebaute Reporter:

1. `DefaultReporter`
2. `DotReporter`
3. `JsonReporter`
4. `VerboseReporter`
5. `TapReporter`
6. `JUnitReporter`
7. `TapFlatReporter`
8. `HangingProcessReporter`
9. `TreeReporter`

### Interface-Reporter:

1. `Reporter`
