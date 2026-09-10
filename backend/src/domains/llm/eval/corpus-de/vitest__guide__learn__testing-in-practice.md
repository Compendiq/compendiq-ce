# Testen in der Praxis

Die vorherigen Seiten haben die Vitest-API behandelt: Assertions, Mocking, Snapshots und Lebenszyklus-Hooks von Tests. Diese Seite konzentriert sich darauf, diese Werkzeuge auf echten Code anzuwenden. Sie behandelt, wie man entscheidet, was getestet wird, wie man Tests wirkungsvoll strukturiert und wie man Testdateien organisiert, wenn ein Projekt wächst.

## Was getestet werden sollte

Wenn Sie sich hinsetzen, um Tests für eine Funktion oder ein Modul zu schreiben, denken Sie zuerst über ihren **Vertrag** nach: Was verspricht sie dem Code, der sie aufruft? Der Vertrag wird durch die Eingaben (Argumente, Konfiguration) und die Ausgaben (Rückgabewerte, Seiteneffekte, Fehler) definiert. Genau das sollten Ihre Tests überprüfen.

Betrachten Sie eine Funktion `formatPrice`:

```js [formatPrice.js]
export function formatPrice(amount, currency) {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency,
  }).format(amount)
}
```

Der Vertrag lautet hier: Gegeben einen Betrag und einen Währungscode, gib eine formatierte Preiszeichenkette zurück. Gute Tests für diese Funktion würden abdecken:

```js [formatPrice.test.js]
import { expect, test } from 'vitest'
import { formatPrice } from './formatPrice.js'

test('formats USD prices', () => {
  expect(formatPrice(10, 'USD')).toBe('$10.00')
})

test('formats EUR prices', () => {
  expect(formatPrice(10, 'EUR')).toBe('€10.00')
})

test('handles zero', () => {
  expect(formatPrice(0, 'USD')).toBe('$0.00')
})

test('handles negative amounts', () => {
  expect(formatPrice(-5.5, 'USD')).toBe('-$5.50')
})

test('rounds to two decimal places', () => {
  expect(formatPrice(10.999, 'USD')).toBe('$11.00')
})
```

Beachten Sie, was diese Tests *nicht* tun. Sie prüfen nicht, welche internen `Intl.NumberFormat`-Optionen übergeben wurden oder ob eine Zwischenvariable gesetzt wurde. Sie prüfen nur die Ausgabe.

::: tip
Eine gute Faustregel: Wenn jemand die Interna refaktoriert, die Ausgabe aber gleich bleibt – sollte der Test dann brechen? Wenn ja, testen Sie wahrscheinlich Implementierungsdetails statt Verhalten.
:::

## Einen Test strukturieren

Die meisten Tests folgen einer natürlichen dreiteiligen Struktur, manchmal "Arrange, Act, Assert" genannt:

1. **Bereiten** Sie die Daten vor, die Ihr Test braucht
2. **Rufen** Sie die Funktion auf bzw. führen Sie die zu testende Aktion aus
3. **Prüfen** Sie, dass das Ergebnis Ihren Erwartungen entspricht

```js
test('removes an item from the list', () => {
  // Set up
  const list = new ShoppingList()
  list.add('milk')
  list.add('bread')

  // Act
  list.remove('milk')

  // Check
  expect(list.getItems()).toEqual(['bread'])
})
```

Sie brauchen keine Kommentare, die jeden Abschnitt beschriften. Die Struktur ergibt sich von selbst, sobald Sie ein paar Tests geschrieben haben. Wichtig ist, dass jeder Test auf ein Verhalten fokussiert bleibt.

### Ein Verhalten pro Test

Wenn Sie feststellen, dass Sie in einem Testnamen ein "und" schreiben ("formatiert den Preis und behandelt Fehler und protokolliert das Ergebnis"), ist das ein Zeichen dafür, dass Sie ihn in separate Tests aufteilen sollten.

### Aussagekräftige Namen

