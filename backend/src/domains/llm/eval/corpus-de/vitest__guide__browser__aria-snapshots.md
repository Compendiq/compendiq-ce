# ARIA-Snapshots <Experimental /> <Version>4.1.4</Version> {#aria-snapshots}

ARIA-Snapshots ermöglichen es Ihnen, die Barrierefreiheitsstruktur Ihrer Seiten zu testen. Statt gegen rohes HTML oder die visuelle Ausgabe zu prüfen, prüfen Sie gegen den Accessibility Tree – dieselbe Struktur, die Screenreader und andere assistive Technologien verwenden.

Gegeben sei dieses HTML:

```html
<nav aria-label="Main">
  <a href="/">Home</a>
  <a href="/about">About</a>
</nav>
```

Sie können dessen Accessibility Tree prüfen:

```ts
await expect.element(page.getByRole('navigation')).toMatchAriaInlineSnapshot(`
  - navigation "Main":
    - link "Home":
      - /url: /
    - link "About":
      - /url: /about
`)
```

Das deckt Regressionen bei der Barrierefreiheit auf: fehlende Labels, kaputte Rollen, falsche Überschriftenebenen und mehr – Dinge, die DOM-Snapshots übersehen würden. Selbst wenn sich die zugrundeliegende HTML-Struktur ändert, schlägt die Assertion nicht fehl, solange der Inhalt semantisch übereinstimmt.

