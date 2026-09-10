# Tests mit KI schreiben

KI-Coding-Assistenten können Ihnen helfen, Tests schneller zu schreiben, aber die Qualität der Ausgabe hängt stark davon ab, was Sie hineingeben. Ein vager Prompt erzeugt vage Tests. Ein präziser Prompt mit dem richtigen Kontext erzeugt Tests, die es tatsächlich wert sind, behalten zu werden.

Diese Seite behandelt, wie Sie guten Testcode von KI-Werkzeugen erhalten und worauf Sie beim Prüfen der Ergebnisse achten sollten.

## Kontext bereitstellen

Das Wichtigste, was Sie tun können, ist, der KI genug Kontext zu geben, damit sie versteht, was sie testet.

Beginnen Sie mit der Quelldatei selbst. Die KI muss die tatsächliche Implementierung sehen, nicht nur eine Beschreibung dessen, was die Funktion tut. Geben Sie die vollständige Datei mit oder zumindest die zu testende Funktion samt ihrer Importe und Typen.

Teilen Sie bestehende Testdateien aus demselben Projekt. Das hilft der KI, Ihre Konventionen zu treffen: ob Sie `test` oder `it` verwenden, wie Sie `describe`-Blöcke strukturieren, ob Sie `test.extend`-Fixtures oder `beforeEach` bevorzugen und wie Sie Ihre Tests benennen. KI-Werkzeuge sind gut im Erkennen von Mustern, aber sie brauchen Muster, an denen sie sich orientieren können.

Fügen Sie Ihre Vitest-Konfiguration hinzu, besonders wenn Sie [`globals`](/config/globals) aktiviert, eine eigene [`environment`](/config/environment) gesetzt oder [`setupFiles`](/config/setupfiles) konfiguriert haben. Ohne diesen Kontext erzeugt die KI womöglich unnötige Importe, verwendet die falsche Testumgebung oder übersieht Setup-Schritte, von denen Ihre Tests abhängen.

Wenn der zu testende Code Abhängigkeiten hat, die gemockt werden müssen, teilen Sie auch diese Dateien (oder zumindest ihre Typsignaturen). Die KI kann keinen brauchbaren Mock für einen Datenbank-Client schreiben, den sie nie gesehen hat.

::: tip
Wenn Ihr Projekt eine `AGENTS.md` oder eine ähnliche Datei mit Coding-Konventionen hat, geben Sie diese ebenfalls mit. Viele KI-Werkzeuge erkennen solche Dateien automatisch und befolgen die dort definierten Regeln.
:::

## Gute Prompts schreiben

Präzise Prompts erzeugen bessere Tests als generische. Vergleichen Sie diese beiden:

**Vage:** "Schreibe Tests für `userService.js`"

Das erzeugt Tests, aber sie werden vermutlich oberflächlich sein: ein Happy-Path-Test pro Funktion, minimale Abdeckung von Randfällen und generische Testnamen.

**Besser:** "Schreibe Tests für die Funktion `createUser` in `userService.js`. Decke Validierungsfehler ab (fehlender Name, ungültiges E-Mail-Format, doppelte E-Mail-Adresse), den erfolgreichen Erstellungspfad, und überprüfe, dass das Passwort vor dem Speichern gehasht wird."

Das sagt der KI genau, auf welche Funktion sie sich konzentrieren soll, welche Szenarien wichtig sind und welches Verhalten zu überprüfen ist. Die Ausgabe wird gründlicher und relevanter sein.

### Tipps für bessere Prompts

