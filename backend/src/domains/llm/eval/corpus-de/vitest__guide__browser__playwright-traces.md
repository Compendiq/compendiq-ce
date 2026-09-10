# Playwright-Traces

Der Browser-Modus von Vitest unterstützt das Erzeugen von Playwrights [Trace-Dateien](https://playwright.dev/docs/trace-viewer#viewing-remote-traces). Um Tracing zu aktivieren, müssen Sie die Option [`trace`](/config/browser/trace) in der Konfiguration `test.browser` setzen.

::: warning
Das Erzeugen von Trace-Dateien ist nur bei Verwendung des [Playwright-Providers](/config/browser/playwright) möglich.
:::

::: code-group
```ts [vitest.config.js]
import { defineConfig } from 'vitest/config'
import { playwright } from '@vitest/browser-playwright'

export default defineConfig({
  test: {
    browser: {
      provider: playwright(),
      trace: 'on',
    },
  },
})
```
```bash [CLI]
vitest --browser.trace=on
```
:::

Standardmäßig erzeugt Vitest für jeden Test eine Trace-Datei. Sie können es auch so konfigurieren, dass Traces nur bei fehlgeschlagenen Tests erzeugt werden, indem Sie `trace` auf `'on-first-retry'`, `'on-all-retries'` oder `'retain-on-failure'` setzen. Die Dateien werden im Ordner `__traces__` neben Ihren Testdateien abgelegt. Der Name des Trace enthält den Projektnamen, den Testnamen sowie die Zähler für [`repeats`](/api/test#repeats) und [`retry`](/api/test#retry):

```
chromium-my-test-0-0.trace.zip
^^^^^^^^ project name
         ^^^^^^ test name
                ^ repeat count
                  ^ retry count
```

Um das Ausgabeverzeichnis zu ändern, können Sie die Option `tracesDir` in der Konfiguration `test.browser.trace` setzen. Auf diese Weise werden alle Traces im selben Verzeichnis abgelegt, gruppiert nach Testdatei.

```ts [vitest.config.js]
import { defineConfig } from 'vitest/config'
import { playwright } from '@vitest/browser-playwright'

export default defineConfig({
  test: {
    browser: {
      provider: playwright(),
      trace: {
        mode: 'on',
        // the path is relative to the root of the project
        tracesDir: './playwright-traces',
      },
    },
  },
})
```

Die Traces stehen in Reportern als [Annotationen](/guide/test-annotations) zur Verfügung. Im HTML-Reporter finden Sie beispielsweise den Link zur Trace-Datei in den Testdetails.

## Trace-Marker

Sie können explizite benannte Marker hinzufügen, um die Trace-Timeline leichter lesbar zu machen:

```ts
import { page } from 'vitest/browser'

document.body.innerHTML = `
  <button type="button">Sign in</button>
`

await page.getByRole('button', { name: 'Sign in' }).mark('sign in button rendered')
```

Sowohl `page.mark(name)` als auch `locator.mark(name)` sind verfügbar.

Mit `page.mark(name, callback)` können Sie außerdem mehrere Operationen unter einem Marker zusammenfassen:

```ts
await page.mark('sign in flow', async () => {
  await page.getByRole('textbox', { name: 'Email' }).fill('john@example.com')
  await page.getByRole('textbox', { name: 'Password' }).fill('secret')
  await page.getByRole('button', { name: 'Sign in' }).click()
})
```

Sie können wiederverwendbare Helper auch mit [`vi.defineHelper()`](/api/vi#vi-defineHelper) umschließen, sodass Trace-Einträge auf die Aufrufstelle des Helpers zeigen und nicht auf dessen Interna:

```ts
import { vi } from 'vitest'
import { page } from 'vitest/browser'

const myRender = vi.defineHelper(async (content: string) => {
  document.body.innerHTML = content
  await page.elementLocator(document.body).mark('render helper')
})

test('renders content', async () => {
  await myRender('<button>Hello</button>') // trace points to this line
})
```

## Vorschau

Um die Trace-Datei zu öffnen, können Sie den Playwright Trace Viewer verwenden. Führen Sie den folgenden Befehl in Ihrem Terminal aus:

```bash
npx playwright show-trace "path-to-trace-file"
```

Damit wird der Trace Viewer gestartet und die angegebene Trace-Datei geladen.

Alternativ können Sie den Trace Viewer in Ihrem Browser unter https://trace.playwright.dev öffnen und die Trace-Datei dort hochladen.

<img alt="Trace Viewer showing the trace timeline and rendered component" img-light src="/trace-viewer-light.png">
<img alt="Trace Viewer showing the trace timeline and rendered component" img-dark src="/trace-viewer-dark.png">

## Quellposition

Wenn Sie einen Trace öffnen, werden Sie feststellen, dass Vitest Browser-Interaktionen gruppiert und sie auf genau die Zeile in Ihrem Test zurückführt, die sie ausgelöst hat. Das geschieht automatisch für:

- `expect.element(...)`-Assertions
- Interaktive Aktionen wie `click`, `fill`, `type`, `hover`, `selectOptions`, `upload`, `dragAndDrop`, `tab`, `keyboard`, `wheel` sowie Screenshots

Im Hintergrund zeichnet Playwright weiterhin wie gewohnt seine eigenen Low-Level-Action-Events auf. Vitest umschließt sie mit Gruppen nach Quellposition, sodass Sie aus der Trace-Timeline direkt zur relevanten Zeile in Ihrem Test springen können.

Für alles, was nicht automatisch abgedeckt wird, können Sie mit `page.mark()` oder `locator.mark()` eigene Trace-Gruppen hinzufügen – siehe [Trace-Marker](#trace-markers) oben.
