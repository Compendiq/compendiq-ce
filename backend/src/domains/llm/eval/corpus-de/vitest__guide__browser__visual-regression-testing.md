<script setup>
import MoonPhase from '../../.vitepress/components/MoonPhase.vue'
</script>

# Visuelle Regressionstests

Vitest kann visuelle Regressionstests ab Werk ausführen. Es nimmt Screenshots Ihrer UI-Komponenten und Seiten auf und vergleicht sie anschließend mit Referenzbildern, um unbeabsichtigte visuelle Änderungen zu erkennen.

Anders als funktionale Tests, die das Verhalten überprüfen, fangen visuelle Tests Styling-Probleme, Layout-Verschiebungen und Rendering-Fehler ab, die ohne gründliche manuelle Prüfung sonst unbemerkt blieben.

## Warum visuelle Regressionstests?

Visuelle Fehler werfen keine Exceptions – sie sehen einfach falsch aus. Genau hier kommen visuelle Tests ins Spiel.

- Diese Schaltfläche schickt das Formular noch immer ab … aber warum ist sie jetzt knallpink?
- Der Text passt perfekt … bis ihn jemand auf dem Smartphone ansieht
- Alles funktioniert bestens … abgesehen davon, dass diese beiden Container außerhalb des Viewports liegen
- Dieses sorgfältige CSS-Refactoring funktioniert … hat aber das Layout auf einer Seite zerlegt, die niemand testet

Visuelle Regressionstests wirken als Sicherheitsnetz für Ihre UI und fangen solche visuellen Änderungen automatisch ab, bevor sie in die Produktion gelangen.

## Beispiel

