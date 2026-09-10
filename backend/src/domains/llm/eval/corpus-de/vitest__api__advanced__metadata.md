# Task-Metadaten <Badge type="danger">advanced</Badge>

Wenn du einen eigenen Reporter entwickelst oder die Vitest-Node.js-API verwendest, kann es nützlich sein, Daten aus Tests, die in verschiedenen Kontexten ausgeführt werden, an deinen Reporter oder deinen eigenen Vitest-Handler zu übergeben.

Dafür kommt der [Testkontext](/guide/test-context) nicht infrage, da er sich nicht serialisieren lässt. Mit Vitest kannst du jedoch die Eigenschaft `meta` nutzen, die auf jedem Task (Suite oder Test) verfügbar ist, um Daten zwischen deinen Tests und dem Node.js-Prozess auszutauschen. Wichtig: Diese Kommunikation verläuft nur in eine Richtung, da die `meta`-Eigenschaft ausschließlich innerhalb des Testkontexts verändert werden kann. Änderungen, die im Node.js-Kontext vorgenommen werden, sind in deinen Tests nicht sichtbar.

Du kannst die `meta`-Eigenschaft im Testkontext oder in `beforeAll`/`afterAll`-Hooks für Suite-Tasks befüllen.

```ts
afterAll((suite) => {
  suite.meta.done = true
})

test('custom', ({ task }) => {
  task.meta.custom = 'some-custom-handler'
})
```

Sobald ein Test abgeschlossen ist, sendet Vitest den Task einschließlich Ergebnis und `meta` per RPC an den Node.js-Prozess und meldet ihn dann in `onTestCaseResult` und anderen Hooks, die Zugriff auf Tasks haben. Um diesen Testfall zu verarbeiten, kannst du die Methode `onTestCaseResult` in deiner Reporter-Implementierung nutzen:

```ts [custom-reporter.js]
import type { Reporter, TestCase, TestModule } from 'vitest/node'

export default {
  onTestCaseResult(testCase: TestCase) {
    // custom === 'some-custom-handler' ✅
    const { custom } = testCase.meta()
  },
  onTestRunEnd(testModule: TestModule) {
    testModule.meta().done === true
    testModule.children.at(0).meta().custom === 'some-custom-handler'
  }
} satisfies Reporter
```

::: danger ACHTUNG
Vitest nutzt unterschiedliche Verfahren zur Kommunikation mit dem Node.js-Prozess.

- Führt Vitest Tests in Worker-Threads aus, werden die Daten über einen [Message Port](https://developer.mozilla.org/en-US/docs/Web/API/MessagePort) gesendet
- Verwendet Vitest einen Child Process, werden die Daten als serialisierter Buffer über die [`process.send`](https://nodejs.org/api/process.html#processsendmessage-sendhandle-options-callback)-API gesendet
- Führt Vitest Tests im Browser aus, werden die Daten mit dem Paket [flatted](https://npmx.dev/package/flatted) in Strings umgewandelt

Diese Eigenschaft ist auch bei jedem Test im `json`-Reporter vorhanden – stelle also sicher, dass sich die Daten nach JSON serialisieren lassen.

Achte außerdem darauf, [Error-Eigenschaften](https://developer.mozilla.org/en-US/docs/Web/API/Web_Workers_API/Structured_clone_algorithm#error_types) zu serialisieren, bevor du sie setzt.
:::

Du kannst diese Informationen auch aus dem Vitest-State abrufen, nachdem die Tests durchgelaufen sind:

```ts
const vitest = await createVitest('test')
const { testModules } = await vitest.start()

const testModule = testModules[0]
testModule.meta().done === true
testModule.children.at(0).meta().custom === 'some-custom-handler'
```

Bei Verwendung von TypeScript lassen sich außerdem die Typdefinitionen erweitern:

```ts
declare module 'vitest' {
  interface TaskMeta {
    done?: boolean
    custom?: string
  }
}
```
