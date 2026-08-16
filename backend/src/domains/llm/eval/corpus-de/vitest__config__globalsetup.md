# globalSetup

- **Typ:** `string | string[]`

Pfad zu den globalen Setup-Dateien relativ zum [root](/config/root) des Projekts.

Eine globale Setup-Datei kann entweder die benannten Funktionen `setup` und `teardown` exportieren oder eine `default`-Funktion, die eine Teardown-Funktion zurückgibt:

::: code-group
```js [exports]
export function setup(project) {
  console.log('setup')
}

export function teardown() {
  console.log('teardown')
}
```
```js [default]
export default function setup(project) {
  console.log('setup')

  return function teardown() {
    console.log('teardown')
  }
}
```
:::

Beachten Sie, dass die Methode `setup` und eine `default`-Funktion als erstes Argument ein [Testprojekt](/api/advanced/test-project) erhalten. Das globale Setup wird aufgerufen, bevor die Test-Worker erzeugt werden, und nur dann, wenn mindestens ein Test in der Warteschlange steht; das Teardown wird aufgerufen, nachdem alle Testdateien durchgelaufen sind. Im [Watch-Modus](/config/watch) wird das Teardown stattdessen aufgerufen, bevor der Prozess beendet wird. Wenn Sie Ihr Setup vor dem erneuten Testlauf umkonfigurieren müssen, können Sie stattdessen den Hook [`onTestsRerun`](#handling-test-reruns) verwenden.

Mehrere globale Setup-Dateien sind möglich. `setup` und `teardown` werden sequenziell ausgeführt, das Teardown in umgekehrter Reihenfolge.

::: danger
Beachten Sie, dass das globale Setup in einem anderen globalen Scope läuft, noch bevor die Test-Worker überhaupt erzeugt werden – Ihre Tests haben also keinen Zugriff auf hier definierte globale Variablen. Sie können jedoch serialisierbare Daten über die Methode [`provide`](/config/provide) an die Tests weiterreichen und sie in Ihren Tests über das aus `vitest` importierte `inject` auslesen:

:::code-group
```ts [example.test.ts]
import { inject } from 'vitest'

inject('wsPort') === 3000
```
```ts [globalSetup.ts]
import type { TestProject } from 'vitest/node'

export default function setup(project: TestProject) {
  project.provide('wsPort', 3000)
}

declare module 'vitest' {
  export interface ProvidedContext {
    wsPort: number
  }
}
```

Wenn Sie Code im selben Prozess wie die Tests ausführen müssen, verwenden Sie stattdessen [`setupFiles`](/config/setupfiles) – beachten Sie aber, dass diese vor jeder Testdatei laufen.
:::

## Umgang mit erneuten Testläufen

Sie können eine eigene Callback-Funktion definieren, die aufgerufen wird, wenn Vitest Tests erneut ausführt. Der Test-Runner wartet auf deren Abschluss, bevor er die Tests ausführt. Beachten Sie, dass Sie `project` nicht destrukturieren können, etwa als `{ onTestsRerun }`, da es auf den Kontext angewiesen ist.

```ts [globalSetup.ts]
import type { TestProject } from 'vitest/node'

export default function setup(project: TestProject) {
  project.onTestsRerun(async () => {
    await restartDb()
  })
}
```
