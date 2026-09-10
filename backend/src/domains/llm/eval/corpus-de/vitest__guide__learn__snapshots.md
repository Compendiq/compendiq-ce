# Snapshot-Testing

Snapshot-Tests erfassen die Ausgabe eines Codeabschnitts und speichern sie in einer Datei. Bei nachfolgenden Läufen wird die Ausgabe mit dem gespeicherten Snapshot verglichen. Ändert sich die Ausgabe, schlägt der Test fehl. Entweder ist die Änderung ein Fehler, oder der Snapshot muss aktualisiert werden.

Dieser Ansatz ist besonders nützlich, wenn Sie etwas testen, das strukturierte Ausgaben erzeugt: eine Funktion, die ein komplexes Objekt zurückgibt, eine Komponente, die HTML rendert, oder ein Error-Formatter, der mehrzeilige Meldungen produziert. Für jedes Feld oder jede Zeile manuelle Assertions zu schreiben wäre mühsam und fehleranfällig. Stattdessen erfassen Sie die gesamte Ausgabe einmal und lassen sich von Vitest melden, wenn sie sich jemals ändert.

## Ihr erster Snapshot

Um einen Snapshot-Test zu erstellen, übergeben Sie einen Wert an [`toMatchSnapshot()`](/api/expect#tomatchsnapshot):

```js
import { expect, test } from 'vitest'

function generateGreeting(name) {
  return {
    message: `Hello, ${name}!`,
    timestamp: null,
    version: 2,
  }
}

test('generates a greeting', () => {
  expect(generateGreeting('Alice')).toMatchSnapshot()
})
```

Wenn Sie diesen Test das erste Mal ausführen, existiert noch kein Snapshot zum Vergleichen, also erstellt Vitest einen. Er wird in einem Verzeichnis `__snapshots__` neben Ihrer Testdatei abgelegt:

```
__snapshots__/
  example.test.js.snap
```

Wenn Sie diese Datei öffnen, sehen Sie eine serialisierte Darstellung des Werts:

```js
exports['generates a greeting 1'] = `
{
  "message": "Hello, Alice!",
  "timestamp": null,
  "version": 2,
}
`
```

Von nun an serialisiert Vitest bei jedem Testlauf die Ausgabe von `generateGreeting('Alice')` und vergleicht sie Zeichen für Zeichen mit diesem gespeicherten Snapshot. Ändert sich die Ausgabe (weil etwa jemand das Nachrichtenformat anpasst oder die Versionsnummer erhöht), schlägt der Test fehl und zeigt ein klares Diff der Änderung.

::: tip
Checken Sie Ihre Snapshot-Dateien in die Versionsverwaltung ein. Sie dokumentieren die erwartete Ausgabe und sollten im Code-Review genauso geprüft werden wie jede andere Test-Assertion.
:::

## Inline-Snapshots

Externe Snapshot-Dateien funktionieren gut, bedeuten aber, dass Sie in eine andere Datei springen müssen, um zu sehen, wie die erwartete Ausgabe tatsächlich aussieht. Bei kleineren Werten ist es oft bequemer, den Snapshot mit [`toMatchInlineSnapshot()`](/api/expect#tomatchinlinesnapshot) direkt in der Testdatei zu halten.

Schreiben Sie die Assertion zunächst ohne Argument:

```js
test('generates a greeting', () => {
  expect(generateGreeting('Alice')).toMatchInlineSnapshot()
})
```

Wenn Sie den Test ausführen, **füllt Vitest den Snapshot automatisch** als String-Argument ein:

```js
test('generates a greeting', () => {
  expect(generateGreeting('Alice')).toMatchInlineSnapshot(`
    {
      "message": "Hello, Alice!",
      "timestamp": null,
      "version": 2,
    }
  `)
})
```

Jetzt steht die erwartete Ausgabe direkt neben dem Code, der sie erzeugt. Sie können den Test lesen und sofort verstehen, was `generateGreeting` zurückgeben soll. Ändert sich die Ausgabe, aktualisiert Vitest den String an Ort und Stelle, sodass Sie keine separaten Snapshot-Dateien verwalten müssen.

Inline-Snapshots eignen sich hervorragend für kleine, klar abgegrenzte Werte. Für große Ausgaben (etwa eine komplette HTML-Seite) passen externe Snapshots oder Datei-Snapshots besser.

::: tip
Anders als externe Snapshots erzeugen Inline-Snapshots keine separaten `.snap`-Dateien. Der erwartete Wert wird direkt in Ihrer Testdatei als Argument von `toMatchInlineSnapshot()` gespeichert, es gibt also nichts zusätzlich zu committen.
:::

## Snapshots aktualisieren

Wenn Sie die Ausgabe Ihres Codes absichtlich ändern, sind bestehende Snapshots veraltet und die Tests schlagen fehl. Das ist beabsichtigt; genau darum geht es beim Snapshot-Testing. Sobald Sie aber überprüft haben, dass die neue Ausgabe korrekt ist, müssen Sie die Snapshots aktualisieren.

Dafür gibt es mehrere Wege:

- **Im Watch-Modus**: Drücken Sie `u` im Terminal, um alle fehlgeschlagenen Snapshots zu aktualisieren
- **Über die CLI**: Führen Sie `vitest -u` oder `vitest --update` aus, um Snapshots zu aktualisieren und zu beenden
- **In VS Code**: Verwenden Sie den Befehl "Update Snapshots" am Test-Gutter-Icon der [Vitest-Erweiterung](https://vitest.dev/vscode)

```bash
vitest -u
```

Bei Inline-Snapshots ändert Vitest Ihre Testdatei direkt mit den neuen Werten. Bei externen Snapshots wird die `.snap`-Datei neu geschrieben.

::: warning
Seien Sie beim Aktualisieren von Snapshots vorsichtig. Prüfen Sie immer das Diff, um zu bestätigen, dass die Änderungen beabsichtigt und kein Fehler sind. Es ist leicht, durch blindes Drücken von `u` versehentlich eine kaputte Ausgabe zu akzeptieren.
:::

## Datei-Snapshots

Manchmal ist die getestete Ausgabe so groß, dass sich selbst eine externe `.snap`-Datei unhandlich anfühlt, oder Sie möchten den Snapshot mit ordentlichem Syntax-Highlighting in Ihrem Editor betrachten. Mit [`toMatchFileSnapshot()`](/api/expect#tomatchfilesnapshot) können Sie den Snapshot in einer Datei mit beliebiger Endung speichern:

```js
test('renders the component', async () => {
  const html = renderComponent()
  await expect(html).toMatchFileSnapshot('./fixtures/component.html')
})
```

Der Snapshot wird als einfache `.html`-Datei gespeichert, die Sie im Browser öffnen, mit Syntax-Highlighting ansehen oder mit üblichen Werkzeugen vergleichen können. Das funktioniert gut für HTML, SVG, CSS, generierten Code oder jede Ausgabe, bei der das Dateiformat für die Lesbarkeit wichtig ist.

## Wann Snapshots sinnvoll sind

Snapshots spielen ihre Stärken aus, wenn Sie mit strukturierten, serialisierbaren Ausgaben arbeiten, für die manuelle Assertions mühsam wären. Einige typische Anwendungsfälle:

- Eine Funktion, die ein komplexes Konfigurationsobjekt mit vielen verschachtelten Feldern zurückgibt
- HTML oder Markup, das von einer Renderfunktion oder Template-Engine erzeugt wird
- Fehlermeldungen mit formatierten Stacktraces oder Kontextinformationen
- CLI-Ausgaben oder Log-Meldungen mit bestimmter Formatierung
- JSON-API-Responses, bei denen Sie jede unerwartete Feldänderung erkennen wollen

Andererseits sind Snapshots nicht immer das beste Werkzeug. Ändert sich die Ausgabe häufig (weil sie zum Beispiel Zeitstempel oder zufällige IDs enthält), verbringen Sie mehr Zeit mit dem Aktualisieren von Snapshots, als sie Ihnen einsparen. Und wenn Sie sich nur für ein oder zwei bestimmte Felder interessieren, drückt eine gezielte Assertion wie [`toMatchObject`](/api/expect#tomatchobject) oder [`toHaveProperty`](/api/expect#tohaveproperty) Ihre Absicht klarer aus als ein Snapshot, der alles erfasst.

Die allgemeine Regel: Verwenden Sie Snapshots, wenn Sie sich gegen *jede* Änderung der Ausgabe absichern wollen, und gezielte Assertions, wenn Sie sich nur für *bestimmte* Eigenschaften interessieren.

## Umgang mit dynamischen Werten

Enthält Ihre Ausgabe Werte, die sich bei jedem Lauf ändern (etwa Zeitstempel oder IDs), können Sie Property-Matcher verwenden, um die Struktur festzuhalten und flüchtige Felder auszublenden. Übergeben Sie ein Objekt mit asymmetrischen Matchern als erstes Argument an `toMatchSnapshot()` oder `toMatchInlineSnapshot()`:

```js
test('user snapshot with dynamic fields', () => {
  const user = createUser('Alice')

  expect(user).toMatchSnapshot({
    id: expect.any(Number),
    createdAt: expect.any(Date),
  })
})
```

Die Felder `id` und `createdAt` werden gegen die Matcher geprüft (irgendeine Zahl, irgendein Datum), statt mit einem gespeicherten Wert verglichen zu werden. Alle anderen Felder landen wie gewohnt im Snapshot.

## Fehler-Snapshots

Eine gängige Verwendung von Inline-Snapshots ist das Erfassen von Fehlermeldungen. [`toThrowErrorMatchingInlineSnapshot`](/api/expect#tothrowerrormatchinginlinesnapshot) kombiniert `toThrow` mit `toMatchInlineSnapshot`, sodass Sie die Fehlermeldung ohne separate `.snap`-Datei als Snapshot festhalten können:

```js
test('throws on invalid input', () => {
  expect(() => parse('')).toThrowErrorMatchingInlineSnapshot(
    `[Error: Unexpected end of input at position 0]`
  )
})
```

Das ist besonders praktisch, um zu überprüfen, dass Fehlermeldungen verständlich sind und sich nicht versehentlich ändern. Wie bei anderen Inline-Snapshots füllt Vitest den String beim ersten Lauf ein und aktualisiert ihn, wenn Sie `u` drücken.

::: tip
Für eigene Snapshot-Serializer, Snapshot-Matcher und fortgeschrittene Konfiguration siehe den Guide [Snapshot](/guide/snapshot).
:::
