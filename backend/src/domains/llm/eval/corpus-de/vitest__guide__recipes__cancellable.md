# Abbrechbare Test-Ressourcen

Ein Test kann Ressourcen halten, die nicht enden, wenn der Test endet. Ein `fetch`, ein Kindprozess, ein Datei-Stream, eine Polling-Schleife: Nichts davon bemerkt, dass Vitest den Test abgebrochen hat, und der Worker muss dasitzen und warten, bis sie von selbst fertig werden. Vitest bricht einen Test ab, wenn er sein `timeout` überschreitet, wenn unter `--bail` ein anderer Test fehlschlägt, oder wenn jemand im Terminal <kbd>Strg</kbd>+<kbd>C</kbd> drückt.

Der Testkontext stellt ein [`signal`](/guide/test-context#signal) <Version>3.2.0</Version> bereit, das in all diesen Fällen ausgelöst wird. Übergeben Sie es an alles, was ein `AbortSignal` akzeptiert, und die Ressource wird freigegeben, sobald Vitest abbricht.

## Muster

```ts
import { test } from 'vitest'

test('stop request when test times out', async ({ signal }) => {
  await fetch('/heavy-resource', { signal })
}, 2000)
```

Wenn der Request nicht innerhalb von 2 Sekunden abgeschlossen ist, lehnt `fetch` mit einem `AbortError` ab, statt dass der Test hängt, bis die Operation beendet ist.

## Weitere Web-APIs, die ein `AbortSignal` akzeptieren

- [`fetch`](https://developer.mozilla.org/docs/Web/API/fetch)
- [`addEventListener`](https://developer.mozilla.org/docs/Web/API/EventTarget/addEventListener), wobei die Übergabe von `{ signal }` den Listener beim Abbruch entfernt
- [`ReadableStream.pipeTo`](https://developer.mozilla.org/docs/Web/API/ReadableStream/pipeTo)
- Node.js-APIs wie [`fs.readFile`](https://nodejs.org/api/fs.html#fspromisesreadfilepath-options), [`child_process.spawn`](https://nodejs.org/api/child_process.html#child_processspawncommand-args-options) und [`setTimeout` oder `setInterval`](https://nodejs.org/api/timers.html), die alle `{ signal }` akzeptieren
- Jeder eigene Code, der `signal.throwIfAborted()` aufruft oder auf `'abort'` lauscht

## Das Signal weiterreichen

Verdrahten Sie das Signal des Tests mit Ihren eigenen Helfern, damit sich der Abbruch bis ganz nach unten fortpflanzt:

```ts
async function pollUntilReady(url: string, signal: AbortSignal) {
  while (!signal.aborted) {
    const res = await fetch(url, { signal })
    if (res.ok) {
      return
    }
    await new Promise(r => setTimeout(r, 200))
  }
  signal.throwIfAborted()
}

test('worker becomes ready', async ({ signal }) => {
  await pollUntilReady('http://localhost:4000/health', signal)
}, 5000)
```

## Siehe auch

- [`signal` im Testkontext](/guide/test-context#signal)
- [`bail`](/config/bail)
- [`testTimeout`](/config/testtimeout)
