# Browser-Modus {#browser-mode}

Diese Seite informiert über die Browser-Modus-Funktion in der Vitest-API, mit der du deine Tests nativ im Browser ausführen kannst und Zugriff auf Browser-Globals wie window und document erhältst.

::: tip
Wenn du Dokumentation zu `expect`, `vi` oder einer allgemeinen API wie Test-Projekten oder Type Testing suchst, sieh dir den ["Getting Started"-Leitfaden](/guide/) an.
:::

<img alt="Vitest UI" img-light src="/ui-browser-1-light.png">
<img alt="Vitest UI" img-dark src="/ui-browser-1-dark.png">

## Installation

Für ein einfacheres Setup kannst du den Befehl `vitest init browser` verwenden, um die erforderlichen Abhängigkeiten zu installieren und eine Browser-Konfiguration zu erzeugen.

::: code-group
```bash [npm]
npx vitest init browser
```
```bash [yarn]
yarn exec vitest init browser
```
```bash [pnpm]
pnpx vitest init browser
```
```bash [bun]
bunx vitest init browser
```
:::

### Manuelle Installation

Du kannst die Pakete auch manuell installieren. Vitest verlangt immer, dass ein Provider definiert ist. Du kannst zwischen [`preview`](/config/browser/preview), [`playwright`](/config/browser/playwright) und [`webdriverio`](/config/browser/webdriverio) wählen.

Wenn du nur eine Vorschau davon haben möchtest, wie deine Tests aussehen, kannst du den Provider `preview` verwenden:

::: code-group
```bash [npm]
npm install -D vitest @vitest/browser-preview
```
```bash [yarn]
yarn add -D vitest @vitest/browser-preview
```
```bash [pnpm]
pnpm add -D vitest @vitest/browser-preview
```
```bash [bun]
bun add -D vitest @vitest/browser-preview
```
:::

