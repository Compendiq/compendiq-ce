# Snapshot

::: tip
Eine einsteigerfreundliche Einführung in Snapshot-Testing finden Sie im Tutorial [Snapshot Testing](/guide/learn/snapshots).
:::

<CourseLink href="https://vueschool.io/lessons/snapshots-in-vitest?friend=vueuse">Lernen Sie Snapshots im Video von Vue School</CourseLink>

Snapshot-Tests sind ein sehr nützliches Werkzeug, wenn Sie sicherstellen wollen, dass sich die Ausgabe Ihrer Funktionen nicht unerwartet ändert.

Beim Einsatz von Snapshots erstellt Vitest einen Snapshot des angegebenen Werts und vergleicht ihn anschließend mit einer Referenz-Snapshot-Datei, die neben dem Test gespeichert ist. Der Test schlägt fehl, wenn die beiden Snapshots nicht übereinstimmen: Entweder ist die Änderung unerwartet, oder der Referenz-Snapshot muss auf die neue Fassung des Ergebnisses aktualisiert werden.

## Snapshots verwenden

Um einen Wert als Snapshot festzuhalten, können Sie [`toMatchSnapshot()`](/api/expect#tomatchsnapshot) aus der `expect()`-API verwenden:

```ts
import { expect, it } from 'vitest'

it('toUpperCase', () => {
  const result = toUpperCase('foobar')
  expect(result).toMatchSnapshot()
})
```

Beim ersten Ausführen dieses Tests erstellt Vitest eine Snapshot-Datei, die so aussieht:

```js
// Vitest Snapshot v1, https://vitest.dev/guide/snapshot.html

exports['toUpperCase 1'] = '"FOOBAR"'
```

Das Snapshot-Artefakt sollte zusammen mit den Codeänderungen eingecheckt und als Teil Ihres Code-Review-Prozesses geprüft werden. In nachfolgenden Testläufen vergleicht Vitest die erzeugte Ausgabe mit dem vorherigen Snapshot. Stimmen sie überein, besteht der Test. Stimmen sie nicht überein, hat der Test-Runner entweder einen Fehler in Ihrem Code gefunden, der behoben werden sollte, oder die Implementierung hat sich geändert und der Snapshot muss aktualisiert werden.

Vitest speichert eine serialisierte Darstellung des empfangenen Werts. Das Rendern der Snapshots wird von [`@vitest/pretty-format`](https://npmx.dev/package/@vitest/pretty-format) übernommen. [`snapshotFormat`](/config/snapshotformat) erlaubt es, das allgemeine Formatierungsverhalten von Snapshots in Vitest zu konfigurieren. Für weitergehende Anpassungen können Sie eigene [Serializer](#custom-serializer) oder eigene [Snapshot-Matcher](#custom-snapshot-matchers) implementieren.

::: warning
Wenn Sie Snapshots mit asynchronen, nebenläufigen Tests verwenden, muss das `expect` aus dem lokalen [Test-Kontext](/guide/test-context) verwendet werden, damit der richtige Test erkannt wird.
:::

## Inline-Snapshots

Analog können Sie [`toMatchInlineSnapshot()`](/api/expect#tomatchinlinesnapshot) verwenden, um den Snapshot inline innerhalb der Testdatei zu speichern.

```ts
import { expect, it } from 'vitest'

it('toUpperCase', () => {
  const result = toUpperCase('foobar')
  expect(result).toMatchInlineSnapshot()
})
```

Statt eine Snapshot-Datei anzulegen, ändert Vitest die Testdatei direkt, um den Snapshot als String einzutragen:

```ts
import { expect, it } from 'vitest'

it('toUpperCase', () => {
  const result = toUpperCase('foobar')
  expect(result).toMatchInlineSnapshot('"FOOBAR"')
})
```

So sehen Sie die erwartete Ausgabe direkt, ohne zwischen Dateien springen zu müssen.

::: warning
Wenn Sie Snapshots mit asynchronen, nebenläufigen Tests verwenden, muss das `expect` aus dem lokalen [Test-Kontext](/guide/test-context) verwendet werden, damit der richtige Test erkannt wird.
:::

## Snapshots aktualisieren

Wenn der empfangene Wert nicht zum Snapshot passt, schlägt der Test fehl und zeigt Ihnen den Unterschied zwischen beiden. Ist die Snapshot-Änderung erwartet, möchten Sie den Snapshot womöglich auf den aktuellen Stand aktualisieren.

Im Watch-Modus können Sie im Terminal die Taste `u` drücken, um den fehlgeschlagenen Snapshot direkt zu aktualisieren.

Oder Sie verwenden das Flag `--update` bzw. `-u` in der CLI, damit Vitest die Snapshots aktualisiert.

```bash
vitest -u
```

### Verhalten in der CI

Standardmäßig schreibt Vitest in der CI keine Snapshots (`process.env.CI` ist truthy), und jede Snapshot-Abweichung, jeder fehlende und jeder veraltete Snapshot lässt den Lauf fehlschlagen. Details siehe [`update`](/config/update).

Ein **veralteter Snapshot** ist ein Snapshot-Eintrag (oder eine Snapshot-Datei), der zu keinem erfassten Test mehr passt. Das passiert üblicherweise nach dem Entfernen oder Umbenennen von Tests.

## Datei-Snapshots

Beim Aufruf von `toMatchSnapshot()` speichern wir alle Snapshots in einer formatierten Snap-Datei. Das bedeutet, dass wir einige Zeichen im Snapshot-String maskieren müssen (nämlich das doppelte Anführungszeichen `"` und den Backtick `` ` ``). Zugleich verlieren Sie womöglich das Syntax-Highlighting für den Snapshot-Inhalt (wenn er in irgendeiner Sprache vorliegt).

Aus diesem Grund haben wir [`toMatchFileSnapshot()`](/api/expect#tomatchfilesnapshot) eingeführt, um explizit gegen eine Datei zu vergleichen. Damit können Sie der Snapshot-Datei eine beliebige Dateiendung geben und sie besser lesbar machen.

```ts
import { expect, it } from 'vitest'

it('render basic', async () => {
  const result = renderHTML(h('div', { class: 'foo' }))
  await expect(result).toMatchFileSnapshot('./test/basic.output.html')
})
```

Es vergleicht mit dem Inhalt von `./test/basic.output.html`. Und lässt sich mit dem Flag `--update` zurückschreiben.

## Visuelle Snapshots

Für visuelle Regressionstests von UI-Komponenten und Seiten bietet Vitest eingebaute Unterstützung über den [Browser-Modus](/guide/browser/) mit der Assertion [`toMatchScreenshot()`](/api/browser/assertions#tomatchscreenshot):

```ts
import { expect, test } from 'vitest'
import { page } from 'vitest/browser'

test('button looks correct', async () => {
  const button = page.getByRole('button')
  await expect(button).toMatchScreenshot('primary-button')
})
```

Dabei werden Screenshots aufgenommen und mit Referenzbildern verglichen, um ungewollte visuelle Änderungen zu erkennen. Mehr dazu im [Guide zum visuellen Regressionstesten](/guide/browser/visual-regression-testing).

## ARIA-Snapshots <Experimental /> <Version>4.1.4</Version> {#aria-snapshots}

ARIA-Snapshots erfassen den Accessibility-Baum eines DOM-Elements und vergleichen ihn mit einer gespeicherten Vorlage. Angelehnt an [Playwrights ARIA-Snapshots](https://playwright.dev/docs/aria-snapshots) bieten sie eine semantische Alternative zum visuellen Regressionstesten – sie prüfen Struktur und Bedeutung statt Pixel.

Zum Beispiel bei folgendem HTML:

```html
<nav aria-label="Main">
  <a href="/">Home</a>
  <a href="/about">About</a>
</nav>
```

Können Sie dessen Accessibility-Baum prüfen:

```ts
import { expect, test } from 'vitest'
import { page } from 'vitest/browser'

test('navigation structure', async () => {
  await expect.element(page.getByRole('navigation')).toMatchAriaInlineSnapshot(`
    - navigation "Main":
      - link "Home":
        - /url: /
      - link "About":
        - /url: /about
  `)
})
```

Einzelheiten zur Syntax, zum Retry-Verhalten im Browser-Modus sowie Beispiele für Datei- und Inline-Snapshots finden Sie im eigenen [ARIA-Snapshots-Guide](/guide/browser/aria-snapshots). Die vollständige API-Referenz finden Sie unter [`toMatchAriaSnapshot`](/api/expect#tomatcharisnapshot) und [`toMatchAriaInlineSnapshot`](/api/expect#tomatchariainlinesnapshot).

## Eigener Serializer

Sie können eigene Logik hinzufügen, um zu verändern, wie Ihre Snapshots serialisiert werden. Wie Jest hat Vitest Standard-Serializer für eingebaute JavaScript-Typen, HTML-Elemente, ImmutableJS und für React-Elemente.

Sie können einen eigenen Serializer explizit über die API [`expect.addSnapshotSerializer`](/api/expect#expect-addsnapshotserializer) hinzufügen.

```ts
expect.addSnapshotSerializer({
  serialize(val, config, indentation, depth, refs, printer) {
    // `printer` is a function that serializes a value using existing plugins.
    return `Pretty foo: ${printer(
      val.foo,
      config,
      indentation,
      depth,
      refs,
    )}`
  },
  test(val) {
    return val && Object.prototype.hasOwnProperty.call(val, 'foo')
  },
})
```

Wir unterstützen außerdem die Option [snapshotSerializers](/config/snapshotserializers), um eigene Serializer implizit hinzuzufügen.

```ts [path/to/custom-serializer.ts]
import { SnapshotSerializer } from 'vitest'

export default {
  serialize(val, config, indentation, depth, refs, printer) {
    // `printer` is a function that serializes a value using existing plugins.
    return `Pretty foo: ${printer(
      val.foo,
      config,
      indentation,
      depth,
      refs,
    )}`
  },
  test(val) {
    return val && Object.prototype.hasOwnProperty.call(val, 'foo')
  },
} satisfies SnapshotSerializer
```

```ts [vitest.config.ts]
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    snapshotSerializers: ['path/to/custom-serializer.ts'],
  },
})
```

Nachdem Sie einen Test wie diesen hinzugefügt haben:

```ts
test('foo snapshot test', () => {
  const bar = {
    foo: {
      x: 1,
      y: 2,
    },
  }

  expect(bar).toMatchSnapshot()
})
```

erhalten Sie den folgenden Snapshot:

```
Pretty foo: Object {
  "x": 1,
  "y": 2,
}
```

## Eigene Snapshot-Matcher <Experimental /> <Version>4.1.3</Version> {#custom-snapshot-matchers}

Sie können eigene Snapshot-Matcher mit den komponierbaren Funktionen bauen, die über `Snapshots` aus `vitest` bereitgestellt werden. Damit können Sie Werte vor dem Snapshotting transformieren und behalten zugleich die volle Unterstützung des Snapshot-Lebenszyklus (Erstellen, Aktualisieren, Inline-Umschreiben).

```ts
import { expect, test, Snapshots } from 'vitest'

const { toMatchFileSnapshot, toMatchInlineSnapshot, toMatchSnapshot } = Snapshots

expect.extend({
  toMatchTrimmedSnapshot(received: string, length: number) {
    return toMatchSnapshot.call(this, received.slice(0, length))
  },
  toMatchTrimmedInlineSnapshot(received: string, inlineSnapshot?: string) {
    return toMatchInlineSnapshot.call(this, received.slice(0, 10), inlineSnapshot)
  },
  async toMatchTrimmedFileSnapshot(received: string, file: string) {
    return toMatchFileSnapshot.call(this, received.slice(0, 10), file)
  },
})

test('file snapshot', () => {
  // create __snapshots__/demo.test.ts with
  // > exports[`file snapshot 1`] = `"extra long"`
  expect('extra long string oh my gerd').toMatchTrimmedSnapshot(10)
})

test('inline snapshot', () => {
  expect('super long string oh my gerd').toMatchTrimmedInlineSnapshot(`"super long"`)
})

test('raw file snapshot', async () => {
  // create raw-file.txt with:
  // > crazy long
  await expect('crazy long string oh my gerd').toMatchTrimmedFileSnapshot('./raw-file.txt')
})
```

Die Composables geben `{ pass, message }` zurück, sodass Sie den Fehler weiter anpassen können:

```ts
import { Snapshots } from 'vitest'

const { toMatchSnapshot } = Snapshots

expect.extend({
  toMatchTrimmedSnapshot(received: string, length: number) {
    const result = toMatchSnapshot.call(this, received.slice(0, length))
    return { ...result, message: () => `Trimmed snapshot failed: ${result.message()}` }
  },
})
```

::: warning
Bei Inline-Snapshot-Matchern muss das Snapshot-Argument der letzte Parameter sein (oder der vorletzte, wenn Property-Matcher verwendet werden). Vitest schreibt das letzte String-Argument im Quellcode um, sodass eigene Argumente vor dem Snapshot funktionieren, eigene Argumente danach jedoch nicht unterstützt werden.
:::

::: tip
Datei-Snapshot-Matcher müssen `async` sein – `toMatchFileSnapshot` gibt ein `Promise` zurück. Denken Sie daran, das Ergebnis im Matcher und in Ihrem Test mit `await` abzuwarten.
:::

::: warning
Wenn ein eigener Inline-Snapshot-Matcher asynchron ist, kann Vitest die Aufrufstelle für das Umschreiben des Inline-Snapshots nicht automatisch ermitteln. Sie müssen die Aufrufstelle erfassen, indem Sie das Flag `'error'` auf dem Chai-Assertion-Objekt setzen:

```ts
import { expect, chai, Snapshots } from 'vitest'

const { toMatchInlineSnapshot } = Snapshots

expect.extend({
  async toMatchTransformedInlineSnapshot(received: string, inlineSnapshot?: string) {
    // capture call site synchronously at the top of matcher implementation
    chai.util.flag(this.assertion, 'error', new Error())
    const transformed = await transform(received)
    return toMatchInlineSnapshot.call(this, transformed, inlineSnapshot)
  },
})
```

:::

Für TypeScript erweitern Sie das Interface `Matchers<R, T>`:

```ts
import 'vitest'

declare module 'vitest' {
  interface Matchers<R, T> {
    toMatchTrimmedSnapshot: (length: number) => R
    toMatchTrimmedInlineSnapshot: (inlineSnapshot?: string) => R
    toMatchTrimmedFileSnapshot: (file: string) => Promise<void>
  }
}
```

::: tip
Mehr zu `expect.extend` und den Konventionen für eigene Matcher finden Sie unter [Extending Matchers](/guide/extending-matchers).
:::

## Eigene Snapshot-Domain <Experimental /> <Version>4.1.4</Version> {#custom-snapshot-domain}

Eigene Serializer steuern, wie Werte in Snapshot-Strings _gerendert_ werden, aber der Vergleich bleibt String-Gleichheit. Ein **Domain-Snapshot-Adapter** geht weiter: Er besitzt die gesamte Vergleichs-Pipeline für einen eigenen Matcher, einschließlich der Frage, wie ein Wert erfasst, gerendert, ein gespeicherter Snapshot geparst und beides semantisch abgeglichen wird.

### Das Adapter-Interface

Ein Domain-Adapter implementiert vier Methoden und ist generisch über zwei Typen – `Captured` (was der Wert tatsächlich ist) und `Expected` (wozu der gespeicherte Snapshot geparst wird):

```ts
import type { DomainMatchResult, DomainSnapshotAdapter } from 'vitest'

const myAdapter: DomainSnapshotAdapter<Captured, Expected> = {
  name: 'my-domain',

  // Extract structured data from the received value
  capture(received: unknown): Captured { /* ... */ },

  // Render captured data as the snapshot string (what gets stored)
  render(captured: Captured): string { /* ... */ },

  // Parse a stored snapshot string into a structured expected value
  parseExpected(input: string): Expected { /* ... */ },

  // Compare captured vs expected, return pass/fail and resolved output
  match(captured: Captured, expected: Expected): DomainMatchResult { /* ... */ },
}
```

#### `DomainMatchResult`

Die Methode `match` gibt ein `DomainMatchResult` mit zwei optionalen String-Feldern zusätzlich zu `pass` zurück:

- **`resolved`** – der erfasste Wert, betrachtet durch die Linse der Vorlage. Wo die Vorlage Muster verwendet (z. B. Regexes) oder Details auslässt, übernimmt der aufgelöste String diese Muster. Wo die Vorlage nicht passt, verwendet er die wörtlich erfassten Werte. Das dient sowohl als Ist-Seite von Diffs als auch als der bei `--update` geschriebene Wert. Wird es weggelassen, greift der Rückfall auf `render(capture(received))`.

- **`expected`** – die gespeicherte Vorlage, erneut als String gerendert. Wird als Soll-Seite von Diffs verwendet. Wird es weggelassen, greift der Rückfall auf den rohen Snapshot-String aus der Snap-Datei oder dem Inline-Snapshot.

:::details Warum sind `Captured` und `Expected` getrennte Typen?

Wenn ein Snapshot zum ersten Mal erzeugt wird, produziert `render(captured)` einen einfachen String, der gespeichert wird. Einmal gespeichert, kann der Anwender ihn jedoch **von Hand bearbeiten** – Literale durch Regex-Muster ersetzen, Zusicherungen lockern oder domänenspezifische Abfragesyntax ergänzen. Nach dem Bearbeiten parst `parseExpected(input)` diesen veränderten String in einen Typ, der _reichhaltiger_ ist als das, was `capture` erzeugt.

Zum Beispiel sind im unten stehenden [Key-Value-Adapter](#example-key-value-adapter) `Captured`-Werte immer `string`, `Expected`-Werte hingegen können `string | RegExp` sein:

```ts
type KVCaptured = Record<string, string>
type KVExpected = Record<string, string | RegExp>
```

Diese Asymmetrie ist es, die `--update` korrekt funktionieren lässt: `match` gibt einen `resolved`-String zurück, der geänderte wörtliche Teile aktualisiert und dabei die von Hand bearbeiteten Muster des Anwenders **bewahrt**. Wären beide Seiten derselbe Typ, gäbe es keine Möglichkeit, "was der Wert tatsächlich ist" von "was der Anwender zusichern wollte" zu unterscheiden – und jede Aktualisierung würde die Muster des Anwenders überschreiben.

:::

### Aus dem Adapter einen Matcher bauen

Registrieren Sie einen eigenen Matcher mit `expect.extend(...)` und rufen Sie die Snapshot-Composables aus `vitest` auf:

```ts [setup.ts]
import { expect, Snapshots } from 'vitest'

declare module 'vitest' {
  interface Matchers<R, T> {
    toMatchMyDomainSnapshot: () => R
    toMatchMyDomainInlineSnapshot: (inlineSnapshot?: string) => R
  }
}

expect.extend({
  toMatchMyDomainSnapshot(received: unknown) {
    return Snapshots.toMatchDomainSnapshot.call(this, myAdapter, received)
  },
  toMatchMyDomainInlineSnapshot(received: unknown, inlineSnapshot?: string) {
    return Snapshots.toMatchDomainInlineSnapshot.call(
      this,
      myAdapter,
      received,
      inlineSnapshot,
    )
  },
})
```

Anschließend verwenden Sie Ihren Matcher in Tests:

```ts
expect(value).toMatchMyDomainSnapshot()
expect(value).toMatchMyDomainInlineSnapshot(`key=value`)
```

### Beispiel: Key-Value-Adapter

Ein minimaler Adapter, der Objekte als `key=value`-Zeilen speichert, mit Unterstützung für Regex-Muster und Teilmengen-Abgleich von Schlüsseln ([vollständiger Quellcode](https://github.com/vitest-dev/vitest/blob/main/test/snapshots/test/fixtures/domain/basic.ts)):

```ts [kv-adapter.ts]
import type { DomainMatchResult, DomainSnapshotAdapter } from 'vitest'

type KVCaptured = Record<string, string>
type KVExpected = Record<string, string | RegExp>

function renderKV(obj: Record<string, unknown>) {
  return `\n${Object.entries(obj).map(([k, v]) => `${k}=${v}`).join('\n')}\n`
}

export const kvAdapter: DomainSnapshotAdapter<KVCaptured, KVExpected> = {
  name: 'kv',

  capture(received: unknown): KVCaptured {
    if (received && typeof received === 'object') {
      return Object.fromEntries(
        Object.entries(received).map(([k, v]) => [k, String(v)]),
      )
    }
    throw new TypeError('kv adapter expects a plain object')
  },

  render(captured: KVCaptured): string {
    return renderKV(captured)
  },

  parseExpected(input: string): KVExpected {
    const entries = input.trim().split('\n').map((line) => {
      const eq = line.indexOf('=')
      const key = line.slice(0, eq)
      const raw = line.slice(eq + 1)
      const value = (raw.startsWith('/') && raw.endsWith('/') && raw.length > 1)
        ? new RegExp(raw.slice(1, -1))
        : raw
      return [key, value]
    })
    return Object.fromEntries(entries)
  },

  match(captured: KVCaptured, expected: KVExpected): DomainMatchResult {
    const resolvedLines: string[] = []
    let pass = true

    for (const [key, actualValue] of Object.entries(captured)) {
      const expectedValue = expected[key]

      // non-asserted keys are skipped (works as subset match)
      if (typeof expectedValue === 'undefined') {
        continue
      }

      // preserve matched pattern for normalized diff and partial update
      if (expectedValue instanceof RegExp && expectedValue.test(actualValue)) {
        resolvedLines.push(`${key}=/${expectedValue.source}/`)
        continue
      }

      resolvedLines.push(`${key}=${actualValue}`)
      pass &&= actualValue === expectedValue
    }

    return {
      pass,
      message: pass ? undefined : 'KV entries do not match',
      resolved: `\n${resolvedLines.join('\n')}\n`,
      expected: `\n${renderKV(expected)}\n`,
    }
  },
}
```

```ts [setup.ts]
import { expect, Snapshots } from 'vitest'
import { kvAdapter } from './kv-adapter'

declare module 'vitest' {
  interface Matchers<R, T> {
    toMatchKvSnapshot: () => R
    toMatchKvInlineSnapshot: (inlineSnapshot?: string) => R
  }
}

expect.extend({
  toMatchKvSnapshot(received: unknown) {
    return Snapshots.toMatchDomainSnapshot.call(this, kvAdapter, received)
  },
  toMatchKvInlineSnapshot(received: unknown, inlineSnapshot?: string) {
    return Snapshots.toMatchDomainInlineSnapshot.call(this, kvAdapter, received, inlineSnapshot)
  },
})
```

```ts [example.test.ts]
import { expect, test } from 'vitest'

test('user data', () => {
  const user = { name: 'Alice', score: '42' }
  expect(user).toMatchKvSnapshot()
})

test('user data inline', () => {
  const user = { name: 'Alice', age: 100, score: '42' }
  expect(user).toMatchKvInlineSnapshot(`
    name=Alice
    score=/\\d+/
  `)
})
```

## Unterschiede zu Jest

Vitest bietet eine nahezu kompatible Snapshot-Funktion zu [der von Jest](https://jestjs.io/docs/snapshot-testing), mit einigen Ausnahmen:

#### 1. Der Kommentar-Header in der Snapshot-Datei ist anders

```diff
- // Jest Snapshot v1, https://goo.gl/fbAQLP
+ // Vitest Snapshot v1, https://vitest.dev/guide/snapshot.html
```

Das beeinflusst die Funktionalität nicht wirklich, kann aber Ihr Commit-Diff bei der Migration von Jest beeinflussen.

#### 2. `printBasicPrototype` ist standardmäßig `false`

Sowohl Jests als auch Vitests Snapshots werden von `pretty-format` angetrieben, aber Vitest legt seine eigenen Snapshot-Standardwerte über [`@vitest/pretty-format`](https://npmx.dev/package/@vitest/pretty-format). Insbesondere setzt Vitest `printBasicPrototype` auf `false`, um eine sauberere Snapshot-Ausgabe zu erhalten, während es in Jest <29.0.0 standardmäßig `true` ist.

```ts
import { expect, test } from 'vitest'

test('snapshot', () => {
  const bar = [
    {
      foo: 'bar',
    },
  ]

  // in Jest
  expect(bar).toMatchInlineSnapshot(`
    Array [
      Object {
        "foo": "bar",
      },
    ]
  `)

  // in Vitest
  expect(bar).toMatchInlineSnapshot(`
    [
      {
        "foo": "bar",
      },
    ]
  `)
})
```

Wir halten das für einen sinnvolleren Standard hinsichtlich Lesbarkeit und der DX insgesamt. Wenn Sie dennoch Jests Verhalten bevorzugen, können Sie Ihre Konfiguration anpassen:

```ts [vitest.config.ts]
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    snapshotFormat: {
      printBasicPrototype: true,
    },
  },
})
```

#### 3. Als Trennzeichen für eigene Meldungen wird das Winkelzeichen `>` statt des Doppelpunkts `:` verwendet

Vitest verwendet aus Gründen der Lesbarkeit das Winkelzeichen `>` statt des Doppelpunkts `:` als Trennzeichen, wenn beim Erstellen einer Snapshot-Datei eine eigene Meldung übergeben wird.

Für den folgenden Beispiel-Testcode:
```js
test('toThrowErrorMatchingSnapshot', () => {
  expect(() => {
    throw new Error('error')
  }).toThrowErrorMatchingSnapshot('hint')
})
```

In Jest lautet der Snapshot:
```console
exports[`toThrowErrorMatchingSnapshot: hint 1`] = `"error"`;
```

In Vitest lautet der entsprechende Snapshot:
```console
exports[`toThrowErrorMatchingSnapshot > hint 1`] = `[Error: error]`;
```

#### 4. Der Standard-`Error`-Snapshot ist bei `toThrowErrorMatchingSnapshot` und `toThrowErrorMatchingInlineSnapshot` anders

```js
import { expect, test } from 'vitest'

test('snapshot', () => {
  // in Jest and Vitest
  expect(new Error('error')).toMatchInlineSnapshot(`[Error: error]`)

  // Jest snapshots `Error.message` for `Error` instance
  // Vitest prints the same value as toMatchInlineSnapshot
  expect(() => {
    throw new Error('error')
  }).toThrowErrorMatchingInlineSnapshot(`"error"`) // [!code --]
  }).toThrowErrorMatchingInlineSnapshot(`[Error: error]`) // [!code ++]
})
```
