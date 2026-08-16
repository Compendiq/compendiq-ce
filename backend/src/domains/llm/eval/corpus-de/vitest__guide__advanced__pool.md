# Eigener Pool <Badge type="danger">advanced</Badge> {#custom-pool}

::: warning
Dies ist eine fortgeschrittene, experimentelle und sehr hardwarenahe API. Wenn Sie einfach nur [Tests ausführen](/guide/) möchten, benötigen Sie sie wahrscheinlich nicht. Sie wird in erster Linie von Bibliotheksautoren verwendet.
:::

Vitest führt Tests in einem Pool aus. Standardmäßig gibt es mehrere Pool-Runner:

- `threads`, um Tests mit `node:worker_threads` auszuführen (die Isolation wird durch einen neuen Worker-Kontext bereitgestellt)
- `forks`, um Tests mit `node:child_process` auszuführen (die Isolation wird durch einen neuen `child_process.fork`-Prozess bereitgestellt)
- `vmThreads`, um Tests mit `node:worker_threads` auszuführen (die Isolation wird aber durch das `vm`-Modul statt durch einen neuen Worker-Kontext bereitgestellt)
- `browser`, um Tests mit Browser-Providern auszuführen
- `typescript`, um eine Typprüfung der Tests durchzuführen

::: tip
Ein Beispiel für die Implementierung eines eigenen Pool-Runners finden Sie unter [`vitest-pool-example`](https://npmx.dev/package/vitest-pool-example).
:::

## Verwendung

Sie können Ihren eigenen Pool-Runner über eine Funktion bereitstellen, die einen `PoolRunnerInitializer` zurückgibt.

```ts [vitest.config.ts]
import { defineConfig } from 'vitest/config'
import customPool from './my-custom-pool.ts'

export default defineConfig({
  test: {
    // will run every file with a custom pool by default
    pool: customPool({
      customProperty: true,
    })
  },
})
```

Wenn Sie Tests in unterschiedlichen Pools ausführen müssen, verwenden Sie die Funktion [`projects`](/guide/projects):

```ts [vitest.config.ts]
import customPool from './my-custom-pool.ts'

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          pool: 'threads',
        },
      },
      {
        test: {
          pool: customPool({
            customProperty: true,
          })
        }
      }
    ],
  },
})
```

## API

Die Option `pool` akzeptiert einen `PoolRunnerInitializer`, der für eigene Pool-Runner verwendet werden kann. Die Eigenschaft `name` sollte den Namen des eigenen Pool-Runners angeben. Sie sollte mit der Eigenschaft `name` Ihres Workers identisch sein.

```ts [my-custom-pool.ts]
import type { PoolRunnerInitializer } from 'vitest/node'

export function customPool(customOptions: CustomOptions): PoolRunnerInitializer {
  return {
    name: 'custom-pool',
    createPoolWorker: options => new CustomPoolWorker(options, customOptions),
  }
}
```

In Ihrem `CustomPoolWorker` müssen Sie alle erforderlichen Methoden definieren:

```ts [my-custom-pool.ts]
import type { PoolOptions, PoolWorker, WorkerRequest } from 'vitest/node'

class CustomPoolWorker implements PoolWorker {
  name = 'custom-pool'
  private customOptions: CustomOptions

  constructor(options: PoolOptions, customOptions: CustomOptions) {
    this.customOptions = customOptions
  }

  send(message: WorkerRequest): void {
    // Provide way to send your worker a message
  }

  on(event: string, callback: (arg: any) => void): void {
    // Provide way to listen to your workers events, e.g. message, error, exit
  }

  off(event: string, callback: (arg: any) => void): void {
    // Provide way to unsubscribe `on` listeners
  }

  async start() {
    // do something when the worker is started
  }

  async stop() {
    // cleanup the state
  }

  deserialize(data) {
    return data
  }
}
```

Ihr `CustomPoolRunner` steuert, wie der Lebenszyklus Ihres eigenen Test-Runner-Workers und dessen Kommunikationskanal funktionieren. Ihr `CustomPoolRunner` könnte beispielsweise einen `node:worker_threads`-`Worker` starten und die Kommunikation über `Worker.postMessage` und `parentPort` bereitstellen.

In Ihrer Worker-Datei können Sie Hilfsfunktionen aus `vitest/worker` importieren:

```ts [my-worker.ts]
import { init, runBaseTests, setupEnvironment } from 'vitest/worker'

init({
  post: (response) => {
    // Provide way to send this message to CustomPoolRunner's onWorker as message event
  },
  on: (callback) => {
    // Provide a way to listen CustomPoolRunner's "postMessage" calls
  },
  off: (callback) => {
    // Optional, provide a way to remove listeners added by "on" calls
  },
  teardown: () => {
    // Optional, provide a way to teardown worker, e.g. unsubscribe all the `on` listeners
  },
  serialize: (value) => {
    // Optional, provide custom serializer for `post` calls
  },
  deserialize: (value) => {
    // Optional, provide custom deserializer for `on` callbacks
  },
  runTests: (state, traces) => runBaseTests('run', state, traces),
  collectTests: (state, traces) => runBaseTests('collect', state, traces),
  setup: setupEnvironment,
})
```
