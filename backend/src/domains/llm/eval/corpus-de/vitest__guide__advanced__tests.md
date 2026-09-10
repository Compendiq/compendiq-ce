# Tests ausführen <Badge type="danger">advanced</Badge> {#running-tests}

::: warning
Dieser Leitfaden erklärt, wie man die Advanced-API nutzt, um Tests über ein Node.js-Skript auszuführen. Wenn Sie einfach nur [Tests ausführen](/guide/) möchten, brauchen Sie das vermutlich nicht. Sie wird in erster Linie von Bibliotheksautoren verwendet.
:::

Vitest stellt zwei Methoden bereit, um Vitest zu initialisieren:

- `startVitest` initialisiert Vitest, prüft, ob die Pakete installiert sind, und führt die Tests sofort aus
- `createVitest` initialisiert Vitest lediglich und führt keine Tests aus

## `startVitest`

```ts
import { startVitest } from 'vitest/node'

const vitest = await startVitest(
  'test',
  [], // CLI filters
  {}, // override test config
  {}, // override Vite config
  {}, // custom Vitest options
)
const testModules = vitest.state.getTestModules()
for (const testModule of testModules) {
  console.log(testModule.moduleId, testModule.ok() ? 'passed' : 'failed')
}
```

## `createVitest`

Erzeugt eine [Vitest](/api/advanced/vitest)-Instanz, ohne Tests auszuführen.

Die Methode `createVitest` prüft nicht, ob die benötigten Pakete installiert sind. Sie berücksichtigt außerdem weder `config.standalone` noch `config.mergeReports`. Vitest wird nicht automatisch geschlossen, selbst wenn `watch` deaktiviert ist.

```ts
import { createVitest } from 'vitest/node'

const vitest = await createVitest(
  'test',
  {}, // override test config
  {}, // override Vite config
  {}, // custom Vitest options
)

// called when `vitest.cancelCurrentRun()` is invoked
vitest.onCancel(() => {})
// called during `vitest.close()` call
vitest.onClose(() => {})
// called when Vitest reruns test files
vitest.onTestsRerun((files) => {})

try {
  // this will set process.exitCode to 1 if tests failed,
  // and won't close the process automatically
  await vitest.start(['my-filter'])
}
catch (err) {
  // this can throw
  // "FilesNotFoundError" if no files were found
  // "GitNotFoundError" with `--changed` and repository is not initialized
}
finally {
  await vitest.close()
}
```

Wenn Sie die `Vitest`-Instanz behalten möchten, rufen Sie mindestens [`init`](/api/advanced/vitest#init) auf. Damit werden die Reporter und der Coverage-Provider initialisiert, es werden aber keine Tests ausgeführt. Es empfiehlt sich außerdem, den `watch`-Modus zu aktivieren, selbst wenn Sie den Vitest-Watcher gar nicht nutzen wollen, die Instanz aber am Laufen halten möchten. Vitest verlässt sich auf dieses Flag, damit einige seiner Funktionen in einem dauerhaft laufenden Prozess korrekt arbeiten.

Nachdem die Reporter initialisiert sind, verwenden Sie [`runTestSpecifications`](/api/advanced/vitest#runtestspecifications) oder [`rerunTestSpecifications`](/api/advanced/vitest#reruntestspecifications), um Tests auszuführen, falls ein manueller Lauf erforderlich ist:

```ts
watcher.on('change', async (file) => {
  const specifications = vitest.getModuleSpecifications(file)
  if (specifications.length) {
    vitest.invalidateFile(file)
    // you can use runTestSpecifications if "reporter.onWatcher*" hooks
    // should not be invoked
    await vitest.rerunTestSpecifications(specifications)
  }
})
```

::: warning
Das obige Beispiel zeigt einen möglichen Anwendungsfall, wenn Sie das Standardverhalten des Watchers deaktivieren. Standardmäßig führt Vitest Tests bei Dateiänderungen bereits erneut aus.

Beachten Sie außerdem, dass `getModuleSpecifications` Testdateien nicht auflöst, sofern sie nicht bereits von `globTestSpecifications` verarbeitet wurden. Wenn die Datei gerade erst erstellt wurde, verwenden Sie stattdessen `project.matchesGlobPattern`:

```ts
watcher.on('add', async (file) => {
  const specifications = []
  for (const project of vitest.projects) {
    if (project.matchesGlobPattern(file)) {
      specifications.push(project.createSpecification(file))
    }
  }

  if (specifications.length) {
    await vitest.rerunTestSpecifications(specifications)
  }
})
```
:::

Falls Sie den Watcher deaktivieren müssen, können Sie seit Vite 5.3 `server.watch: null` oder `server.watch: { ignored: ['*/*'] }` an eine Vite-Konfiguration übergeben:

```ts
await createVitest(
  'test',
  {},
  {
    plugins: [
      {
        name: 'stop-watcher',
        async configureServer(server) {
          await server.watcher.close()
        }
      }
    ],
    server: {
      watch: null,
    },
  }
)
```