Schreiben Sie Testnamen, die das Verhalten beschreiben, nicht die Implementierung. "gibt formatierten Preis für USD zurück" ist besser als "ruft Intl.NumberFormat mit den richtigen Optionen auf". Wenn ein Test fehlschlägt, sollte der Name Ihnen sagen, was kaputt ist, ohne dass Sie den Testrumpf lesen müssen.

## Randfälle testen

Nachdem Sie das Hauptverhalten abgedeckt haben, denken Sie über die Grenzen nach. Was passiert an den Rändern? Welche Eingaben sind ungewöhnlich, aber gültig? Was sollte passieren, wenn etwas schiefgeht?

Hier ist ein Beispiel mit einer Funktion `parseAge`, die eine Nutzereingabe entgegennimmt und eine Zahl zurückgibt:

```js [parseAge.js]
export function parseAge(input) {
  const age = Number(input)
  if (Number.isNaN(age) || age < 0 || age > 150) {
    throw new Error(`Invalid age: ${input}`)
  }
  return Math.floor(age)
}
```

Der Happy Path ist unkompliziert, aber in den Randfällen verstecken sich die Fehler:

```js [parseAge.test.js]
import { expect, test } from 'vitest'
import { parseAge } from './parseAge.js'

test('parses a valid age', () => {
  expect(parseAge('25')).toBe(25)
})

test('rounds down decimal ages', () => {
  expect(parseAge('25.9')).toBe(25)
})

test('handles zero', () => {
  expect(parseAge('0')).toBe(0)
})

test('handles the upper boundary', () => {
  expect(parseAge('150')).toBe(150)
})

test('throws for negative numbers', () => {
  expect(() => parseAge('-1')).toThrow('Invalid age: -1')
})

test('throws for numbers above 150', () => {
  expect(() => parseAge('151')).toThrow('Invalid age: 151')
})

test('throws for non-numeric strings', () => {
  expect(() => parseAge('abc')).toThrow('Invalid age: abc')
})

test('throws for empty string', () => {
  expect(() => parseAge('')).toThrow('Invalid age: ')
})
```

Sie müssen nicht jede mögliche Eingabe testen. Konzentrieren Sie sich auf die Grenzen (0, 150, 151, -1), die Fehlerpfade und die Arten von Eingaben, die Ihre Funktion realistischerweise erhalten könnte.

::: tip
Wenn Sie unsicher sind, ob ein Randfall relevant ist, fragen Sie sich: Könnte ein echter Nutzer oder ein echter Aufrufer ihn auslösen? Wenn ja, testen Sie ihn.
:::

### Property-based Testing

Bei Funktionen mit einer großen Bandbreite gültiger Eingaben kommt man mit dem manuellen Auswählen von Randfällen nur begrenzt weit. **Property-based Testing** ist eine Technik, bei der Sie die *Eigenschaften* beschreiben, die für jede Eingabe gelten sollen, und das Test-Framework Hunderte zufälliger Eingaben erzeugt, um eine zu finden, die das bricht.

