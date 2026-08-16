# Interaktivitäts-API

Vitest implementiert eine Teilmenge der APIs von [`@testing-library/user-event`](https://testing-library.com/docs/user-event/intro) über das [Chrome DevTools Protocol](https://chromedevtools.github.io/devtools-protocol/) oder [webdriver](https://www.w3.org/TR/webdriver/), statt Events zu simulieren; dadurch wird das Browserverhalten zuverlässiger und stimmiger mit der Art, wie Nutzer mit einer Seite interagieren.

```ts
import { userEvent } from 'vitest/browser'

await userEvent.click(document.querySelector('.button'))
```

Nahezu jede `userEvent`-Methode erbt die Optionen ihres Providers.

## userEvent.setup

```ts
function setup(): UserEvent
```

Erzeugt eine neue User-Event-Instanz. Das ist nützlich, wenn Sie den Tastaturzustand erhalten müssen, um Tasten korrekt zu drücken und loszulassen.

::: warning
Anders als bei `@testing-library/user-event` wird die standardmäßige `userEvent`-Instanz aus `vitest/browser` einmalig erzeugt und nicht bei jedem Methodenaufruf neu! Den Unterschied in der Funktionsweise sehen Sie in diesem Ausschnitt:

```ts
import { userEvent as vitestUserEvent } from 'vitest/browser'
import { userEvent as originalUserEvent } from '@testing-library/user-event'

await vitestUserEvent.keyboard('{Shift}') // press shift without releasing
await vitestUserEvent.keyboard('{/Shift}') // releases shift

await originalUserEvent.keyboard('{Shift}') // press shift without releasing
await originalUserEvent.keyboard('{/Shift}') // DID NOT release shift because the state is different
```

Dieses Verhalten ist nützlicher, weil wir die Tastatur nicht emulieren, sondern die Umschalttaste tatsächlich drücken; das ursprüngliche Verhalten beizubehalten würde beim Tippen in ein Feld zu unerwarteten Problemen führen.
:::

::: warning
Bei den Providern `playwright` und `webdriverio` werden Interaktionen vom zugrundeliegenden Browsertreiber ausgeführt. Das bedeutet, dass Teile des Interaktionszustands, etwa gedrückte Tasten oder die Zeigerposition und der daraus resultierende Hover-Zustand, zwischen Tests in derselben Datei bestehen bleiben können.

Vitest setzt nicht losgelassenen Tastaturzustand vor dem Start jedes Testfalls automatisch zurück, die Zeigerposition und der daraus resultierende Hover-Zustand werden jedoch nicht automatisch zurückgesetzt, da das Zurücksetzen der Zeigerposition teuer sein kann.

Das gilt sowohl für `userEvent.*`-Aufrufe als auch für Locator-Kurzformen wie `locator.click()` oder `locator.hover()`, weil sie denselben zugrundeliegenden Interaktionszustand verwenden.

Wenn Ihre Tests auf einen neutralen Hover-Zustand angewiesen sind, setzen Sie ihn explizit zurück, zum Beispiel in `beforeEach`:

```ts
import { beforeEach } from 'vitest'
import { userEvent } from 'vitest/browser'

beforeEach(async () => {
  await userEvent.unhover(document.body)
})
```
:::

## userEvent.click

```ts
function click(
  element: Element | Locator,
  options?: UserEventClickOptions,
): Promise<void>
```

Klickt auf ein Element. Erbt die Optionen des Providers. Eine ausführliche Erklärung der Funktionsweise dieser Methode finden Sie in der Dokumentation Ihres Providers.

```ts
import { page, userEvent } from 'vitest/browser'

test('clicks on an element', async () => {
  const logo = page.getByRole('img', { name: /logo/ })

  await userEvent.click(logo)
  // or you can access it directly on the locator
  await logo.click()

  // With WebdriverIO, this uses either ElementClick (with no arguments) or
  // actions (with arguments). Use an empty object to force the use of actions.
  await logo.click({})
})
```

### Klicken mit einem Modifikator

Mit WebdriverIO oder Playwright:

```ts
await userEvent.keyboard('{Shift>}')
// By using an empty object as the option, this opts in to using a chain of actions
// instead of an ElementClick in webdriver.
// Firefox has a bug that makes this necessary.
// Follow https://bugzilla.mozilla.org/show_bug.cgi?id=1456642 to know when this
// will be fixed.
await userEvent.click(element, {})
await userEvent.keyboard('{/Shift}')
```

Mit Playwright:
```ts
await userEvent.click(element, { modifiers: ['Shift'] })
```

Referenzen:

- [Playwright-API `locator.click`](https://playwright.dev/docs/api/class-locator#locator-click)
- [WebdriverIO-API `element.click`](https://webdriver.io/docs/api/element/click/)
- [testing-library-API `click`](https://testing-library.com/docs/user-event/convenience/#click)

## userEvent.dblClick

```ts
function dblClick(
  element: Element | Locator,
  options?: UserEventDoubleClickOptions,
): Promise<void>
```

Löst ein Doppelklick-Event auf einem Element aus.

Eine ausführliche Erklärung der Funktionsweise dieser Methode finden Sie in der Dokumentation Ihres Providers.

```ts
import { page, userEvent } from 'vitest/browser'

test('triggers a double click on an element', async () => {
  const logo = page.getByRole('img', { name: /logo/ })

  await userEvent.dblClick(logo)
  // or you can access it directly on the locator
  await logo.dblClick()
})
```

Referenzen:

- [Playwright-API `locator.dblclick`](https://playwright.dev/docs/api/class-locator#locator-dblclick)
- [WebdriverIO-API `element.doubleClick`](https://webdriver.io/docs/api/element/doubleClick/)
- [testing-library-API `dblClick`](https://testing-library.com/docs/user-event/convenience/#dblClick)

## userEvent.tripleClick

```ts
function tripleClick(
  element: Element | Locator,
  options?: UserEventTripleClickOptions,
): Promise<void>
```

Löst ein Dreifachklick-Event auf einem Element aus. Da es in der Browser-API kein `tripleclick` gibt, feuert diese Methode drei Klick-Events hintereinander; Sie müssen daher das [Detail des Klick-Events](https://developer.mozilla.org/en-US/docs/Web/API/Element/click_event#usage_notes) prüfen, um das Event zu filtern: `evt.detail === 3`.

Eine ausführliche Erklärung der Funktionsweise dieser Methode finden Sie in der Dokumentation Ihres Providers.

```ts
import { page, userEvent } from 'vitest/browser'

test('triggers a triple click on an element', async () => {
  const logo = page.getByRole('img', { name: /logo/ })
  let tripleClickFired = false
  logo.addEventListener('click', (evt) => {
    if (evt.detail === 3) {
      tripleClickFired = true
    }
  })

  await userEvent.tripleClick(logo)
  // or you can access it directly on the locator
  await logo.tripleClick()

  expect(tripleClickFired).toBe(true)
})
```

Referenzen:

- [Playwright-API `locator.click`](https://playwright.dev/docs/api/class-locator#locator-click): umgesetzt über `click` mit `clickCount: 3`.
- [WebdriverIO-API `browser.action`](https://webdriver.io/docs/api/browser/action/): umgesetzt über die Actions-API mit `move` plus drei `down + up + pause`-Events hintereinander
- [testing-library-API `tripleClick`](https://testing-library.com/docs/user-event/convenience/#tripleClick)

## userEvent.wheel <Version>4.1.0</Version> {#userevent-wheel}

```ts
function wheel(
  element: Element | Locator,
  options: UserEventWheelOptions,
): Promise<void>
```

Löst ein [`wheel`-Event](https://developer.mozilla.org/en-US/docs/Web/API/Element/wheel_event) auf einem Element aus.

Sie können die Scrollmenge entweder über `delta` für präzise pixelgenaue Steuerung oder über `direction` für einfacheres gerichtetes Scrollen (`up`, `down`, `left`, `right`) angeben. Wenn Sie mehrere Wheel-Events auslösen müssen, verwenden Sie aus Performancegründen die Option `times`, statt die Methode mehrfach aufzurufen.

```ts
import { page, userEvent } from 'vitest/browser'

test('scroll using delta values', async () => {
  const tablist = page.getByRole('tablist')

  // Scroll right by 100 pixels
  await userEvent.wheel(tablist, { delta: { x: 100 } })

  // Scroll down by 50 pixels
  await userEvent.wheel(tablist, { delta: { y: 50 } })

  // Scroll diagonally 2 times
  await userEvent.wheel(tablist, { delta: { x: 50, y: 100 }, times: 2 })
})

test('scroll using direction', async () => {
  const tablist = page.getByRole('tablist')

  // Scroll right 5 times
  await userEvent.wheel(tablist, { direction: 'right', times: 5 })

  // Scroll left once
  await userEvent.wheel(tablist, { direction: 'left' })
})
```

Wheel-Events können auch direkt von [Locators](/api/browser/locators#wheel) ausgelöst werden:

```ts
import { page } from 'vitest/browser'

await page.getByRole('tablist').wheel({ direction: 'right' })
```

::: warning
Diese Methode ist zum Testen von UI gedacht, die explizit auf `wheel`-Events hört (z. B. eigene Zoom-Steuerungen, horizontales Scrollen von Tabs, Canvas-Interaktionen). Wenn Sie die Seite scrollen müssen, um ein Element in den sichtbaren Bereich zu bringen, verlassen Sie sich stattdessen auf das eingebaute automatische Scrollen der anderen `userEvent`-Methoden oder der [Locator-Aktionen](/api/browser/locators#methods).
:::

## userEvent.fill

```ts
function fill(
  element: Element | Locator,
  text: string,
): Promise<void>
```

Setzt einen Wert in ein `input`-/`textarea`-/`contenteditable`-Feld. Vorhandener Text im Eingabefeld wird vor dem Setzen des neuen Werts entfernt.

```ts
import { page, userEvent } from 'vitest/browser'

test('update input', async () => {
  const input = page.getByRole('input')

  await userEvent.fill(input, 'foo') // input.value == foo
  await userEvent.fill(input, '{{a[[') // input.value == {{a[[
  await userEvent.fill(input, '{Shift}') // input.value == {Shift}

  // or you can access it directly on the locator
  await input.fill('foo') // input.value == foo
})
```

Diese Methode fokussiert das Element, füllt es und löst nach dem Füllen ein `input`-Event aus. Mit einer leeren Zeichenkette können Sie das Feld leeren.

::: tip
Diese API ist schneller als [`userEvent.type`](#userevent-type) oder [`userEvent.keyboard`](#userevent-keyboard), sie **unterstützt aber nicht** die [`keyboard`-Syntax von user-event](https://testing-library.com/docs/user-event/keyboard) (z. B. `{Shift}{selectall}`).

Wir empfehlen diese API gegenüber [`userEvent.type`](#userevent-type), wenn Sie keine Sonderzeichen eingeben oder keine feingranulare Kontrolle über Tastendruck-Events benötigen.
:::

Referenzen:

- [Playwright-API `locator.fill`](https://playwright.dev/docs/api/class-locator#locator-fill)
- [WebdriverIO-API `element.setValue`](https://webdriver.io/docs/api/element/setValue)
- [testing-library-API `type`](https://testing-library.com/docs/user-event/utility/#type)

## userEvent.keyboard

```ts
function keyboard(text: string): Promise<void>
```

Mit `userEvent.keyboard` können Sie Tastenanschläge auslösen. Hat ein Eingabefeld den Fokus, werden Zeichen in dieses Feld getippt. Andernfalls werden Tastatur-Events auf dem aktuell fokussierten Element ausgelöst (`document.body`, wenn kein Element fokussiert ist).

Diese API unterstützt die [`keyboard`-Syntax von user-event](https://testing-library.com/docs/user-event/keyboard).

```ts
import { userEvent } from 'vitest/browser'

test('trigger keystrokes', async () => {
  await userEvent.keyboard('foo') // translates to: f, o, o
  await userEvent.keyboard('{{a[[') // translates to: {, a, [
  await userEvent.keyboard('{Shift}{f}{o}{o}') // translates to: Shift, f, o, o
  await userEvent.keyboard('{a>5}') // press a without releasing it and trigger 5 keydown
  await userEvent.keyboard('{a>5/}') // press a for 5 keydown and then release it
})
```

Referenzen:

- [Playwright-API `Keyboard`](https://playwright.dev/docs/api/class-keyboard)
- [WebdriverIO-API `action('key')`](https://webdriver.io/docs/api/browser/action#key-input-source)
- [testing-library-API `type`](https://testing-library.com/docs/user-event/utility/#type)

## userEvent.tab

```ts
function tab(options?: UserEventTabOptions): Promise<void>
```

Sendet ein `Tab`-Tastenevent. Das ist eine Kurzform für `userEvent.keyboard('{tab}')`.

```ts
import { page, userEvent } from 'vitest/browser'

test('tab works', async () => {
  const [input1, input2] = page.getByRole('input').elements()

  expect(input1).toHaveFocus()

  await userEvent.tab()

  expect(input2).toHaveFocus()

  await userEvent.tab({ shift: true })

  expect(input1).toHaveFocus()
})
```

Referenzen:

- [Playwright-API `Keyboard`](https://playwright.dev/docs/api/class-keyboard)
- [WebdriverIO-API `action('key')`](https://webdriver.io/docs/api/browser/action#key-input-source)
- [testing-library-API `tab`](https://testing-library.com/docs/user-event/convenience/#tab)

## userEvent.type

```ts
function type(
  element: Element | Locator,
  text: string,
  options?: UserEventTypeOptions,
): Promise<void>
```

::: warning
Wenn Sie nicht auf [Sonderzeichen](https://testing-library.com/docs/user-event/keyboard) angewiesen sind (z. B. `{shift}` oder `{selectall}`), empfiehlt sich aus Performancegründen stattdessen [`userEvent.fill`](#userevent-fill).
:::

Die Methode `type` implementiert das [`type`](https://testing-library.com/docs/user-event/utility/#type)-Utility von `@testing-library/user-event`, das auf der [`keyboard`](https://testing-library.com/docs/user-event/keyboard)-API aufsetzt.

Mit dieser Funktion können Sie Zeichen in ein `input`-/`textarea`-/`contenteditable`-Element tippen. Sie unterstützt die [`keyboard`-Syntax von user-event](https://testing-library.com/docs/user-event/keyboard).

Wenn Sie lediglich Tasten ohne Eingabefeld drücken müssen, verwenden Sie die API [`userEvent.keyboard`](#userevent-keyboard).

```ts
import { page, userEvent } from 'vitest/browser'

test('update input', async () => {
  const input = page.getByRole('input')

  await userEvent.type(input, 'foo') // input.value == foo
  await userEvent.type(input, '{{a[[') // input.value == foo{a[
  await userEvent.type(input, '{Shift}') // input.value == foo{a[
})
```

::: info
Vitest stellt auf dem Locator keine `.type`-Methode wie `input.type` bereit, da sie nur zur Kompatibilität mit der `userEvent`-Bibliothek existiert. Ziehen Sie stattdessen `.fill` in Betracht, da es schneller ist.
:::

Referenzen:

- [Playwright-API `locator.press`](https://playwright.dev/docs/api/class-locator#locator-press)
- [WebdriverIO-API `action('key')`](https://webdriver.io/docs/api/browser/action#key-input-source)
- [testing-library-API `type`](https://testing-library.com/docs/user-event/utility/#type)

## userEvent.clear

```ts
function clear(element: Element | Locator, options?: UserEventClearOptions): Promise<void>
```

Diese Methode leert den Inhalt des Eingabeelements.

```ts
import { page, userEvent } from 'vitest/browser'

test('clears input', async () => {
  const input = page.getByRole('input')

  await userEvent.fill(input, 'foo')
  expect(input).toHaveValue('foo')

  await userEvent.clear(input)
  // or you can access it directly on the locator
  await input.clear()

  expect(input).toHaveValue('')
})
```

Referenzen:

- [Playwright-API `locator.clear`](https://playwright.dev/docs/api/class-locator#locator-clear)
- [WebdriverIO-API `element.clearValue`](https://webdriver.io/docs/api/element/clearValue)
- [testing-library-API `clear`](https://testing-library.com/docs/user-event/utility/#clear)

## userEvent.selectOptions

```ts
function selectOptions(
  element: Element | Locator,
  values:
    | HTMLElement
    | HTMLElement[]
    | Locator
    | Locator[]
    | string
    | string[],
  options?: UserEventSelectOptions,
): Promise<void>
```

Mit `userEvent.selectOptions` lässt sich ein Wert in einem `<select>`-Element auswählen.

::: warning
Hat das select-Element kein Attribut [`multiple`](https://developer.mozilla.org/en-US/docs/Web/HTML/Element/select#attr-multiple), wählt Vitest nur das erste Element des Arrays aus.

Anders als `@testing-library` unterstützt Vitest derzeit kein [listbox](https://developer.mozilla.org/en-US/docs/Web/Accessibility/ARIA/Roles/listbox_role), wir planen aber, das künftig zu ergänzen.
:::

```ts
import { page, userEvent } from 'vitest/browser'

test('clears input', async () => {
  const select = page.getByRole('select')

  await userEvent.selectOptions(select, 'Option 1')
  // or you can access it directly on the locator
  await select.selectOptions('Option 1')

  expect(select).toHaveValue('option-1')

  await userEvent.selectOptions(select, 'option-1')
  expect(select).toHaveValue('option-1')

  await userEvent.selectOptions(select, [
    page.getByRole('option', { name: 'Option 1' }),
    page.getByRole('option', { name: 'Option 2' }),
  ])
  expect(select).toHaveValue(['option-1', 'option-2'])
})
```

::: warning
Der Provider `webdriverio` unterstützt die Auswahl mehrerer Elemente nicht, da er dafür keine API bereitstellt.
:::

Referenzen:

- [Playwright-API `locator.selectOption`](https://playwright.dev/docs/api/class-locator#locator-select-option)
- [WebdriverIO-API `element.selectByIndex`](https://webdriver.io/docs/api/element/selectByIndex)
- [testing-library-API `selectOptions`](https://testing-library.com/docs/user-event/utility/#-selectoptions-deselectoptions)

## userEvent.hover

```ts
function hover(
  element: Element | Locator,
  options?: UserEventHoverOptions,
): Promise<void>
```

Diese Methode bewegt die Cursorposition auf das ausgewählte Element. Eine ausführliche Erklärung der Funktionsweise dieser Methode finden Sie in der Dokumentation Ihres Providers.

::: warning
Wenn Sie den Provider `webdriverio` verwenden, bewegt sich der Cursor standardmäßig in die Mitte des Elements.

Wenn Sie den Provider `playwright` verwenden, bewegt sich der Cursor auf „irgendeinen“ sichtbaren Punkt des Elements.
:::

```ts
import { page, userEvent } from 'vitest/browser'

test('hovers logo element', async () => {
  const logo = page.getByRole('img', { name: /logo/ })

  await userEvent.hover(logo)
  // or you can access it directly on the locator
  await logo.hover()
})
```

Referenzen:

- [Playwright-API `locator.hover`](https://playwright.dev/docs/api/class-locator#locator-hover)
- [WebdriverIO-API `element.moveTo`](https://webdriver.io/docs/api/element/moveTo/)
- [testing-library-API `hover`](https://testing-library.com/docs/user-event/convenience/#hover)

## userEvent.unhover

```ts
function unhover(
  element: Element | Locator,
  options?: UserEventHoverOptions,
): Promise<void>
```

Das funktioniert genauso wie [`userEvent.hover`](#userevent-hover), bewegt den Cursor aber stattdessen auf das Element `document.body`.

::: warning
Standardmäßig liegt die Cursorposition auf „irgendeinem“ sichtbaren Punkt (beim Provider `playwright`) oder in der Mitte (beim Provider `webdriverio`) des body-Elements; befindet sich das aktuell überfahrene Element bereits an derselben Position, hat diese Methode also keine Wirkung.
:::

```ts
import { page, userEvent } from 'vitest/browser'

test('unhover logo element', async () => {
  const logo = page.getByRole('img', { name: /logo/ })

  await userEvent.unhover(logo)
  // or you can access it directly on the locator
  await logo.unhover()
})
```

Referenzen:

- [Playwright-API `locator.hover`](https://playwright.dev/docs/api/class-locator#locator-hover)
- [WebdriverIO-API `element.moveTo`](https://webdriver.io/docs/api/element/moveTo/)
- [testing-library-API `hover`](https://testing-library.com/docs/user-event/convenience/#hover)

## userEvent.upload

```ts
function upload(
  element: Element | Locator,
  files: string[] | string | File[] | File,
  options?: UserEventUploadOptions,
): Promise<void>
```

Ändert ein File-Input-Element so, dass es die angegebenen Dateien enthält.

```ts
import { page, userEvent } from 'vitest/browser'

test('can upload a file', async () => {
  const input = page.getByRole('button', { name: /Upload files/ })

  const file = new File(['file'], 'file.png', { type: 'image/png' })

  await userEvent.upload(input, file)
  // or you can access it directly on the locator
  await input.upload(file)

  // you can also use file paths relative to the root of the project
  await userEvent.upload(input, './fixtures/file.png')
})
```

::: warning
Der Provider `webdriverio` unterstützt diesen Befehl nur in den Browsern `chrome` und `edge`. Außerdem werden derzeit nur String-Typen unterstützt.
:::

Referenzen:

- [Playwright-API `locator.setInputFiles`](https://playwright.dev/docs/api/class-locator#locator-set-input-files)
- [WebdriverIO-API `browser.uploadFile`](https://webdriver.io/docs/api/browser/uploadFile)
- [testing-library-API `upload`](https://testing-library.com/docs/user-event/utility/#upload)

## userEvent.dragAndDrop

```ts
function dragAndDrop(
  source: Element | Locator,
  target: Element | Locator,
  options?: UserEventDragAndDropOptions,
): Promise<void>
```

Zieht das Quellelement auf das Zielelement. Vergessen Sie nicht, dass beim `source`-Element das Attribut `draggable` auf `true` gesetzt sein muss.

```ts
import { page, userEvent } from 'vitest/browser'

test('drag and drop works', async () => {
  const source = page.getByRole('img', { name: /logo/ })
  const target = page.getByTestId('logo-target')

  await userEvent.dragAndDrop(source, target)
  // or you can access it directly on the locator
  await source.dropTo(target)

  await expect.element(target).toHaveTextContent('Logo is processed')
})
```

::: warning
Diese API wird vom standardmäßigen Provider `preview` nicht unterstützt.
:::

Referenzen:

- [Playwright-API `frame.dragAndDrop`](https://playwright.dev/docs/api/class-frame#frame-drag-and-drop)
- [WebdriverIO-API `element.dragAndDrop`](https://webdriver.io/docs/api/element/dragAndDrop/)

## userEvent.copy

```ts
function copy(): Promise<void>
```

Kopiert den ausgewählten Text in die Zwischenablage.

```js
import { page, userEvent } from 'vitest/browser'

test('copy and paste', async () => {
  // write to 'source'
  await userEvent.click(page.getByPlaceholder('source'))
  await userEvent.keyboard('hello')

  // select and copy 'source'
  await userEvent.dblClick(page.getByPlaceholder('source'))
  await userEvent.copy()

  // paste to 'target'
  await userEvent.click(page.getByPlaceholder('target'))
  await userEvent.paste()

  await expect.element(page.getByPlaceholder('source')).toHaveTextContent('hello')
  await expect.element(page.getByPlaceholder('target')).toHaveTextContent('hello')
})
```

Referenzen:

- [testing-library-API `copy`](https://testing-library.com/docs/user-event/convenience/#copy)

## userEvent.cut

```ts
function cut(): Promise<void>
```

Schneidet den ausgewählten Text in die Zwischenablage aus.

```js
import { page, userEvent } from 'vitest/browser'

test('copy and paste', async () => {
  // write to 'source'
  await userEvent.click(page.getByPlaceholder('source'))
  await userEvent.keyboard('hello')

  // select and cut 'source'
  await userEvent.dblClick(page.getByPlaceholder('source'))
  await userEvent.cut()

  // paste to 'target'
  await userEvent.click(page.getByPlaceholder('target'))
  await userEvent.paste()

  await expect.element(page.getByPlaceholder('source')).toHaveTextContent('')
  await expect.element(page.getByPlaceholder('target')).toHaveTextContent('hello')
})
```

Referenzen:

- [testing-library-API `cut`](https://testing-library.com/docs/user-event/clipboard#cut)

## userEvent.paste

```ts
function paste(): Promise<void>
```

Fügt den Text aus der Zwischenablage ein. Verwendungsbeispiele finden Sie unter [`userEvent.copy`](#userevent-copy) und [`userEvent.cut`](#userevent-cut).

Referenzen:

- [testing-library-API `paste`](https://testing-library.com/docs/user-event/clipboard#paste)
