# Context API

Vitest stellt über den Entry-Point `vitest/browser` ein Context-Modul bereit. Seit 2.0 bietet es eine kleine Sammlung von Werkzeugen, die für Sie in Tests nützlich sein können.

## `userEvent`

::: tip
Die `userEvent`-API wird ausführlich in der [Interactivity API](/api/browser/interactivity) erläutert.
:::

```ts
/**
 * Handler for user interactions. The support is implemented by the browser provider (`playwright` or `webdriverio`).
 * If used with `preview` provider, fallbacks to simulated events via `@testing-library/user-event`.
 * @experimental
 */
export const userEvent: {
  setup: () => UserEvent
  cleanup: () => Promise<void>
  click: (element: Element, options?: UserEventClickOptions) => Promise<void>
  dblClick: (element: Element, options?: UserEventDoubleClickOptions) => Promise<void>
  tripleClick: (element: Element, options?: UserEventTripleClickOptions) => Promise<void>
  selectOptions: (
    element: Element,
    values: HTMLElement | HTMLElement[] | string | string[],
    options?: UserEventSelectOptions,
  ) => Promise<void>
  keyboard: (text: string) => Promise<void>
  type: (element: Element, text: string, options?: UserEventTypeOptions) => Promise<void>
  clear: (element: Element) => Promise<void>
  tab: (options?: UserEventTabOptions) => Promise<void>
  hover: (element: Element, options?: UserEventHoverOptions) => Promise<void>
  unhover: (element: Element, options?: UserEventHoverOptions) => Promise<void>
  fill: (element: Element, text: string, options?: UserEventFillOptions) => Promise<void>
  dragAndDrop: (source: Element, target: Element, options?: UserEventDragAndDropOptions) => Promise<void>
}
```

## `commands`

::: tip
Diese API wird ausführlich in der [Commands API](/api/browser/commands) erläutert.
:::

```ts
/**
 * Available commands for the browser.
 * A shortcut to `server.commands`.
 */
export const commands: BrowserCommands
```

## `page`

Der Export `page` stellt Werkzeuge bereit, um mit der aktuellen `page` zu interagieren.

::: warning
Auch wenn er einige Werkzeuge von Playwrights `page` offenlegt, handelt es sich nicht um dasselbe Objekt. Da der Browser-Kontext im Browser ausgewertet wird, haben Ihre Tests keinen Zugriff auf Playwrights `page`, weil diese auf dem Server läuft.

Verwenden Sie die [Commands API](/api/browser/commands), wenn Sie Zugriff auf Playwrights `page`-Objekt benötigen.
:::

```ts
export const page: {
  /**
   * Change the size of iframe's viewport.
   */
  viewport(width: number, height: number): Promise<void>
  /**
   * Make a screenshot of the test iframe or a specific element.
   * @returns Path to the screenshot file or path and base64.
   */
  screenshot(options: Omit<ScreenshotOptions, 'base64'> & { base64: true }): Promise<{
    path: string
    base64: string
  }>
  screenshot(options?: ScreenshotOptions): Promise<string>
  /**
   * Add a trace marker when browser tracing is enabled.
   */
  mark(name: string, options?: { stack?: string; kind?: BrowserTraceEntryKind }): Promise<void>
  /**
   * Group multiple operations under a trace marker when browser tracing is enabled.
   */
  mark<T>(name: string, body: () => T | Promise<T>, options?: { stack?: string; kind?: BrowserTraceEntryKind }): Promise<T>
  /**
   * Extend default `page` object with custom methods.
   */
  extend(methods: Partial<BrowserPage>): BrowserPage
  /**
   * Wrap an HTML element in a `Locator`. When querying for elements, the search will always return this element.
   */
  elementLocator(element: Element): Locator
  /**
   * The iframe locator. This is a document locator that enters the iframe body
   * and works similarly to the `page` object.
   * **Warning:** At the moment, this is supported only by the `playwright` provider.
   */
  frameLocator(iframeElement: Locator): FrameLocator

  /**
   * Locator APIs. See its documentation for more details.
   */
  getByRole(role: ARIARole | string, options?: LocatorByRoleOptions): Locator
  getByLabelText(text: string | RegExp, options?: LocatorOptions): Locator
  getByTestId(text: string | RegExp): Locator
  getByAltText(text: string | RegExp, options?: LocatorOptions): Locator
  getByPlaceholder(text: string | RegExp, options?: LocatorOptions): Locator
  getByText(text: string | RegExp, options?: LocatorOptions): Locator
  getByTitle(text: string | RegExp, options?: LocatorOptions): Locator
}
```

