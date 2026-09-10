# Locators

Ein Locator ist eine Repräsentation eines Elements oder mehrerer Elemente. Jeder Locator ist durch eine Zeichenkette definiert, die Selektor genannt wird. Vitest abstrahiert diesen Selektor, indem es komfortable Methoden bereitstellt, die ihn im Hintergrund erzeugen.

Die Locator-API verwendet einen Fork der [Playwright-Locators](https://playwright.dev/docs/api/class-locator) namens [Ivya](https://npmx.dev/ivya). Vitest stellt diese API jedoch für jeden [Provider](/config/browser/provider) bereit, nicht nur für Playwright.

::: tip
Diese Seite behandelt die Verwendung der API. Um Locators und ihren Einsatz besser zu verstehen, lies die [Playwright-Dokumentation zu "Locators"](https://playwright.dev/docs/locators).
:::

::: tip Unterschied zu `testing-library`
Die `page.getBy*`-Methoden von Vitest geben ein Locator-Objekt zurück, kein DOM-Element. Dadurch werden Locator-Abfragen komponierbar, und Vitest kann Interaktionen und Assertions bei Bedarf wiederholen.

Im Vergleich zu testing-library-Queries:

- Verwende Locator-Verkettung (`.getBy*`, `.filter`, `.nth`) statt `within(...)`.
- Behalte Locators und interagiere später mit ihnen (`await locator.click()`), statt Elemente vorab aufzulösen.
- Notausgänge für einzelne Elemente wie `.element()` und `.query()` sind strikt und werfen einen Fehler, wenn mehrere Elemente passen.

```ts
import { expect } from 'vitest'
import { page } from 'vitest/browser'

const deleteButton = page
  .getByRole('row')
  .filter({ hasText: 'Vitest' })
  .getByRole('button', { name: /delete/i })

await deleteButton.click()
await expect.element(deleteButton).toBeEnabled()
```
:::

## getByRole

```ts
function getByRole(
  role: ARIARole | string,
  options?: LocatorByRoleOptions,
): Locator
```

Erzeugt eine Möglichkeit, ein Element über seine [ARIA-Rolle](https://developer.mozilla.org/en-US/docs/Web/Accessibility/ARIA/Roles), seine [ARIA-Attribute](https://developer.mozilla.org/en-US/docs/Web/Accessibility/ARIA/Attributes) und seinen [Accessible Name](https://developer.mozilla.org/en-US/docs/Glossary/Accessible_name) zu lokalisieren.

::: tip
Wenn du nur ein einzelnes Element mit `getByText('The name')` suchst, ist es oft besser, `getByRole(expectedRole, { name: 'The name' })` zu verwenden. Die Abfrage über den Accessible Name ersetzt keine anderen Abfragen wie `*ByAltText` oder `*ByTitle`. Zwar kann der Accessible Name diesen Attributen entsprechen, er ersetzt aber nicht deren Funktionalität.
:::

Betrachte die folgende DOM-Struktur.

```html
<h3>Sign up</h3>
<label>
  Login
  <input type="text" />
</label>
<label>
  Password
  <input type="password" />
</label>
<br/>
<button>Submit</button>
```

Du kannst jedes Element über seine implizite Rolle lokalisieren:

```ts
await expect.element(
  page.getByRole('heading', { name: 'Sign up' })
).toBeVisible()

await page.getByRole('textbox', { name: 'Login' }).fill('admin')
await page.getByRole('textbox', { name: 'Password' }).fill('admin')

await page.getByRole('button', { name: /submit/i }).click()
```

::: warning
Rollen werden über String-Gleichheit abgeglichen, ohne Vererbung aus der ARIA-Rollenhierarchie. Deshalb schließt die Abfrage einer Oberklassen-Rolle wie `checkbox` keine Elemente mit einer Unterklassen-Rolle wie `switch` ein.

Standardmäßig haben viele semantische Elemente in HTML eine Rolle; `<input type="radio">` hat zum Beispiel die Rolle "radio". Nicht-semantische Elemente in HTML haben keine Rolle; `<div>` und `<span>` ohne zusätzliche Semantik geben `null` zurück. Das Attribut `role` kann Semantik hinzufügen.

Rollen über `role`- oder `aria-*`-Attribute an eingebaute Elemente zu vergeben, die bereits eine implizite Rolle haben, wird von den ARIA-Richtlinien **ausdrücklich abgeraten**.
:::

**Optionen**

- `exact: boolean`

  Ob der `name` exakt abgeglichen wird: unter Beachtung der Groß-/Kleinschreibung und über die gesamte Zeichenkette. Standardmäßig deaktiviert. Diese Option wird ignoriert, wenn `name` ein regulärer Ausdruck ist. Beachte, dass auch ein exakter Abgleich Leerraum am Rand entfernt.

  ```tsx
  <button>Hello World</button>

  page.getByRole('button', { name: 'hello world' }) // ✅
  page.getByRole('button', { name: 'hello world', exact: true }) // ❌
  page.getByRole('button', { name: 'Hello World', exact: true }) // ✅
  ```

- `checked: boolean`

  Ob angehakte Elemente (gesetzt über `aria-checked` oder `<input type="checkbox"/>`) eingeschlossen werden sollen oder nicht. Standardmäßig wird der Filter nicht angewendet.

  Weitere Informationen unter [`aria-checked`](https://www.w3.org/TR/wai-aria-1.2/#aria-checked)

  ```tsx
  <>
    <button role="checkbox" aria-checked="true" />
    <input type="checkbox" checked />
  </>

  page.getByRole('checkbox', { checked: true }) // ✅
  page.getByRole('checkbox', { checked: false }) // ❌
  ```

- `disabled: boolean`

  Ob deaktivierte Elemente eingeschlossen werden sollen oder nicht. Standardmäßig wird der Filter nicht angewendet. Beachte, dass der `disable`-Zustand anders als andere Attribute vererbt wird.

  Weitere Informationen unter [`aria-disabled`](https://www.w3.org/TR/wai-aria-1.2/#aria-disabled)

  ```tsx
  <input type="text" disabled />

  page.getByRole('textbox', { disabled: true }) // ✅
  page.getByRole('textbox', { disabled: false }) // ❌
  ```

- `expanded: boolean`

  Ob aufgeklappte Elemente eingeschlossen werden sollen oder nicht. Standardmäßig wird der Filter nicht angewendet.

  Weitere Informationen unter [`aria-expanded`](https://www.w3.org/TR/wai-aria-1.2/#aria-expanded)

  ```tsx
  <a aria-expanded="true" href="example.com">Link</a>

  page.getByRole('link', { expanded: true }) // ✅
  page.getByRole('link', { expanded: false }) // ❌
  ```

- `includeHidden: boolean`

  Ob Elemente abgefragt werden sollen, die [normalerweise ausgeschlossen](https://www.w3.org/TR/wai-aria-1.2/#tree_exclusion) vom Accessibility-Baum sind. Standardmäßig werden vom Rollen-Selektor nur nicht versteckte Elemente gefunden.

  Beachte, dass die Rollen `none` und `presentation` immer eingeschlossen sind.

  ```tsx
  <button style="display: none" />

  page.getByRole('button') // ❌
  page.getByRole('button', { includeHidden: false }) // ❌
  page.getByRole('button', { includeHidden: true }) // ✅
  ```

- `level: number`

  Ein numerisches Attribut, das üblicherweise bei den Rollen `heading`, `listitem`, `row` und `treeitem` vorhanden ist, mit Standardwerten für `<h1>-<h6>`-Elemente. Standardmäßig wird der Filter nicht angewendet.

  Weitere Informationen unter [`aria-level`](https://www.w3.org/TR/wai-aria-1.2/#aria-level)

  ```tsx
  <>
    <h1>Heading Level One</h1>
    <div role="heading" aria-level="1">Second Heading Level One</div>
  </>

  page.getByRole('heading', { level: 1 }) // ✅
  page.getByRole('heading', { level: 2 }) // ❌
  ```

- `name: string | RegExp`

  [Ein Accessible Name](https://developer.mozilla.org/en-US/docs/Glossary/Accessible_name). Standardmäßig erfolgt der Abgleich ohne Beachtung der Groß-/Kleinschreibung und sucht nach einer Teilzeichenkette. Mit der Option `exact` steuerst du dieses Verhalten.

  ```tsx
  <button>Click Me!</button>

  page.getByRole('button', { name: 'Click Me!' }) // ✅
  page.getByRole('button', { name: 'click me!' }) // ✅
  page.getByRole('button', { name: 'Click Me?' }) // ❌
  ```

- `pressed: boolean`

  Ob gedrückte Elemente eingeschlossen werden sollen oder nicht. Standardmäßig wird der Filter nicht angewendet.

  Weitere Informationen unter [`aria-pressed`](https://www.w3.org/TR/wai-aria-1.2/#aria-pressed)

  ```tsx
  <button aria-pressed="true">👍</button>

  page.getByRole('button', { pressed: true }) // ✅
  page.getByRole('button', { pressed: false }) // ❌
  ```

- `selected: boolean`

  Ob ausgewählte Elemente eingeschlossen werden sollen oder nicht. Standardmäßig wird der Filter nicht angewendet.

  Weitere Informationen unter [`aria-selected`](https://www.w3.org/TR/wai-aria-1.2/#aria-selected)

  ```tsx
  <button role="tab" aria-selected="true">Vue</button>

  page.getByRole('button', { selected: true }) // ✅
  page.getByRole('button', { selected: false }) // ❌
  ```

**Siehe auch**

- [Liste der ARIA-Rollen bei MDN](https://developer.mozilla.org/en-US/docs/Web/Accessibility/ARIA/Roles)
- [Liste der ARIA-Rollen bei w3.org](https://www.w3.org/TR/wai-aria-1.2/#role_definitions)
- [`ByRole` von testing-library](https://testing-library.com/docs/queries/byrole/)

## getByAltText

```ts
function getByAltText(
  text: string | RegExp,
  options?: LocatorOptions,
): Locator
```

Erzeugt einen Locator, der ein Element mit einem `alt`-Attribut findet, das zum Text passt. Anders als bei der Implementierung von testing-library findet Vitest jedes Element mit passendem `alt`-Attribut.

```tsx
<img alt="Incredibles 2 Poster" src="/incredibles-2.png" />

page.getByAltText(/incredibles.*? poster/i) // ✅
page.getByAltText('non existing alt text') // ❌
```

**Optionen**

- `exact: boolean`

  Ob der `text` exakt abgeglichen wird: unter Beachtung der Groß-/Kleinschreibung und über die gesamte Zeichenkette. Standardmäßig deaktiviert. Diese Option wird ignoriert, wenn `text` ein regulärer Ausdruck ist. Beachte, dass auch ein exakter Abgleich Leerraum am Rand entfernt.

**Siehe auch**

- [`ByAltText` von testing-library](https://testing-library.com/docs/queries/byalttext/)

## getByLabelText

```ts
function getByLabelText(
  text: string | RegExp,
  options?: LocatorOptions,
): Locator
```

Erzeugt einen Locator, der ein Element mit einem zugehörigen Label findet.

Der Locator `page.getByLabelText('Username')` findet jedes Input im folgenden Beispiel:

```html
// for/htmlFor relationship between label and form element id
<label for="username-input">Username</label>
<input id="username-input" />

// The aria-labelledby attribute with form elements
<label id="username-label">Username</label>
<input aria-labelledby="username-label" />

// Wrapper labels
<label>Username <input /></label>

// Wrapper labels where the label text is in another child element
<label>
  <span>Username</span>
  <input />
</label>

// aria-label attributes
// Take care because this is not a label that users can see on the page,
// so the purpose of your input must be obvious to visual users.
<input aria-label="Username" />
```

**Optionen**

- `exact: boolean`

  Ob der `text` exakt abgeglichen wird: unter Beachtung der Groß-/Kleinschreibung und über die gesamte Zeichenkette. Standardmäßig deaktiviert. Diese Option wird ignoriert, wenn `text` ein regulärer Ausdruck ist. Beachte, dass auch ein exakter Abgleich Leerraum am Rand entfernt.

**Siehe auch**

- [`ByLabelText` von testing-library](https://testing-library.com/docs/queries/bylabeltext/)

## getByPlaceholder

```ts
function getByPlaceholder(
  text: string | RegExp,
  options?: LocatorOptions,
): Locator
```

Erzeugt einen Locator, der ein Element mit dem angegebenen `placeholder`-Attribut findet. Vitest findet jedes Element mit passendem `placeholder`-Attribut, nicht nur `input`.

```tsx
<input placeholder="Username" />

page.getByPlaceholder('Username') // ✅
page.getByPlaceholder('not found') // ❌
```

::: warning
In der Regel ist es besser, sich über [`getByLabelText`](#getbylabeltext) auf ein Label zu stützen als auf einen Platzhalter.
:::

**Optionen**

- `exact: boolean`

  Ob der `text` exakt abgeglichen wird: unter Beachtung der Groß-/Kleinschreibung und über die gesamte Zeichenkette. Standardmäßig deaktiviert. Diese Option wird ignoriert, wenn `text` ein regulärer Ausdruck ist. Beachte, dass auch ein exakter Abgleich Leerraum am Rand entfernt.

**Siehe auch**

- [`ByPlaceholderText` von testing-library](https://testing-library.com/docs/queries/byplaceholdertext/)

## getByText

```ts
function getByText(
  text: string | RegExp,
  options?: LocatorOptions,
): Locator
```

Erzeugt einen Locator, der ein Element findet, das den angegebenen Text enthält. Der Text wird gegen den [`nodeValue`](https://developer.mozilla.org/en-US/docs/Web/API/Node/nodeValue) eines TextNode oder gegen den Wert eines Inputs abgeglichen, wenn dessen Typ `button` oder `reset` ist. Der Abgleich über Text normalisiert immer den Leerraum, selbst bei exaktem Abgleich. Zum Beispiel werden mehrere Leerzeichen zu einem, Zeilenumbrüche zu Leerzeichen, und führender sowie abschließender Leerraum wird ignoriert.

```tsx
<a href="/about">About ℹ️</a>

page.getByText(/about/i) // ✅
page.getByText('about', { exact: true }) // ❌
```

::: tip
Dieser Locator eignet sich für nicht-interaktive Elemente. Wenn du ein interaktives Element wie einen Button oder ein Input lokalisieren musst, bevorzuge [`getByRole`](#getbyrole).
:::

**Optionen**

- `exact: boolean`

  Ob der `text` exakt abgeglichen wird: unter Beachtung der Groß-/Kleinschreibung und über die gesamte Zeichenkette. Standardmäßig deaktiviert. Diese Option wird ignoriert, wenn `text` ein regulärer Ausdruck ist. Beachte, dass auch ein exakter Abgleich Leerraum am Rand entfernt.

**Siehe auch**

- [`ByText` von testing-library](https://testing-library.com/docs/queries/bytext/)

## getByTitle

```ts
function getByTitle(
  text: string | RegExp,
  options?: LocatorOptions,
): Locator
```

Erzeugt einen Locator, der ein Element mit dem angegebenen `title`-Attribut findet. Anders als das `getByTitle` von testing-library kann Vitest keine `title`-Elemente innerhalb eines SVG finden.

```tsx
<span title="Delete" id="2"></span>

page.getByTitle('Delete') // ✅
page.getByTitle('Create') // ❌
```

**Optionen**

- `exact: boolean`

  Ob der `text` exakt abgeglichen wird: unter Beachtung der Groß-/Kleinschreibung und über die gesamte Zeichenkette. Standardmäßig deaktiviert. Diese Option wird ignoriert, wenn `text` ein regulärer Ausdruck ist. Beachte, dass auch ein exakter Abgleich Leerraum am Rand entfernt.

**Siehe auch**

- [`ByTitle` von testing-library](https://testing-library.com/docs/queries/bytitle/)

## getByTestId

```ts
function getByTestId(text: string | RegExp): Locator
```

Erzeugt einen Locator, der ein Element findet, das zum angegebenen Test-ID-Attribut passt. Den Attributnamen kannst du über [`browser.locators.testIdAttribute`](/config/browser/locators#testidattribute) konfigurieren.

```tsx
<div data-testid="custom-element" />

page.getByTestId('custom-element') // ✅
page.getByTestId('non-existing-element') // ❌
```

::: warning
Es wird empfohlen, das nur dann zu verwenden, wenn die anderen Locators für deinen Anwendungsfall nicht funktionieren. Die Verwendung von `data-testid`-Attributen bildet nicht ab, wie deine Software tatsächlich genutzt wird, und sollte nach Möglichkeit vermieden werden.
:::

**Optionen**

- `exact: boolean`

  Ob der `text` exakt abgeglichen wird: unter Beachtung der Groß-/Kleinschreibung und über die gesamte Zeichenkette. Standardmäßig deaktiviert. Diese Option wird ignoriert, wenn `text` ein regulärer Ausdruck ist. Beachte, dass auch ein exakter Abgleich Leerraum am Rand entfernt.

**Siehe auch**

- [`ByTestId` von testing-library](https://testing-library.com/docs/queries/bytestid/)

## nth

```ts
function nth(index: number): Locator
```

Diese Methode gibt einen neuen Locator zurück, der nur einen bestimmten Index innerhalb eines mehrelementigen Abfrageergebnisses trifft. Die Zählung beginnt bei null, `nth(0)` wählt das erste Element. Anders als `elements()[n]` wird der `nth`-Locator so lange wiederholt, bis das Element vorhanden ist.

```html
<div aria-label="one"><input/><input/><input/></div>
<div aria-label="two"><input/></div>
```

```tsx
page.getByRole('textbox').nth(0) // ✅
page.getByRole('textbox').nth(4) // ❌
```

::: tip
Bevor du zu `nth` greifst, kann es sinnvoll sein, verkettete Locators zu verwenden, um deine Suche einzugrenzen.
Manchmal gibt es keine bessere Unterscheidung als über die Elementposition; auch wenn das zu instabilen Tests führen kann, ist es besser als nichts.
:::

```tsx
page.getByLabel('two').getByRole('input') // ✅ better alternative to page.getByRole('textbox').nth(3)
page.getByLabel('one').getByRole('input') // ❌ too ambiguous
page.getByLabel('one').getByRole('input').nth(1) // ✅ pragmatic compromise
```

## first

```ts
function first(): Locator
```

Diese Methode gibt einen neuen Locator zurück, der nur den ersten Index eines mehrelementigen Abfrageergebnisses trifft.
Sie ist syntaktischer Zucker für `nth(0)`.

```html
<input/> <input/> <input/>
```

```tsx
page.getByRole('textbox').first() // ✅
```

## last

```ts
function last(): Locator
```

Diese Methode gibt einen neuen Locator zurück, der nur den letzten Index eines mehrelementigen Abfrageergebnisses trifft.
Sie ist syntaktischer Zucker für `nth(-1)`.

```html
<input/> <input/> <input/>
```

```tsx
page.getByRole('textbox').last() // ✅
```

## and

```ts
function and(locator: Locator): Locator
```

Diese Methode erzeugt einen neuen Locator, der sowohl auf den Eltern-Locator als auch auf den übergebenen Locator passt. Das folgende Beispiel findet einen Button mit einem bestimmten Titel:

```ts
page.getByRole('button').and(page.getByTitle('Subscribe'))
```

## or

```ts
function or(locator: Locator): Locator
```

Diese Methode erzeugt einen neuen Locator, der auf einen der beiden oder auf beide Locators passt.

::: warning
Beachte: Wenn der Locator mehr als ein Element trifft, kann der Aufruf einer weiteren Methode einen Fehler werfen, sofern diese ein einzelnes Element erwartet:

```tsx
<>
  <button>Click me</button>
  <a href="https://vitest.dev">Error happened!</a>
</>

page.getByRole('button')
  .or(page.getByRole('link'))
  .click() // ❌ matches multiple elements
```
:::

## filter

```ts
function filter(options: LocatorOptions): Locator
```

Diese Methode grenzt den Locator anhand der Optionen ein, etwa durch Filtern nach Text. Sie kann verkettet werden, um mehrere Filter anzuwenden.

### has

- **Typ:** `Locator`

Diese Option grenzt den Selektor auf Elemente ein, die andere Elemente enthalten, die auf den übergebenen Locator passen. Zum Beispiel mit diesem HTML:

```html{1,3}
<article>
  <div>Vitest</div>
</article>
<article>
  <div>Rolldown</div>
</article>
```

Wir können den Locator so eingrenzen, dass er nur den `article` mit dem Text `Vitest` darin findet:

```ts
page.getByRole('article').filter({ has: page.getByText('Vitest') }) // ✅
```

::: warning
Der übergebene Locator (`page.getByText('Vitest')` im Beispiel) muss relativ zum Eltern-Locator (`page.getByRole('article')` im Beispiel) sein. Er wird ausgehend vom Eltern-Locator abgefragt, nicht vom Dokument-Root.

Das heißt, du kannst keinen Locator übergeben, der ein Element außerhalb des Eltern-Locators abfragt:

```ts
page.getByText('Vitest').filter({ has: page.getByRole('article') }) // ❌
```

Dieses Beispiel schlägt fehl, weil das `article`-Element außerhalb des Elements mit dem Text `Vitest` liegt.
:::

::: tip
Diese Methode kann verkettet werden, um das Element noch weiter einzugrenzen:

```ts
page.getByRole('article')
  .filter({ has: page.getByRole('button', { name: 'delete row' }) })
  .filter({ has: page.getByText('Vitest') })
```
:::

### hasNot

- **Typ:** `Locator`

Diese Option grenzt den Selektor auf Elemente ein, die keine anderen Elemente enthalten, die auf den übergebenen Locator passen. Zum Beispiel mit diesem HTML:

```html{1,3}
<article>
  <div>Vitest</div>
</article>
<article>
  <div>Rolldown</div>
</article>
```

Wir können den Locator so eingrenzen, dass er nur den `article` findet, der kein `Rolldown` enthält.

```ts
page.getByRole('article')
  .filter({ hasNot: page.getByText('Rolldown') }) // ✅
page.getByRole('article')
  .filter({ hasNot: page.getByText('Vitest') }) // ❌
```

::: warning
Beachte, dass der übergebene Locator wie bei der Option [`has`](#has) gegen das Elternelement abgefragt wird, nicht gegen den Dokument-Root.
:::

### hasText

- **Typ:** `string | RegExp`

Diese Option grenzt den Selektor auf Elemente ein, die den übergebenen Text irgendwo in sich enthalten. Wird ein `string` übergeben, erfolgt der Abgleich ohne Beachtung der Groß-/Kleinschreibung und sucht nach einer Teilzeichenkette.

```html{1,3}
<article>
  <div>Vitest</div>
</article>
<article>
  <div>Rolldown</div>
</article>
```

Beide Locators finden dasselbe Element, weil die Suche die Groß-/Kleinschreibung nicht beachtet:

```ts
page.getByRole('article').filter({ hasText: 'Vitest' }) // ✅
page.getByRole('article').filter({ hasText: 'Vite' }) // ✅
```

### hasNotText

- **Typ:** `string | RegExp`

Diese Option grenzt den Selektor auf Elemente ein, die den übergebenen Text nirgends in sich enthalten. Wird ein `string` übergeben, erfolgt der Abgleich ohne Beachtung der Groß-/Kleinschreibung und sucht nach einer Teilzeichenkette.

## Methoden

Alle Methoden sind asynchron und müssen mit `await` abgewartet werden. Seit Vitest 3 schlagen Tests fehl, wenn eine Methode nicht abgewartet wird.

### click

```ts
function click(options?: UserEventClickOptions): Promise<void>
```

Klickt auf ein Element. Über die Optionen kannst du die Cursorposition setzen.

```ts
import { page } from 'vitest/browser'

await page.getByRole('img', { name: 'Rose' }).click()
```

- [Mehr dazu unter `userEvent.click`](/api/browser/interactivity#userevent-click)

### dblClick

```ts
function dblClick(options?: UserEventDoubleClickOptions): Promise<void>
```

Löst ein Doppelklick-Event auf einem Element aus. Über die Optionen kannst du die Cursorposition setzen.

```ts
import { page } from 'vitest/browser'

await page.getByRole('img', { name: 'Rose' }).dblClick()
```

- [Mehr dazu unter `userEvent.dblClick`](/api/browser/interactivity#userevent-dblclick)

### tripleClick

```ts
function tripleClick(options?: UserEventTripleClickOptions): Promise<void>
```

Löst ein Dreifachklick-Event auf einem Element aus. Da es in der Browser-API kein `tripleclick` gibt, feuert diese Methode drei Klick-Events hintereinander.

```ts
import { page } from 'vitest/browser'

await page.getByRole('img', { name: 'Rose' }).tripleClick()
```

- [Mehr dazu unter `userEvent.tripleClick`](/api/browser/interactivity#userevent-tripleclick)

### wheel <Version>4.1.0</Version> {#wheel}

```ts
function wheel(options: UserEventWheelOptions): Promise<void>
```

Löst ein [`wheel`-Event](https://developer.mozilla.org/en-US/docs/Web/API/Element/wheel_event) auf einem Element aus. Über die Optionen kannst du eine grobe Scroll-`direction` oder einen präzisen `delta`-Wert wählen.

```ts
import { page } from 'vitest/browser'

// Scroll right
await page.getByRole('tablist').wheel({ direction: 'right' })
```

- [Mehr dazu unter `userEvent.wheel`](/api/browser/interactivity#userevent-wheel)

### clear

```ts
function clear(options?: UserEventClearOptions): Promise<void>
```

Leert den Inhalt des Input-Elements.

```ts
import { page } from 'vitest/browser'

await page.getByRole('textbox', { name: 'Full Name' }).clear()
```

- [Mehr dazu unter `userEvent.clear`](/api/browser/interactivity#userevent-clear)

### hover

```ts
function hover(options?: UserEventHoverOptions): Promise<void>
```

Bewegt die Cursorposition auf das ausgewählte Element.

```ts
import { page } from 'vitest/browser'

await page.getByRole('img', { name: 'Rose' }).hover()
```

- [Mehr dazu unter `userEvent.hover`](/api/browser/interactivity#userevent-hover)

### unhover

```ts
function unhover(options?: UserEventHoverOptions): Promise<void>
```

Das funktioniert genauso wie [`locator.hover`](#hover), bewegt den Cursor aber stattdessen auf das Element `document.body`.

```ts
import { page } from 'vitest/browser'

await page.getByRole('img', { name: 'Rose' }).unhover()
```

- [Mehr dazu unter `userEvent.unhover`](/api/browser/interactivity#userevent-unhover)

### fill

```ts
function fill(text: string, options?: UserEventFillOptions): Promise<void>
```

Setzt den Wert des aktuellen `input`-, `textarea`- oder `contenteditable`-Elements.

```ts
import { page } from 'vitest/browser'

await page.getByRole('input', { name: 'Full Name' }).fill('Mr. Bean')
```

- [Mehr dazu unter `userEvent.fill`](/api/browser/interactivity#userevent-fill)

### dropTo

```ts
function dropTo(
  target: Locator,
  options?: UserEventDragAndDropOptions,
): Promise<void>
```

Zieht das aktuelle Element auf die Zielposition.

```ts
import { page } from 'vitest/browser'

const paris = page.getByText('Paris')
const france = page.getByText('France')

await paris.dropTo(france)
```

- [Mehr dazu unter `userEvent.dragAndDrop`](/api/browser/interactivity#userevent-draganddrop)

### selectOptions

```ts
function selectOptions(
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

Wählt einen oder mehrere Werte aus einem `<select>`-Element.

```ts
import { page } from 'vitest/browser'

const languages = page.getByRole('select', { name: 'Languages' })

await languages.selectOptions('EN')
await languages.selectOptions(['ES', 'FR'])
await languages.selectOptions([
  languages.getByRole('option', { name: 'Spanish' }),
  languages.getByRole('option', { name: 'French' }),
])
```

- [Mehr dazu unter `userEvent.selectOptions`](/api/browser/interactivity#userevent-selectoptions)

### screenshot

```ts
function screenshot(options: LocatorScreenshotOptions & { save: false }): Promise<string>
function screenshot(options: LocatorScreenshotOptions & { base64: true }): Promise<{
  path: string
  base64: string
}>
function screenshot(options?: LocatorScreenshotOptions & { base64?: false }): Promise<string>
```

Erstellt einen Screenshot des Elements, das auf den Selektor des Locators passt.

Den Speicherort des Screenshots gibst du über die Option `path` an, die relativ zur aktuellen Testdatei ist. Ist die Option `path` nicht gesetzt, verwendet Vitest standardmäßig [`browser.screenshotDirectory`](/config/browser/screenshotdirectory) (standardmäßig `__screenshot__`) zusammen mit den Namen der Datei und des Tests, um den Dateipfad des Screenshots zu bestimmen.

Wenn du außerdem den Inhalt des Screenshots brauchst, kannst du `base64: true` angeben, um ihn zusammen mit dem Dateipfad zurückzugeben, unter dem der Screenshot gespeichert wird.

```ts
import { page } from 'vitest/browser'

const button = page.getByRole('button', { name: 'Click Me!' })

const path = await button.screenshot()

const { path, base64 } = await button.screenshot({
  path: './button-click-me.png',
  base64: true, // also return base64 string
})
// path - fullpath to the screenshot
// bas64 - base64 encoded string of the screenshot
```

::: warning WARNUNG <Version>3.2.0</Version>
Beachte, dass `screenshot` immer einen Base64-String zurückgibt, wenn `save` auf `false` gesetzt ist.
Der `path` wird in diesem Fall ebenfalls ignoriert.
:::

### mark

```ts
function mark(name: string, options?: { stack?: string; kind?: BrowserTraceEntryKind }): Promise<void>
```

Fügt der Trace-Zeitleiste eine benannte Markierung hinzu und verwendet den aktuellen Locator als Kontext der Markierung.

Übergib `options.stack`, um die Callsite-Position in den Trace-Metadaten zu überschreiben. Das ist nützlich für Wrapper-Bibliotheken, die die Quellposition des Endnutzers erhalten müssen.

Übergib `options.kind`, um deine Markierung als bestimmten Typ zu kategorisieren, zum Beispiel als `'action'`.

```ts
import { page } from 'vitest/browser'

const submitButton = page.getByRole('button', { name: 'Submit' })

await submitButton.mark('before submit')
await submitButton.click()
await submitButton.mark('after submit')
```

::: tip
Diese Methode ist nur nützlich, wenn [`browser.trace`](/config/browser/trace) aktiviert ist.
:::

### query

```ts
function query(): Element | null
```

Diese Methode gibt ein einzelnes Element zurück, das auf den Selektor des Locators passt, oder `null`, wenn kein Element gefunden wird.

Passen mehrere Elemente auf den Selektor, wirft diese Methode einen Fehler. Verwende [`.elements()`](#elements), wenn du alle passenden DOM-Elemente brauchst, oder [`.all()`](#all), wenn du ein Array von Locators brauchst, die auf den Selektor passen.

::: danger
Dies ist ein Notausgang für externe APIs, die keine Locators unterstützen. Bevorzuge stattdessen die Locator-Methoden.
:::

Betrachte die folgende DOM-Struktur:

```html
<div>Hello <span>World</span></div>
<div>Hello</div>
```

Diese Locators werfen keinen Fehler:

```ts
page.getByText('Hello World').query() // ✅ HTMLDivElement
page.getByText('Hello Germany').query() // ✅ null
page.getByText('World').query() // ✅ HTMLSpanElement
page.getByText('Hello', { exact: true }).query() // ✅ HTMLSpanElement
```

Diese Locators werfen einen Fehler:

```ts
// returns multiple elements
page.getByText('Hello').query() // ❌
page.getByText(/^Hello/).query() // ❌
```

### element

```ts
function element(): Element
```

Diese Methode gibt ein einzelnes Element zurück, das auf den Selektor des Locators passt.

Passt _kein Element_ auf den Selektor, wird ein Fehler geworfen. Erwäge [`.query()`](#query), wenn du nur prüfen möchtest, ob das Element existiert.

Passen _mehrere Elemente_ auf den Selektor, wird ein Fehler geworfen. Verwende [`.elements()`](#elements), wenn du alle passenden DOM-Elemente brauchst, oder [`.all()`](#all), wenn du ein Array von Locators brauchst, die auf den Selektor passen.

::: danger
Dies ist ein Notausgang für externe APIs, die keine Locators unterstützen. Bevorzuge stattdessen die Locator-Methoden.

Sie wird automatisch aufgerufen, wenn ein Locator mit `expect.element` verwendet wird — bei jeder [Wiederholung](/api/browser/assertions) der Assertion:

```ts
await expect.element(page.getByRole('button')).toBeDisabled()
```
:::

Betrachte die folgende DOM-Struktur:

```html
<div>Hello <span>World</span></div>
<div>Hello Germany</div>
<div>Hello</div>
```

Diese Locators werfen keinen Fehler:

```ts
page.getByText('Hello World').element() // ✅
page.getByText('Hello Germany').element() // ✅
page.getByText('World').element() // ✅
page.getByText('Hello', { exact: true }).element() // ✅
```

Diese Locators werfen einen Fehler:

```ts
// returns multiple elements
page.getByText('Hello').element() // ❌
page.getByText(/^Hello/).element() // ❌

// returns no elements
page.getByText('Hello USA').element() // ❌
```

### elements

```ts
function elements(): Element[]
```

Diese Methode gibt ein Array von Elementen zurück, die auf den Selektor des Locators passen.

Diese Funktion wirft nie einen Fehler. Gibt es keine Elemente, die auf den Selektor passen, gibt diese Methode ein leeres Array zurück.

Betrachte die folgende DOM-Struktur:

```html
<div>Hello <span>World</span></div>
<div>Hello</div>
```

Diese Locators sind immer erfolgreich:

```ts
page.getByText('Hello World').elements() // ✅ [HTMLElement]
page.getByText('World').elements() // ✅ [HTMLElement]
page.getByText('Hello', { exact: true }).elements() // ✅ [HTMLElement]
page.getByText('Hello').elements() // ✅ [HTMLElement, HTMLElement]
page.getByText('Hello USA').elements() // ✅ []
```

### findElement <Version>4.1.0</Version> {#findelement}

```ts
function findElement(
  options?: SelectorOptions
): Promise<HTMLElement | SVGElement>
```

::: danger WARNUNG
Dies ist ein Notausgang für Fälle, in denen du das rohe DOM-Element brauchst — etwa um es an eine Drittanbieter-Bibliothek wie FormKit zu übergeben, die keine Vitest-Locators akzeptiert. Wenn du selbst mit dem Element interagierst, verwende stattdessen die anderen [eingebauten Methoden](#methods).
:::

Diese Methode gibt ein Element zurück, das auf den Locator passt. Anders als [`.element()`](#element) wartet diese Methode und versucht es erneut, bis ein passendes Element im DOM erscheint, mit wachsenden Intervallen (0, 20, 50, 100, 100, 500 ms).

Wird _kein Element_ vor dem Timeout gefunden, wird ein Fehler geworfen. Standardmäßig entspricht das Timeout dem Test-Timeout.

Passen _mehrere Elemente_ auf den Selektor und ist `strict` gleich `true` (der Standard), wird sofort ein Fehler geworfen, ohne es erneut zu versuchen. Setze `strict` auf `false`, um stattdessen das erste passende Element zurückzugeben.

Sie akzeptiert Optionen:

- `timeout: number` – Wie lange in Millisekunden gewartet wird, bis mindestens ein Element gefunden wird. Standardmäßig teilt sie sich das Timeout mit dem Test.
- `strict: boolean` – Bei `true` (Standard) wird ein Fehler geworfen, wenn mehrere Elemente auf den Locator passen. Bei `false` wird das erste passende Element zurückgegeben.

Betrachte die folgende DOM-Struktur:

```html
<div>Hello <span>World</span></div>
<div>Hello Germany</div>
<div>Hello</div>
```

Diese Locators lösen sich erfolgreich auf:

```ts
await page.getByText('Hello World').findElement() // ✅ HTMLDivElement
await page.getByText('World').findElement() // ✅ HTMLSpanElement
await page.getByText('Hello Germany').findElement() // ✅ HTMLDivElement
```

Diese Locators werfen einen Fehler:

```ts
// multiple elements match, strict mode rejects
await page.getByText('Hello').findElement() // ❌
await page.getByText(/^Hello/).findElement() // ❌

// no matching element before timeout
await page.getByText('Hello USA').findElement() // ❌
```

`strict: false` verwenden, um mehrere Treffer zuzulassen:

```ts
// returns the first matching element instead of throwing
await page.getByText('Hello').findElement({ strict: false }) // ✅ HTMLDivElement
```

### all

```ts
function all(): Locator[]
```

Diese Methode gibt ein Array neuer Locators zurück, die auf den Selektor passen.

Intern ruft diese Methode `.elements` auf und hüllt jedes Element mit [`page.elementLocator`](/api/browser/context#page) ein.

- [Siehe `locator.elements()`](#elements)

### serialize

```ts
function serialize(): SerializedLocator
```

Gibt eine JSON-serialisierbare Repräsentation des Locators zurück. Das zurückgegebene Objekt hat zwei Felder:

- [`selector`](#selector): die providerspezifische Selektor-Zeichenkette, mit der das Element zur Laufzeit abgefragt wird.
- `locator`: eine für Menschen lesbare Beschreibung des Locators (z. B. `getByRole('button')`), die für Fehlermeldungen und Tracing verwendet wird. Entspricht dem Aufruf von [`asLocator()`](#aslocator).

Das ist in erster Linie dafür gedacht, einen Locator an ein [Browser-Kommando](/api/browser/commands) weiterzureichen, das in Node läuft und keine lebende `Locator`-Instanz empfangen kann:

```ts
import { commands, page } from 'vitest/browser'

await commands.myCommand(page.getByRole('button').serialize())
```

::: tip
Vitest serialisiert jedes `Locator`-Argument, das an ein Kommando übergeben wird, automatisch, weshalb ein expliziter Aufruf von `serialize()` selten nötig ist. Du kannst auch `JSON.stringify(locator)` verwenden (das intern [`toJSON`](#tojson) aufruft), was dasselbe Ergebnis liefert.
:::

### toJSON

```ts
function toJSON(): SerializedLocator
```

Alias von [`serialize`](#serialize). Definiert, damit `JSON.stringify(locator)` und auf Structured Clone basierende Transporte ein `SerializedLocator`-Objekt zurückgeben.

### asLocator

```ts
function asLocator(): string
```

Gibt eine für Menschen lesbare Beschreibung des Locators in der JavaScript-Locator-Syntax zurück (z. B. `getByRole('button', { name: 'Submit' })`). Das ist dieselbe Zeichenkette, die als Feld `locator` von [`serialize()`](#serialize) bereitgestellt wird und in Fehlermeldungen und Traces verwendet wird.

```ts
import { page } from 'vitest/browser'

const button = page.getByRole('button', { name: 'Submit' })
button.asLocator() // "getByRole('button', { name: 'Submit' })"
```

::: tip
Verwende [`selector`](#selector), wenn du die providerspezifische Zeichenkette brauchst, um sie an ein [Browser-Kommando](/api/browser/commands) weiterzureichen. Verwende `asLocator()` nur für diagnostische Ausgaben. Die zurückgegebene Zeichenkette ist nicht dafür gedacht, erneut zum Abfragen von Elementen verwendet zu werden.
:::

## Eigenschaften

### selector

Der `selector` ist eine Zeichenkette, mit der der Browser-Provider das Element lokalisiert. Playwright verwendet eine `playwright`-Locator-Syntax, `preview` und `webdriverio` verwenden CSS.

::: danger
Du solltest diese Zeichenkette nicht in deinem Testcode verwenden. Die `selector`-Zeichenkette sollte nur bei der Arbeit mit der Commands-API verwendet werden:

```ts [commands.ts]
import type { BrowserCommand } from 'vitest/node'
import type { SerializedLocator } from '@vitest/browser'

const test: BrowserCommand<SerializedLocator> = function test(context, { selector }) {
  // playwright
  await context.iframe.locator(selector).click()
  // webdriverio
  await context.browser.$(selector).click()
}
```

```ts [example.test.ts]
import { test } from 'vitest'
import { commands, page } from 'vitest/browser'

test('works correctly', async () => {
  await commands.test(page.getByText('Hello').serialize()) // ✅
  // vitest will automatically unwrap it to a SerializedLocator
  await commands.test(page.getByText('Hello')) // ✅
})
```
:::

### length

Dieser Getter gibt die Anzahl der Elemente zurück, auf die dieser Locator passt. Er entspricht dem Aufruf von `locator.elements().length`.

Betrachte die folgende DOM-Struktur:

```html
<button>Click Me!</button>
<button>Don't click me!</button>
```

Diese Eigenschaft ist immer erfolgreich:

```ts
page.getByRole('button').length // ✅ 2
page.getByRole('button', { title: 'Click Me!' }).length // ✅ 1
page.getByRole('alert').length // ✅ 0
```

## Eigene Locators <Version>3.2.0</Version> <Badge type="danger">advanced</Badge> {#custom-locators}

Du kannst die API der eingebauten Locators erweitern, indem du ein Objekt aus Locator-Factories definierst. Diese Methoden existieren dann als Methoden am `page`-Objekt und an jedem erzeugten Locator.

Solche Locators können nützlich sein, wenn die eingebauten Locators nicht ausreichen, etwa wenn du ein eigenes Framework für deine UI verwendest.

Die Locator-Factory muss eine Selektor-Zeichenkette oder einen Locator selbst zurückgeben.

::: tip
Die Selektor-Syntax ist identisch mit den Playwright-Locators. Bitte lies [deren Leitfaden](https://playwright.dev/docs/other-locators), um besser zu verstehen, wie man mit ihnen arbeitet.
:::

```ts
import { locators } from 'vitest/browser'

locators.extend({
  getByArticleTitle(title) {
    return `[data-title="${title}"]`
  },
  getByArticleCommentsCount(count) {
    return `.comments :text("${count} comments")`
  },
  async previewComments() {
    // you have access to the current locator via "this"
    // beware that if the method was called on `page`, `this` will be `page`,
    // not the locator!
    if (this !== page) {
      await this.click()
    }
    // ...
  }
})

// if you are using typescript, you can extend LocatorSelectors interface
// to have the autocompletion in locators.extend, page.* and locator.* methods
declare module 'vitest/browser' {
  interface LocatorSelectors {
    // if the custom method returns a string, it will be converted into a locator
    // if it returns anything else, then it will be returned as usual
    getByArticleTitle(title: string): Locator
    getByArticleCommentsCount(count: number): Locator

    // Vitest will return a promise and won't try to convert it into a locator
    previewComments(this: Locator): Promise<void>
  }
}
```

Wird die Methode am globalen `page`-Objekt aufgerufen, gilt der Selektor für die gesamte Seite. Im Beispiel unten findet `getByArticleTitle` alle Elemente mit einem Attribut `data-title` mit dem Wert von `title`. Wird die Methode dagegen an einem Locator aufgerufen, ist sie auf diesen Locator eingegrenzt.

```html
<article data-title="Hello, World!">
  Hello, World!
  <button id="comments">2 comments</button>
</article>

<article data-title="Hello, Vitest!">
  Hello, Vitest!
  <button id="comments">0 comments</button>
</article>
```

```ts
const articles = page.getByRole('article')
const worldArticle = page.getByArticleTitle('Hello, World!') // ✅
const commentsElement = worldArticle.getByArticleCommentsCount(2) // ✅
const wrongCommentsElement = worldArticle.getByArticleCommentsCount(0) // ❌
const wrongElement = page.getByArticleTitle('No Article!') // ❌

await commentsElement.previewComments() // ✅
await wrongCommentsElement.previewComments() // ❌
```
