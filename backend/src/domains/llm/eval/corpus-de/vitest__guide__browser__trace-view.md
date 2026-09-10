# Trace View <Badge type="warning" text="Experimental" /> <Version>5.0.0</Version>

`browser.traceView` zeichnet Browser-Interaktionen als DOM-Snapshots auf und lässt Sie diese im eingebauten Trace-Viewer von Vitest Schritt für Schritt abspielen. Das ist nützlich, wenn die Live-Ansicht des Browsers nicht ausreicht: Sie können frühere Tests, fehlgeschlagene Wiederholungen, Screenshots, Assertions und Nutzeraktionen inspizieren, nachdem der Browser bereits weitergelaufen ist.

Trace View ergänzt den bestehenden Workflow für Browser-Tests. Das Aktivieren erzwingt keinen bestimmten Debugging-Modus. Sie können es mit der normalen lokalen Browser-UI, mit einem Headless-Browser plus Vitest UI oder mit dem HTML-Reporter in der CI verwenden.

::: tip Trace View, Browser-UI und HTML-Berichte

Der normale lokale Browser-Modus öffnet die [Browser-UI](/config/browser/ui), in der Tests in einem sichtbaren Iframe laufen. Das ist beim Entwickeln nützlich, aber der Iframe zeigt nur den aktuellen Browserzustand. Sobald ein anderer Test läuft, ist der zuvor gerenderte Zustand verschwunden.

`browser.traceView` behält für jeden Test eine abspielbare Aufzeichnung. Im lokalen Browser-UI-Modus erscheint der Trace-Viewer neben der bestehenden Live-Ansicht, sodass Sie die Browser-UI weiterhin nutzen und zugleich die aufgezeichneten Schritte inspizieren können.

