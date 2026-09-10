# browser.expect

- **Typ:** `ExpectOptions`

## browser.expect.toMatchScreenshot

Standardoptionen für die
[`toMatchScreenshot`-Assertion](/api/browser/assertions.html#tomatchscreenshot).
Diese Optionen werden auf alle Screenshot-Assertions angewendet.

::: tip
Globale Standardwerte für Screenshot-Assertions helfen dabei, Konsistenz über
Ihre gesamte Testsuite hinweg zu wahren, und reduzieren Wiederholungen in
einzelnen Tests. Sie können diese Standardwerte bei Bedarf für bestimmte
Testfälle weiterhin auf Ebene der einzelnen Assertion überschreiben.
:::

```ts
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    browser: {
      enabled: true,
      expect: {
        toMatchScreenshot: {
          comparatorName: 'pixelmatch',
          comparatorOptions: {
            threshold: 0.2,
            allowedMismatchedPixels: 100,
          },
          resolveScreenshotPath: ({ arg, browserName, ext, testFileName }) =>
            `custom-screenshots/${testFileName}/${arg}-${browserName}${ext}`,
        },
      },
    },
  },
})
```

[Alle in der `toMatchScreenshot`-Assertion verfügbaren Optionen](/api/browser/assertions#options)
lassen sich hier konfigurieren. Zusätzlich stehen zwei Funktionen zur
Pfadauflösung zur Verfügung: `resolveScreenshotPath` und `resolveDiffPath`.

## browser.expect.toMatchScreenshot.screenshotDirectory

- **Typ:** `string | undefined`
- **Standard:** `__screenshots__`

Der Verzeichnisname, unter dem Referenz-Screenshots abgelegt werden.

Dieser Wert wird als `screenshotDirectory` an [`browser.expect.toMatchScreenshot.resolveScreenshotPath`](#browserexpecttomatchscreenshotresolvescreenshotpath) und [`browser.expect.toMatchScreenshot.resolveDiffPath`](#browserexpecttomatchscreenshotresolvediffpath) übergeben und in der Standard-Pfadauflösung von `resolveScreenshotPath` verwendet.

## browser.expect.toMatchScreenshot.resolveScreenshotPath

- **Typ:** `(data: PathResolveData) => string`
- **Standardausgabe:** ``path.resolve(root, testFileDirectory, screenshotDirectory, testFileName, `${arg}-${browserName}-${platform}${ext}`)``

Eine Funktion, mit der Sie anpassen, wo Referenz-Screenshots abgelegt werden. Die
Funktion erhält ein Objekt mit den folgenden Eigenschaften:

- `arg: string`

  Pfad **ohne** Erweiterung, bereinigt und relativ zur Testdatei.

  Er stammt aus den Argumenten, die an `toMatchScreenshot` übergeben werden;
  wird ohne Argumente aufgerufen, ist dies der automatisch erzeugte Name.

  ```ts
  test('calls `onClick`', () => {
    expect(locator).toMatchScreenshot()
    // arg = "calls-onclick-1"
  })

  expect(locator).toMatchScreenshot('foo/bar/baz.png')
  // arg = "foo/bar/baz"

  expect(locator).toMatchScreenshot('../foo/bar/baz.png')
  // arg = "foo/bar/baz"
  ```

- `ext: string`

  Erweiterung des Screenshots, mit führendem Punkt.

  Sie kann über die an `toMatchScreenshot` übergebenen Argumente gesetzt werden,
  der Wert fällt aber auf `'.png'` zurück, wenn eine nicht unterstützte
  Erweiterung verwendet wird.

- `browserName: string`

  Der Browsername der Instanz.

- `platform: NodeJS.Platform`

  Der Wert von
  [`process.platform`](https://nodejs.org/docs/v22.16.0/api/process.html#processplatform).

- `screenshotDirectory: string`

  Der an [`browser.expect.toMatchScreenshot.screenshotDirectory`](#browserexpecttomatchscreenshotscreenshotdirectory) übergebene Wert, oder, falls keiner angegeben ist, dessen Standardwert (`__screenshots__`).

- `root: string`

  Absoluter Pfad zum [`root`](/config/root) des Projekts.

- `testFileDirectory: string`

  Pfad zur Testdatei, relativ zum [`root`](/config/root) des Projekts.

- `testFileName: string`

  Der Dateiname des Tests.

- `testName: string`

  Der Name des [`test`](/api/test), einschließlich übergeordneter
  [`describe`](/api/describe)-Blöcke, bereinigt.

- `attachmentsDir: string`

  Der an [`attachmentsDir`](/config/attachmentsdir) übergebene Wert, oder, falls
  keiner angegeben ist, dessen Standardwert.

- `project: TestProject` <Version type="experimental">4.1.6</Version> <Experimental />

  Das [`TestProject`](/api/advanced/test-project), zu dem der Test gehört.

Um Screenshots beispielsweise nach Browser zu gruppieren:

```ts
resolveScreenshotPath: ({ arg, browserName, ext, root, testFileName }) =>
  `${root}/screenshots/${browserName}/${testFileName}/${arg}${ext}`
```

## browser.expect.toMatchScreenshot.resolveDiffPath

- **Typ:** `(data: PathResolveData) => string`
- **Standardausgabe:** ``path.resolve(root, attachmentsDir, testFileDirectory, testFileName, `${arg}-${browserName}-${platform}${ext}`)``

Eine Funktion, mit der Sie anpassen, wo Diff-Bilder abgelegt werden, wenn ein
Screenshot-Vergleich fehlschlägt. Sie erhält dasselbe Datenobjekt wie
[`resolveScreenshotPath`](#browser-expect-tomatchscreenshot-resolvescreenshotpath).

Um Diffs beispielsweise in einem Unterverzeichnis der Anhänge abzulegen:

```ts
resolveDiffPath: ({ arg, attachmentsDir, browserName, ext, root, testFileName }) =>
  `${root}/${attachmentsDir}/screenshot-diffs/${testFileName}/${arg}-${browserName}${ext}`
```

## browser.expect.toMatchScreenshot.comparators

- **Typ:** `Record<string, Comparator>`

Registriert eigene Algorithmen zum Screenshot-Vergleich, etwa [SSIM](https://en.wikipedia.org/wiki/Structural_similarity_index_measure) oder andere Metriken für wahrgenommene Ähnlichkeit.

Um einen eigenen Comparator zu erstellen, müssen Sie ihn in Ihrer Konfiguration registrieren. Wenn Sie TypeScript verwenden, deklarieren Sie seine Optionen im Interface `ScreenshotComparatorRegistry`.

```ts
import { defineConfig } from 'vitest/config'

// 1. Declare the comparator's options type
declare module 'vitest/browser' {
  interface ScreenshotComparatorRegistry {
    myCustomComparator: {
      sensitivity?: number
      ignoreColors?: boolean
    }
  }
}

// 2. Implement the comparator
export default defineConfig({
  test: {
    browser: {
      expect: {
        toMatchScreenshot: {
          comparators: {
            myCustomComparator: async (
              reference,
              actual,
              {
                createDiff, // always provided by Vitest
                sensitivity = 0.01,
                ignoreColors = false,
              }
            ) => {
              // ...algorithm implementation
              return { pass, diff, message }
            },
          },
        },
      },
    },
  },
})
```

Verwenden Sie ihn anschließend in Ihren Tests:

```ts
await expect(locator).toMatchScreenshot({
  comparatorName: 'myCustomComparator',
  comparatorOptions: {
    sensitivity: 0.08,
    ignoreColors: true,
  },
})
```

**Signatur der Comparator-Funktion:**

```ts
type Comparator<Options> = (
  reference: {
    metadata: { height: number; width: number }
    data: TypedArray
  },
  actual: {
    metadata: { height: number; width: number }
    data: TypedArray
  },
  options: {
    createDiff: boolean
  } & Options
) => Promise<{
  pass: boolean
  diff: TypedArray | null
  message: string | null
}> | {
  pass: boolean
  diff: TypedArray | null
  message: string | null
}
```

Die Bilder `reference` und `actual` werden mit dem passenden Codec dekodiert (derzeit nur PNG). Die Eigenschaft `data` ist ein flaches `TypedArray` (`Buffer`, `Uint8Array` oder `Uint8ClampedArray`), das Pixeldaten im RGBA-Format enthält:

- **4 Byte pro Pixel**: Rot, Grün, Blau, Alpha (jeweils von `0` bis `255`)
- **Zeilenweise Anordnung**: Pixel werden von links nach rechts und von oben nach unten gespeichert
- **Gesamtlänge**: `width × height × 4` Byte
- **Alphakanal**: immer vorhanden. Bilder ohne Transparenz haben Alphawerte von `255` (vollständig deckend)

::: tip Performance-Hinweise
Die Option `createDiff` gibt an, ob ein Diff-Bild benötigt wird. Während der [Erkennung stabiler Screenshots](/guide/browser/visual-regression-testing#how-visual-tests-work) ruft Vitest Comparatoren mit `createDiff: false` auf, um unnötige Arbeit zu vermeiden.

**Berücksichtigen Sie dieses Flag, damit Ihre Tests schnell bleiben.**
:::

::: warning Fehlende Optionen behandeln
Der Parameter `options` in `toMatchScreenshot()` ist optional, daher geben Nutzer möglicherweise nicht alle Optionen Ihres Comparators an. Machen Sie sie stets optional und versehen Sie sie mit Standardwerten:

```ts
myCustomComparator: (
  reference,
  actual,
  { createDiff, threshold = 0.1, maxDiff = 100 },
) => {
  // ...comparison logic
}
```
:::