Visuelle Regressionstests lassen sich in Vitest über die [Assertion `toMatchScreenshot`](/api/browser/assertions#tomatchscreenshot) umsetzen:

```ts
import { expect, test } from 'vitest'
import { page } from 'vitest/browser'

test('button renders in default state', async () => {
  // render your component

  // capture and compare screenshot
  await expect(page.getByRole('button')).toMatchScreenshot()
})
```

## Erste Schritte

### Stabilität der Umgebung

Visuelle Regressionstests sind **empfindlich gegenüber Unterschieden in der Umgebung**, weil Rendering über Umgebungen hinweg nicht perfekt deterministisch ist und von mehreren Faktoren abhängt:

- GPU, Treiber und Hardwarebeschleunigung
- Betriebssystem
- Font-Rendering-Pipelines
- Browser, Browser-Versionen und Einstellungen
- Ob der Browser headless oder mit Oberfläche läuft
- Bildschirmskalierung, Farbprofile und Anzeigeeinstellungen
- … und gelegentlich das, was sich wie die Mondphase anfühlt <MoonPhase />

In der Praxis können selbst scheinbar identische Umgebungen gelegentlich subtile Rendering-Unterschiede erzeugen. Deshalb sind **visuelle Regressionstests am zuverlässigsten, wenn sie in einer standardisierten und streng kontrollierten Umgebung laufen**. Aus demselben Grund werden [Docker-Container](https://playwright.dev/docs/docker), [reine CI-Workflows für visuelle Tests oder Cloud-Dienste](#visual-testing-for-teams) nachdrücklich empfohlen.

### Kein Ersatz für Verhaltenstests

Wenn ein visueller Test zusammen mit Verhaltenstests fehlschlägt, ist schwerer zu erkennen, was tatsächlich kaputt ist und warum. Visuelle Fehlschläge sind bei bewusster UI-Arbeit außerdem zu erwarten, ein fehlschlagender Unit-Test in der Regel nicht. Beides getrennt zu halten sorgt dafür, dass jede Suite aus den richtigen Gründen laut fehlschlägt.

Es sei ausdrücklich gesagt, dass **`toMatchScreenshot` kein Ersatz für ordentliche Assertions ist**.

Ein Test, der eine Schaltfläche rendert und lediglich einen Screenshot aufnimmt, dokumentiert nur den aktuellen Zustand. Anhand eines Screenshots lässt sich nicht feststellen, ob Nutzende mit der Schaltfläche interagieren können. **Visuelle Tests funktionieren am besten als ergänzende Schicht über Verhaltenstests, nicht als deren Ersatz**.

Anders gesagt: **Visuelles Testen sagt Ihnen nicht, warum etwas so rendert, wie es rendert**. Es sagt Ihnen nur, dass etwas auf eine bestimmte Weise gerendert wurde – oder anders als beim letzten Mal.

Nehmen Sie als Beispiel die fachliche Anforderung, kürzliche Einkäufe in einer Tabelle nach Kaufdatum zu sortieren. Wenn Sie nur auf die visuellen Regressionstests blicken, fällt Ihnen vielleicht auf, dass dieselben Einträge wie beim letzten Test in einer anderen Reihenfolge stehen. Das kann daran liegen, dass Sie die Sortierung gerade eingeführt haben – oder daran, dass die Sortierung kaputt ist. So oder so wissen Sie allein durch den Blick auf die UI nicht, warum die Reihenfolge anders ist. Jemand könnte den visuellen Diff als Rauschen abtun, weil die Tabelle „gleich aussieht“, obwohl die Sortierlogik nun kaputt ist. Damit haben Sie eine gebrochene fachliche Anforderung in der Produktion.

### Projektstruktur

Ihre visuelle Suite von den übrigen Tests zu trennen liefert Ihnen sauberere Fehlersignale und einen bewussteren Update-Workflow. Das empfohlene Setup verwendet [Projekte](/guide/projects) mit einer Namenskonvention `[name].vrt.test.[ext]`, um sie abzugrenzen, und führt sie der Konsistenz halber headless aus. Da die Browser-Instanz eine andere Standardgröße haben kann, wird zudem eine bestimmte Viewport-Größe gesetzt.

```ts [vitest.config.ts]
import { defaultExclude, defineConfig } from 'vitest/config'

const vrtPattern = '**/*.vrt.test.[tj]s?(x)'

export default defineConfig({
  test: {
    // ...other configurations
    projects: [
      {
        test: {
          name: 'unit',
          exclude: [vrtPattern, ...defaultExclude],
        },
      },
      {
        test: {
          name: 'vrt',
          browser: {
            headless: true,
            instances: [
              {
                browser: '[browser-name]',
                viewport: { width: 1280, height: 720 },
              },
            ],
          },
          include: [vrtPattern],
        },
      },
    ],
  },
})
```

Mit dieser Konfiguration fügen Sie Skripte hinzu, um jedes Projekt separat zu starten:

```json [package.json]
{
  "scripts": {
    "test:unit": "vitest --project unit",
    "test:visual": "vitest --project vrt"
  }
}
```

### Referenzen erstellen

Wenn Sie einen visuellen Test zum ersten Mal ausführen, erstellt Vitest einen Referenz-Screenshot (auch Baseline genannt) und lässt den Test mit der folgenden Fehlermeldung fehlschlagen:

```
expect(element).toMatchScreenshot()

No existing reference screenshot found; a new one was created. Review it before running tests again.

Reference screenshot:
  tests/__screenshots__/button.vrt.test.ts/button-default-state-chromium-darwin.png
```

Das ist normal. Prüfen Sie, ob der Screenshot korrekt aussieht, und führen Sie den Test erneut aus. Vitest vergleicht künftige Läufe nun mit dieser Baseline.

::: tip
Referenz-Screenshots liegen in `__screenshots__`-Ordnern neben Ihren Tests. **Checken Sie sie in Ihr Repository ein.**
:::

### Organisation der Screenshots

Standardmäßig werden Screenshots so organisiert:

```
.
├── __screenshots__
│   └── test-file.vrt.test.ts
│       ├── test-name-chromium-darwin.png
│       ├── test-name-firefox-linux.png
│       └── test-name-webkit-win32.png
└── test-file.vrt.test.ts
```

Die Namenskonvention umfasst:
- **Testname**: entweder das erste Argument des Aufrufs `toMatchScreenshot()` oder automatisch aus dem Namen des Tests erzeugt.
- **Browser-Name**: hängt vom konfigurierten Browser-Provider ab, zum Beispiel `chrome`, `chromium`, `firefox` oder `webkit`.
- **Plattform**: `aix`, `darwin`, `freebsd`, `linux`, `openbsd`, `sunos` oder `win32`.

So überschreiben sich Screenshots aus unterschiedlichen Umgebungen nicht gegenseitig.

### Referenzen aktualisieren

Wenn Sie Ihre UI absichtlich ändern, müssen Sie die Referenz-Screenshots aktualisieren, genau wie Sie Snapshots aktualisieren würden:

```bash
$ vitest --project vrt --update
```

Prüfen Sie aktualisierte Screenshots vor dem Commit, um sicherzustellen, dass die Änderungen beabsichtigt sind.

::: warning Veraltete Screenshots
Beachten Sie, dass **Screenshots gelöschter oder umbenannter Tests nicht automatisch entfernt werden**. Räumen Sie den Ordner `__screenshots__` manuell auf, wenn Sie Tests entfernen oder umbenennen, sonst sammeln sich mit der Zeit veraltete Referenzen an.
:::

### Fehlgeschlagene Tests debuggen

Wenn ein visueller Test fehlschlägt, liefert Vitest drei Bilder zur Fehlersuche:

1. **Referenz-Screenshot**: das erwartete Baseline-Bild
1. **Tatsächlicher Screenshot**: was während des Tests aufgenommen wurde
1. **Diff-Bild**: hebt die Unterschiede hervor; wird nur erzeugt, wenn die Screenshots dieselben Abmessungen haben (das Verhalten kann bei eigenen Matchern abweichen)

In der CLI-Ausgabe sehen Sie etwa Folgendes:

```
expect(element).toMatchScreenshot()

Screenshot does not match the stored reference.
245 pixels (ratio 0.03) differ.

Reference screenshot:
  tests/__screenshots__/button.vrt.test.ts/button-chromium-darwin.png

Actual screenshot:
  tests/.vitest/attachments/button.vrt.test.ts/button-chromium-darwin-actual.png

Diff image:
  tests/.vitest/attachments/button.vrt.test.ts/button-chromium-darwin-diff.png
```

Im UI-Modus zeigt Vitest eine Diff-Ansicht mit Tabs und einem A/B-Schieberegler, wie unten dargestellt.

<center>
  <img alt="Animated demo of the visual regression diff view, switching tabs and using the slider to reveal differences" img-light src="/visual-regression/diff-view-light.avif">
  <img alt="Animated demo of the visual regression diff view, switching tabs and using the slider to reveal differences" img-dark src="/visual-regression/diff-view-dark.avif">

  <sup>Ein Beispiel der Diff-UI für visuelle Regressionen mit den Tabs „Diff“, „Reference“, „Actual“ und „Slider“ sowie der Darstellung, wie der Schieberegler unerwartete visuelle Änderungen in einer Komponente sichtbar macht.</sup>
</center>

#### Das Diff-Bild verstehen

- **Rote Pixel** sind Bereiche, die sich zwischen Referenz und Ist unterscheiden
- **Gelbe Pixel** sind Unterschiede beim Anti-Aliasing (wenn Anti-Aliasing nicht ignoriert wird)
- **Transparente/originale** Bereiche sind unverändert

:::tip
Ist der Diff überwiegend rot, stimmt wirklich etwas nicht. Ist er nur mit ein paar roten Pixeln rund um Text gesprenkelt, müssen Sie vermutlich nur Ihren Schwellwert anheben.
:::

## Die Assertion `toMatchScreenshot` konfigurieren

Die Assertion `toMatchScreenshot` lässt sich sowohl global – durch Ändern ihrer Standardoptionen – als auch pro Test konfigurieren.

Um die Standardwerte zu ändern, passen Sie die [Vitest-Konfiguration](/config/browser/expect#tomatchscreenshot) an:

```ts{6-16} [vitest.config.ts]
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    browser: {
      expect: {
        toMatchScreenshot: {
          comparatorName: 'pixelmatch',
          comparatorOptions: {
            // 0-1, how different can colors be?
            threshold: 0.2,
            // 1% of pixels can differ
            allowedMismatchedPixelRatio: 0.01,
          },
        },
      },
    },
  },
})
```

Für feinere Kontrolle überschreiben Sie die globalen Einstellungen in einzelnen Tests, indem Sie die Optionen direkt an die Assertion übergeben:

```ts{2-6}
await expect(element).toMatchScreenshot('button', {
  comparatorName: 'pixelmatch',
  comparatorOptions: {
    // more lax comparison for text-heavy elements
    allowedMismatchedPixelRatio: 0.1,
  },
})
```

## Comparators von Drittanbietern

Vitest bringt `pixelmatch` als eingebauten Comparator mit. Er ist schnell, vergleicht Bilder Pixel für Pixel, hat keine nativen Abhängigkeiten und deckt die meisten Fälle gut ab. Perzeptuelle Comparators sind nicht standardmäßig enthalten, weil sie schwerere Abhängigkeiten mitbringen und es keinen eindeutigen „besten“ gibt – verschiedene Algorithmen treffen unterschiedliche Kompromisse. Die Comparator-API existiert genau dafür, dass Sie einbinden können, was Ihren Anforderungen entspricht. Diese Entscheidung kann sich mit der Reifung des Ökosystems allerdings ändern.

Für Anwendungsfälle, in denen ein pixelgenauer Vergleich übermäßiges Rauschen erzeugt, kann ein perzeptueller Comparator oder einer für strukturelle Ähnlichkeit besser passen. Diese vergleichen Bilder eher so, wie ein Mensch es täte, tolerieren geringfügige Rendering-Unterschiede und erkennen dennoch bedeutsame visuelle Änderungen.

Es gibt viele Algorithmen; diese sind ein nützlicher Ausgangspunkt:

- [`@blazediff/ssim`](https://blazediff.dev/docs/ssim), Implementierungen von [SSIM (Structural Similarity Index)](https://en.wikipedia.org/wiki/Structural_similarity_index_measure) zur perzeptuellen Beurteilung der Bildqualität. Es bietet Standard-SSIM, MS-SSIM (Multi-Scale SSIM) und Hitchhiker’s SSIM für verschiedene Anwendungsfälle
- [`@blazediff/gmsd`](https://blazediff.dev/docs/gmsd), eine single-threaded GMSD-Metrik (Gradient Magnitude Similarity Deviation) zur perzeptuellen Beurteilung der Bildqualität, gut geeignet für CI-Umgebungen

Um einen davon zu verwenden, installieren und registrieren Sie ihn:

```ts{5-11,18-46} [vitest.config.ts]
import ssim from '@blazediff/ssim/ssim'
import type { SsimOptionsExtended } from '@blazediff/ssim/ssim'
import { defineConfig } from 'vitest/config'

declare module 'vitest/browser' {
  interface ScreenshotComparatorRegistry {
    'standard-ssim': SsimOptionsExtended & {
      threshold?: number
    }
  }
}

export default defineConfig({
  test: {
    browser: {
      expect: {
        toMatchScreenshot: {
          comparators: {
            // naive implementation, always check the library's docs
            'standard-ssim': (
              reference,
              actual,
              { createDiff, ...options }
            ) => {
              const diffBuffer = createDiff
                ? new Uint8Array(reference.data.length)
                : undefined

              const output = ssim(
                reference.data,
                actual.data,
                diffBuffer,
                reference.metadata.width,
                reference.metadata.height,
                options,
              )

              const pass = output >= (options.threshold ?? 0.95)

              return {
                pass,
                diff: diffBuffer ?? null,
                message: pass ? null : `SSIM score: ${output}.`,
              }
            },
          },
        },
      },
    },
  },
})
```

Nach der Registrierung lässt sich der Comparator in Ihrer Konfiguration oder pro Test über seinen Namen referenzieren:

:::code-group

```ts{8} [vitest.config.ts]
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    browser: {
      expect: {
        toMatchScreenshot: {
          comparatorName: 'standard-ssim',
        },
      },
    },
  },
})
```

```ts{2} [button.vrt.test.tsx]
await expect(button).toMatchScreenshot('button', {
  comparatorName: 'standard-ssim',
})
```

:::

## Bewährte Vorgehensweisen

### Konkrete Elemente testen

Sofern Sie nicht ausdrücklich die gesamte Seite testen möchten, nehmen Sie bevorzugt einzelne Komponenten auf, um Fehlalarme zu reduzieren:

```ts
// ❌ Captures entire page; prone to unrelated changes
await expect(page).toMatchScreenshot()

// ✅ Captures only the component under test
await expect(
  page.getByRole('article', { name: 'Tote bag' })
).toMatchScreenshot()
```

### Dynamische Inhalte behandeln

Dynamische Inhalte wie Zeitstempel, Nutzerdaten oder Zufallswerte lassen Tests fehlschlagen. Mocken Sie entweder die zugrunde liegenden Datenquellen oder maskieren Sie sie mit der [Option `mask`](https://playwright.dev/docs/api/class-page#page-screenshot-option-mask) in `screenshotOptions`, wenn Sie den Playwright-Provider verwenden.

```ts{8}
const profile = page.getByRole(
  'article',
  { name: 'Gracie\'s profile' },
)

await expect(profile).toMatchScreenshot({
  screenshotOptions: {
    mask: [profile.getByRole('status')],
  },
})
```

### Animationen deaktivieren

::: tip
Beim Playwright-Provider werden Animationen bei Verwendung der eingebauten Assertion automatisch deaktiviert: Der Wert der Option `animations` in `screenshotOptions` ist standardmäßig auf `"disabled"` gesetzt.

Wenn Sie lieber alle Animationen deaktivieren, um Ausführungszeit zu sparen, lesen Sie weiter.
:::

Animationen können Tests flaky machen. Deaktivieren Sie sie während des Testens, indem Sie über [`setupFiles`](/config/setupfiles) oder direkt in Ihren Tests ein eigenes CSS-Snippet einfügen:

```ts
const stylesheet = document.createElement('style')

stylesheet.textContent = /* css */`
  *, *::before, *::after {
    animation-duration: 0s !important;
    animation-delay: 0s !important;
    transition-duration: 0s !important;
    transition-delay: 0s !important;
  }
`

document.head.appendChild(stylesheet)
```

Alternativ können Sie das CSS über [`browser.testerHtmlPath`](/config/browser/testerhtmlpath) in einem eigenen HTML-Template deklarieren.

### Passende Schwellwerte setzen

Schwellwerte einzustellen ist knifflig. Es hängt vom Inhalt, von der Testumgebung und davon ab, was für Ihre App akzeptabel ist, und kann sich je nach Test auch unterscheiden.

Vitest definiert keine Standardtoleranz für abweichende Pixel. Der passende Wert hängt von Ihrer Anwendung und Umgebung ab. Empfohlen wird `allowedMismatchedPixelRatio`, damit der Schwellwert anhand der Größe des Screenshots berechnet wird und nicht als feste Zahl.

Wenn Sie sowohl `allowedMismatchedPixelRatio` als auch `allowedMismatchedPixels` setzen, verwendet Vitest jeweils die strengere Grenze.

### Git LFS verwenden

Legen Sie Referenz-Screenshots in [Git LFS](https://github.com/git-lfs/git-lfs?tab=readme-ov-file) ab, wenn Sie eine große Test-Suite planen.

## Häufige Probleme und Lösungen

### Fehlalarme durch Font-Rendering

Verfügbarkeit und Rendering von Schriften unterscheiden sich zwischen Systemen erheblich. Mögliche Lösungen sind:

- Webfonts verwenden und auf deren Laden warten:

  ```ts
  // wait for fonts to load
  await document.fonts.ready

  // continue with your tests
  ```

- Den Vergleichsschwellwert für textlastige Bereiche erhöhen:

  ```ts{6-7}
  await expect(
    page.getByRole('article', { name: 'How to grow tomatoes' })
  ).toMatchScreenshot({
    comparatorName: 'pixelmatch',
    comparatorOptions: {
      // 10% of the pixels are allowed to change
      allowedMismatchedPixelRatio: 0.1,
    },
  })
  ```

- [Ein gemeinsames Umgebungs-Setup erwägen](#visual-testing-for-teams), um konsistentes Font-Rendering zu erhalten.

### Flaky Tests oder unterschiedliche Screenshot-Größen

Wenn Tests zufällig bestehen und fehlschlagen oder Screenshots zwischen Läufen unterschiedliche Abmessungen haben:

- Warten Sie, bis alles geladen ist, einschließlich Ladeindikatoren
- Setzen Sie explizite Viewport-Größen: `await page.viewport(1920, 1080)`
- Prüfen Sie das responsive Verhalten an den Viewport-Grenzen
- Prüfen Sie auf unbeabsichtigte Animationen oder Transitions
- Erhöhen Sie das Test-Timeout für große Screenshots
- [Erwägen Sie ein gemeinsames Umgebungs-Setup](#visual-testing-for-teams)

## Visuelles Testen für Teams

Selbst bei kontrolliertem lokalem Setup schlagen auf einem Rechner erzeugte Referenzen auf einem anderen häufig fehl. Das wird relevant, sobald mehr als eine Person die Suite ausführt.

Die visuelle Regressions-Suite in einer gemeinsamen Umgebung auszuführen löst dieses Problem. Dafür gibt es drei Wege:

1. **Selbst gehostete Runner** (z. B. Docker-Images), aufwendig einzurichten und zu pflegen
1. **Referenzen in CI erzeugen**, was etwas Einrichtung erfordert
1. **Cloud-Dienste** wie [Azure App Testing](https://azure.microsoft.com/en-us/products/app-testing/), gebaut für genau dieses Problem, aber üblicherweise auf bestimmte Provider und Browser beschränkt

Optionen 2 und 3 sind am schnellsten einsatzbereit, daher werden sie unten behandelt.

:::: tabs key:shared-environment-vrt
=== GitHub Actions (CI)

Auf GitHub-Runnern sind keine Browser vorinstalliert. Installieren Sie sie vor dem Ausführen der Tests mit den Schritten für Ihren Provider:

::: tabs key:provider
== Playwright

[Playwright](https://npmx.dev/package/playwright) macht das leicht. Pinnen Sie einfach Ihre Version und fügen Sie diesen Schritt vor dem Testlauf ein:

```yaml [.github/workflows/ci.yml]
# ...the rest of the workflow
- name: Install Playwright Browsers
  run: npx --no playwright install --with-deps --only-shell
```

== WebdriverIO

[WebdriverIO](https://npmx.dev/package/webdriverio) installiert Browser automatisch, wenn beim Start eines Testlaufs keine gefunden werden; es empfiehlt sich jedoch, den Installationsprozess davon zu entkoppeln. Zur Unterstützung haben die Leute von [@browser-actions](https://github.com/browser-actions) Skripte zur Installation von [Chrome](https://github.com/browser-actions/setup-chrome), [Edge](https://github.com/browser-actions/setup-edge) und [Firefox](https://github.com/browser-actions/setup-firefox) in bequeme wiederverwendbare Actions verpackt:

```yaml [.github/workflows/ci.yml]
# ...the rest of the workflow
- uses: browser-actions/setup-chrome@v1
  with:
    chrome-version: 120
```

:::

Führen Sie die visuellen Tests dann in Ihrem bestehenden Workflow aus:

```yaml [.github/workflows/ci.yml]
# ...the rest of the workflow
# ...browser setup
- name: Visual Regression Testing
  run: npm run test:visual
```

### Der Update-Workflow

`vitest --update` lokal auszuführen würde Screenshots auf Ihrem Rechner erzeugen und damit den gesamten Sinn einer kontrollierten Umgebung untergraben. Stattdessen brauchen Sie eine Möglichkeit, das Update in CI auszulösen, wo die Umgebung derjenigen entspricht, die die Tests ausführt.

Sie möchten nicht, dass das automatisch bei jedem PR geschieht <small>*(Chaos!)*</small>. Erstellen Sie stattdessen einen manuell ausgelösten Workflow, der läuft, wenn es beabsichtigte Änderungen an der UI gibt.

Der folgende Workflow:
- Läuft nur auf Feature-Branches (nie auf main)
- Führt die auslösende Person als Co-Autor auf
- Verhindert nebenläufige Läufe auf demselben Branch
- Zeigt eine schöne Zusammenfassung:
  - **Wenn Screenshots sich geändert haben**, listet er auf, was sich geändert hat

    <img alt="Action summary after updates" img-light src="/vrt-gha-summary-update-light.png">
    <img alt="Action summary after updates" img-dark src="/vrt-gha-summary-update-dark.png">

  - **Wenn sich nichts geändert hat**, nun ja, dann sagt er Ihnen auch das

    <img alt="Action summary after no updates" img-light src="/vrt-gha-summary-no-update-light.png">
    <img alt="Action summary after no updates" img-dark src="/vrt-gha-summary-no-update-dark.png">

::: tip
Das ist nur ein Ansatz. Manche bevorzugen PR-Kommentare (`/update-screenshots`), andere nutzen Labels. Passen Sie es an Ihren Workflow an.

Wichtig ist, dass es einen kontrollierten Weg gibt, Referenz-Screenshots zu aktualisieren.
:::

```yaml [.github/workflows/update-screenshots.yml]
name: Update Visual Regression Screenshots

on:
  workflow_dispatch: # manual trigger only

env:
  AUTHOR_NAME: 'github-actions[bot]'
  AUTHOR_EMAIL: '41898282+github-actions[bot]@users.noreply.github.com'
  COMMIT_MESSAGE: |
    test: update visual regression screenshots

    Co-authored-by: ${{ github.actor }} <${{ github.actor_id }}+${{ github.actor }}@users.noreply.github.com>

jobs:
  update-screenshots:
    runs-on: ubuntu-24.04

    # safety first: don't run on main
    if: github.ref_name != github.event.repository.default_branch

    # one at a time per branch
    concurrency:
      group: visual-regression-screenshots@${{ github.ref_name }}
      cancel-in-progress: true

    permissions:
      contents: write # needs to push changes

    steps:
      - name: Checkout selected branch
        uses: actions/checkout@v4
        with:
          ref: ${{ github.ref_name }}
          # use PAT if triggering other workflows
          # token: ${{ secrets.GITHUB_TOKEN }}

      - name: Configure Git
        run: |
          git config --global user.name "${{ env.AUTHOR_NAME }}"
          git config --global user.email "${{ env.AUTHOR_EMAIL }}"

      # your setup steps here (node, pnpm, whatever)
      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: 24

      - name: Install dependencies
        run: npm ci

      - name: Install Playwright Browsers
        run: npx --no playwright install --with-deps --only-shell

      - name: Update Visual Regression Screenshots
        run: npm run test:visual --update

      # check what changed
      - name: Check for changes
        id: check_changes
        run: |
          CHANGED_FILES=$(git status --porcelain | awk '{print $2}')
          if [ "${CHANGED_FILES:+x}" ]; then
            echo "changes=true" >> $GITHUB_OUTPUT
            echo "Changes detected"

            # save the list for the summary
            echo "changed_files<<EOF" >> $GITHUB_OUTPUT
            echo "$CHANGED_FILES" >> $GITHUB_OUTPUT
            echo "EOF" >> $GITHUB_OUTPUT
            echo "changed_count=$(echo "$CHANGED_FILES" | wc -l)" >> $GITHUB_OUTPUT
          else
            echo "changes=false" >> $GITHUB_OUTPUT
            echo "No changes detected"
          fi

      # commit if there are changes
      - name: Commit changes
        if: steps.check_changes.outputs.changes == 'true'
        run: |
          git add -A
          git commit -m "${{ env.COMMIT_MESSAGE }}"

      - name: Push changes
        if: steps.check_changes.outputs.changes == 'true'
        run: git push origin ${{ github.ref_name }}

      # pretty summary for humans
      - name: Summary
        run: |
          if [[ "${{ steps.check_changes.outputs.changes }}" == "true" ]]; then
            echo "### 📸 Visual Regression Screenshots Updated" >> $GITHUB_STEP_SUMMARY
            echo "" >> $GITHUB_STEP_SUMMARY
            echo "Successfully updated **${{ steps.check_changes.outputs.changed_count }}** screenshot(s) on \`${{ github.ref_name }}\`" >> $GITHUB_STEP_SUMMARY
            echo "" >> $GITHUB_STEP_SUMMARY
            echo "#### Changed Files:" >> $GITHUB_STEP_SUMMARY
            echo "\`\`\`" >> $GITHUB_STEP_SUMMARY
            echo "${{ steps.check_changes.outputs.changed_files }}" >> $GITHUB_STEP_SUMMARY
            echo "\`\`\`" >> $GITHUB_STEP_SUMMARY
            echo "" >> $GITHUB_STEP_SUMMARY
            echo "✅ The updated screenshots have been committed and pushed. Your visual regression baseline is now up to date!" >> $GITHUB_STEP_SUMMARY
          else
            echo "### ℹ️ No Screenshot Updates Required" >> $GITHUB_STEP_SUMMARY
            echo "" >> $GITHUB_STEP_SUMMARY
            echo "The visual regression test command ran successfully but no screenshots needed updating." >> $GITHUB_STEP_SUMMARY
            echo "" >> $GITHUB_STEP_SUMMARY
            echo "All screenshots are already up to date! 🎉" >> $GITHUB_STEP_SUMMARY
          fi
```

=== Azure App Testing (Cloud-Dienst)

Bei dieser Methode bleiben Ihre Tests lokal, während die Browser in der Cloud laufen. Sie baut auf Playwrights Remote-Browser-Funktion auf, und Azure kümmert sich um die gesamte Infrastruktur.

Alle verwenden dieselben Cloud-Browser, sodass Referenzen unabhängig davon konsistent sind, wer sie erzeugt. Die Tests funktionieren lokal, Sie zahlen nur für die tatsächliche Nutzung, und es gibt nichts zu warten.

### Konfiguration

Damit Playwright sich mit den innerhalb des Dienstes gestarteten Browsern verbindet, müssen Sie die Provider-Konfiguration anpassen.

```ts{14-28} [vitest.config.ts]
import { env } from 'node:process'
import { defineConfig } from 'vitest/config'
import { playwright } from '@vitest/browser-playwright'

export default defineConfig({
  test: {
    // ...other configurations
    projects: [
      {
        test: {
          name: 'vrt',
          browser: {
            provider: playwright({
              connectOptions: {
                wsEndpoint: `${env.PLAYWRIGHT_SERVICE_URL}?${new URLSearchParams({
                  'api-version': '2025-09-01',
                  'os': 'linux', // always use Linux for consistency
                  // helps identifying runs in the service's dashboard
                  'runName': `Vitest ${env.CI ? 'CI' : 'local'} run @${new Date().toISOString()}`,
                })}`,
                exposeNetwork: '<loopback>',
                headers: {
                  Authorization: `Bearer ${env.PLAYWRIGHT_SERVICE_ACCESS_TOKEN}`,
                },
                timeout: 30_000,
              }
            }),
            headless: true,
            instances: [
              {
                browser: '[browser-name]',
                viewport: { width: 1280, height: 720 },
              },
            ],
          },
          include: [vrtPattern],
        },
      },
      // ...other projects
    ],
  },
})
```

Um einen Playwright Workspace anzulegen, folgen Sie der [offiziellen Anleitung](https://learn.microsoft.com/en-us/azure/app-testing/playwright-workspaces/quickstart-run-end-to-end-tests?tabs=playwrightcli&pivots=playwright-test-runner#create-a-workspace).

Sobald Ihr Workspace erstellt ist, konfigurieren Sie Vitest für dessen Nutzung:

1. **Endpunkt-URL setzen**: Rufen Sie gemäß der [offiziellen Anleitung](https://learn.microsoft.com/en-us/azure/app-testing/playwright-workspaces/quickstart-run-end-to-end-tests?tabs=playwrightcli&pivots=playwright-test-runner#configure-the-browser-endpoint) die URL ab und setzen Sie sie als Umgebungsvariable `PLAYWRIGHT_SERVICE_URL`.
1. **Token-Authentifizierung aktivieren**: [Aktivieren Sie Access Tokens](https://learn.microsoft.com/en-us/azure/app-testing/playwright-workspaces/how-to-manage-authentication?pivots=playwright-test-runner#enable-authentication-using-access-tokens) für Ihren Workspace, [erzeugen Sie dann ein Token](https://learn.microsoft.com/en-us/azure/app-testing/playwright-workspaces/how-to-manage-access-tokens#generate-a-workspace-access-token) und setzen Sie es als Umgebungsvariable `PLAYWRIGHT_SERVICE_ACCESS_TOKEN`.

::: danger Halten Sie dieses Token geheim!
Committen Sie `PLAYWRIGHT_SERVICE_ACCESS_TOKEN` niemals in Ihr Repository. Wer das Token besitzt, kann Ihre Rechnung in die Höhe treiben. Verwenden Sie lokal Umgebungsvariablen und in CI Secrets.
:::

### Tests ausführen

```bash
# Local development
npm run test:unit    # runs locally using your browsers
npm run test:visual  # uses cloud browsers

# Update screenshots
npm run test:visual -- --update
```

### CI-Einrichtung

Fügen Sie die Secrets Ihrer CI-Konfiguration hinzu:

```yaml
env:
  PLAYWRIGHT_SERVICE_URL: ${{ vars.PLAYWRIGHT_SERVICE_URL }}
  PLAYWRIGHT_SERVICE_ACCESS_TOKEN: ${{ secrets.PLAYWRIGHT_SERVICE_ACCESS_TOKEN }}
```

Führen Sie Ihre Tests anschließend wie gewohnt aus. Der Dienst kümmert sich um die Browser-Infrastruktur.

::::

### Die richtige Option wählen

Alle Ansätze funktionieren. Die eigentliche Frage ist, welche Schmerzpunkte Ihnen und Ihrem Team am wichtigsten sind.

Wenn Sie mit Containerisierung vertraut sind, gibt Ihnen ein selbst gehostetes Docker-Setup eine kontrollierte Umgebung ohne externe Abhängigkeiten oder Kosten. Der Nachteil ist die Wartung, denn Setup, Browser-Versionen und jeder Defekt liegen bei Ihnen.

CI-Läufe funktionieren mit jedem Browser-Provider und geben Ihnen volle Kontrolle, doch Screenshots lassen sich nur in CI erzeugen. Wenn jemand lokal `vitest --update` ausführt und das Ergebnis committet, schlagen diese Referenzen im nächsten CI-Lauf voraussichtlich fehl. Das lässt sich verhindern, indem der Befehl hinter einer Prüfung auf die CI-Umgebung abgesichert wird.

Ein Cloud-Dienst ergibt Sinn, wenn Entwicklerinnen und Entwickler visuelle Tests lokal ausführen und aktualisieren können sollen, ohne unpassende Referenzen zu riskieren. Noch nützlicher wird er, wenn Designer an der Prüfung von Änderungen beteiligt sind oder wenn der Zyklus aus Pushen, Warten, Prüfen, Beheben und erneutem Pushen zu einem echten Engpass wird.

Noch unentschieden? Beginnen Sie mit dem CI-Workflow. Sie können später jederzeit auf einen Container oder einen Cloud-Dienst umsteigen, falls es zum Schmerzpunkt wird.

## Tiefer eintauchen

### Wie Vitest die Stabilität von Screenshots sicherstellt

Visuelle Regressionstests setzen voraus, dass Screenshots über Läufe hinweg stabil bleiben. In der Praxis sind Seiten nicht sofort stabil: Bilder laden asynchron, Animationen enden zu unterschiedlichen Zeitpunkten, Schriften rendern und Layouts pendeln sich ein. Um das abzumildern, verwendet Vitest eine Strategie namens „Stable Screenshot Detection“:

1. Es nimmt einen ersten Screenshot auf (oder verwendet den Referenz-Screenshot, sofern vorhanden) als Baseline
1. Es nimmt einen weiteren Screenshot auf und vergleicht ihn mit der Baseline
    - Stimmen die Screenshots überein, ist die Seite stabil und der Test wird fortgesetzt
    - Unterscheiden sie sich, verwendet Vitest den neuesten Screenshot als Baseline und wiederholt den Vorgang
1. Das setzt sich fort, bis Stabilität erreicht ist oder das Timeout greift

So sorgen vorübergehende visuelle Änderungen (etwa Lade-Spinner oder Animationen) nicht für Fehlalarme. Hört jedoch etwas nie auf zu animieren, laufen Sie in das Timeout – erwägen Sie dann, [Animationen während des Testens zu deaktivieren](#disable-animations).

Wird nach einem oder mehreren Wiederholungsversuchen ein stabiler Screenshot aufgenommen und existiert ein Referenz-Screenshot, führt Vitest einen abschließenden Vergleich mit der Referenz durch, mit `createDiff: true`. Stimmen sie nicht überein, wird dabei ein Diff-Bild erzeugt.

Während der Stabilitätserkennung ruft Vitest Comparators mit `createDiff: false` auf, da es nur wissen muss, ob die Screenshots übereinstimmen. Das hält den Erkennungsprozess schnell.