Für eine statische Ausgabe ergänzen Sie den [HTML-Reporter](/guide/reporters#html-reporter). Derselbe Trace-Viewer lässt sich dann aus dem erzeugten Bericht öffnen, was bei Fehlschlägen im Run-Modus und in der CI hilfreich ist.

:::

::: details Suchen Sie Playwright-Traces?

Diese Seite dokumentiert nun die eingebaute Funktion `browser.traceView` von Vitest. Der frühere Leitfaden `browser.trace` für Playwright-Traces ist nach [Playwright Traces](./playwright-traces) umgezogen.

:::

## Schnellstart

Aktivieren Sie Trace View mit der Option [`browser.traceView`](/config/browser/traceview):

::: code-group

```ts [vitest.config.ts]
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    browser: {
      traceView: true,
    },
  },
})
```

```bash [CLI]
vitest --browser.traceView
```

:::

Wenn `browser.traceView` aktiviert ist, lassen sich Tests mit aufgezeichneten Traces aus der [Browser-UI](/config/browser/ui), der [Vitest UI](/guide/ui) und dem [HTML-Reporter](/guide/reporters#html-reporter) heraus im Trace-Viewer öffnen. Der Viewer hat zwei in der Größe veränderbare Bereiche:

- **Schrittliste** (links) — jede aufgezeichnete Aktion, Assertion, Markierung und jeder Lifecycle-Eintrag, mit Name, Zeitangaben, Selektor und Quellcode-Position. Fehlgeschlagene Aktionen und Assertions werden rot hervorgehoben.
- **DOM-Snapshot** (rechts) — eine Rekonstruktion der Seite zum ausgewählten Schritt. Das Element, mit dem interagiert wurde, ist blau hervorgehoben.

Beim Auswählen eines Schritts wird zudem dessen Quellcode-Position im Editor-Tab geöffnet, sofern diese verfügbar ist.

<img alt="Vitest UI trace viewer showing step list and DOM snapshot" img-light src="/browser/trace-view-light.png">
<img alt="Vitest UI trace viewer showing step list and DOM snapshot" img-dark src="/browser/trace-view-dark.png">

<small>Das Beispiel-Replay verwendet die Komponente `VDateInput` von [Vuetify](https://github.com/vuetifyjs/vuetify).</small>


## Übliche Setups

<!--
TODO: The browser UI / Vitest UI / browser driver combinations are not specific to trace view and might be better documented in the Browser Mode guide.  Something like:

  | top-level --ui | browser.ui | browser.headless | Result |
  | --- | --- | --- | --- |
  | off | true | false | browser UI/live iframe in headed browser |
  | on | false | true | pure Vitest UI, tests in headless browser |
  | on | false | false | pure Vitest UI, tests in separate headed browser window |

-->

`browser.traceView` zeichnet Traces auf. Die Optionen für Browsermodus, UI und Reporter bestimmen, wo Sie sie inspizieren.

| Ziel | Konfiguration | Ergebnis |
| --- | --- | --- |
| Trace-Replay zur normalen lokalen Browser-UI hinzufügen | `vitest --browser.traceView` | Verwendet die standardmäßige lokale Browser-UI mit sichtbarem Browser und ergänzt Trace-Replay für aufgezeichnete Tests. |
| Lokal mit einem Headless-Browser debuggen | `vitest --browser.traceView --browser.headless --ui` | Der Browser läuft headless, während die Vitest UI die aufgezeichneten Trace-Schritte und Snapshots anzeigt. |
| Lokal mit sichtbarem Browserfenster und Vitest UI debuggen | `vitest --browser.traceView --browser.headless=false --browser.ui=false --ui` | Die Vitest UI zeigt die aufgezeichneten Trace-Schritte und Snapshots, während die Tests in einem separaten sichtbaren Browserfenster laufen. |
| Einen statischen Bericht für CI oder Run-Modus erzeugen | `vitest run --browser.traceView --reporter=html` | Der HTML-Bericht enthält den Trace-Viewer für aufgezeichnete Tests. |

## Verhältnis zu Playwright-Traces

`browser.traceView` und [`browser.trace`](/config/browser/trace) sind voneinander unabhängige Funktionen:

|                        | `browser.traceView`                                       | `browser.trace`                                |
| ---------------------- | --------------------------------------------------------- | ---------------------------------------------- |
| Provider-Unterstützung | Alle Provider (playwright, webdriverio, preview)          | Nur Playwright                                 |
| Viewer                 | Browser-UI / Vitest UI / HTML-Reporter                    | Playwright Trace Viewer / trace.playwright.dev |
| Format                 | [rrweb](https://github.com/rrweb-io/rrweb)-DOM-Snapshots | Playwright `.trace.zip`                        |
| Externes Werkzeug nötig | Nein                                                      | Ja (`npx playwright show-trace`)               |

Sie können beide gleichzeitig aktivieren. Zum Workflow mit `browser.trace` siehe [Playwright Traces](./playwright-traces).

## Aufgezeichnete Schritte

Trace-Einträge werden automatisch aufgezeichnet für:

- `expect.element(...)`-Assertions
- Interaktive Aktionen wie `click`, `dblClick`, `tripleClick`, `fill`, `clear`, `type`, `hover`, `selectOptions`, `upload`, `dragAndDrop`, `tab`, `keyboard`, `wheel` sowie Screenshots
- Lifecycle-Ereignisse des Test-Runners (z. B. wird `vitest:onAfterRetryTask` nach jedem Test- und Wiederholungslauf aufgezeichnet)

Jeder Eintrag erfasst den DOM-Zustand zu diesem Zeitpunkt sowie Zeitangaben, den Selektor und die auslösende Quellcode-Position.

In der Vitest UI werden Trace-Einträge während des Testlaufs gestreamt, sodass Sie aufgezeichnete Schritte bereits vor Testende inspizieren können. Lang laufende Aktionen, `expect.element(...)`-Assertions und Callback-Einträge von `page.mark()` erscheinen zunächst als laufende Schritte und werden anschließend mit ihrem endgültigen Status und ihrer Dauer aktualisiert.

## Eigene Trace-Einträge

Mit `page.mark()` und `locator.mark()` können Sie eigene benannte Einträge einfügen:

```ts
import { page } from 'vitest/browser'

await page.mark('content rendered')

await page.getByRole('button', { name: 'Sign in' }).mark('sign in button')
```

Sie können `page.mark()` auch einen Callback übergeben. Beachten Sie, dass Gruppierung derzeit nicht unterstützt wird — jede innere Aktion wird einzeln aufgezeichnet, und der Markierungseintrag erscheint am Ende:

```ts
await page.mark('sign in flow', async () => {
  await page.getByRole('textbox', { name: 'Email' }).fill('john@example.com')
  await page.getByRole('textbox', { name: 'Password' }).fill('secret')
  await page.getByRole('button', { name: 'Sign in' }).click()
})
```

Verwenden Sie [`vi.defineHelper()`](/api/vi#vi-defineHelper), damit Einträge aus wiederverwendbaren Helfern auf die Aufrufstelle statt auf das Innenleben des Helfers zeigen:

```ts
import { vi } from 'vitest'
import { page } from 'vitest/browser'

const renderContent = vi.defineHelper(async (html: string) => {
  document.body.innerHTML = html
  await page.elementLocator(document.body).mark('render')
})

test('shows button', async () => {
  await renderContent('<button>Hello</button>') // trace entry points here
})
```

## Wiederholungen und Repeats

Jeder Versuch — Retry oder Repeat — wird als eigener Trace aufgezeichnet. Hat ein Test mehrere Versuche, öffnet der Viewer standardmäßig den jüngsten. Im Report-Tab können Sie zwischen den Versuchen wechseln.

## Snapshot-Genauigkeit

Standardmäßig erfasst Trace View den DOM-Baum, Attribute, Formularwerte, lesbares Same-Origin-CSS, Scrollpositionen von Elementen, die Viewport-Größe und die Scrollposition des Fensters. Bild- und Canvas-Pixel werden standardmäßig nicht eingebettet.

Stylesheets werden über das CSSOM des Browsers erfasst. Lesbare `<style>`-Tags und Same-Origin-`<link rel="stylesheet">`-Dateien werden in den Snapshot serialisiert und als Inline-Styles abgespielt, sodass normale Komponenten-Styles im Trace-Viewer und im HTML-Reporter weiterhin funktionieren. Erfasst werden dabei die geparsten CSS-Regeln, die der Browser angewendet hat, nicht die exakten ursprünglichen Stylesheet-Bytes: Kommentare, Formatierung, ungültige Regeln sowie CSS-Ressourcendateien wie Hintergrundbilder oder Schriften werden auf diesem Weg nicht mitgebündelt.

Zusätzliche Genauigkeitsoptionen aktivieren Sie über die Objektform:

```ts
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    browser: {
      traceView: {
        enabled: true,
        inlineImages: true,
        recordCanvas: true,
      },
    },
  },
})
```

`inlineImages` speichert die Pixel geladener `<img>`-Elemente im Trace-Snapshot. Das ist vor allem für den HTML-Reporter nützlich, wo der Bericht portabel sein soll, ohne von externen Bild-URLs abzuhängen. Es handelt sich um eine Pixel-Erfassung, nicht um eine Erfassung der Originalressource: SVGs werden gerastert, animierte Bilder bleiben nicht als Animationen erhalten, und CSS-Hintergrundbilder oder Schriften sind nicht abgedeckt. Bilder von fremden Ursprüngen benötigen per CORS lesbare Pixel, um eingebettet zu werden; andernfalls können sie weiterhin über die externe URL gerendert werden, sofern diese erreichbar bleibt.

`recordCanvas` speichert lesbare Canvas-Pixel im Trace-Snapshot. Das ist für Diagramme und einfache 2D-Canvas-Ausgaben nützlich, stellt aber keine vollständige Zeitleiste der Canvas-Zeichenoperationen dar und bietet kein vollständiges WebGL-Replay.

### Grenzen bei externen Ressourcen

Trace View bietet derzeit keinen allgemeinen Ressourcenspeicher. Ressourcen, die nicht in den Snapshot übernommen werden, bleiben URL-gestützt.

Das bedeutet: CSS-Hintergrundbilder und `@font-face`-Dateien, die aus serialisiertem CSS referenziert werden, hängen weiterhin von ihren ursprünglichen URLs ab. Externe Bilder können im Viewer weiterhin gerendert werden, wenn der Browser die URL laden kann, sind im HTML-Reporter aber nicht portabel, sofern `inlineImages` ihre Pixel nicht erfassen kann. Bilder von fremden Ursprüngen benötigen dafür per CORS lesbare Pixel; andernfalls kann der Browser sie zwar anzeigen, rrweb sie aber nicht gefahrlos in eine Canvas-Data-URL zeichnen.

Verwenden Sie `inlineImages` für geladene `<img>`-Elemente, die im HTML-Reporter portabel sein müssen. CSS-Subressourcen, Schriften, Cross-Origin-Bilder ohne CORS, Videos und andere externe Dateien bleiben Einschränkungen des aktuellen, Snapshot-basierten Trace-Formats.

::: warning Sandbox beim Canvas-Replay

`recordCanvas` aktiviert eine schwächere Iframe-Sandbox im Trace-Viewer. rrweb spielt Canvas-Daten über einen Image-Load-Handler ab, weshalb Vitest für Traces, die mit `recordCanvas` aufgezeichnet wurden, Skripte innerhalb des Replay-Iframes zulässt. Lassen Sie diese Option nur aktiviert, wenn Canvas-Pixel für das Debugging nützlich sind.

:::