::: tip
Die `getBy*`-API wird in der [Locators API](/api/browser/locators) erläutert.
:::

::: warning WARNUNG <Version>3.2.0</Version>
Beachten Sie, dass `screenshot` immer einen Base64-String zurückgibt, wenn `save` auf `false` gesetzt ist.
Der `path` wird in diesem Fall ebenfalls ignoriert.
:::

### mark

```ts
function mark(name: string, options?: { stack?: string; kind?: BrowserTraceEntryKind }): Promise<void>
function mark<T>(
  name: string,
  body: () => T | Promise<T>,
  options?: { stack?: string; kind?: BrowserTraceEntryKind },
): Promise<T>
```

Fügt der Trace-Timeline des aktuellen Tests einen benannten Marker hinzu.

Übergeben Sie `options.stack`, um die Aufrufposition in den Trace-Metadaten zu überschreiben. Das ist nützlich für Wrapper-Bibliotheken, die die Quellposition des Endnutzers erhalten müssen.

Übergeben Sie `options.kind`, um Ihren Marker als bestimmten Typ zu kategorisieren, zum Beispiel als `'action'`.

Wenn Sie einen Callback übergeben, erzeugt Vitest eine Trace-Gruppe mit diesem Namen, führt den Callback aus und schließt die Gruppe automatisch.

```ts
import { page } from 'vitest/browser'

await page.mark('before submit')
await page.getByRole('button', { name: 'Submit' }).click()
await page.mark('after submit')

await page.mark('submit flow', async () => {
  await page.getByRole('textbox', { name: 'Email' }).fill('john@example.com')
  await page.getByRole('button', { name: 'Submit' }).click()
}, { kind: 'action' })
```

::: tip
Diese Methode ist nur dann nützlich, wenn [`browser.trace`](/config/browser/trace) aktiviert ist.

