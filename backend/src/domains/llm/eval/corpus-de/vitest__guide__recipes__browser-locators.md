# Domänen-Locators

Eingebaute [Locators](/api/browser/locators) wie `getByRole` und `getByText` decken Abfragen ab, die sich auf Accessibility-Attribute abbilden lassen. Sie stoßen an ihre Grenzen, wenn eine App Strukturen aufweist, die nicht zu ARIA passen – etwa einen „Kommentar mit N Antworten“ oder eine Zeile in einer eigenen Tabellenkomponente.

Der Notbehelf ist `querySelector`. Das funktioniert, doch das Ergebnis ist eine einfache Abfrage und kein Locator, sodass Sie automatische Wiederholungen und den Schutz durch den Strict-Modus verlieren.

[`locators.extend`](/api/browser/locators#custom-locators) <Version>3.2.0</Version> fügt einen domänenspezifischen Locator hinzu, ohne die Locator-API aufzugeben. Der von der Methode zurückgegebene Wert ist weiterhin ein Locator, sodass automatische Wiederholungen, der Schutz durch den Strict-Modus und Verkettung auch in Ihren eigenen Methoden erhalten bleiben. Die Namen, die Sie diesen Methoden geben, werden Teil des Testvokabulars Ihres Teams: `page.getByCard({ id: 'product-1' })` liest sich nach dem Produkt statt nach dem DOM, und derselbe Name taucht in der gesamten Suite einheitlich auf.

## Einen Playwright-String zurückgeben

Die einfachste Form gibt einen [Playwright-Locator-String](https://playwright.dev/docs/other-locators) zurück. Vitest behandelt den zurückgegebenen String als Kindabfrage desjenigen Locators, auf dem die Methode aufgerufen wurde: Beim Aufruf auf `page` wird der String gegen die gesamte Seite ausgeführt, beim Aufruf auf einem übergeordneten Locator eingeschränkt auf dessen Teilbaum.

Greifen Sie zu dieser Form, wenn sich die neue Abfrage mit eingebauten Locators nicht gut ausdrücken lässt – etwa ein CSS-mit-Text-Selektor für ein Widget, das auf keine eingebaute Rolle abbildet, oder ein XPath für eine Legacy-Komponente, über die Sie keine Kontrolle haben.

```ts
import { locators } from 'vitest/browser'

locators.extend({
  getByCommentsCount(count: number) {
    return `.comments :text("${count} comments")`
  },
})
```

```ts
import { expect, test } from 'vitest'
import { page } from 'vitest/browser'

test('article shows comment count', async () => {
  await expect.element(page.getByCommentsCount(1)).toBeVisible()
  await expect.element(
    page.getByRole('article', { name: 'Hello World' })
      .getByCommentsCount(1)
  ).toBeVisible()
})
```

## Bestehende Locators kombinieren

Wenn Sie statt eines Strings einen Locator zurückgeben, verwendet Vitest diesen Locator direkt. Innerhalb der Erweiterung ist `this` an den Locator gebunden, auf dem die Methode aufgerufen wurde (bzw. an `page` bei Aufrufen auf oberster Ebene), sodass Sie bestehende Locators verketten oder `filter` anwenden können, um Beziehungen zwischen Elementen auszudrücken, die keine einzelne eingebaute Option erfasst.

Das folgende Beispiel nutzt `filter({ has })`, um einen Zeilen-Locator auf jene Zeilen einzuschränken, die eine Schaltfläche mit einem bestimmten Namen enthalten, und kodiert damit ein verbreitetes Muster für Aktionen pro Zeile als eine einzige benannte Abfrage:

```ts
import { locators } from 'vitest/browser'
import type { Locator } from 'vitest/browser'

locators.extend({
  getRowWithAction(this: Locator, action: string) {
    return this.getByRole('row').filter({
      has: this.getByRole('button', { name: action }),
    })
  },
})
```

```ts
await page.getRowWithAction('Delete').first().click()
```

Bevorzugen Sie diese Variante gegenüber der Rohstring-Form, wenn sich die Abfrage mit beiden Optionen ausdrücken lässt. Eingebaute Locators kodieren Accessibility-bewusste Abfragen, und deren Verkettung oder Filterung bewahrt diese Garantien. Greifen Sie nur dann zur Rohstring-Form, wenn keine Kette eingebauter Locators die Abfrage abdeckt, denn der String führt genau den Selektor aus, den Sie geschrieben haben, und umgeht damit den Locator-Mechanismus, den Sie eigentlich beibehalten wollen.

## Eigene Interaktionen

Auch Methoden, die eine Interaktion ausführen, statt einen Locator zurückzugeben, funktionieren. Das ist derselbe Mechanismus, mit dem Sie Ihre eigene DSL aus Benutzeraktionen formen – definiert neben Ihren Abfragen, damit das Testvokabular einheitlich bleibt.

`locators.extend` typisiert `this` als `BrowserPage | Locator`, da eigene Methoden von beiden aus erreichbar sind. Für Abfrage-Helper ist das in Ordnung, denn `getByRole` und andere Abfragemethoden existieren auf beiden. Für Interaktions-Helper gilt das nicht: `page` besitzt weder `click` noch `fill`, sodass ein Aufruf von `page.clickAndFill('x')` zur Laufzeit fehlschlagen würde. Sichern Sie sich dagegen ab, indem Sie `this` mit dem `page`-Singleton vergleichen; das erlaubt TypeScript, `this` nach dem `throw` auf `Locator` einzugrenzen:

```ts
import { locators, page } from 'vitest/browser'
import type { BrowserPage, Locator } from 'vitest/browser'

locators.extend({
  async clickAndFill(this: BrowserPage | Locator, text: string) {
    if (this === page) {
      throw new TypeError(
        'clickAndFill must be called on a locator, like page.getByRole(\'textbox\').clickAndFill(...)',
      )
    }
    await this.click()
    await this.fill(text)
  },
})

await page.getByRole('textbox').clickAndFill('Hello World')
```

Interaktionsmethoden lassen sich nicht zu Selektoren zusammensetzen. `page.getByRole('textbox').clickAndFill('Hello')` funktioniert, weil `getByRole` einen Locator zurückgibt; `page.clickAndFill('Hello')` würde in die Absicherung laufen. Greifen Sie zu dieser Form für Aktions-Helper, nicht für Abfrage-Helper.

## Locator-Typen erweitern

`locators.extend` ist eine Registrierung zur Laufzeit. TypeScript weiß von den neuen Methoden nichts, bis Sie das Interface [`LocatorSelectors`](/api/browser/locators) erweitern, üblicherweise in einer gemeinsamen `.d.ts`-Datei:

```ts
import 'vitest/browser'

declare module 'vitest/browser' {
  interface LocatorSelectors {
    getByCommentsCount: (count: number) => Locator
    getRowWithAction: (action: string) => Locator
    clickAndFill: (text: string) => Promise<void>
  }
}
```

`LocatorSelectors` ist das Interface, das sowohl `Locator` als auch `BrowserPage` erweitern, sodass jede darauf deklarierte Methode auf beiden erscheint. Das entspricht dem, was `locators.extend` zur Laufzeit tut, und ist der Grund, warum Interaktions-Helper wie `clickAndFill` die obige Absicherung benötigen: TypeScript lässt `page.clickAndFill('x')` die Typprüfung passieren, doch die Absicherung fängt die Fehlanwendung ab, bevor sie auf eine fehlende Methode trifft.

## Siehe auch

- [API für eigene Locators](/api/browser/locators#custom-locators)
- [Eingebaute Locators](/api/browser/locators)
- [Playwright „other locators“](https://playwright.dev/docs/other-locators)
