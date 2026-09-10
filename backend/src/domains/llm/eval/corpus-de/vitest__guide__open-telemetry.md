# Open-Telemetry-Unterstützung <Experimental /> {#open-telemetry-support}

::: tip FEEDBACK
Bitte hinterlassen Sie Feedback zu dieser Funktion in einer [GitHub Discussion](https://github.com/vitest-dev/vitest/discussions/9222).
:::

::: tip Beispielprojekt
[GitHub](https://github.com/vitest-dev/vitest/tree/main/examples/opentelemetry)
:::

[OpenTelemetry](https://opentelemetry.io/)-Traces können ein nützliches Werkzeug sein, um Performance und Verhalten Ihrer Anwendung innerhalb von Tests zu debuggen.

Ist die Integration aktiviert, erzeugt Vitest Spans, die auf den Worker Ihres Tests beschränkt sind.

::: warning
Die Initialisierung von OpenTelemetry erhöht die Startzeit jedes Tests, sofern Vitest nicht ohne [Isolation](/config/isolate) läuft. Sie sehen das als Span `vitest.runtime.traces` innerhalb von `vitest.worker.start`.
:::

Um OpenTelemetry in Vitest zu nutzen, geben Sie über [`experimental.openTelemetry.sdkPath`](/config/experimental#experimental-opentelemetry) einen Pfad zu einem SDK-Modul an und setzen `experimental.openTelemetry.enabled` auf `true`. Vitest instrumentiert dann automatisch den gesamten Prozess und jeden einzelnen Test-Worker.

Achten Sie darauf, das SDK als Default-Export zu exportieren, damit Vitest die Netzwerk-Requests leeren kann, bevor der Prozess beendet wird. Beachten Sie, dass Vitest `start` nicht automatisch aufruft.

## Schnellstart

Bevor Sie sich die Traces Ihrer Anwendung ansehen können, installieren Sie die benötigten Pakete und geben in der Konfiguration den Pfad zu Ihrer Instrumentierungsdatei an.

```shell
npm i @opentelemetry/sdk-node @opentelemetry/auto-instrumentations-node @opentelemetry/exporter-trace-otlp-proto
```

::: code-group
```js{12} [otel.js]
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node'
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto'
import { NodeSDK } from '@opentelemetry/sdk-node'

const sdk = new NodeSDK({
  serviceName: 'vitest',
  traceExporter: new OTLPTraceExporter(),
  instrumentations: [getNodeAutoInstrumentations()],
})

sdk.start()
export default sdk
```
```js [vitest.config.js]
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    experimental: {
      openTelemetry: {
        enabled: true,
        sdkPath: './otel.js',
      },
    },
  },
})
```
:::

::: danger FAKE TIMERS
Wenn Sie Fake-Timer verwenden, ist es wichtig, sie vor dem Ende des Tests zurückzusetzen, da Traces sonst möglicherweise nicht korrekt erfasst werden.
:::

Vitest verarbeitet das Modul unter `sdkPath` nicht; deshalb ist es wichtig, dass sich das SDK innerhalb Ihrer Node.js-Umgebung importieren lässt. Idealerweise verwenden Sie für diese Datei die Endung `.js`. Eine andere Endung verlangsamt Ihre Tests und erfordert unter Umständen zusätzliche Node.js-Argumente.

Wenn Sie eine TypeScript-Datei bereitstellen möchten, machen Sie sich mit der Seite [TypeScript](https://nodejs.org/api/typescript.html#type-stripping) in der Node.js-Dokumentation vertraut.

## Eigene Traces

Sie können die OpenTelemetry-API selbst verwenden, um bestimmte Vorgänge in Ihrem Code zu verfolgen. Eigene Traces erben automatisch den OpenTelemetry-Kontext von Vitest:

```ts
import { trace } from '@opentelemetry/api'
import { test } from 'vitest'
import { db } from './src/db'

const tracer = trace.getTracer('vitest')

test('db connects properly', async () => {
  // this is shown inside `vitest.test.runner.test.callback` span
  await tracer.startActiveSpan('db.connect', () => db.connect())
})
```

## Browser-Modus

Wenn Tests im [Browser-Modus](/guide/browser/) laufen, propagiert Vitest den Trace-Kontext zwischen Node.js und dem Browser. Traces auf der Node.js-Seite (Testorchestrierung, Kommunikation mit dem Browser-Treiber) sind ohne zusätzliche Konfiguration verfügbar.

Um Traces aus der Browser-Laufzeit zu erfassen, geben Sie über `browserSdkPath` ein browserkompatibles SDK an:

```shell
npm i @opentelemetry/sdk-trace-web @opentelemetry/exporter-trace-otlp-proto
```

::: code-group
```js [otel-browser.js]
import {
  BatchSpanProcessor,
  WebTracerProvider,
} from '@opentelemetry/sdk-trace-web'
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto'

const provider = new WebTracerProvider({
  spanProcessors: [
    new BatchSpanProcessor(new OTLPTraceExporter()),
  ],
})

provider.register()
export default provider
```
```js [vitest.config.js]
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    browser: {
      enabled: true,
      provider: 'playwright',
      instances: [{ browser: 'chromium' }],
    },
    experimental: {
      openTelemetry: {
        enabled: true,
        sdkPath: './otel.js',
        browserSdkPath: './otel-browser.js',
      },
    },
  },
})
```
:::

::: warning ASYNC CONTEXT
Anders als Node.js besitzen Browser keine automatische Propagierung des Async-Kontexts. Vitest kümmert sich intern darum für die Testausführung, aber eigene Spans in tief verschachteltem asynchronem Code propagieren den Kontext möglicherweise nicht automatisch.
:::

## Traces ansehen

Um Traces zu erzeugen, führen Sie Vitest wie gewohnt aus. Sie können Vitest sowohl im Watch-Modus als auch im Run-Modus betreiben. Vitest ruft `sdk.shutdown()` manuell auf, nachdem alles abgeschlossen ist, um sicherzustellen, dass Traces korrekt verarbeitet werden.

Sie können Traces mit jedem Open-Source- oder kommerziellen Produkt ansehen, das die OpenTelemetry-API unterstützt. Wenn Sie OpenTelemetry bisher nicht verwendet haben, empfehlen wir den Einstieg mit [Jaeger](https://www.jaegertracing.io/docs/2.11/getting-started/#all-in-one), weil es sich wirklich einfach einrichten lässt.

<img src="/otel-jaeger.png" alt="an example of open telemetry result in jaeger" />

## `@opentelemetry/api`

Vitest deklariert `@opentelemetry/api` als optionale Peer-Dependency und nutzt sie intern, um Spans zu erzeugen. Ist die Trace-Erfassung nicht aktiviert, versucht Vitest nicht, diese Abhängigkeit zu verwenden.

Wenn Sie Vitest für OpenTelemetry konfigurieren, installieren Sie üblicherweise `@opentelemetry/sdk-node`, das `@opentelemetry/api` als transitive Abhängigkeit enthält und damit die Peer-Dependency-Anforderung von Vitest erfüllt. Wenn Sie einen Fehler sehen, der besagt, dass `@opentelemetry/api` nicht gefunden werden kann, bedeutet das in der Regel, dass die Trace-Erfassung nicht aktiviert wurde. Bleibt der Fehler auch nach korrekter Konfiguration bestehen, müssen Sie `@opentelemetry/api` möglicherweise explizit installieren.

## Kontextpropagierung zwischen Prozessen

Vitest unterstützt die automatische Kontextpropagierung von Elternprozessen über die Umgebungsvariablen `TRACEPARENT` und `TRACESTATE`, wie sie in der [OpenTelemetry-Spezifikation](https://github.com/open-telemetry/opentelemetry-specification/blob/main/specification/context/env-carriers.md) definiert sind. Das ist besonders nützlich, wenn Vitest Teil eines größeren verteilten Tracing-Systems ist (z. B. CI/CD-Pipelines mit OpenTelemetry-Instrumentierung).