- Fragen Sie explizit nach Randfällen. "Füge Tests für leere Eingaben, Grenzwerte und Fehlerbehandlung hinzu" erzeugt eine umfassendere Abdeckung, als es dem Ermessen der KI zu überlassen. Ohne diesen Anstoß erzeugen die meisten Werkzeuge eine Handvoll Happy-Path-Tests und hören dann auf.
- Nennen Sie bestimmte Vitest-Funktionen, wenn Sie sie verwendet haben wollen. "Verwende `toMatchInlineSnapshot` für die Fehlermeldungen" oder "verwende `test.for` für die verschiedenen Währungsformate" lenkt die KI zu den richtigen Werkzeugen, statt sie auf repetitive Copy-Paste-Tests zurückfallen zu lassen.
- Wenn Sie asynchronen Code testen, sagen Sie das. "Die Funktion gibt ein Promise zurück" oder "das ruft eine externe API auf" hilft der KI, `async`/`await` und passende Matcher wie `.resolves` und `.rejects` zu verwenden.
- Sagen Sie der KI, was sie *nicht* tun soll. "Teste gegen die echte Implementierung, mocke keine Module" oder "verwende keine Snapshot-Tests" verhindert gängige Standardverhalten, die Sie nicht wollen. KI-Werkzeuge neigen zum Übermocken, und eine explizite Einschränkung verhindert das.
- Beschreiben Sie die gewünschte Teststruktur. "Gruppiere Tests nach Methode mit `describe`-Blöcken" oder "verwende `test.extend`-Fixtures für die Datenbankverbindung statt `beforeEach`" erspart Ihnen das nachträgliche Umstrukturieren der Ausgabe.
- Verweisen Sie auf bestehende Tests, wenn Sie um Ergänzungen bitten. "Folge demselben Stil wie die Tests in `auth.test.js`" ist wirkungsvoller, als den Stil von Grund auf zu beschreiben. Die KI übernimmt Namenskonventionen, Assertion-Muster und Importstile aus dem Beispiel.
- Wenn das erste Ergebnis nicht passt, iterieren Sie. "Diese Tests hängen zu sehr an Implementierungsdetails. Schreibe sie so um, dass sie nur die Rückgabewerte und geworfenen Fehler prüfen" ist eine legitime Anschlussanweisung. Verfeinerung im Dialog liefert oft bessere Ergebnisse, als von Anfang an den perfekten Prompt schreiben zu wollen.

## KI-generierte Tests prüfen

KI-generierte Tests können auf den ersten Blick überzeugend wirken und dennoch Probleme haben. Folgendes sollten Sie prüfen, bevor Sie sie committen.

### Prüfen die Tests wirklich etwas Sinnvolles?

Achten Sie auf Tests, die eine Funktion aufrufen und nur prüfen, dass sie keinen Fehler wirft, oder auf Tests, die gegen den Mock selbst statt gegen das Verhalten assertieren. Ein Test wie dieser vermittelt falsche Sicherheit:

```js
test('creates a user', () => {
  const user = createUser('Alice', 'alice@example.com')
  expect(user).toBeDefined() // this passes for almost anything
})
```

Eine bessere Assertion prüft die tatsächlichen Eigenschaften:

```js
test('creates a user with the correct fields', () => {
  const user = createUser('Alice', 'alice@example.com')
  expect(user).toMatchObject({
    name: 'Alice',
    email: 'alice@example.com',
  })
  expect(user.id).toBeTypeOf('string')
})
```

### Testen sie Verhalten oder Implementierung?

KI neigt zum Übermocken. Wenn Sie einen Test sehen, der jede Abhängigkeit mockt und dann prüft, dass bestimmte interne Methoden in einer bestimmten Reihenfolge aufgerufen wurden, dann testet er Implementierungsdetails. Solche Tests brechen bei jedem Refactoring, selbst wenn das Verhalten gleich bleibt.