Sie könnten zum Beispiel sagen "für jede gültige Alterszeichenkette sollte `parseAge` eine nichtnegative ganze Zahl zurückgeben" und das Werkzeug das Gegenbeispiel finden lassen. [fast-check](https://fast-check.dev/) ist eine populäre Bibliothek für Property-based Testing, die sich gut in Vitest integriert. Es ist eine fortgeschrittene Technik, aber es lohnt sich, sie zu kennen, wenn Ihre Testanforderungen wachsen.

## Wann man mocken sollte

Mocking ist ein mächtiges Werkzeug, aber man setzt es leicht zu häufig ein.

### Langsame Abhängigkeiten

Netzwerk-Requests, Dateisystemoperationen und Datenbankaufrufe können dafür sorgen, dass Ihre Tests Sekunden statt Millisekunden brauchen. Ersetzen Sie sie durch Mocks, damit die Feedbackschleife schnell bleibt.

Speziell für HTTP-Requests sollten Sie [Mock Service Worker](https://mswjs.io/) in Betracht ziehen, statt fetch direkt zu mocken. Anleitungen zur Einrichtung finden Sie im Guide [Mocking Requests](/guide/mocking/requests).

### Nicht-deterministische Werte

Wenn Ihr Code vom aktuellen Datum, einer Zufallszahl oder einem UUID-Generator abhängt, mocken Sie diese, damit Ihre Tests vorhersagbar werden. Vitest stellt [`vi.useFakeTimers()`](/api/vi#vi-usefaketimers) und [`vi.setSystemTime()`](/api/vi#vi-setsystemtime) bereit, um die Zeit in Tests zu steuern.

### Was man nicht mocken sollte

Mocken Sie nicht das, was Sie testen. Wenn Sie einen `UserService` testen, mocken Sie nicht den `UserService`. Mocken Sie seine *Abhängigkeiten* (die Datenbank, den E-Mail-Versand) und lassen Sie den Service selbst echt laufen.

Bevorzugen Sie außerdem echte Implementierungen, wenn sie schnell und zuverlässig sind. Wenn eine Abhängigkeit eine einfache In-Memory-Datenstruktur oder eine pure Funktion ist, gibt es keinen Grund, sie zu mocken. Je näher Ihre Tests an der echten Verwendung sind, desto mehr Sicherheit geben sie Ihnen.

::: tip
Greifen Sie nur dann zu Mocks, wenn das echte Ding langsam oder instabil ist oder Seiteneffekte hat, die Sie in einem Test nicht kontrollieren können.
:::

## Fehler mit Tests beheben

Wenn Sie einen Fehler finden, ist es verlockend, direkt in den Code zu springen und ihn zu beheben. Ein besserer Ansatz ist, zuerst einen fehlschlagenden Test zu schreiben, der den Fehler reproduziert, dann den Code zu reparieren und zuzusehen, wie der Test grün wird.

Das hat mehrere Vorteile. Der Test belegt, dass der Fehler echt ist und nicht nur ein Missverständnis. Er dokumentiert genau, was kaputt war. Und er verhindert, dass derselbe Fehler später zurückkehrt, weil der Test ihn abfängt, falls jemand versehentlich dasselbe Problem wieder einbaut.

So sieht das in der Praxis aus. Angenommen, Nutzer melden, dass `parseAge` abstürzt, wenn ihm eine Zeichenkette mit führenden Leerzeichen wie `" 25"` übergeben wird. Schreiben Sie zuerst einen Test, der das Problem reproduziert:

```js
test('handles leading spaces', () => {
  expect(parseAge(' 25')).toBe(25)
})
```

Führen Sie ihn aus und bestätigen Sie, dass er fehlschlägt. Jetzt wissen Sie genau, was kaputt ist, und haben ein klares Ziel. Beheben Sie die Implementierung:

```js
export function parseAge(input) {
  const age = Number(input.trim())
  // ...
}
```

Führen Sie den Test erneut aus. Er besteht. Der Fehler ist behoben, und Sie haben einen Regressionstest, der ihn abfängt, falls jemand später den `.trim()`-Aufruf entfernt.

::: tip
Wenn Sie KI-Agenten zum Beheben von Fehlern einsetzen, konfigurieren Sie sie so, dass sie demselben Prinzip folgen: erst das Problem mit einem fehlschlagenden Test reproduzieren, dann den Code reparieren. Das hindert den Agenten daran, einen Fehler zu "beheben", indem er den Test statt des Codes ändert, und gibt Ihnen Sicherheit, dass die Korrektur tatsächlich funktioniert.
:::

## Testdateien organisieren

Es gibt keinen einzig richtigen Weg, Tests zu organisieren, aber manche Muster skalieren besser als andere.

### Dateiaufbau

Der einfachste Ausgangspunkt ist eine Testdatei pro Quelldatei. Zu jeder `utils.js` gibt es direkt daneben eine `utils.test.js`. Das macht es leicht, die Tests zu einem beliebigen Stück Code zu finden, und die meisten Editoren zeigen sie im Dateibaum nebeneinander an:

```
src/
  utils.js
  utils.test.js
  formatPrice.js
  formatPrice.test.js
```

Manche Teams bevorzugen stattdessen ein separates Verzeichnis `__tests__` oder `test`. Beide Ansätze funktionieren. Wichtig ist die Konsistenz über das Projekt hinweg. Vitests [`include`](/config/include)-Muster passt standardmäßig auf beide Anordnungen.

### Gruppieren mit `describe`

Wenn ein Modul mehrere Funktionen exportiert, verwenden Sie `describe`-Blöcke, um die Tests jeder Funktion zu gruppieren. Das hält die Testausgabe geordnet und macht klar, zu welcher Funktion ein fehlschlagender Test gehört:

```js
describe('formatPrice', () => {
  test('formats USD prices', () => { /* ... */ })
  test('handles zero', () => { /* ... */ })
})

describe('parseAmount', () => {
  test('parses valid amounts', () => { /* ... */ })
  test('throws for invalid input', () => { /* ... */ })
})
```

Vermeiden Sie es, `describe`-Blöcke tiefer als eine oder zwei Ebenen zu verschachteln. Tief verschachtelte Testbäume sind schwer zu lesen und bedeuten meist, dass das Quellmodul zu viele Dinge auf einmal tut.

### Große Dateien aufteilen

Wenn ein Projekt wächst, werden manche Testdateien unweigerlich lang. Wenn eine Testdatei über einige hundert Zeilen hinauswächst, erwägen Sie, sie nach Thema oder Funktionsbereich aufzuteilen. Aus `userService.test.js` könnten zum Beispiel `userService.creation.test.js` und `userService.auth.test.js` werden. Das macht es außerdem schneller, während der Entwicklung eine Teilmenge der Tests auszuführen.

### Tests benennen

Testnamen sind wichtiger, als Sie vielleicht erwarten. Wenn ein Test in der CI fehlschlägt, ist der Name oft das Erste, was jemand liest. Namen wie "funktioniert korrekt" oder "behandelt Randfall" sagen Ihnen nicht, was kaputt ist.

Bevorzugen Sie Namen, die das konkrete Verhalten beschreiben: "gibt 0 für einen leeren Warenkorb zurück", "wirft, wenn das E-Mail-Format ungültig ist", "erhält bestehende Einträge beim Hinzufügen eines neuen". Die Testausgabe sollte sich wie eine Spezifikation dessen lesen, was das Modul tut.

## Ein durchgearbeitetes Beispiel

Fügen wir alles zusammen. Hier ist ein kleines Modul `TodoList`:

```js [todoList.js]
let nextId = 1

export function createTodoList() {
  const items = []

  return {
    add(text) {
      if (!text.trim()) {
        throw new Error('Todo text cannot be empty')
      }
      const todo = { id: nextId++, text, completed: false }
      items.push(todo)
      return todo
    },

    remove(id) {
      const index = items.findIndex(item => item.id === id)
      if (index === -1) {
        throw new Error(`Todo with id ${id} not found`)
      }
      items.splice(index, 1)
    },

    toggle(id) {
      const todo = items.find(item => item.id === id)
      if (!todo) {
        throw new Error(`Todo with id ${id} not found`)
      }
      todo.completed = !todo.completed
    },

    getAll() {
      return items
    },

    getCompleted() {
      return items.filter(item => item.completed)
    },
  }
}
```

Wenn wir uns diesen Code ansehen, können wir die zu testenden Verhaltensweisen benennen:

- Einträge hinzufügen (der Hauptzweck)
- Leere Einträge hinzufügen (sollte fehlschlagen)
- Einträge per ID entfernen
- Einträge entfernen, die nicht existieren (sollte fehlschlagen)
- Den Erledigt-Status umschalten
- Alle Einträge vs. erledigte Einträge abrufen

So könnte die Testdatei aussehen:

```js [todoList.test.js]
import { describe, expect, test } from 'vitest'
import { createTodoList } from './todoList.js'

describe('add', () => {
  test('adds a new todo', () => {
    const list = createTodoList()
    const todo = list.add('Buy groceries')

    expect(todo.text).toBe('Buy groceries')
    expect(todo.completed).toBe(false)
    expect(list.getAll()).toHaveLength(1)
  })

  test('assigns unique IDs to each todo', () => {
    const list = createTodoList()
    const first = list.add('First')
    const second = list.add('Second')

    expect(first.id).not.toBe(second.id)
  })

  test('throws when text is empty', () => {
    const list = createTodoList()
    expect(() => list.add('')).toThrow('Todo text cannot be empty')
  })

  test('throws when text is only whitespace', () => {
    const list = createTodoList()
    expect(() => list.add('   ')).toThrow('Todo text cannot be empty')
  })
})

describe('remove', () => {
  test('removes a todo by ID', () => {
    const list = createTodoList()
    const todo = list.add('Buy groceries')

    list.remove(todo.id)

    expect(list.getAll()).toHaveLength(0)
  })

  test('keeps other items when removing one', () => {
    const list = createTodoList()
    const first = list.add('First')
    list.add('Second')

    list.remove(first.id)

    expect(list.getAll()).toHaveLength(1)
    expect(list.getAll()[0].text).toBe('Second')
  })

  test('throws when ID does not exist', () => {
    const list = createTodoList()
    expect(() => list.remove(999)).toThrow('Todo with id 999 not found')
  })
})

describe('toggle', () => {
  test('marks a todo as completed', () => {
    const list = createTodoList()
    const todo = list.add('Buy groceries')

    list.toggle(todo.id)

    expect(list.getAll()[0].completed).toBe(true)
  })

  test('toggles back to incomplete', () => {
    const list = createTodoList()
    const todo = list.add('Buy groceries')

    list.toggle(todo.id)
    list.toggle(todo.id)

    expect(list.getAll()[0].completed).toBe(false)
  })

  test('throws when ID does not exist', () => {
    const list = createTodoList()
    expect(() => list.toggle(999)).toThrow('Todo with id 999 not found')
  })
})

describe('getCompleted', () => {
  test('returns only completed todos', () => {
    const list = createTodoList()
    const buy = list.add('Buy groceries')
    list.add('Clean house')
    list.toggle(buy.id)

    const completed = list.getCompleted()

    expect(completed).toHaveLength(1)
    expect(completed[0].text).toBe('Buy groceries')
  })

  test('returns empty array when nothing is completed', () => {
    const list = createTodoList()
    list.add('Buy groceries')

    expect(list.getCompleted()).toHaveLength(0)
  })
})
```

Jeder `describe`-Block konzentriert sich auf eine Methode. Jeder Test überprüft ein bestimmtes Verhalten. Die Testnamen lesen sich wie eine Spezifikation dessen, was das Modul tut. Und wenn einer dieser Tests fehlschlägt, sagen Ihnen der Name und die Assertion genau, was kaputt ist.

::: tip
Beachten Sie, dass wir in jedem Test ein frisches `createTodoList()` erzeugen. Das hält die Tests unabhängig, was bedeutet, dass sie in beliebiger Reihenfolge laufen können, ohne sich gegenseitig zu beeinflussen. Wenn Sie feststellen, dass Sie in jedem Test dasselbe Setup wiederholen, ist das ein guter Kandidat für [`beforeEach`](/api/hooks#beforeeach) oder eine [`test.extend`](/guide/test-context#extend-test-context)-Fixture.
:::

::: details Was ist mit `nextId`?
Der Zähler `nextId` am Anfang des Moduls wird über alle Aufrufe von `createTodoList()` hinweg geteilt, auch über Tests hinweg. Das bedeutet, dass IDs nicht vorhersagbar sind: Ein Test bekommt womöglich die IDs 1 und 2, ein anderer 3 und 4, je nach Ausführungsreihenfolge. Hier funktioniert das problemlos, weil die Tests nur *relative* Eindeutigkeit prüfen (`first.id !== second.id`), nicht konkrete ID-Werte. Würde ein Test `expect(todo.id).toBe(1)` behaupten, würde er brechen, je nachdem, welche Tests davor liefen. Wenn Sie geteilten Zustand auf Modulebene wie diesen haben, stellen Sie sicher, dass Ihre Tests nicht von seinem konkreten Wert abhängen.
:::

---

Wenn Sie eine Webanwendung bauen und Komponenten in einer echten Browser-Umgebung testen möchten, schauen Sie sich [Component Testing](/guide/browser/component-testing) an, um React, Vue, Svelte und andere UI-Frameworks zu testen.
