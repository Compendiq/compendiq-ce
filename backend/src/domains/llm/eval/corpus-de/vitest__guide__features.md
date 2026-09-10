# Funktionen

<script setup>
import FeaturesList from '../.vitepress/components/FeaturesList.vue'
</script>

<FeaturesList class="!gap-1 text-lg" />

<div h-2 />
<CourseLink href="https://vueschool.io/lessons/your-first-test?friend=vueuse">Lernen Sie im Video, wie Sie Ihren ersten Test schreiben</CourseLink>

::: tip
Diese Seite ist ein grober Überblick über die Fähigkeiten von Vitest. Wenn Sie neu bei Vitest sind, empfehlen wir, zuerst das Tutorial [Learn](/guide/learn/writing-tests) für eine praxisnahe Einführung zu lesen.
:::

## Gemeinsame Konfiguration für Test, Entwicklung und Build

Vites Konfiguration, Transformer, Resolver und Plugins. Verwenden Sie dasselbe Setup wie in Ihrer App, um die Tests auszuführen.

Mehr dazu unter [Vitest konfigurieren](/config/).

## Watch-Modus

```bash
$ vitest
```

Wenn Sie Ihren Quellcode oder die Testdateien ändern, durchsucht Vitest intelligent den Modulgraphen und führt nur die zugehörigen Tests erneut aus – genau so, wie HMR in Vite funktioniert!

`vitest` startet intelligent **standardmäßig in der Entwicklungsumgebung** im `watch mode` und in der CI-Umgebung (wenn `process.env.CI` vorhanden ist) im `run mode`. Sie können `vitest watch` oder `vitest run` verwenden, um den gewünschten Modus explizit anzugeben.

Starten Sie Vitest mit dem Flag `--standalone`, damit es im Hintergrund weiterläuft. Es führt keine Tests aus, bis sie sich ändern. Vitest führt bei geändertem Quellcode keine Tests aus, solange der Test, der die Quelle importiert, nicht bereits gelaufen ist.

## Gängige Web-Idiome out of the box

ES-Module-, TypeScript-, JSX- und PostCSS-Unterstützung out of the box

## Threads