Für fortgeschrittene Fälle können Sie den ARIA-Baum auch über `utils.aria` aus `vitest/browser` erzeugen und untersuchen. Details finden Sie in der [Context-API](/api/browser/context#aria).

## Snapshot-Workflow

ARIA-Snapshots verwenden denselben Vitest-Snapshot-Workflow wie andere Snapshot-Assertions. Datei-Snapshots, Inline-Snapshots, `--update` / `-u`, Aktualisierungen im Watch-Modus und das Snapshot-Verhalten in der CI funktionieren alle auf dieselbe Weise.

Den allgemeinen Snapshot-Workflow, das Aktualisierungsverhalten und Richtlinien zur Durchsicht finden Sie im [Snapshot-Leitfaden](/guide/snapshot).

## Grundlegende Verwendung

Gegeben sei eine Seite mit diesem HTML:

```html
<form aria-label="Log In">
  <input aria-label="Email" />
  <input aria-label="Password" type="password" />
  <button>Submit</button>
</form>
```

### Datei-Snapshots

Verwenden Sie `toMatchAriaSnapshot()`, um den Snapshot in einer `.snap`-Datei neben Ihrem Test abzulegen:

```ts [basic.test.ts]
import { expect, test } from 'vitest'

test('login form', async () => {
  await expect.element(page.getByRole('form')).toMatchAriaSnapshot()
})
```

Beim ersten Lauf erzeugt Vitest einen Eintrag in der Snapshot-Datei:

```js [__snapshots__/basic.test.ts.snap]
// Vitest Snapshot ...

exports[`login form 1`] = `
- form "Log In":
  - textbox "Email"
  - textbox "Password"
  - button "Submit"
`
```

### Inline-Snapshots

Verwenden Sie `toMatchAriaInlineSnapshot()`, um den Snapshot direkt in der Testdatei abzulegen:

```ts
import { expect, test } from 'vitest'

test('login form', async () => {
  await expect.element(page.getByRole('form')).toMatchAriaInlineSnapshot(`
    - form "Log In":
      - textbox "Email"
      - textbox "Password"
      - button "Submit"
  `)
})
```

## Retry-Verhalten im Browser-Modus

Im [Browser-Modus](/guide/browser/) pollt `expect.element()` das DOM und wartet, bis sich der Accessibility Tree **stabilisiert** hat, bevor das Ergebnis ausgewertet wird. Bei jedem Poll fragt der Matcher das Element erneut ab und erfasst den Accessibility Tree neu. Der Snapshot gilt als stabil, wenn zwei aufeinanderfolgende Polls dieselbe Ausgabe liefern.

```ts
await expect.element(page.getByRole('form')).toMatchAriaInlineSnapshot(`
  - form "Log In":
    - textbox "Email"
    - textbox "Password"
    - button "Submit"
`)
```

Beim ersten Lauf oder mit `--update` wird das stabile Ergebnis als neuer Snapshot geschrieben.

Liegt bereits ein Snapshot vor, prüft der Matcher zusätzlich, ob das stabile Ergebnis übereinstimmt. Ist das nicht der Fall, wird das Polling zurückgesetzt und fortgesetzt – so bekommt das DOM Zeit, den erwarteten Zustand zu erreichen. Damit werden Fälle wie Animationen, asynchrones Rendering oder verzögerte Zustandsänderungen abgedeckt, bei denen sich der Baum kurzzeitig in einem Zwischenzustand stabilisieren kann, bevor er seine endgültige Form annimmt.

## Handbearbeitete Muster erhalten

Wenn Sie einen Snapshot von Hand bearbeiten, um Regex-Muster zu verwenden, überstehen diese Muster ein `--update`. Nur die literalen Teile, die sich geändert haben, werden überschrieben. So können Sie flexible Assertions schreiben, die nicht brechen, wenn sich Inhalte ändern.

### Beispiel

**Schritt 1.** Ihre Warenkorbseite rendert dieses HTML:

```html
<h1>Your Cart</h1>
<ul aria-label="Cart Items">
  <li>Wireless Headphones — $79.99</li>
</ul>
<button>Checkout</button>
```

Sie führen Ihren Test zum ersten Mal mit `--update` aus. Vitest erzeugt den Snapshot:

```yaml
- heading "Your Cart" [level=1]
- list "Cart Items":
    - listitem: Wireless Headphones — $79.99
- button "Checkout"
```

**Schritt 2.** Die Artikelnamen und Preise sind Seed-Testdaten, die sich ändern können. Sie bearbeiten diese Zeilen von Hand zu Regex-Mustern, behalten die stabile Struktur aber als Literale bei:

```yaml
- heading "Your Cart" [level=1]
- list "Cart Items":
    - listitem: /.+ — \$\d+\.\d+/
- button "Checkout"
```

**Schritt 3.** Später benennt ein Entwickler den Button von "Checkout" in "Place Order" um. Ein `--update` aktualisiert dieses Literal, erhält aber Ihre Regex-Muster:

```yaml
- heading "Your Cart" [level=1]
- list "Cart Items":
    - listitem: /.+ — \$\d+\.\d+/
- button "Place Order"   👈 New snapshot updated with new string
```

Die Regex-Muster, die Sie in Schritt 2 geschrieben haben, bleiben erhalten, weil sie weiterhin auf den tatsächlichen Inhalt passen. Nur das nicht übereinstimmende Literal "Checkout" wurde zu "Place Order" aktualisiert.

## Snapshot-Format

ARIA-Snapshots verwenden eine YAML-ähnliche Syntax. Jede Zeile steht für einen Knoten im Accessibility Tree.

::: info
ARIA-Snapshot-Templates verwenden eine **Teilmenge der YAML**-Syntax. Unterstützt werden nur die Funktionen, die für Accessibility Trees nötig sind: skalare Werte, verschachtelte Mappings über Einrückung und Sequenzen (`- item`). Fortgeschrittene YAML-Funktionen wie Anker, Tags, Flow-Collections und mehrzeilige Skalare werden nicht unterstützt.

Erfasster Text wird zudem in Bezug auf Leerraum normalisiert, bevor er in den Snapshot gerendert wird. Zeilenumbrüche, `<br>`-Umbrüche, Tabulatoren und wiederholter Leerraum werden zu einzelnen Leerzeichen zusammengefasst, sodass mehrzeiliger DOM-Text als einzeiliger Snapshot-Wert ausgegeben wird.
:::

Jedes zugängliche Element im Baum wird als YAML-Knoten dargestellt:

```yaml
- role "name" [attribute=value]
```

- `role`: die ARIA-Rolle des Elements, etwa `heading`, `list`, `listitem` oder `button`
- `"name"`: der [zugängliche Name](https://w3c.github.io/accname/), sofern vorhanden. Zeichenketten in Anführungszeichen entsprechen exakten Werten, `/patterns/` entsprechen regulären Ausdrücken
- `[attribute=value]`: Zustände und Eigenschaften der Barrierefreiheit wie `checked`, `disabled`, `expanded`, `level`, `pressed` oder `selected`

Diese Werte stammen aus ARIA-Attributen und dem Accessibility Tree des Browsers, einschließlich der Semantik, die aus nativen HTML-Elementen abgeleitet wird.

Da ARIA-Snapshots den Accessibility Tree des Browsers widerspiegeln, erscheinen Inhalte, die aus diesem Baum ausgeschlossen sind, etwa durch `aria-hidden="true"` oder `display: none`, nicht im Snapshot.

### Rollen und zugängliche Namen

Zum Beispiel:

```html
<button>Submit</button>
<h1>Welcome</h1>
<a href="/">Home</a>
<input aria-label="Email" />
```

```yaml
- button "Submit"
- heading "Welcome" [level=1]
- link "Home"
- textbox "Email"
```

Die Rolle ergibt sich üblicherweise aus der nativen Semantik des Elements, sie kann aber auch über ARIA definiert werden. Der zugängliche Name wird aus dem Textinhalt, zugeordneten Labels, `aria-label`, `aria-labelledby` und verwandten Benennungsregeln berechnet.

Einen genaueren Blick darauf, wie Namen berechnet werden, bietet [Accessible Name and Description Computation](https://w3c.github.io/accname/).

Manche Inhalte erscheinen im Snapshot als Textknoten statt als rollenbasiertes Element:

```html
<span>Hello world</span>
```

```yaml
- text: Hello world
```

Textwerte werden nach der Leerraumnormalisierung stets in einer einzelnen Zeile serialisiert. Zum Beispiel:

```html
<p>
Line 1
Line 2<br />Line 3
Line 4
</p>
```

```yaml
- paragraph: Line 1 Line 2 Line 3 Line 4
```

### Kindelemente

Kindelemente erscheinen eingerückt unter ihrem Elternelement:

```html
<ul>
  <li>First</li>
  <li>Second</li>
  <li>Third</li>
</ul>
```

```yaml
- list:
    - listitem: First
    - listitem: Second
    - listitem: Third
```

Hat das Elternelement einen zugänglichen Namen, enthält der Snapshot ihn vor den verschachtelten Kindelementen:

```html
<nav aria-label="Main">
  <a href="/">Home</a>
  <a href="/about">About</a>
</nav>
```

```yaml
- navigation "Main":
    - link "Home"
    - link "About"
```

Enthält ein Element nur ein einzelnes Textkind und hat keine weiteren Eigenschaften, wird der Text inline gerendert:

```html
<p>Hello world</p>
```

```yaml
- paragraph: Hello world
```

### Attribute

ARIA-Zustände und -Eigenschaften erscheinen in eckigen Klammern:

| HTML                                                                   | Snapshot                                  |
| ---------------------------------------------------------------------- | ----------------------------------------- |
| `<input type="checkbox" checked aria-label="Agree">`                   | `- checkbox "Agree" [checked]`            |
| `<input type="checkbox" aria-checked="mixed" aria-label="Select all">` | `- checkbox "Select all" [checked=mixed]` |
| `<button aria-disabled="true">Submit</button>`                         | `- button "Submit" [disabled]`            |
| `<button aria-expanded="true">Menu</button>`                           | `- button "Menu" [expanded]`              |
| `<h2>Title</h2>`                                                       | `- heading "Title" [level=2]`             |
| `<button aria-pressed="true">Bold</button>`                            | `- button "Bold" [pressed]`               |
| `<button aria-pressed="mixed">Bold</button>`                           | `- button "Bold" [pressed=mixed]`         |
| `<option selected>English</option>`                                    | `- option "English" [selected]`           |

Attribute erscheinen nur, wenn sie aktiv sind. Ein Button, der nicht deaktiviert ist, hat schlicht kein Attribut `[disabled]` – es gibt kein `[disabled=false]`.

### Pseudo-Attribute

Einige DOM-Eigenschaften, die nicht Teil von ARIA, aber zum Testen nützlich sind, werden mit einem Präfix `/` bereitgestellt:

#### `/url:`

Links enthalten ihre URL:

```html
<a href="/">Home</a>
```

```yaml
- link "Home":
    - /url: /
```

#### `/placeholder:`

Textfelder können ihren Platzhaltertext enthalten:

```html
<input aria-label="Email" placeholder="user@example.com" />
```

```yaml
- textbox "Email":
    - /placeholder: user@example.com
```

::: tip Wann erscheint `/placeholder:`?

Das Pseudo-Attribut `/placeholder:` erscheint nur, wenn sich der Platzhaltertext **vom zugänglichen Namen unterscheidet**. Hat ein Eingabefeld einen Platzhalter, aber kein `aria-label` und kein zugeordnetes `<label>`, verwendet der Browser den Platzhalter als zugänglichen Namen. In diesem Fall steckt die Platzhalterinformation bereits im Namen und wird nicht dupliziert.

- Wenn der Platzhalter der zugängliche Name ist:

```html
<input placeholder="Search" />
```

```yaml
- textbox "Search"
```

- Wenn sich der Platzhalter vom zugänglichen Namen unterscheidet:

```html
<input placeholder="Search" aria-label="Search products" />
```

```yaml
- textbox "Search products":
    - /placeholder: Search
```

:::

## Abgleich

### Reguläre Ausdrücke

Verwenden Sie Regex-Muster, um Namen flexibel abzugleichen:

```html
<h1>Welcome, Alice</h1>
<a href="https://example.com/profile/123">Profile</a>
```

```yaml
- heading /Welcome, .*/
- link "Profile":
    - /url: /https:\/\/example\.com\/.*/
```

Regex funktioniert auch in Werten von Pseudo-Attributen:

```html
<input aria-label="Search" placeholder="Type to search..." />
```

```yaml
- textbox "Search":
    - /placeholder: /Type .*/
```

::: warning Backslashes in Regex-Mustern escapen
Snapshots werden als JavaScript-Strings gespeichert – bei Inline-Snapshots in Template-Literalen mit Backticks und in `.snap`-Dateien. Deshalb müssen Backslashes **verdoppelt** werden, wenn Sie einen Snapshot von Hand um ein Regex-Muster ergänzen.

Um zum Beispiel eine oder mehrere Ziffern mit `\d+` abzugleichen:

```ts
// ✅ Correct — double backslash
await expect.element(button).toMatchAriaInlineSnapshot(`
  - button: /item \\d+/
`)

// ❌ Wrong — single backslash is consumed by JS, regex sees "d+" instead of "\d+"
await expect.element(button).toMatchAriaInlineSnapshot(`
  - button: /item \d+/
`)
```

Das gilt sowohl für Inline-Snapshots als auch für `.snap`-Dateien. Wenn Vitest einen Snapshot **automatisch erzeugt** oder **aktualisiert**, wird das Escaping automatisch übernommen – darum müssen Sie sich nur beim Bearbeiten von Regex-Mustern von Hand kümmern.
:::

### Abgleich von Kindelementen

Die Direktive `/children` steuert, wie die Kindelemente eines Knotens mit dem Template verglichen werden. Es gibt drei Modi:

#### Teilweiser Abgleich (Standard)

Standardmäßig (ohne `/children`-Direktive) verwenden Templates **contain**-Semantik – zusätzliche Kindelemente im tatsächlichen Baum sind zulässig, solange alle Template-Kindelemente als geordnete Teilfolge auftreten. Das entspricht `/children: contain`.

```html
<main>
  <h1>Welcome</h1>
  <p>Some intro text</p>
  <button>Get Started</button>
</main>
```

```ts
// This passes — the template children are a subset of the actual children
await expect.element(page.getByRole('main')).toMatchAriaInlineSnapshot(`
  - main:
    - heading "Welcome" [level=1]
`)
```

Das ist nützlich für fokussierte, robuste Tests, die nicht brechen, wenn unabhängige Inhalte hinzukommen.

#### Exakter Abgleich (`/children: equal`)

Verlangt, dass die unmittelbaren Kindelemente des Knotens exakt dem Template entsprechen – gleiche Anzahl, gleiche Reihenfolge. Auf dieser Ebene sind keine zusätzlichen Kindelemente zulässig.

```html
<ul aria-label="Features">
  <li>Feature A</li>
  <li>Feature B</li>
  <li>Feature C</li>
</ul>
```

```ts
// This FAILS — the list has 3 items but the template only lists 2
await expect.element(page.getByRole('list')).toMatchAriaInlineSnapshot(`
  - list "Features":
    - /children: equal
    - listitem: Feature A
    - listitem: Feature B
`)
```

```ts
// This PASSES — all 3 items are listed
await expect.element(page.getByRole('list')).toMatchAriaInlineSnapshot(`
  - list "Features":
    - /children: equal
    - listitem: Feature A
    - listitem: Feature B
    - listitem: Feature C
`)
```

Der strikte Abgleich gilt nur auf der Ebene, auf der `/children` steht. Nachfahren jedes `listitem` verwenden weiterhin die standardmäßige contain-Semantik.

#### Tiefer exakter Abgleich (`/children: deep-equal`)

Wie `equal`, allerdings **überträgt sich der strikte Abgleich auf alle Nachfahren**. Jede Verschachtelungsebene muss exakt übereinstimmen – gleiche Anzahl, gleiche Reihenfolge, keine zusätzlichen Knoten in irgendeiner Tiefe.

```ts
await expect.element(page.getByRole('navigation')).toMatchAriaInlineSnapshot(`
  - navigation "Main":
    - /children: deep-equal
    - link "Home":
      - /url: /
    - link "About":
      - /url: /about
`)
```

Mit `deep-equal` muss auch jedes Kind jedes `link` exakt übereinstimmen. Hätte ein Link einen zusätzlichen Kindknoten, der nicht im Template aufgeführt ist, würde die Assertion fehlschlagen.

#### Vergleich

| Modus | Direktive | Verhalten |
| --- | --- | --- |
| Teilweise | _(Standard)_ oder `/children: contain` | Template-Kindelemente sind eine geordnete Teilfolge – zusätzliche tatsächliche Kindelemente werden ignoriert |
| Exakt | `/children: equal` | Unmittelbare Kindelemente müssen exakt übereinstimmen; Nachfahren verwenden weiterhin teilweisen Abgleich |
| Tief exakt | `/children: deep-equal` | Alle Kindelemente in jeder Tiefe müssen exakt übereinstimmen |
