# browser.locators

Optionen für die eingebauten [Browser-Locators](/api/browser/locators).

## browser.locators.testIdAttribute

- **Typ:** `string`
- **Standard:** `data-testid`

Attribut, das zum Auffinden von Elementen mit dem Locator `getByTestId` verwendet wird.

## browser.locators.exact

- **Typ:** `boolean`
- **Standard:** `true`

Ist der Wert `true`, treffen [Locators](/api/browser/locators) Text standardmäßig exakt und verlangen eine vollständige Übereinstimmung unter Beachtung der Groß- und Kleinschreibung. Einzelne Locator-Aufrufe können diesen Standard über ihre eigene Option `exact` überschreiben.

```ts
// With exact: true (default), this only matches the string "Hello, World" exactly.
// With exact: false, this matches "Hello, World!", "Say Hello, World", etc.
const locator = page.getByText('Hello, World', { exact: true })
await locator.click()
```

## browser.locators.errorFormat <Version>5.0.0</Version> {#browser-locators-errorformat}

- **Typ:** `'html' | 'aria' | 'all'`
- **Standard:** `'all'`

Steuert, was Vitest ausgibt, wenn ein Locator kein Element finden kann. Vitest gibt Informationen zu dem DOM-Teilbaum aus, in dem die Locator-Suche lief, beziehungsweise `document.body` bei Locators auf Seitenebene.

- `'html'` gibt diesen DOM-Teilbaum mittels [`utils.prettyDOM`](/api/browser/context#prettydom) als HTML aus.
- `'aria'` gibt diesen DOM-Teilbaum als [ARIA-Snapshot](/guide/browser/aria-snapshots) aus, der sich auf zugängliche Rollen, Namen und Zustände konzentriert.
- `'all'` gibt zuerst den ARIA-Snapshot und anschließend die HTML-Ausgabe aus.

```ts
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    browser: {
      enabled: true,
      locators: {
        errorFormat: 'aria',
      },
    },
  },
})
```

`all` zeigt beispielsweise folgenden Fehler an:

```html
VitestBrowserElementError: Cannot find element with locator: getByRole('button', { name: 'Save' })

ARIA tree:
- main:
  - heading "Settings" [level=1]
  - button "Cancel"

HTML:
<body>
  <main>
    <h1>
      Settings
    </h1>
    <button>
      Cancel
    </button>
  </main>
</body>
```