Standardmäßig führt Vitest Testdateien in [mehreren Prozessen](/guide/parallelism) mit [`node:child_process`](https://nodejs.org/api/child_process.html) aus, sodass Tests gleichzeitig laufen können. Wenn Sie Ihre Test-Suite noch weiter beschleunigen wollen, erwägen Sie, `--pool=threads` zu aktivieren, um Tests mit [`node:worker_threads`](https://nodejs.org/api/worker_threads.html) auszuführen (beachten Sie, dass manche Pakete mit diesem Setup möglicherweise nicht funktionieren).
Um Tests in einem einzigen Thread oder Prozess auszuführen, siehe [`fileParallelism`](/config/fileparallelism).

Vitest isoliert außerdem die Umgebung jeder Datei, sodass Änderungen an der Umgebung in einer Datei andere nicht beeinflussen. Die Isolation kann durch Übergabe von `--no-isolate` an die CLI deaktiviert werden (wobei Korrektheit gegen Laufzeit-Performance eingetauscht wird).

## Tests filtern

Vitest bietet viele Möglichkeiten, die auszuführenden Tests einzugrenzen, um das Testen zu beschleunigen, damit Sie sich auf die Entwicklung konzentrieren können.

Mehr dazu unter [Tests filtern](/guide/filtering).

## Tests nebenläufig ausführen

Verwenden Sie `.concurrent` bei aufeinanderfolgenden Tests, um sie parallel zu starten.

```ts
import { describe, it } from 'vitest'

// The two tests marked with concurrent will be started in parallel
describe('suite', () => {
  it('serial test', async () => { /* ... */ })
  it.concurrent('concurrent test 1', async ({ expect }) => { /* ... */ })
  it.concurrent('concurrent test 2', async ({ expect }) => { /* ... */ })
})
```

Wenn Sie `.concurrent` auf eine Suite anwenden, wird jeder Test darin parallel gestartet.

```ts
import { describe, it } from 'vitest'

// All tests within this suite will be started in parallel
describe.concurrent('suite', () => {
  it('concurrent test 1', async ({ expect }) => { /* ... */ })
  it('concurrent test 2', async ({ expect }) => { /* ... */ })
  it.concurrent('concurrent test 3', async ({ expect }) => { /* ... */ })
})
```

Sie können `.skip`, `.only` und `.todo` auch bei nebenläufigen Suites und Tests verwenden. Mehr dazu in der [API-Referenz](/api/test#test-concurrent).

::: warning
Beim Ausführen nebenläufiger Tests müssen Snapshots und Assertions das `expect` aus dem lokalen [Test-Kontext](/guide/test-context) verwenden, damit der richtige Test erkannt wird.
:::

## Snapshot

[Jest-kompatible](https://jestjs.io/docs/snapshot-testing) Snapshot-Unterstützung.

```ts
import { expect, it } from 'vitest'

it('renders correctly', () => {
  const result = render()
  expect(result).toMatchSnapshot()
})
```

Mehr dazu unter [Snapshot](/guide/snapshot).

## Kompatibilität mit Chai und Jest `expect`

[Chai](https://www.chaijs.com/) ist für Assertions mit [Jest-`expect`](https://jestjs.io/docs/expect)-kompatiblen APIs eingebaut.

Beachten Sie: Wenn Sie Drittanbieter-Bibliotheken verwenden, die Matcher hinzufügen, sorgt das Setzen von [`test.globals`](/config/globals) auf `true` für bessere Kompatibilität.

## Mocking

Vitest stellt `jest`-kompatible APIs auf dem `vi`-Objekt bereit.

```ts
import { expect, vi } from 'vitest'

const fn = vi.fn()

fn('hello', 1)

expect(vi.isMockFunction(fn)).toBe(true)
expect(fn.mock.calls[0]).toEqual(['hello', 1])

fn.mockImplementation((arg: string) => arg)

fn('world', 2)

expect(fn.mock.results[1].value).toBe('world')
```

Vitest unterstützt sowohl [happy-dom](https://github.com/capricorn86/happy-dom) als auch [jsdom](https://github.com/jsdom/jsdom), um DOM- und Browser-APIs zu mocken. Sie werden nicht mit Vitest ausgeliefert, Sie müssen sie separat installieren:

::: code-group
```bash [happy-dom]
$ npm i -D happy-dom
```
```bash [jsdom]
$ npm i -D jsdom
```
:::

Ändern Sie danach die Option `environment` in Ihrer Konfigurationsdatei:

```ts [vitest.config.ts]
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'happy-dom', // or 'jsdom', 'node'
  },
})
```

Mehr dazu unter [Mocking](/guide/mocking).

## Coverage

Vitest unterstützt native Code Coverage über [`v8`](https://v8.dev/blog/javascript-code-coverage) und instrumentierte Code Coverage über [`istanbul`](https://istanbul.js.org/).

```json [package.json]
{
  "scripts": {
    "test": "vitest",
    "coverage": "vitest run --coverage"
  }
}
```

Mehr dazu unter [Coverage](/guide/coverage).

## In-Source-Testing

Vitest bietet außerdem eine Möglichkeit, Tests innerhalb Ihres Quellcodes zusammen mit der Implementierung auszuführen, ähnlich wie bei [Rusts Modultests](https://doc.rust-lang.org/book/ch11-03-test-organization.html#the-tests-module-and-cfgtest).

Dadurch teilen sich die Tests dieselbe Closure wie die Implementierungen und können gegen private Zustände testen, ohne sie zu exportieren. Gleichzeitig rückt das die Feedbackschleife bei der Entwicklung näher.

```ts [src/index.ts]
// the implementation
export function add(...args: number[]): number {
  return args.reduce((a, b) => a + b, 0)
}

// in-source test suites
if (import.meta.vitest) {
  const { it, expect } = import.meta.vitest
  it('add', () => {
    expect(add()).toBe(0)
    expect(add(1)).toBe(1)
    expect(add(1, 2, 3)).toBe(6)
  })
}
```

Mehr dazu unter [In-source testing](/guide/in-source).

## Benchmarking <Experimental /> {#benchmarking}

Sie können Benchmark-Tests mit der Funktion [`bench`](/api/test#bench) über [Tinybench](https://github.com/tinylibs/tinybench) ausführen, um Performance-Ergebnisse zu vergleichen.

```ts [sort.bench.ts]
import { bench, describe } from 'vitest'

describe('sort', () => {
  bench('normal', () => {
    const x = [1, 5, 4, 2, 3]
    x.sort((a, b) => {
      return a - b
    })
  })

  bench('reverse', () => {
    const x = [1, 5, 4, 2, 3]
    x.reverse().sort((a, b) => {
      return a - b
    })
  })
})
```

<img alt="Benchmark report" img-dark src="https://github.com/vitest-dev/vitest/assets/4232207/6f0383ea-38ba-4f14-8a05-ab243afea01d">
<img alt="Benchmark report" img-light src="https://github.com/vitest-dev/vitest/assets/4232207/efbcb427-ecf1-4882-88de-210cd73415f6">

## Typ-Tests <Experimental /> {#type-testing}

Sie können [Tests schreiben](/guide/testing-types), um Typ-Regressionen abzufangen. Vitest bringt das Paket [`expect-type`](https://github.com/mmkal/expect-type) mit, das Ihnen eine ähnliche und leicht verständliche API bietet.

```ts [types.test-d.ts]
import { assertType, expectTypeOf, test } from 'vitest'
import { mount } from './mount.js'

test('my types work properly', () => {
  expectTypeOf(mount).toBeFunction()
  expectTypeOf(mount).parameter(0).toExtend<{ name: string }>()

  // @ts-expect-error name is a string
  assertType(mount({ name: 42 }))
})
```

## Sharding

Führen Sie Tests auf verschiedenen Maschinen mit den Flags [`--shard`](/guide/cli#shard) und [`--reporter=blob`](/guide/reporters#blob-reporter) aus.
Alle Test- und Coverage-Ergebnisse können am Ende Ihrer CI-Pipeline mit dem Befehl `--merge-reports` zusammengeführt werden:

```bash
vitest --shard=1/2 --reporter=blob --coverage
vitest --shard=2/2 --reporter=blob --coverage
vitest --merge-reports --reporter=junit --coverage
```

Weitere Informationen finden Sie unter [`Improving Performance | Sharding`](/guide/improving-performance#sharding).

## Umgebungsvariablen

Vitest lädt aus `.env`-Dateien ausschließlich Umgebungsvariablen mit dem Präfix `VITE_` automatisch, um die Kompatibilität mit Frontend-bezogenen Tests zu wahren und [Vites etablierter Konvention](https://vitejs.dev/guide/env-and-mode.html#env-files) zu folgen. Um dennoch jede Umgebungsvariable aus `.env`-Dateien zu laden, können Sie die aus `vite` importierte Methode `loadEnv` verwenden:

```ts [vitest.config.ts]
import { loadEnv } from 'vite'
import { defineConfig } from 'vitest/config'

export default defineConfig(({ mode }) => ({
  test: {
    // mode defines what ".env.{mode}" file to choose if exists
    env: loadEnv(mode, process.cwd(), ''),
  },
}))
```

## Unbehandelte Fehler

Standardmäßig fängt und meldet Vitest alle [unbehandelten Rejections](https://developer.mozilla.org/en-US/docs/Web/API/Window/unhandledrejection_event), [nicht abgefangenen Exceptions](https://nodejs.org/api/process.html#event-uncaughtexception) (in Node.js) und [error](https://developer.mozilla.org/en-US/docs/Web/API/Window/error_event)-Events (im [Browser](/guide/browser/)).

Sie können dieses Verhalten deaktivieren, indem Sie sie manuell abfangen. Vitest geht dann davon aus, dass Sie sich um den Callback kümmern, und meldet den Fehler nicht.

::: code-group
```ts [setup.node.js]
// in Node.js
process.on('unhandledRejection', () => {
  // your own handler
})

process.on('uncaughtException', () => {
  // your own handler
})
```
```ts [setup.browser.js]
// in the browser
window.addEventListener('error', () => {
  // your own handler
})

window.addEventListener('unhandledrejection', () => {
  // your own handler
})
```
:::

Alternativ können Sie gemeldete Fehler auch mit der Option [`dangerouslyIgnoreUnhandledErrors`](/config/dangerouslyignoreunhandlederrors) ignorieren. Vitest meldet sie weiterhin, aber sie beeinflussen das Testergebnis nicht (der Exit-Code ändert sich nicht).

Wenn Sie testen müssen, dass ein Fehler nicht abgefangen wurde, können Sie einen Test wie diesen schreiben:

```ts
test('my function throws uncaught error', async ({ onTestFinished }) => {
  const unhandledRejectionListener = vi.fn()
  process.on('unhandledRejection', unhandledRejectionListener)
  onTestFinished(() => {
    process.off('unhandledRejection', unhandledRejectionListener)
  })

  callMyFunctionThatRejectsError()

  await expect.poll(unhandledRejectionListener).toHaveBeenCalled()
})
```