Fragen Sie sich: Wenn jemand die Interna ändert, die Funktion aber weiterhin das korrekte Ergebnis liefert, würde dieser Test brechen? Wenn ja, ist er wahrscheinlich zu eng an die Implementierung gekoppelt. Mehr zu dieser Unterscheidung finden Sie unter [Testing in Practice](/guide/learn/testing-in-practice#what-to-test).

### Laufen die Tests überhaupt?

Führen Sie die Tests immer aus, bevor Sie sie committen. KI-generierte Tests können Importfehler enthalten, auf nicht existierende Funktionen verweisen oder APIs falsch verwenden. Ein Test, der im Chatfenster korrekt aussieht, kann sofort fehlschlagen, wenn Sie ihn tatsächlich ausführen:

```bash
vitest run src/userService.test.js
```

### Gibt es echte Randfälle?

KI-Werkzeuge neigen dazu, Happy-Path-Tests zu erzeugen und die schwierigen Fälle auszulassen. Fragen Sie sich nach dem Durchsehen der generierten Tests: Was passiert bei leerer Eingabe? Was bei `null` oder `undefined`? Was, wenn der Netzwerk-Request fehlschlägt? Was, wenn die Liste leer ist?

Wenn diese Szenarien nicht abgedeckt sind, bitten Sie die KI, sie zu ergänzen, oder schreiben Sie sie selbst.

## An der Ausgabe weiterarbeiten

Behandeln Sie KI-generierte Tests als ersten Entwurf, nicht als fertiges Produkt. Ein guter Arbeitsablauf sieht so aus:

1. **Generieren** Sie die ersten Tests mit einem präzisen Prompt und gutem Kontext
2. **Führen** Sie sie sofort aus, um Fehler zu finden
3. **Prüfen** Sie jeden Test auf die oben beschriebenen Probleme
4. **Bitten Sie um Überarbeitungen**, wenn ganze Abschnitte verbessert werden müssen ("diese Tests mocken zu viel, schreibe sie so um, dass sie die tatsächliche Integration mit dem Datenbankmodul testen")
5. **Bearbeiten Sie manuell** für kleine Korrekturen, statt für jedes Detail erneut zu prompten

Mit der Zeit, wenn die KI mehr von Ihrer Codebasis und Ihren Testmustern sieht, verbessert sich ihre Ausgabe. Die frühen Tests in Ihrem Projekt geben das Muster für alles Folgende vor – es lohnt sich also, diese richtig zu machen.

## Häufige Fallstricke

### Falsche APIs

Das häufigste Problem bei KI-generierten Vitest-Tests ist die Verwendung der falschen API-Oberfläche. KI-Modelle werden mit sehr viel Jest-Code trainiert, sodass sie manchmal `jest.fn()` statt `vi.fn()` oder `jest.mock` statt `vi.mock` erzeugen. Das schlägt sofort fehl.

Ein verwandtes Problem sind Importe: Wenn Ihre Konfiguration `globals: true` setzt, fügt die KI möglicherweise trotzdem `import { test, expect } from 'vitest'` hinzu (harmlos, aber unnötig) – oder umgekehrt erzeugt sie Tests ohne Importe, obwohl Globals nicht aktiviert sind. Wenn Sie immer wieder Jest-APIs sehen, verweisen Sie die KI auf die [Vitest-API-Referenz](/api/vi) oder nehmen Sie sie in den Kontext auf.

### Aufräumen von Mocks

KI-generierte Tests richten oft Spies mit `vi.spyOn` ein oder ersetzen Module mit `vi.mock`, stellen sie aber nie wieder her. Wenn Ihre Konfiguration nicht [`restoreMocks: true`](/config/restoremocks) enthält, sickern diese Mocks zwischen Tests durch und verursachen verwirrende Fehlschläge. Der einfachste Weg ist, diese Konfigurationsoption global zu aktivieren.

In diesem Zusammenhang neigen KI-Werkzeuge dazu, Module über String-Pfade zu mocken (`vi.mock('./module.js')`), obwohl die `import()`-Form (`vi.mock(import('./module.js'))`) aus Gründen der Typsicherheit und des automatischen Refactorings vorzuziehen ist. Unter [Mock Functions](/guide/learn/mock-functions#mocking-modules) erfahren Sie, warum das wichtig ist.

### Umständliche Testnamen

KI erzeugt tendenziell Namen wie "should correctly return the formatted price string when given a valid positive number and a supported currency code." Solche Namen sind schwer zu überfliegen, wenn man Dutzende Tests hat. Kürzere Namen, die das Verhalten beschreiben, funktionieren besser: "formats USD prices", "throws for negative amounts", "returns empty array when no items match."

### Watch-Modus

Vitest läuft standardmäßig im Watch-Modus, wartet auf Dateiänderungen und führt Tests interaktiv erneut aus. Vitest versucht, CI- sowie nicht-interaktive und Agenten-Umgebungen zu erkennen und den Watch-Modus automatisch zu deaktivieren, aber diese Erkennung kann unzuverlässig sein.

Wenn Sie einen KI-Agenten Tests ausführen lassen, verwenden Sie immer `vitest run` oder `vitest --no-watch`, damit der Prozess nach Abschluss der Tests beendet wird.