Ein serverseitiges Gegenstück steht auf dem [`BrowserCommandContext`](/api/browser/commands#recording-trace-markers) zur Verfügung, sodass [eigene Commands](/api/browser/commands#custom-commands) Marker aufzeichnen können, die dem auslösenden Test zugeordnet sind.
:::

### frameLocator

```ts
function frameLocator(iframeElement: Locator): FrameLocator
```

Die Methode `frameLocator` gibt eine `FrameLocator`-Instanz zurück, mit der sich Elemente innerhalb des Iframes finden lassen.

Der Frame-Locator ähnelt `page`. Er bezieht sich nicht auf das HTML-Element des Iframes, sondern auf dessen Dokument.

```ts
const frame = page.frameLocator(
  page.getByTestId('iframe')
)

await frame.getByText('Hello World').click() // ✅
await frame.click() // ❌ Not available
```

::: danger WICHTIG
Standardmäßig unterstützt `frameLocator` in Cross-Origin-Iframes keine Abfragen von Elementen mit `expect.element()`. Interaktive Methoden wie `.click()` funktionieren einwandfrei. Das ist ein anderes Verhalten als bei Playwright.

```ts
const frame = page.frameLocator(page.getByTestId('cross-origin-iframe'))
const button = frame.getByRole('button', { name: 'Submit' })

await button.click() // Interactive methods work fine ✅
await expect.element(button).toBeVisible() // Querying elements does not work ❌
```

Wenn Sie mit Cross-Origin-Iframes arbeiten müssen, müssen Sie `args: ["--disable-web-security"]` in [`launchOptions`](/config/browser/playwright.html#launchoptions) übergeben. Alternativ erstellen Sie ein eigenes [Browser-Command](/api/browser/commands.html#custom-commands), das serverseitig auf das Iframe zugreift, wo es verfügbar ist.
:::

::: danger WICHTIG
Derzeit wird die Methode `frameLocator` nur vom `playwright`-Provider unterstützt.

Die interaktiven Methoden (wie `click` oder `fill`) sind auf Elementen innerhalb des Iframes immer verfügbar, doch Assertions mit `expect.element` setzen voraus, dass das Iframe der [Same-Origin-Policy](https://developer.mozilla.org/en-US/docs/Web/Security/Same-origin_policy) genügt.
:::

## `cdp`

```ts
function cdp(): CDPSession
```

Der Export `cdp` gibt die aktuelle Chrome-DevTools-Protocol-Session zurück. Er ist vor allem für Autorinnen und Autoren von Bibliotheken nützlich, um darauf aufbauende Werkzeuge zu bauen.

::: warning
Die CDP-Session funktioniert nur mit dem `playwright`-Provider und nur bei Verwendung des Browsers `chromium`. Mehr dazu lesen Sie in Playwrights Dokumentation zu [`CDPSession`](https://playwright.dev/docs/api/class-cdpsession).

CDP ist eine privilegierte Debugging-API. Sie ist nur verfügbar, wenn Schreib- und Ausführungsoperationen der Browser-API über [`api.allowWrite`](/config/api#api-allowwrite) und [`api.allowExec`](/config/api#api-allowexec) aktiviert sind.
:::

```ts
export const cdp: () => CDPSession
```

## `server`

Der Export `server` repräsentiert die Node.js-Umgebung, in der der Vitest-Server läuft. Er ist vor allem zum Debuggen oder zum Einschränken Ihrer Tests je nach Umgebung nützlich.

```ts
export const server: {
  /**
   * Platform the Vitest server is running on.
   * The same as calling `process.platform` on the server.
   */
  platform: Platform
  /**
   * Runtime version of the Vitest server.
   * The same as calling `process.version` on the server.
   */
  version: string
  /**
   * Name of the browser provider.
   */
  provider: string
  /**
   * Name of the current browser.
   */
  browser: string
  /**
   * Available commands for the browser.
   */
  commands: BrowserCommands
  /**
   * Serialized test config.
   */
  config: SerializedConfig
}
```

## `utils`

Hilfsfunktionen, die für eigene Render-Bibliotheken nützlich sind.

```ts
export const utils: {
  /**
   * This is similar to calling `page.elementLocator`, but it returns only
   * locator selectors.
   */
  getElementLocatorSelectors(element: Element): LocatorSelectors
  /**
   * Prints prettified HTML of an element.
   */
  debug(
    el?: Element | Locator | null | (Element | Locator)[],
    maxLength?: number,
    options?: PrettyDOMOptions,
  ): void
  /**
   * Returns prettified HTML of an element.
   */
  prettyDOM(
    dom?: Element | Locator | undefined | null,
    maxLength?: number,
    prettyFormatOptions?: PrettyDOMOptions,
  ): string
  /**
   * Configures default options of `prettyDOM` and `debug` functions.
   * This will also affect `vitest-browser-{framework}` package.
   */
  configurePrettyDOM(options: StringifyOptions): void
  /**
   * Creates "Cannot find element" error. Useful for custom locators.
   */
  getElementError(selector: string, container?: Element): Error
  /**
   * Utilities for generating and working with ARIA trees and templates.
   * @experimental
   */
  aria: {
    generateAriaTree(rootElement: Element): AriaNode
    renderAriaTree(root: AriaNode): string
    renderAriaTemplate(template: AriaTemplateNode): string
    parseAriaTemplate(text: string): AriaTemplateNode
    matchAriaTree(root: AriaNode, template: AriaTemplateNode): { pass: boolean; resolved: string }
  }
}
```

### configurePrettyDOM <Version>4.0.0</Version> {#configureprettydom}

Mit der Funktion `configurePrettyDOM` können Sie Standardoptionen für die Funktionen `prettyDOM` und `debug` konfigurieren. Das ist nützlich, um anzupassen, wie HTML in Fehlermeldungen von Tests formatiert wird.

```ts
import { utils } from 'vitest/browser'

utils.configurePrettyDOM({
  maxDepth: 3,
  filterNode: 'script, style, [data-test-hide]'
})
```

#### Optionen

- **`maxDepth`** – Maximale Tiefe, bis zu der verschachtelte Elemente ausgegeben werden (Standard: `Infinity`)
- **`maxLength`** – Maximale Länge des Ausgabe-Strings (Standard: `7000`)
- **`filterNode`** – Ein CSS-Selektor-String oder eine Funktion, um Knoten aus der Ausgabe herauszufiltern. Wird ein String angegeben, werden Elemente ausgeschlossen, die dem Selektor entsprechen. Wird eine Funktion angegeben, sollte sie `false` zurückgeben, um einen Knoten auszuschließen.
- **`highlight`** – Syntaxhervorhebung aktivieren (Standard: `true`)
- Sowie weitere Optionen aus [`@vitest/pretty-format`](https://npmx.dev/package/@vitest/pretty-format)

#### Filtern mit CSS-Selektoren <Version>4.1.0</Version> {#filtering-with-css-selectors}

Die Option `filterNode` erlaubt es Ihnen, irrelevantes Markup (etwa Skripte, Styles oder versteckte Elemente) aus Fehlermeldungen von Tests auszublenden, wodurch sich die eigentliche Fehlerursache leichter erkennen lässt.

```ts
import { utils } from 'vitest/browser'

// Filter out common noise elements
utils.configurePrettyDOM({
  filterNode: 'script, style, [data-test-hide]'
})

// Or use directly with prettyDOM
const html = utils.prettyDOM(element, undefined, {
  filterNode: 'script, style'
})
```

**Gängige Muster:**

Skripte und Styles herausfiltern:
```ts
utils.configurePrettyDOM({ filterNode: 'script, style' })
```

Bestimmte Elemente über Data-Attribute ausblenden:
```ts
utils.configurePrettyDOM({ filterNode: '[data-test-hide]' })
```

Verschachtelte Inhalte innerhalb eines Elements ausblenden:
```ts
// Hides all children of elements with data-test-hide-content
utils.configurePrettyDOM({ filterNode: '[data-test-hide-content] *' })
```

Mehrere Selektoren kombinieren:
```ts
utils.configurePrettyDOM({
  filterNode: 'script, style, [data-test-hide], svg'
})
```

::: tip
Diese Funktion ist von der Konfiguration [`defaultIgnore`](https://testing-library.com/docs/dom-testing-library/api-configuration/#defaultignore) der Testing Library inspiriert.
:::

### aria <Version type="experimental">5.0.0</Version> {#aria}

Der Namensraum `aria` legt Low-Level-Werkzeuge offen, die von Vitests ARIA-Snapshot-Matchern verwendet werden.

```ts
import { utils } from 'vitest/browser'

document.body.innerHTML = `
  <h1>Hello, World!</h1>
  <button aria-hidden="true">Hidden</button>
  <button>Visible</button>
`
const tree = utils.aria.generateAriaTree(document.body)
const yaml = utils.aria.renderAriaNode(tree)
console.log(yaml)
// - heading "Hello, World!" [level=1]
// - button "Visible""
```