::: warning
Um Tests in der CI auszuführen, musst du allerdings entweder [`playwright`](https://npmx.dev/package/playwright) oder [`webdriverio`](https://npmx.dev/package/webdriverio) installieren. Wir empfehlen außerdem, auch lokal auf eines von beiden umzusteigen, statt den Standard-Provider `preview` zu verwenden, da dieser Events simuliert, statt das Chrome DevTools Protocol zu nutzen.

Wenn du keines dieser Werkzeuge bereits verwendest, empfehlen wir, mit Playwright zu beginnen, da es parallele Ausführung unterstützt, wodurch deine Tests schneller laufen.

::: tabs key:provider
== Playwright
[Playwright](https://npmx.dev/package/playwright) ist ein Framework für Web-Testing und -Automatisierung.

::: code-group
```bash [npm]
npm install -D vitest @vitest/browser-playwright
```
```bash [yarn]
yarn add -D vitest @vitest/browser-playwright
```
```bash [pnpm]
pnpm add -D vitest @vitest/browser-playwright
```
```bash [bun]
bun add -D vitest @vitest/browser-playwright
```
== WebdriverIO

[WebdriverIO](https://npmx.dev/package/webdriverio) erlaubt es dir, Tests lokal über das WebDriver-Protokoll auszuführen.

::: code-group
```bash [npm]
npm install -D vitest @vitest/browser-webdriverio
```
```bash [yarn]
yarn add -D vitest @vitest/browser-webdriverio
```
```bash [pnpm]
pnpm add -D vitest @vitest/browser-webdriverio
```
```bash [bun]
bun add -D vitest @vitest/browser-webdriverio
```
:::

## Konfiguration

Um den Browser-Modus in deiner Vitest-Konfiguration zu aktivieren, setze das Feld `browser.enabled` in deiner Vitest-Konfigurationsdatei auf `true`. Hier ein Beispiel für eine Konfiguration mit dem browser-Feld:

```ts [vitest.config.ts]
import { defineConfig } from 'vitest/config'
import { playwright } from '@vitest/browser-playwright'

export default defineConfig({
  test: {
    browser: {
      provider: playwright(),
      enabled: true,
      // at least one instance is required
      instances: [
        { browser: 'chromium' },
      ],
    },
  }
})
```

::: info
Vitest belegt Port `63315`, um Konflikte mit dem Entwicklungsserver zu vermeiden, sodass du beide parallel betreiben kannst. Du kannst das mit der Option [`api`](/config/api) ändern.
:::

Wenn du Vite noch nicht verwendet hast, stelle sicher, dass das Plugin deines Frameworks installiert und in der Konfiguration angegeben ist. Manche Frameworks benötigen zusätzliche Konfiguration – sieh zur Sicherheit in deren Vite-bezogene Dokumentation.

::: code-group
```ts [react]
import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import { playwright } from '@vitest/browser-playwright'

export default defineConfig({
  plugins: [react()],
  test: {
    browser: {
      enabled: true,
      provider: playwright(),
      instances: [
        { browser: 'chromium' },
      ],
    }
  }
})
```
```ts [vue]
import { defineConfig } from 'vitest/config'
import { playwright } from '@vitest/browser-playwright'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
  plugins: [vue()],
  test: {
    browser: {
      enabled: true,
      provider: playwright(),
      instances: [
        { browser: 'chromium' },
      ],
    }
  }
})
```
```ts [svelte]
import { defineConfig } from 'vitest/config'
import { svelte } from '@sveltejs/vite-plugin-svelte'
import { playwright } from '@vitest/browser-playwright'

export default defineConfig({
  plugins: [svelte()],
  test: {
    browser: {
      enabled: true,
      provider: playwright(),
      instances: [
        { browser: 'chromium' },
      ],
    }
  }
})
```
```ts [solid]
import { defineConfig } from 'vitest/config'
import solidPlugin from 'vite-plugin-solid'
import { playwright } from '@vitest/browser-playwright'

export default defineConfig({
  plugins: [solidPlugin()],
  test: {
    browser: {
      enabled: true,
      provider: playwright(),
      instances: [
        { browser: 'chromium' },
      ],
    }
  }
})
```
```ts [marko]
import { defineConfig } from 'vitest/config'
import marko from '@marko/vite'
import { playwright } from '@vitest/browser-playwright'

export default defineConfig({
  plugins: [marko()],
  test: {
    browser: {
      enabled: true,
      provider: playwright(),
      instances: [
        { browser: 'chromium' },
      ],
    }
  }
})
```
```ts [qwik]
import { defineConfig } from 'vitest/config'
import { qwikVite } from '@builder.io/qwik/optimizer'
import { playwright } from '@vitest/browser-playwright'

// optional, run the tests in SSR mode
import { testSSR } from 'vitest-browser-qwik/ssr-plugin'

export default defineConfig({
  plugins: [testSSR(), qwikVite()],
  test: {
    browser: {
      enabled: true,
      provider: playwright(),
      instances: [{ browser: 'chromium' }]
    },
  },
})
```
:::

Wenn du einige Tests mit einem Node-basierten Runner ausführen musst, kannst du eine [`projects`](/guide/projects)-Option mit separaten Konfigurationen für verschiedene Teststrategien definieren:

{#projects-config}

```ts [vitest.config.ts]
import { defineConfig } from 'vitest/config'
import { playwright } from '@vitest/browser-playwright'

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          // an example of file based convention,
          // you don't have to follow it
          include: [
            'tests/unit/**/*.{test,spec}.ts',
            'tests/**/*.unit.{test,spec}.ts',
          ],
          name: 'unit',
          environment: 'node',
        },
      },
      {
        test: {
          // an example of file based convention,
          // you don't have to follow it
          include: [
            'tests/browser/**/*.{test,spec}.ts',
            'tests/**/*.browser.{test,spec}.ts',
          ],
          name: 'browser',
          browser: {
            enabled: true,
            provider: playwright(),
            instances: [
              { browser: 'chromium' },
            ],
          },
        },
      },
    ],
  },
})
```

## Typen der Browser-Option

Die browser-Option in Vitest hängt vom Provider ab. Vitest schlägt fehl, wenn du `--browser` übergibst und dessen Namen nicht in der Konfigurationsdatei angibst. Verfügbare Optionen:

- `webdriverio` unterstützt diese Browser:
  - `firefox`
  - `chrome`
  - `edge`
  - `safari`
- `playwright` unterstützt diese Browser:
  - `firefox`
  - `webkit`
  - `chromium`

## Browser-Kompatibilität

Vitest verwendet den [Vite-Dev-Server](https://vitejs.dev/guide/#browser-support), um deine Tests auszuführen, daher unterstützen wir nur Features, die in der Option [`esbuild.target`](https://vitejs.dev/config/shared-options.html#esbuild) angegeben sind (standardmäßig `esnext`).

Standardmäßig zielt Vite auf Browser, die native [ES Modules](https://caniuse.com/es6-module), nativen [dynamischen ESM-Import](https://caniuse.com/es6-module-dynamic-import) und [`import.meta`](https://caniuse.com/mdn-javascript_operators_import_meta) unterstützen. Darüber hinaus nutzen wir [`BroadcastChannel`](https://caniuse.com/?search=BroadcastChannel), um zwischen iframes zu kommunizieren:

- Chrome >=87
- Firefox >=78
- Safari >=15.4
- Edge >=88

## Tests ausführen

Wenn du einen Browser-Namen in der browser-Option angibst, versucht Vitest standardmäßig, den angegebenen Browser über `preview` zu starten und die Tests dort auszuführen. Wenn du `preview` nicht verwenden möchtest, kannst du über die Option `browser.provider` einen eigenen Browser-Provider konfigurieren.

Um einen Browser über die CLI anzugeben, verwende das Flag `--browser` gefolgt vom Browser-Namen, etwa so:

```sh
npx vitest --browser=chromium
```

Oder du übergibst der CLI Browser-Optionen in Punktnotation:

```sh
npx vitest --browser.headless
```

::: warning
Seit Vitest 3.2 schlägt Vitest fehl, wenn du die Option `browser` nicht in deiner Konfiguration hast, aber das Flag `--browser` angibst, weil es nicht annehmen kann, dass die Konfiguration für den Browser und nicht für Node.js-Tests gedacht ist.
:::

Standardmäßig öffnet Vitest während der Entwicklung automatisch die Browser-UI. Deine Tests laufen in einem iframe in der Mitte. Du kannst den Viewport konfigurieren, indem du die bevorzugten Abmessungen wählst, `page.viewport` im Test aufrufst oder Standardwerte in [der Konfiguration](/config/browser/viewport) setzt.

Ein alternatives Debugging-Modell, das für jeden Test DOM-Snapshots erfasst, statt ein Live-iframe zu zeigen, findest du unter [Trace View](/guide/browser/trace-view).

## Headless

Der Headless-Modus ist eine weitere Option im Browser-Modus. Im Headless-Modus läuft der Browser im Hintergrund ohne Benutzeroberfläche, was ihn für automatisierte Tests nützlich macht. Die headless-Option in Vitest kann auf einen booleschen Wert gesetzt werden, um den Headless-Modus zu aktivieren oder zu deaktivieren.

Im Headless-Modus öffnet Vitest die UI nicht automatisch. Wenn du weiterhin die UI verwenden, die Tests aber headless ausführen möchtest, kannst du das Paket [`@vitest/ui`](/guide/ui) installieren und beim Ausführen von Vitest das Flag `--ui` übergeben.

Hier ein Beispiel für eine Konfiguration, die den Headless-Modus aktiviert:

```ts [vitest.config.ts]
import { defineConfig } from 'vitest/config'
import { playwright } from '@vitest/browser-playwright'

export default defineConfig({
  test: {
    browser: {
      provider: playwright(),
      enabled: true,
      headless: true,
    },
  }
})
```

Du kannst den Headless-Modus auch über das Flag `--browser.headless` in der CLI setzen, etwa so:

```sh
npx vitest --browser.headless
```

In diesem Fall läuft Vitest headless im Chrome-Browser.

::: warning
Der Headless-Modus ist standardmäßig nicht verfügbar. Du musst entweder den Provider [`playwright`](https://npmx.dev/package/playwright) oder [`webdriverio`](https://npmx.dev/package/webdriverio) verwenden, um diese Funktion zu aktivieren.
:::

## Beispiele

Standardmäßig brauchst du keine externen Pakete, um mit dem Browser-Modus zu arbeiten:

```js [example.test.js]
import { expect, test } from 'vitest'
import { page } from 'vitest/browser'
import { render } from './my-render-function.js'

test('properly handles form inputs', async () => {
  render() // mount DOM elements

  // Asserts initial state.
  await expect.element(page.getByText('Hi, my name is Alice')).toBeInTheDocument()

  // Get the input DOM node by querying the associated label.
  const usernameInput = page.getByLabelText(/username/i)

  // Type the name into the input. This already validates that the input
  // is filled correctly, no need to check the value manually.
  await usernameInput.fill('Bob')

  await expect.element(page.getByText('Hi, my name is Bob')).toBeInTheDocument()
})
```

Vitest stellt jedoch auch Pakete bereit, um Komponenten für mehrere verbreitete Frameworks direkt zu rendern:

- [`vitest-browser-vue`](https://github.com/vitest-dev/vitest-browser-vue) zum Rendern von [vue](https://vuejs.org)-Komponenten
- [`vitest-browser-svelte`](https://github.com/vitest-dev/vitest-browser-svelte) zum Rendern von [svelte](https://svelte.dev)-Komponenten
- [`vitest-browser-react`](https://github.com/vitest-dev/vitest-browser-react) zum Rendern von [react](https://react.dev)-Komponenten
- [`vitest-browser-angular`](https://github.com/vitest-community/vitest-browser-angular) zum Rendern von [Angular](https://angular.dev)-Komponenten

Für andere Frameworks sind Community-Pakete verfügbar:

- [`vitest-browser-lit`](https://github.com/EskiMojo14/vitest-browser-lit) zum Rendern von [lit](https://lit.dev)-Komponenten
- [`vitest-browser-preact`](https://github.com/JoviDeCroock/vitest-browser-preact) zum Rendern von [preact](https://preactjs.com)-Komponenten
- [`vitest-browser-qwik`](https://github.com/QwikDev/vitest-browser-qwik) zum Rendern von [qwik](https://qwik.dev)-Komponenten

Wenn dein Framework nicht vertreten ist, erstelle gern dein eigenes Paket – es ist ein einfacher Wrapper um den Renderer des Frameworks und die API `page.elementLocator`. Wir nehmen einen Link darauf auf dieser Seite auf. Achte darauf, dass sein Name mit `vitest-browser-` beginnt.

Neben dem Rendern von Komponenten und dem Auffinden von Elementen musst du auch Assertions formulieren. Vitest forkt die Bibliothek [`@testing-library/jest-dom`](https://github.com/testing-library/jest-dom), um von Haus aus eine breite Palette an DOM-Assertions bereitzustellen. Mehr dazu in der [Assertions-API](/api/browser/assertions).

```ts
import { expect } from 'vitest'
import { page } from 'vitest/browser'
// element is rendered correctly
await expect.element(page.getByText('Hello World')).toBeInTheDocument()
```

Vitest stellt eine [Context-API](/api/browser/context) mit einer kleinen Sammlung von Hilfsmitteln bereit, die dir in Tests nützlich sein können. Wenn du zum Beispiel eine Interaktion durchführen musst, etwa ein Element anklicken oder Text in ein Eingabefeld tippen, kannst du `userEvent` aus `vitest/browser` verwenden. Mehr dazu in der [Interactivity-API](/api/browser/interactivity).

```ts
import { page, userEvent } from 'vitest/browser'
await userEvent.fill(page.getByLabelText(/username/i), 'Alice')
// or just locator.fill
await page.getByLabelText(/username/i).fill('Alice')
```

::: code-group
```ts [vue]
import { render } from 'vitest-browser-vue'
import Component from './Component.vue'

test('properly handles v-model', async () => {
  const screen = await render(Component)

  // Asserts initial state.
  await expect.element(screen.getByText('Hi, my name is Alice')).toBeInTheDocument()

  // Get the input DOM node by querying the associated label.
  const usernameInput = screen.getByLabelText(/username/i)

  // Type the name into the input. This already validates that the input
  // is filled correctly, no need to check the value manually.
  await usernameInput.fill('Bob')

  await expect.element(screen.getByText('Hi, my name is Bob')).toBeInTheDocument()
})
```
```ts [svelte]
import { render } from 'vitest-browser-svelte'
import { expect, test } from 'vitest'

import Greeter from './greeter.svelte'

test('greeting appears on click', async () => {
  const screen = await render(Greeter, { name: 'World' })

  const button = screen.getByRole('button')
  await button.click()
  const greeting = screen.getByText(/hello world/iu)

  await expect.element(greeting).toBeInTheDocument()
})
```
```tsx [react]
import { render } from 'vitest-browser-react'
import Fetch from './fetch'

test('loads and displays greeting', async () => {
  // Render a React element into the DOM
  const screen = render(<Fetch url="/greeting" />)

  await screen.getByText('Load Greeting').click()
  // wait before throwing an error if it cannot find an element
  const heading = screen.getByRole('heading')

  // assert that the alert message is correct
  await expect.element(heading).toHaveTextContent('hello there')
  await expect.element(screen.getByRole('button')).toBeDisabled()
})
```
```ts [lit]
import { render } from 'vitest-browser-lit'
import { html } from 'lit'
import './greeter-button'

test('greeting appears on click', async () => {
  const screen = render(html`<greeter-button name="World"></greeter-button>`)

  const button = screen.getByRole('button')
  await button.click()
  const greeting = screen.getByText(/hello world/iu)

  await expect.element(greeting).toBeInTheDocument()
})
```
```tsx [preact]
import { render } from 'vitest-browser-preact'
import { createElement } from 'preact'
import Greeting from '.Greeting'

test('greeting appears on click', async () => {
  const screen = render(<Greeting />)

  const button = screen.getByRole('button')
  await button.click()
  const greeting = screen.getByText(/hello world/iu)

  await expect.element(greeting).toBeInTheDocument()
})
```
```tsx [qwik]
import { render } from 'vitest-browser-qwik'
import Greeting from './greeting'

test('greeting appears on click', async () => {
  // renderSSR and renderHook are also available
  const screen = render(<Greeting />)

  const button = screen.getByRole('button')
  await button.click()
  const greeting = screen.getByText(/hello world/iu)

  await expect.element(greeting).toBeInTheDocument()
})
```
:::

Vitest unterstützt nicht alle Frameworks von Haus aus, du kannst aber externe Werkzeuge verwenden, um Tests mit diesen Frameworks auszuführen. Wir ermutigen die Community außerdem, eigene `vitest-browser`-Wrapper zu erstellen – wenn du einen hast, ergänze ihn gern bei den Beispielen oben.

Für nicht unterstützte Frameworks empfehlen wir die `testing-library`-Pakete:

- [`@solidjs/testing-library`](https://testing-library.com/docs/solid-testing-library/intro) zum Rendern von [solid](https://www.solidjs.com)-Komponenten
- [`@marko/testing-library`](https://testing-library.com/docs/marko-testing-library/intro) zum Rendern von [marko](https://markojs.com)-Komponenten

Weitere Beispiele findest du auch im Repository [`browser-examples`](https://github.com/vitest-tests/browser-examples).

::: warning
`testing-library` stellt ein Paket `@testing-library/user-event` bereit. Wir empfehlen nicht, es direkt zu verwenden, da es Events simuliert, statt sie tatsächlich auszulösen – verwende stattdessen das aus `vitest/browser` importierte [`userEvent`](/api/browser/interactivity), das intern das Chrome DevTools Protocol oder Webdriver nutzt (je nach Provider).
:::

::: code-group
```tsx [solid]
// based on @testing-library/solid API
// https://testing-library.com/docs/solid-testing-library/api

import { render } from '@testing-library/solid'

it('uses params', async () => {
  const App = () => (
    <>
      <Route
        path="/ids/:id"
        component={() => (
          <p>
            Id:
            {useParams()?.id}
          </p>
        )}
      />
      <Route path="/" component={() => <p>Start</p>} />
    </>
  )
  const { baseElement } = render(() => <App />, { location: 'ids/1234' })
  const screen = page.elementLocator(baseElement)

  await expect.screen(screen.getByText('Id: 1234')).toBeInTheDocument()
})
```
```ts [marko]
// based on @testing-library/marko API
// https://testing-library.com/docs/marko-testing-library/api

import { render, screen } from '@marko/testing-library'
import Greeting from './greeting.marko'

test('renders a message', async () => {
  const { baseElement } = await render(Greeting, { name: 'Marko' })
  const screen = page.elementLocator(baseElement)
  await expect.element(screen.getByText(/Marko/)).toBeInTheDocument()
  expect(container.firstChild).toMatchInlineSnapshot(`
    <h1>Hello, Marko!</h1>
  `)
})
```
:::

## Einschränkungen

### Thread-blockierende Dialoge

Bei der Verwendung von Vitest Browser ist zu beachten, dass thread-blockierende Dialoge wie `alert`, `confirm` oder `print` nicht nativ verwendet werden können. Der Grund ist, dass sie die Webseite blockieren, wodurch Vitest nicht weiter mit der Seite kommunizieren kann und die Ausführung hängen bleibt.

In solchen Situationen stellt Vitest Standard-Mocks mit standardmäßigen Rückgabewerten für diese APIs bereit. Das stellt sicher, dass die Ausführung nicht hängen bleibt, falls ein Nutzer versehentlich synchrone Popup-Web-APIs verwendet. Dennoch wird empfohlen, diese Web-APIs für ein besseres Erlebnis selbst zu mocken. Mehr dazu unter [Mocking](/guide/mocking).

### Spionieren auf Modul-Exporte

Der Browser-Modus nutzt die native ESM-Unterstützung des Browsers, um Module auszuliefern. Das Modul-Namespace-Objekt ist versiegelt und kann nicht neu konfiguriert werden, anders als in Node.js-Tests, wo Vitest den Module Runner patchen kann. Das bedeutet, dass du `vi.spyOn` nicht auf ein importiertes Objekt anwenden kannst:

```ts
import { vi } from 'vitest'
import * as module from './module.js'

vi.spyOn(module, 'method') // ❌ throws an error
```

Um diese Einschränkung zu umgehen, unterstützt Vitest die Option `{ spy: true }` in `vi.mock('./module.js')`. Damit wird automatisch jeder Export im Modul mit einem Spy versehen, ohne ihn durch eine Attrappe zu ersetzen.

```ts
import { vi } from 'vitest'
import * as module from './module.js'

vi.mock('./module.js', { spy: true })

vi.mocked(module.method).mockImplementation(() => {
  // ...
})
```

Die einzige Möglichkeit, exportierte _Variablen_ zu mocken, besteht jedoch darin, eine Methode zu exportieren, die den internen Wert ändert:

::: code-group
```js [module.js]
export let MODE = 'test'
export function changeMode(newMode) {
  MODE = newMode
}
```
```js [module.test.ts]
import { expect } from 'vitest'
import { changeMode, MODE } from './module.js'

changeMode('production')
expect(MODE).toBe('production')
```
:::
