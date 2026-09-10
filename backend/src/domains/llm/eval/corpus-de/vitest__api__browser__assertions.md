# Assertion-API

Vitest bringt von Haus aus eine breite Auswahl an DOM-Assertions mit, geforkt aus der Bibliothek [`@testing-library/jest-dom`](https://github.com/testing-library/jest-dom), ergänzt um Unterstützung für Locators und eingebaute Wiederholbarkeit.

::: tip TypeScript-Unterstützung
Wenn Sie [TypeScript](/guide/browser/#typescript) verwenden oder korrekte Typhinweise in `expect` haben möchten, stellen Sie sicher, dass `vitest/browser` irgendwo referenziert wird. Falls Sie nie von dort importiert haben, können Sie einen `reference`-Kommentar in einer beliebigen Datei ergänzen, die von Ihrer `tsconfig.json` abgedeckt ist:

```ts
/// <reference types="vitest/browser" />
```
:::

Tests im Browser können aufgrund ihrer asynchronen Natur unbeständig fehlschlagen. Deshalb ist es wichtig, sicherstellen zu können, dass Assertions auch dann erfolgreich sind, wenn die Bedingung verzögert eintritt (etwa durch ein Timeout, einen Netzwerk-Request oder eine Animation). Zu diesem Zweck stellt Vitest über die APIs [`expect.poll`](/api/expect#poll) und `expect.element` von Haus aus wiederholbare Assertions bereit:

```ts
import { expect, test } from 'vitest'
import { page } from 'vitest/browser'

test('error banner is rendered', async () => {
  triggerError()

  // This creates a locator that will try to find the element
  // when any of its methods are called.
  // This call by itself doesn't check the existence of the element.
  const banner = page.getByRole('alert', {
    name: /error/i,
  })

  // Vitest provides `expect.element` with built-in retry-ability
  // It will repeatedly check that the element exists in the DOM and that
  // the content of `element.textContent` is equal to "Error!"
  // until all the conditions are met
  await expect.element(banner).toMatchTextContent('Error!')
})
```

Wir empfehlen, bei der Arbeit mit `page.getBy*`-Locators immer `expect.element` zu verwenden, um Flakiness in Tests zu reduzieren. Beachten Sie, dass `expect.element` eine zweite Option akzeptiert:

```ts
interface ExpectPollOptions {
  // The interval to retry the assertion for in milliseconds
  // Defaults to "expect.poll.interval" config option
  interval?: number
  // Time to retry the assertion for in milliseconds
  // Defaults to "expect.poll.timeout" config option
  timeout?: number
  // The message printed when the assertion fails
  message?: string
}
```

::: tip
Wie [`expect.poll`](/api/expect#poll) wiederholt `expect.element` DOM-Assertions, bis sie erfolgreich sind oder das Timeout erreicht ist. Erhält es einen Locator, löst Vitest ihn vor dem Ausführen der DOM-Assertion mit [`locator.findElement()`](/api/browser/locators#findelement) auf. Die Option `timeout` gilt für den gesamten Wiederholungsvorgang. Die Option `interval` steuert, wie oft fehlgeschlagene DOM-Assertions wiederholt werden; die Auflösung des Locators verwendet jedoch die eigenen, ansteigenden Wiederholungsintervalle von `findElement`.

`toMatchTextContent` und alle anderen Assertions sind weiterhin auf einem gewöhnlichen `expect` ohne eingebauten Wiederholungsmechanismus verfügbar:

```ts
// will fail immediately if .textContent is not `'Error!'`
expect(banner).toMatchTextContent('Error!')
```
:::

## toBeDisabled

```ts
function toBeDisabled(): Promise<void>
```

Erlaubt es Ihnen zu prüfen, ob ein Element aus Sicht des Nutzers deaktiviert ist.

Passt, wenn das Element ein Formularsteuerelement ist und das Attribut `disabled` an diesem Element gesetzt ist oder das Element ein Nachfahre eines form-Elements mit einem Attribut `disabled` ist.

Beachten Sie, dass nur native Steuerelemente wie die HTML-Elemente `button`, `input`, `select`, `textarea`, `option`, `optgroup` durch Setzen des Attributs "disabled" deaktiviert werden können. Das Attribut "disabled" an anderen Elementen wird ignoriert, sofern es sich nicht um ein Custom Element handelt.

```html
<button
  data-testid="button"
  type="submit"
  disabled
>
  submit
</button>
```

```ts
await expect.element(getByTestId('button')).toBeDisabled() // ✅
await expect.element(getByTestId('button')).not.toBeDisabled() // ❌
```

## toBeEnabled

```ts
function toBeEnabled(): Promise<void>
```

Erlaubt es Ihnen zu prüfen, ob ein Element aus Sicht des Nutzers nicht deaktiviert ist.

Funktioniert wie [`not.toBeDisabled()`](#tobedisabled). Verwenden Sie diesen Matcher, um doppelte Verneinungen in Ihren Tests zu vermeiden.

```html
<button
  data-testid="button"
  type="submit"
  disabled
>
  submit
</button>
```

```ts
await expect.element(getByTestId('button')).toBeEnabled() // ✅
await expect.element(getByTestId('button')).not.toBeEnabled() // ❌
```

## toBeEmptyDOMElement

```ts
function toBeEmptyDOMElement(): Promise<void>
```

Damit können Sie prüfen, ob ein Element für den Nutzer keinen sichtbaren Inhalt hat. Kommentare werden ignoriert, die Assertion schlägt jedoch fehl, wenn das Element Leerraum enthält.

```html
<span data-testid="not-empty"><span data-testid="empty"></span></span>
<span data-testid="with-whitespace"> </span>
<span data-testid="with-comment"><!-- comment --></span>
```

```ts
await expect.element(getByTestId('empty')).toBeEmptyDOMElement()
await expect.element(getByTestId('not-empty')).not.toBeEmptyDOMElement()
await expect.element(
  getByTestId('with-whitespace')
).not.toBeEmptyDOMElement()
```

## toBeInTheDocument

```ts
function toBeInTheDocument(): Promise<void>
```

Prüft, ob ein Element im Dokument vorhanden ist oder nicht.

```html
<svg data-testid="svg-element"></svg>
```

```ts
await expect.element(getByTestId('svg-element')).toBeInTheDocument()
await expect.element(getByTestId('does-not-exist')).not.toBeInTheDocument()
```

::: warning
Dieser Matcher findet keine losgelösten Elemente. Das Element muss dem Dokument hinzugefügt sein, damit `toBeInTheDocument` es findet. Wenn Sie in einem losgelösten Element suchen möchten, verwenden Sie bitte [`toContainElement`](#tocontainelement).
:::

## toBeInvalid

```ts
function toBeInvalid(): Promise<void>
```

Damit können Sie prüfen, ob ein Element derzeit ungültig ist.

Ein Element ist ungültig, wenn es ein [Attribut `aria-invalid`](https://developer.mozilla.org/en-US/docs/Web/Accessibility/ARIA/Reference/Attributes/aria-invalid) ohne Wert oder mit dem Wert `"true"` hat oder wenn das Ergebnis von [`checkValidity()`](https://developer.mozilla.org/en-US/docs/Web/HTML/Constraint_validation) `false` ist.

```html
<input data-testid="no-aria-invalid" />
<input data-testid="aria-invalid" aria-invalid />
<input data-testid="aria-invalid-value" aria-invalid="true" />
<input data-testid="aria-invalid-false" aria-invalid="false" />

<form data-testid="valid-form">
  <input />
</form>

<form data-testid="invalid-form">
  <input required />
</form>
```

```ts
await expect.element(getByTestId('no-aria-invalid')).not.toBeInvalid()
await expect.element(getByTestId('aria-invalid')).toBeInvalid()
await expect.element(getByTestId('aria-invalid-value')).toBeInvalid()
await expect.element(getByTestId('aria-invalid-false')).not.toBeInvalid()

await expect.element(getByTestId('valid-form')).not.toBeInvalid()
await expect.element(getByTestId('invalid-form')).toBeInvalid()
```

## toBeRequired

```ts
function toBeRequired(): Promise<void>
```

Damit können Sie prüfen, ob ein Formularelement derzeit erforderlich ist.

Ein Element ist erforderlich, wenn es ein Attribut `required` oder `aria-required="true"` besitzt.

```html
<input data-testid="required-input" required />
<input data-testid="aria-required-input" aria-required="true" />
<input data-testid="conflicted-input" required aria-required="false" />
<input data-testid="aria-not-required-input" aria-required="false" />
<input data-testid="optional-input" />
<input data-testid="unsupported-type" type="image" required />
<select data-testid="select" required></select>
<textarea data-testid="textarea" required></textarea>
<div data-testid="supported-role" role="tree" required></div>
<div data-testid="supported-role-aria" role="tree" aria-required="true"></div>
```

```ts
await expect.element(getByTestId('required-input')).toBeRequired()
await expect.element(getByTestId('aria-required-input')).toBeRequired()
await expect.element(getByTestId('conflicted-input')).toBeRequired()
await expect.element(getByTestId('aria-not-required-input')).not.toBeRequired()
await expect.element(getByTestId('optional-input')).not.toBeRequired()
await expect.element(getByTestId('unsupported-type')).not.toBeRequired()
await expect.element(getByTestId('select')).toBeRequired()
await expect.element(getByTestId('textarea')).toBeRequired()
await expect.element(getByTestId('supported-role')).not.toBeRequired()
await expect.element(getByTestId('supported-role-aria')).toBeRequired()
```

## toBeValid

```ts
function toBeValid(): Promise<void>
```

Damit können Sie prüfen, ob der Wert eines Elements derzeit gültig ist.

Ein Element ist gültig, wenn es kein [Attribut `aria-invalid`](https://developer.mozilla.org/en-US/docs/Web/Accessibility/ARIA/Reference/Attributes/aria-invalid) oder den Attributwert "false" besitzt. Handelt es sich um ein Formularelement, muss zusätzlich das Ergebnis von [`checkValidity()`](https://developer.mozilla.org/en-US/docs/Web/HTML/Constraint_validation) `true` sein.

```html
<input data-testid="no-aria-invalid" />
<input data-testid="aria-invalid" aria-invalid />
<input data-testid="aria-invalid-value" aria-invalid="true" />
<input data-testid="aria-invalid-false" aria-invalid="false" />

<form data-testid="valid-form">
  <input />
</form>

<form data-testid="invalid-form">
  <input required />
</form>
```

```ts
await expect.element(getByTestId('no-aria-invalid')).toBeValid()
await expect.element(getByTestId('aria-invalid')).not.toBeValid()
await expect.element(getByTestId('aria-invalid-value')).not.toBeValid()
await expect.element(getByTestId('aria-invalid-false')).toBeValid()

await expect.element(getByTestId('valid-form')).toBeValid()
await expect.element(getByTestId('invalid-form')).not.toBeValid()
```

## toBeVisible

```ts
function toBeVisible(): Promise<void>
```

Damit können Sie prüfen, ob ein Element für den Nutzer derzeit sichtbar ist.

Ein Element gilt als sichtbar, wenn es eine nicht leere Bounding Box hat und der berechnete Stil nicht `visibility:hidden` ist.

Beachten Sie gemäß dieser Definition:

- Elemente mit Größe null gelten **nicht** als sichtbar.
- Elemente mit `display:none` gelten **nicht** als sichtbar.
- Elemente mit `opacity:0` gelten **als** sichtbar.

Um zu prüfen, dass mindestens ein Element aus der Liste sichtbar ist, verwenden Sie `locator.first()`.

```ts
// A specific element is visible.
await expect.element(page.getByText('Welcome')).toBeVisible()

// At least one item in the list is visible.
await expect.element(page.getByTestId('todo-item').first()).toBeVisible()

// At least one of the two elements is visible, possibly both.
await expect.element(
  page.getByRole('button', { name: 'Sign in' })
    .or(page.getByRole('button', { name: 'Sign up' }))
    .first()
).toBeVisible()
```

## toBeInViewport <Version>4.0.0</Version> {#tobeinviewport}

```ts
function toBeInViewport(options: { ratio?: number }): Promise<void>
```

Damit können Sie mit der [IntersectionObserver-API](https://developer.mozilla.org/en-US/docs/Web/API/Intersection_Observer_API) prüfen, ob sich ein Element derzeit im sichtbaren Bereich befindet.

Sie können das Argument `ratio` als Option übergeben; es gibt den Mindestanteil des Elements an, der im sichtbaren Bereich liegen soll. `ratio` sollte zwischen 0 und 1 liegen.

```ts
// A specific element is in viewport.
await expect.element(page.getByText('Welcome')).toBeInViewport()

// 50% of a specific element should be in viewport
await expect.element(page.getByText('To')).toBeInViewport({ ratio: 0.5 })

// Full of a specific element should be in viewport
await expect.element(page.getByText('Vitest')).toBeInViewport({ ratio: 1 })
```

## toContainElement

```ts
function toContainElement(element: HTMLElement | SVGElement | Locator | null): Promise<void>
```

Damit können Sie prüfen, ob ein Element ein anderes Element als Nachfahren enthält oder nicht.

```html
<span data-testid="ancestor"><span data-testid="descendant"></span></span>
```

```ts
const ancestor = getByTestId('ancestor')
const descendant = getByTestId('descendant')
const nonExistingElement = getByTestId('does-not-exist')

await expect.element(ancestor).toContainElement(descendant)
await expect.element(descendant).not.toContainElement(ancestor)
await expect.element(ancestor).not.toContainElement(nonExistingElement)
```

## toContainHTML

```ts
function toContainHTML(htmlText: string): Promise<void>
```

Prüft, ob eine Zeichenkette, die ein HTML-Element darstellt, in einem anderen Element enthalten ist. Die Zeichenkette sollte gültiges HTML enthalten und kein unvollständiges HTML.

```html
<span data-testid="parent"><span data-testid="child"></span></span>
```

```ts
// These are valid usages
await expect.element(getByTestId('parent')).toContainHTML('<span data-testid="child"></span>')
await expect.element(getByTestId('parent')).toContainHTML('<span data-testid="child" />')
await expect.element(getByTestId('parent')).not.toContainHTML('<br />')

// These won't work
await expect.element(getByTestId('parent')).toContainHTML('data-testid="child"')
await expect.element(getByTestId('parent')).toContainHTML('data-testid')
await expect.element(getByTestId('parent')).toContainHTML('</span>')
```

::: warning
Wahrscheinlich brauchen Sie diesen Matcher gar nicht. Wir empfehlen, aus der Perspektive zu testen, wie der Nutzer die Anwendung im Browser wahrnimmt. Deshalb wird von Tests gegen eine bestimmte DOM-Struktur abgeraten.

Nützlich sein kann er in Situationen, in denen der getestete Code HTML rendert, das aus einer externen Quelle stammt, und Sie prüfen möchten, dass dieser HTML-Code wie beabsichtigt verwendet wurde.

Er sollte nicht dazu verwendet werden, eine DOM-Struktur zu prüfen, die Sie selbst kontrollieren. Verwenden Sie dafür bitte [`toContainElement`](#tocontainelement).
:::

## toHaveAccessibleDescription

```ts
function toHaveAccessibleDescription(description?: string | RegExp): Promise<void>
```

Damit können Sie prüfen, dass ein Element die erwartete
[zugängliche Beschreibung](https://w3c.github.io/accname/) hat.

Sie können die exakte Zeichenkette der erwarteten zugänglichen Beschreibung übergeben oder eine
Teilübereinstimmung erreichen, indem Sie einen regulären Ausdruck übergeben oder
[`expect.stringContaining`](/api/expect#expect-stringcontaining) bzw. [`expect.stringMatching`](/api/expect#expect-stringmatching) verwenden.

```html
<a
  data-testid="link"
  href="/"
  aria-label="Home page"
  title="A link to start over"
  >Start</a
>
<a data-testid="extra-link" href="/about" aria-label="About page">About</a>
<img src="avatar.jpg" data-testid="avatar" alt="User profile pic" />
<img
  src="logo.jpg"
  data-testid="logo"
  alt="Company logo"
  aria-describedby="t1"
/>
<span id="t1" role="presentation">The logo of Our Company</span>
<img
  src="logo.jpg"
  data-testid="logo2"
  alt="Company logo"
  aria-description="The logo of Our Company"
/>
```

```ts
await expect.element(getByTestId('link')).toHaveAccessibleDescription()
await expect.element(getByTestId('link')).toHaveAccessibleDescription('A link to start over')
await expect.element(getByTestId('link')).not.toHaveAccessibleDescription('Home page')
await expect.element(getByTestId('extra-link')).not.toHaveAccessibleDescription()
await expect.element(getByTestId('avatar')).not.toHaveAccessibleDescription()
await expect.element(getByTestId('logo')).not.toHaveAccessibleDescription('Company logo')
await expect.element(getByTestId('logo')).toHaveAccessibleDescription(
  'The logo of Our Company',
)
await expect.element(getByTestId('logo2')).toHaveAccessibleDescription(
  'The logo of Our Company',
)
```

## toHaveAccessibleErrorMessage

```ts
function toHaveAccessibleErrorMessage(message?: string | RegExp): Promise<void>
```

Damit können Sie prüfen, dass ein Element die erwartete
[zugängliche Fehlermeldung](https://w3c.github.io/aria/#aria-errormessage) hat.

Sie können die exakte Zeichenkette der erwarteten zugänglichen Fehlermeldung übergeben.
Alternativ können Sie eine Teilübereinstimmung erreichen, indem Sie einen regulären Ausdruck
übergeben oder
[`expect.stringContaining`](/api/expect#expect-stringcontaining) bzw. [`expect.stringMatching`](/api/expect#expect-stringmatching) verwenden.

```html
<input
  aria-label="Has Error"
  aria-invalid="true"
  aria-errormessage="error-message"
/>
<div id="error-message" role="alert">This field is invalid</div>

<input aria-label="No Error Attributes" />
<input
  aria-label="Not Invalid"
  aria-invalid="false"
  aria-errormessage="error-message"
/>
```

```ts
// Inputs with Valid Error Messages
await expect.element(getByRole('textbox', { name: 'Has Error' })).toHaveAccessibleErrorMessage()
await expect.element(getByRole('textbox', { name: 'Has Error' })).toHaveAccessibleErrorMessage(
  'This field is invalid',
)
await expect.element(getByRole('textbox', { name: 'Has Error' })).toHaveAccessibleErrorMessage(
  /invalid/i,
)
await expect.element(
  getByRole('textbox', { name: 'Has Error' }),
).not.toHaveAccessibleErrorMessage('This field is absolutely correct!')

// Inputs without Valid Error Messages
await expect.element(
  getByRole('textbox', { name: 'No Error Attributes' }),
).not.toHaveAccessibleErrorMessage()

await expect.element(
  getByRole('textbox', { name: 'Not Invalid' }),
).not.toHaveAccessibleErrorMessage()
```

## toHaveAccessibleName

```ts
function toHaveAccessibleName(name?: string | RegExp): Promise<void>
```

Damit können Sie prüfen, dass ein Element den erwarteten
[zugänglichen Namen](https://w3c.github.io/accname/) hat. Das ist zum Beispiel nützlich,
um zu prüfen, dass Formularelemente und Buttons ordentlich beschriftet sind.

Sie können die exakte Zeichenkette des erwarteten zugänglichen Namens übergeben oder eine
Teilübereinstimmung erreichen, indem Sie einen regulären Ausdruck übergeben oder
[`expect.stringContaining`](/api/expect#expect-stringcontaining) bzw. [`expect.stringMatching`](/api/expect#expect-stringmatching) verwenden.

```html
<img data-testid="img-alt" src="" alt="Test alt" />
<img data-testid="img-empty-alt" src="" alt="" />
<svg data-testid="svg-title"><title>Test title</title></svg>
<button data-testid="button-img-alt"><img src="" alt="Test" /></button>
<p><img data-testid="img-paragraph" src="" alt="" /> Test content</p>
<button data-testid="svg-button"><svg><title>Test</title></svg></p>
<div><svg data-testid="svg-without-title"></svg></div>
<input data-testid="input-title" title="test" />
```

```javascript
await expect.element(getByTestId('img-alt')).toHaveAccessibleName('Test alt')
await expect.element(getByTestId('img-empty-alt')).not.toHaveAccessibleName()
await expect.element(getByTestId('svg-title')).toHaveAccessibleName('Test title')
await expect.element(getByTestId('button-img-alt')).toHaveAccessibleName()
await expect.element(getByTestId('img-paragraph')).not.toHaveAccessibleName()
await expect.element(getByTestId('svg-button')).toHaveAccessibleName()
await expect.element(getByTestId('svg-without-title')).not.toHaveAccessibleName()
await expect.element(getByTestId('input-title')).toHaveAccessibleName()
```

## toHaveAttribute

```ts
function toHaveAttribute(attribute: string, value?: unknown): Promise<void>
```

Damit können Sie prüfen, ob das angegebene Element ein Attribut hat oder nicht. Optional
können Sie zusätzlich prüfen, ob das Attribut einen bestimmten erwarteten Wert hat oder
teilweise übereinstimmt, mit [`expect.stringContaining`](/api/expect#expect-stringcontaining) bzw. [`expect.stringMatching`](/api/expect#expect-stringmatching).

```html
<button data-testid="ok-button" type="submit" disabled>ok</button>
```

```ts
const button = getByTestId('ok-button')

await expect.element(button).toHaveAttribute('disabled')
await expect.element(button).toHaveAttribute('type', 'submit')
await expect.element(button).not.toHaveAttribute('type', 'button')

await expect.element(button).toHaveAttribute(
  'type',
  expect.stringContaining('sub')
)
await expect.element(button).toHaveAttribute(
  'type',
  expect.not.stringContaining('but')
)
```

## toHaveClass

```ts
function toHaveClass(...classNames: string[], options?: { exact: boolean }): Promise<void>
function toHaveClass(...classNames: (string | RegExp)[]): Promise<void>
```

Damit können Sie prüfen, ob das angegebene Element bestimmte Klassen in seinem
Attribut `class` hat. Sie müssen mindestens eine Klasse angeben, es sei denn, Sie
prüfen, dass ein Element keinerlei Klassen hat.

Die Liste der Klassennamen darf Zeichenketten und reguläre Ausdrücke enthalten. Reguläre
Ausdrücke werden gegen jede einzelne Klasse des Zielelements abgeglichen und NICHT
gegen den gesamten Wert seines Attributs `class` als Ganzes.

::: warning
Beachten Sie, dass Sie die Option `exact: true` nicht verwenden können, wenn ausschließlich reguläre Ausdrücke angegeben sind.
:::

```html
<button data-testid="delete-button" class="btn extra btn-danger">
  Delete item
</button>
<button data-testid="no-classes">No Classes</button>
```

```ts
const deleteButton = getByTestId('delete-button')
const noClasses = getByTestId('no-classes')

await expect.element(deleteButton).toHaveClass('extra')
await expect.element(deleteButton).toHaveClass('btn-danger btn')
await expect.element(deleteButton).toHaveClass(/danger/, 'btn')
await expect.element(deleteButton).toHaveClass('btn-danger', 'btn')
await expect.element(deleteButton).not.toHaveClass('btn-link')
await expect.element(deleteButton).not.toHaveClass(/link/)

// ⚠️ regexp matches against individual classes, not the whole classList
await expect.element(deleteButton).not.toHaveClass(/btn extra/)

// the element has EXACTLY a set of classes (in any order)
await expect.element(deleteButton).toHaveClass('btn-danger extra btn', {
  exact: true
})
// if it has more than expected it is going to fail
await expect.element(deleteButton).not.toHaveClass('btn-danger extra', {
  exact: true
})

await expect.element(noClasses).not.toHaveClass()
```

## toHaveFocus

```ts
function toHaveFocus(): Promise<void>
```

Damit können Sie prüfen, ob ein Element den Fokus hat oder nicht.

```html
<div><input type="text" data-testid="element-to-focus" /></div>
```

```ts
const input = page.getByTestId('element-to-focus')
input.element().focus()
await expect.element(input).toHaveFocus()
input.element().blur()
await expect.element(input).not.toHaveFocus()
```

## toHaveFormValues

```ts
function toHaveFormValues(expectedValues: Record<string, unknown>): Promise<void>
```

Damit können Sie prüfen, ob ein form- oder fieldset-Element für jeden angegebenen Namen ein Formularsteuerelement mit dem angegebenen Wert enthält.

::: tip
Es ist wichtig zu betonen, dass dieser Matcher nur auf einem [form](https://developer.mozilla.org/en-US/docs/Web/API/HTMLFormElement)- oder [fieldset](https://developer.mozilla.org/en-US/docs/Web/API/HTMLFieldSetElement)-Element aufgerufen werden kann.

Dadurch kann er die Eigenschaft [`.elements`](https://developer.mozilla.org/en-US/docs/Web/API/HTMLFormElement/elements) von `form` und `fieldset` nutzen, um alle darin enthaltenen Formularsteuerelemente zuverlässig zu ermitteln.

Das vermeidet außerdem die Möglichkeit, dass Nutzer einen Container übergeben, der mehr als ein `form` enthält, wodurch nicht zusammengehörige Formularsteuerelemente vermischt würden, die einander sogar widersprechen könnten.
:::

Dieser Matcher abstrahiert die Besonderheiten, mit denen der Wert eines Formularsteuerelements
je nach dessen Typ ermittelt wird. So haben `<input>`-Elemente zum Beispiel ein
Attribut `value`, `<select>`-Elemente jedoch nicht. Hier eine Liste aller
abgedeckten Fälle:

- `<input type="number">`-Elemente liefern den Wert als **Zahl** statt als
  Zeichenkette.
- `<input type="checkbox">`-Elemente:
  - Gibt es nur ein einziges mit dem angegebenen Attribut `name`, wird es als
    **boolean** behandelt und liefert `true`, wenn die Checkbox angehakt ist, sonst
    `false`.
  - Gibt es mehr als eine Checkbox mit demselben Attribut `name`, werden sie
    gemeinsam als ein einzelnes Formularsteuerelement behandelt, das den Wert als
    **Array** mit allen Werten der ausgewählten Checkboxen der Gruppe
    liefert.
- `<input type="radio">`-Elemente werden alle über das Attribut `name` gruppiert, und
  eine solche Gruppe wird als ein einzelnes Formularsteuerelement behandelt. Dieses Steuerelement liefert den
  Wert als **Zeichenkette**, die dem Attribut `value` des ausgewählten
  Radio-Buttons innerhalb der Gruppe entspricht.
- `<input type="text">`-Elemente liefern den Wert als **Zeichenkette**. Das gilt auch
  für `<input>`-Elemente mit jedem anderen möglichen Attribut `type`,
  das oben nicht ausdrücklich durch eigene Regeln abgedeckt ist (z. B. `search`,
  `email`, `date`, `password`, `hidden` usw.)
- `<select>`-Elemente ohne das Attribut `multiple` liefern den Wert als
  **Zeichenkette**, die dem Attribut `value` der ausgewählten `option` entspricht, oder
  `undefined`, wenn keine Option ausgewählt ist.
- `<select multiple>`-Elemente liefern den Wert als **Array** mit allen
  Werten der [ausgewählten Optionen](https://developer.mozilla.org/en-US/docs/Web/API/HTMLSelectElement/selectedOptions).
- `<textarea>`-Elemente liefern ihren Wert als **Zeichenkette**. Der Wert
  entspricht ihrem Knoteninhalt.

Die obigen Regeln machen es zum Beispiel einfach, von einem einzelnen Select-Steuerelement
auf eine Gruppe von Radio-Buttons zu wechseln. Oder von einem Mehrfachauswahl-Steuerelement
auf eine Gruppe von Checkboxen. Die resultierende Menge an Formularwerten, die dieser
Matcher zum Vergleich heranzieht, wäre dieselbe.

```html
<form data-testid="login-form">
  <input type="text" name="username" value="jane.doe" />
  <input type="password" name="password" value="12345678" />
  <input type="checkbox" name="rememberMe" checked />
  <button type="submit">Sign in</button>
</form>
```

```ts
await expect.element(getByTestId('login-form')).toHaveFormValues({
  username: 'jane.doe',
  rememberMe: true,
})
```

## toHaveStyle

```ts
function toHaveStyle(css: string | Partial<CSSStyleDeclaration>): Promise<void>
```

Damit können Sie prüfen, ob auf ein bestimmtes Element bestimmte CSS-Eigenschaften
mit bestimmten Werten angewendet sind. Es passt nur, wenn das Element _alle_
erwarteten Eigenschaften angewendet hat, nicht nur einige davon.

```html
<button
  data-testid="delete-button"
  style="display: none; background-color: red"
>
  Delete item
</button>
```

```ts
const button = getByTestId('delete-button')

await expect.element(button).toHaveStyle('display: none')
await expect.element(button).toHaveStyle({ display: 'none' })
await expect.element(button).toHaveStyle(`
  background-color: red;
  display: none;
`)
await expect.element(button).toHaveStyle({
  backgroundColor: 'red',
  display: 'none',
})
await expect.element(button).not.toHaveStyle(`
  background-color: blue;
  display: none;
`)
await expect.element(button).not.toHaveStyle({
  backgroundColor: 'blue',
  display: 'none',
})
```

Das funktioniert auch mit Regeln, die dem Element über einen Klassennamen zugewiesen sind,
für den Regeln in einem im Dokument aktiven Stylesheet definiert sind.
Es gelten die üblichen Regeln der CSS-Kaskade.

## toHaveTextContent

```ts
function toHaveTextContent(
  text: string | number,
  options?: { normalizeWhitespace: boolean }
): Promise<void>
```

Mit diesem Matcher können Sie prüfen, dass der Text eines Elements exakt der angegebenen Zeichenkette entspricht. Das
funktioniert für Elemente, aber auch für Textknoten und Fragmente.

Wenn Sie eine Teilprüfung oder einen Abgleich unter Berücksichtigung der Groß-/Kleinschreibung durchführen möchten, verwenden Sie stattdessen [`toMatchTextContent`](#tomatchtextcontent).

```html
<span data-testid="text-content">Text Content</span>
```

```ts
const element = getByTestId('text-content')

await expect.element(element).toHaveTextContent('Text Content')
await expect.element(element).not.toHaveTextContent('Content')
```

## toMatchTextContent

```ts
function toMatchTextContent(
  text: string | number | RegExp,
  options?: { normalizeWhitespace: boolean }
): Promise<void>
```

Mit diesem Matcher können Sie prüfen, ob der angegebene Knoten einen Textinhalt hat oder nicht. Das
funktioniert für Elemente, aber auch für Textknoten und Fragmente.

Wird ein `string`-Argument übergeben, erfolgt eine teilweise Übereinstimmung
unter Berücksichtigung der Groß-/Kleinschreibung mit dem Knoteninhalt.

Für einen Abgleich ohne Berücksichtigung der Groß-/Kleinschreibung können Sie einen `RegExp` mit dem
Modifikator `/i` verwenden.

Wenn Sie den gesamten Inhalt abgleichen möchten, können Sie dafür einen `RegExp` verwenden oder stattdessen den Matcher [`toHaveTextContent`](#tohavetextcontent).

```html
<span data-testid="text-content">Text Content</span>
```

```ts
const element = getByTestId('text-content')

await expect.element(element).toMatchTextContent('Content')
// to match the whole content
await expect.element(element).toMatchTextContent(/^Text Content$/)
// to use case-insensitive match
await expect.element(element).toMatchTextContent(/content$/i)
await expect.element(element).not.toMatchTextContent('content')
```

## toHaveValue

```ts
function toHaveValue(value: string | string[] | number | null): Promise<void>
```

Damit können Sie prüfen, ob das angegebene Formularelement den angegebenen Wert hat.
Es akzeptiert `<input>`-, `<select>`- und `<textarea>`-Elemente mit Ausnahme von
`<input type="checkbox">` und `<input type="radio">`, die sinnvollerweise nur mit
[`toBeChecked`](#tobechecked) oder
[`toHaveFormValues`](#tohaveformvalues) abgeglichen werden können.

Es akzeptiert außerdem Elemente mit den Rollen `meter`, `progressbar`, `slider` oder
`spinbutton` und prüft deren Attribut `aria-valuenow` (als Zahl).

Für alle übrigen Formularelemente wird der Wert nach demselben Algorithmus abgeglichen wie bei
[`toHaveFormValues`](#tohaveformvalues).

```html
<input type="text" value="text" data-testid="input-text" />
<input type="number" value="5" data-testid="input-number" />
<input type="text" data-testid="input-empty" />
<select multiple data-testid="select-number">
  <option value="first">First Value</option>
  <option value="second" selected>Second Value</option>
  <option value="third" selected>Third Value</option>
</select>
```

```ts
const textInput = getByTestId('input-text')
const numberInput = getByTestId('input-number')
const emptyInput = getByTestId('input-empty')
const selectInput = getByTestId('select-number')

await expect.element(textInput).toHaveValue('text')
await expect.element(numberInput).toHaveValue(5)
await expect.element(emptyInput).not.toHaveValue()
await expect.element(selectInput).toHaveValue(['second', 'third'])
```

## toHaveDisplayValue

```typescript
function toHaveDisplayValue(
  value: string | RegExp | (string | RegExp)[]
): Promise<void>
```

Damit können Sie prüfen, ob das angegebene Formularelement den angegebenen
angezeigten Wert hat (also den, den der Endnutzer sieht). Es akzeptiert `<input>`-,
`<select>`- und `<textarea>`-Elemente mit Ausnahme von
`<input type="checkbox">` und `<input type="radio">`, die sinnvollerweise nur mit
[`toBeChecked`](#tobechecked) oder
[`toHaveFormValues`](#tohaveformvalues) abgeglichen werden können.

```html
<label for="input-example">First name</label>
<input type="text" id="input-example" value="Luca" />

<label for="textarea-example">Description</label>
<textarea id="textarea-example">An example description here.</textarea>

<label for="single-select-example">Fruit</label>
<select id="single-select-example">
  <option value="">Select a fruit...</option>
  <option value="banana">Banana</option>
  <option value="ananas">Ananas</option>
  <option value="avocado">Avocado</option>
</select>

<label for="multiple-select-example">Fruits</label>
<select id="multiple-select-example" multiple>
  <option value="">Select a fruit...</option>
  <option value="banana" selected>Banana</option>
  <option value="ananas">Ananas</option>
  <option value="avocado" selected>Avocado</option>
</select>
```

```ts
const input = page.getByLabelText('First name')
const textarea = page.getByLabelText('Description')
const selectSingle = page.getByLabelText('Fruit')
const selectMultiple = page.getByLabelText('Fruits')

await expect.element(input).toHaveDisplayValue('Luca')
await expect.element(input).toHaveDisplayValue(/Luc/)
await expect.element(textarea).toHaveDisplayValue('An example description here.')
await expect.element(textarea).toHaveDisplayValue(/example/)
await expect.element(selectSingle).toHaveDisplayValue('Select a fruit...')
await expect.element(selectSingle).toHaveDisplayValue(/Select/)
await expect.element(selectMultiple).toHaveDisplayValue([/Avocado/, 'Banana'])
```

## toBeChecked

```ts
function toBeChecked(): Promise<void>
```

Damit können Sie prüfen, ob das angegebene Element angehakt ist. Es akzeptiert ein
`input` vom Typ `checkbox` oder `radio` sowie Elemente mit einer `role` von `checkbox`,
`radio` oder `switch` mit einem gültigen Attribut `aria-checked` mit dem Wert `"true"` oder
`"false"`.

```html
<input type="checkbox" checked data-testid="input-checkbox-checked" />
<input type="checkbox" data-testid="input-checkbox-unchecked" />
<div role="checkbox" aria-checked="true" data-testid="aria-checkbox-checked" />
<div
  role="checkbox"
  aria-checked="false"
  data-testid="aria-checkbox-unchecked"
/>

<input type="radio" checked value="foo" data-testid="input-radio-checked" />
<input type="radio" value="foo" data-testid="input-radio-unchecked" />
<div role="radio" aria-checked="true" data-testid="aria-radio-checked" />
<div role="radio" aria-checked="false" data-testid="aria-radio-unchecked" />
<div role="switch" aria-checked="true" data-testid="aria-switch-checked" />
<div role="switch" aria-checked="false" data-testid="aria-switch-unchecked" />
```

```ts
const inputCheckboxChecked = getByTestId('input-checkbox-checked')
const inputCheckboxUnchecked = getByTestId('input-checkbox-unchecked')
const ariaCheckboxChecked = getByTestId('aria-checkbox-checked')
const ariaCheckboxUnchecked = getByTestId('aria-checkbox-unchecked')
await expect.element(inputCheckboxChecked).toBeChecked()
await expect.element(inputCheckboxUnchecked).not.toBeChecked()
await expect.element(ariaCheckboxChecked).toBeChecked()
await expect.element(ariaCheckboxUnchecked).not.toBeChecked()

const inputRadioChecked = getByTestId('input-radio-checked')
const inputRadioUnchecked = getByTestId('input-radio-unchecked')
const ariaRadioChecked = getByTestId('aria-radio-checked')
const ariaRadioUnchecked = getByTestId('aria-radio-unchecked')
await expect.element(inputRadioChecked).toBeChecked()
await expect.element(inputRadioUnchecked).not.toBeChecked()
await expect.element(ariaRadioChecked).toBeChecked()
await expect.element(ariaRadioUnchecked).not.toBeChecked()

const ariaSwitchChecked = getByTestId('aria-switch-checked')
const ariaSwitchUnchecked = getByTestId('aria-switch-unchecked')
await expect.element(ariaSwitchChecked).toBeChecked()
await expect.element(ariaSwitchUnchecked).not.toBeChecked()
```

## toBePartiallyChecked

```typescript
function toBePartiallyChecked(): Promise<void>
```

Damit können Sie prüfen, ob das angegebene Element teilweise angehakt ist. Es
akzeptiert ein `input` vom Typ `checkbox` sowie Elemente mit einer `role` von `checkbox`
mit `aria-checked="mixed"` oder ein `input` vom Typ `checkbox` mit
`indeterminate` auf `true`

```html
<input type="checkbox" aria-checked="mixed" data-testid="aria-checkbox-mixed" />
<input type="checkbox" checked data-testid="input-checkbox-checked" />
<input type="checkbox" data-testid="input-checkbox-unchecked" />
<div role="checkbox" aria-checked="true" data-testid="aria-checkbox-checked" />
<div
  role="checkbox"
  aria-checked="false"
  data-testid="aria-checkbox-unchecked"
/>
<input type="checkbox" data-testid="input-checkbox-indeterminate" />
```

```ts
const ariaCheckboxMixed = getByTestId('aria-checkbox-mixed')
const inputCheckboxChecked = getByTestId('input-checkbox-checked')
const inputCheckboxUnchecked = getByTestId('input-checkbox-unchecked')
const ariaCheckboxChecked = getByTestId('aria-checkbox-checked')
const ariaCheckboxUnchecked = getByTestId('aria-checkbox-unchecked')
const inputCheckboxIndeterminate = getByTestId('input-checkbox-indeterminate')

await expect.element(ariaCheckboxMixed).toBePartiallyChecked()
await expect.element(inputCheckboxChecked).not.toBePartiallyChecked()
await expect.element(inputCheckboxUnchecked).not.toBePartiallyChecked()
await expect.element(ariaCheckboxChecked).not.toBePartiallyChecked()
await expect.element(ariaCheckboxUnchecked).not.toBePartiallyChecked()

inputCheckboxIndeterminate.element().indeterminate = true
await expect.element(inputCheckboxIndeterminate).toBePartiallyChecked()
```

## toHaveRole

```ts
function toHaveRole(role: ARIARole): Promise<void>
```

Damit können Sie prüfen, dass ein Element die erwartete [Rolle](https://www.w3.org/TR/html-aria/#docconformance) hat.

Das ist nützlich, wenn Sie bereits über eine andere Abfrage als die Rolle selbst Zugriff auf ein Element haben und zusätzliche Aussagen zu dessen Barrierefreiheit treffen möchten.

Die Rolle kann entweder auf eine explizite Rolle (über das Attribut `role`) oder auf eine implizite über die [impliziten ARIA-Semantiken](https://www.w3.org/TR/html-aria/#docconformance) passen.

```html
<button data-testid="button">Continue</button>
<div role="button" data-testid="button-explicit">Continue</button>
<button role="switch button" data-testid="button-explicit-multiple">Continue</button>
<a href="/about" data-testid="link">About</a>
<a data-testid="link-invalid">Invalid link<a/>
```

```ts
await expect.element(getByTestId('button')).toHaveRole('button')
await expect.element(getByTestId('button-explicit')).toHaveRole('button')
await expect.element(getByTestId('button-explicit-multiple')).toHaveRole('button')
await expect.element(getByTestId('button-explicit-multiple')).toHaveRole('switch')
await expect.element(getByTestId('link')).toHaveRole('link')
await expect.element(getByTestId('link-invalid')).not.toHaveRole('link')
await expect.element(getByTestId('link-invalid')).toHaveRole('generic')
```

::: warning
Rollen werden wörtlich über Zeichenkettengleichheit abgeglichen, ohne Vererbung aus der ARIA-Rollenhierarchie. Folglich schließt die Abfrage einer Oberrolle wie `checkbox` keine Elemente mit einer Unterrolle wie `switch` ein.

Beachten Sie außerdem, dass Vitest anders als `testing-library` alle eigenen Rollen bis auf die erste gültige ignoriert und damit dem Verhalten von Playwright folgt:

```jsx
<div data-testid="switch" role="switch alert"></div>

await expect.element(getByTestId('switch')).toHaveRole('switch') // ✅
await expect.element(getByTestId('switch')).toHaveRole('alert') // ❌
```
:::

## toHaveSelection

```ts
function toHaveSelection(selection?: string): Promise<void>
```

Damit lässt sich prüfen, dass ein Element eine
[Textauswahl](https://developer.mozilla.org/en-US/docs/Web/API/Selection) hat.

Das ist nützlich, um zu prüfen, ob Text oder ein Teil des Texts innerhalb eines
Elements ausgewählt ist. Das Element kann ein Eingabefeld vom Typ text, eine textarea oder ein
beliebiges anderes Element sein, das Text enthält, etwa ein Absatz, span, div usw.

::: warning
Die erwartete Auswahl ist eine Zeichenkette; eine Prüfung auf
Indizes des Auswahlbereichs ist nicht möglich.
:::

```html
<div>
  <input type="text" value="text selected text" data-testid="text" />
  <textarea data-testid="textarea">text selected text</textarea>
  <p data-testid="prev">prev</p>
  <p data-testid="parent">
    text <span data-testid="child">selected</span> text
  </p>
  <p data-testid="next">next</p>
</div>
```

```ts
getByTestId('text').element().setSelectionRange(5, 13)
await expect.element(getByTestId('text')).toHaveSelection('selected')

getByTestId('textarea').element().setSelectionRange(0, 5)
await expect.element('textarea').toHaveSelection('text ')

const selection = document.getSelection()
const range = document.createRange()
selection.removeAllRanges()
selection.empty()
selection.addRange(range)

// selection of child applies to the parent as well
range.selectNodeContents(getByTestId('child').element())
await expect.element(getByTestId('child')).toHaveSelection('selected')
await expect.element(getByTestId('parent')).toHaveSelection('selected')

// selection that applies from prev all, parent text before child, and part child.
range.setStart(getByTestId('prev').element(), 0)
range.setEnd(getByTestId('child').element().childNodes[0], 3)
await expect.element(queryByTestId('prev')).toHaveSelection('prev')
await expect.element(queryByTestId('child')).toHaveSelection('sel')
await expect.element(queryByTestId('parent')).toHaveSelection('text sel')
await expect.element(queryByTestId('next')).not.toHaveSelection()

// selection that applies from part child, parent text after child and part next.
range.setStart(getByTestId('child').element().childNodes[0], 3)
range.setEnd(getByTestId('next').element().childNodes[0], 2)
await expect.element(queryByTestId('child')).toHaveSelection('ected')
await expect.element(queryByTestId('parent')).toHaveSelection('ected text')
await expect.element(queryByTestId('prev')).not.toHaveSelection()
await expect.element(queryByTestId('next')).toHaveSelection('ne')
```

## toMatchScreenshot <Experimental /> {#tomatchscreenshot}

```ts
function toMatchScreenshot(
  options?: ScreenshotMatcherOptions,
): Promise<void>
function toMatchScreenshot(
  name?: string,
  options?: ScreenshotMatcherOptions,
): Promise<void>
```

::: tip
Die Assertion `toMatchScreenshot` lässt sich global in Ihrer
[Vitest-Konfiguration](/config/browser/expect#tomatchscreenshot) konfigurieren.
:::

Diese Assertion erlaubt es Ihnen, visuelle Regressionstests durchzuführen, indem
Screenshots von Elementen oder Seiten mit gespeicherten Referenzbildern verglichen werden.

Werden Unterschiede jenseits des konfigurierten Schwellwerts erkannt, schlägt der Test fehl.
Um die Änderungen leichter zu erkennen, erzeugt die Assertion:

- den tatsächlichen, während des Tests aufgenommenen Screenshot
- den erwarteten Referenz-Screenshot
- ein Diff-Bild, das die Unterschiede hervorhebt (sofern möglich)

::: warning Stabilität von Screenshots
Die Assertion nimmt automatisch wiederholt Screenshots auf, bis zwei aufeinanderfolgende
Aufnahmen dasselbe Ergebnis liefern. Das reduziert Flakiness durch
Animationen, Ladezustände oder andere dynamische Inhalte. Sie können dieses
Verhalten über die Option `timeout` steuern.

Das Rendering im Browser kann jedoch variieren zwischen:

- verschiedenen Browsern und Browserversionen
- Betriebssystemen (Windows, macOS, Linux)
- Bildschirmauflösungen und Pixeldichten
- GPU-Treibern und Hardwarebeschleunigung
- Schriftrendering und Systemschriften

Es empfiehlt sich, den
[Leitfaden zu visuellen Regressionstests](/guide/browser/visual-regression-testing) zu lesen,
um diese Teststrategie effizient umzusetzen.
:::

::: tip
Wenn ein Screenshot-Vergleich aufgrund **beabsichtigter Änderungen** fehlschlägt, können Sie
den Referenz-Screenshot aktualisieren, indem Sie im Watch-Modus die Taste `u` drücken oder
die Tests mit den Flags `-u` bzw. `--update` ausführen.
:::

```html
<button data-testid="button">Fancy Button</button>
```

```ts
// basic usage, auto-generates screenshot name
await expect.element(getByTestId('button')).toMatchScreenshot()

// with custom name
await expect.element(getByTestId('button')).toMatchScreenshot('fancy-button')

// with options
await expect.element(getByTestId('button')).toMatchScreenshot({
  comparatorName: 'pixelmatch',
  comparatorOptions: {
    allowedMismatchedPixelRatio: 0.01,
  },
})

// with both name and options
await expect.element(getByTestId('button')).toMatchScreenshot('fancy-button', {
  comparatorName: 'pixelmatch',
  comparatorOptions: {
    allowedMismatchedPixelRatio: 0.01,
  },
})
```

### Optionen

- `comparatorName: "pixelmatch" = "pixelmatch"`

  Der Algorithmus bzw. die Bibliothek, die zum Vergleichen von Bildern verwendet wird.

  `"pixelmatch"` ist der einzige eingebaute Comparator, Sie können aber eigene verwenden, indem Sie sie [in der Konfigurationsdatei registrieren](/config/browser/expect#browser-expect-tomatchscreenshot-comparators).

- `comparatorOptions: object`

  Diese Optionen erlauben es, das Verhalten des Comparators zu ändern. Welche Eigenschaften
  gesetzt werden können, hängt vom gewählten Comparator-Algorithmus ab.

  Vitest setzt von Haus aus Standardwerte, die sich aber überschreiben lassen.

  - [Optionen für `"pixelmatch"`](#pixelmatch-comparator-options)

  ::: warning
  **Setzen Sie `comparatorName` immer explizit, um korrekte Typinferenz für
  `comparatorOptions` zu erhalten**.

  Ohne ihn weiß TypeScript nicht, welche Optionen gültig sind:

  ```ts
  // ❌ TypeScript can't infer the correct options
  await expect.element(button).toMatchScreenshot({
    comparatorOptions: {
      // might error when new comparators are added
      allowedMismatchedPixelRatio: 0.01,
    },
  })

  // ✅ TypeScript knows these are pixelmatch options
  await expect.element(button).toMatchScreenshot({
    comparatorName: 'pixelmatch',
    comparatorOptions: {
      allowedMismatchedPixelRatio: 0.01,
    },
  })
  ```
  :::

- `screenshotOptions: object`

  Dieselben Optionen, die
  [`locator.screenshot()`](/api/browser/locators.html#screenshot) erlaubt, mit Ausnahme von:

  - `'base64'`
  - `'path'`
  - `'save'`
  - `'type'`

- `timeout: number = 5_000`

  Zeit, die gewartet wird, bis ein stabiler Screenshot gefunden ist.

  Der Wert `0` deaktiviert das Timeout; lässt sich jedoch kein stabiler Screenshot
  ermitteln, endet der Vorgang nicht.

#### Comparator-Optionen für `"pixelmatch"`

Der Comparator `"pixelmatch"` verwendet intern [`@blazediff/core`](https://blazediff.dev/docs/core). Bei seiner Verwendung stehen die folgenden Optionen zur Verfügung:

- `allowedMismatchedPixelRatio: number | undefined = undefined`

  Der maximal zulässige Anteil abweichender Pixel zwischen dem aufgenommenen Screenshot
  und dem Referenzbild.

  Muss ein Wert zwischen `0` und `1` sein.

  Zum Beispiel bedeutet `allowedMismatchedPixelRatio: 0.02`, dass der Test erfolgreich ist,
  wenn bis zu 2 % der Pixel abweichen, und fehlschlägt, wenn mehr als 2 % abweichen.

- `allowedMismatchedPixels: number | undefined = undefined`

  Die maximale Anzahl an Pixeln, die zwischen dem aufgenommenen Screenshot und dem
  gespeicherten Referenzbild abweichen dürfen.

  Ist der Wert `undefined`, führt jede von null verschiedene Abweichung zum Fehlschlagen des Tests.

  Zum Beispiel bedeutet `allowedMismatchedPixels: 10`, dass der Test erfolgreich ist, wenn 10 oder
  weniger Pixel abweichen, und fehlschlägt, wenn 11 oder mehr abweichen.

- `threshold: number = 0.1`

  Akzeptabler wahrgenommener Farbunterschied zwischen demselben Pixel in zwei Bildern.

  Der Wert reicht von `0` (streng) bis `1` (sehr großzügig). Niedrigere Werte bedeuten, dass auch kleine
  Unterschiede erkannt werden.

  Der Vergleich verwendet den [YIQ-Farbraum](https://en.wikipedia.org/wiki/YIQ).

- `includeAA: boolean = false`

  Bei `true` wird das Erkennen und Ignorieren kantengeglätteter Pixel deaktiviert.

- `alpha: number = 0.1`

  Überblendungsgrad unveränderter Pixel im Diff-Bild.

  Reicht von `0` (weiß) bis `1` (ursprüngliche Helligkeit).

- `aaColor: [r: number, g: number, b: number] = [255, 255, 0]`

  Farbe, die für kantengeglättete Pixel im Diff-Bild verwendet wird.

- `diffColor: [r: number, g: number, b: number] = [255, 0, 0]`

  Farbe, die für abweichende Pixel im Diff-Bild verwendet wird.

- `diffColorAlt: [r: number, g: number, b: number] | undefined = undefined`

  Optionale Alternativfarbe für Dunkel-auf-Hell-Unterschiede, um zu verdeutlichen, was
  hinzugefügt und was entfernt wurde.

  Ist sie nicht gesetzt, wird `diffColor` für alle Unterschiede verwendet.

- `diffMask: boolean = false`

  Bei `true` wird nur das Diff als Maske auf transparentem Hintergrund angezeigt, statt
  es über das Originalbild zu legen.

  Kantengeglättete Pixel werden nicht angezeigt (sofern erkannt).

::: warning
Sind sowohl `allowedMismatchedPixels` als auch `allowedMismatchedPixelRatio` gesetzt,
wird der restriktivere Wert verwendet.

Wenn Sie zum Beispiel 100 Pixel oder ein Verhältnis von 2 % erlauben und Ihr Bild 10.000
Pixel hat, liegt die effektive Grenze bei 100 statt bei 200 Pixeln.
:::
