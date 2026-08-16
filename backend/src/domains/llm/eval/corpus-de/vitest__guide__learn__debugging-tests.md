# Fehlschlagende Tests debuggen

Diese Seite behandelt, wie Sie Testfehlern in Vitest auf den Grund gehen: die Fehlerausgabe lesen, Probleme eingrenzen, häufige Ursachen erkennen und die verfügbaren Debugging-Werkzeuge nutzen.

## Den Fehler lesen

Wenn ein Test fehlschlägt, liefert Ihnen Vitest mehrere Informationen. Sehen wir uns einen echten Fehlschlag an und schlüsseln ihn auf:

<<< ./snippets/debug-output-fail.ansi

Das ist eine Menge, aber jeder Teil sagt Ihnen etwas:

**Die Kopfzeile** (`FAIL src/user.test.js > createUser > sets the default role`) sagt Ihnen, welche Datei, welcher describe-Block und welcher Test fehlgeschlagen ist. Das ist der vollständige Pfad im Testbaum.

**Die Assertion-Meldung** (`expected { ... } to deeply equal { ... }`) sagt Ihnen, welche Art von Prüfung fehlgeschlagen ist, und zeigt die beiden verglichenen Werte.

**Der Diff** zeigt genau, was sich unterscheidet. Zeilen, die mit <code class="diff-add">+</code> beginnen, sind das, was Sie tatsächlich erhalten haben; Zeilen, die mit <code class="diff-remove">-</code> beginnen, sind das, was Sie erwartet haben. In diesem Fall war die Rolle <code class="diff-add">"viewer"</code>, der Test erwartete aber <code class="diff-remove">"member"</code>.

**Der Code-Ausschnitt** zeigt die genaue Zeile sowie einige umliegende Zeilen, mit einem Zirkumflex (`^`), das auf die fehlschlagende Assertion zeigt. In den meisten Terminals und IDEs können Sie auf den Dateipfad klicken, um direkt dorthin zu springen.

An diesem Punkt lautet die Frage: Hat sich der Code geändert (vielleicht wurde die Standardrolle absichtlich auf `"viewer"` aktualisiert), oder ist der Test falsch? Sehen Sie im Quellcode von `createUser` nach, um das herauszufinden. Wurde der Standardwert absichtlich geändert, passen Sie den Test an. Wenn nicht, haben Sie einen Bug gefunden.

## Das Problem eingrenzen

Wenn ein Test fehlschlägt und die Ursache nicht sofort klar ist, besteht der erste Schritt darin, ihn zu isolieren. Führen Sie nur diesen einen Test aus, ohne den Rest Ihrer Suite:

```bash
# Run only the failing test file
vitest src/user.test.js

# Run only tests matching a name pattern
vitest -t "sets the default role"

# Combine both for maximum precision
vitest src/user.test.js -t "sets the default role"
```

Sie können auch [`.only`](/api/test#only) am Test selbst ergänzen:

```js
test.only('sets the default role', () => {
  // only this test runs in the file
})
```

Wenn Sie viele Fehlschläge haben und sich auf den ersten konzentrieren möchten, nutzen Sie [`--bail`](/config/bail), um nach einer festgelegten Anzahl von Fehlschlägen abzubrechen:

```bash
vitest --bail 1
```

Wenn der Test allein ausgeführt grün ist, gemeinsam mit anderen aber fehlschlägt, haben Sie ein Problem mit der Testisolation (mehr dazu weiter unten). Schlägt er auch allein fehl, liegt das Problem im Test selbst oder in dem Code, den er testet.

## Häufige Fehlerursachen

### Geteilter Zustand zwischen Tests

Das ist eines der häufigsten und ärgerlichsten Probleme. Ein Test ist grün, wenn Sie ihn allein ausführen, schlägt aber fehl, wenn die komplette Suite läuft. Die übliche Ursache ist, dass ein anderer Test geteilten Zustand verändert (eine globale Variable, einen Cache auf Modulebene, eine Datenbank) und hinter sich nicht aufräumt.

```js
// This is a problem: `users` is shared between tests
const users = []

test('adds a user', () => {
  users.push('Alice')
  expect(users).toEqual(['Alice'])
})

test('starts empty', () => {
  // This fails because 'Alice' is still in the array!
  expect(users).toEqual([])
})
```

Die Lösung besteht darin, den Zustand vor jedem Test mit [`beforeEach`](/api/hooks#beforeeach) zurückzusetzen — oder, noch besser, mit [`test.extend`](/guide/test-context#extend-test-context) automatisch für jeden Test frischen Zustand zu erzeugen:

```js
const test = baseTest.extend('users', () => [])

test('adds a user', ({ users }) => {
  users.push('Alice')
  expect(users).toEqual(['Alice'])
})

test('starts empty', ({ users }) => {
  // Passes: each test gets its own array
  expect(users).toEqual([])
})
```

### Async-Probleme

Tests mit Promises können sporadisch oder auf verwirrende Weise fehlschlagen, wenn der asynchrone Ablauf nicht korrekt behandelt wird. Der häufigste Fehler ist ein vergessenes `await`:

```js
// This test always passes, even if fetchUser rejects!
test('fetches user', () => {
  // Missing await: the test finishes before the promise settles
  expect(fetchUser(1)).resolves.toMatchObject({ name: 'Alice' })
})
```

Vitest warnt Sie am Ende des Tests normalerweise vor nicht abgewarteten Assertions. Wenn Sie diese Warnung sehen, ergänzen Sie das fehlende `await`:

```js
test('fetches user', async () => {
  await expect(fetchUser(1)).resolves.toMatchObject({ name: 'Alice' })
})
```

Wenn ein Test hängt und schließlich in einen Timeout läuft, bedeutet das üblicherweise, dass ein Promise nie aufgelöst wird. Suchen Sie nach fehlenden Callbacks, nicht erfüllten Bedingungen oder Deadlocks in dem Code, den Sie testen.

### Veraltete Snapshots

Wenn Sie [Snapshot-Tests](/guide/learn/snapshots) verwenden und die Ausgabe Ihres Codes absichtlich geändert haben, sind die vorhandenen Snapshots veraltet. Der Test schlägt fehl und zeigt einen Diff zwischen dem alten Snapshot und der neuen Ausgabe.

Das ist zu erwarten. Prüfen Sie den Diff, um zu bestätigen, dass die Änderungen korrekt sind, und aktualisieren Sie die Snapshots anschließend, indem Sie im Watch-Modus `u` drücken oder `vitest -u` ausführen.

### Falsche Testumgebung

Wenn Ihr Code auf Browser-APIs wie `document` oder `window` zugreift und Sie Fehler wie „document is not defined“ sehen, läuft Ihr Test in der Node-Umgebung (dem Standard). Sie können über die Konfigurationsoption [`environment`](/config/environment) in eine browserähnliche Umgebung wechseln — oder besser noch den [Browser-Modus](/guide/browser/) nutzen, der Tests in einem echten Browser ausführt.

### Nicht aufgeräumte Mocks

Wenn ein Mock aus einem Test in einen anderen überschwappt, erhalten Sie unerwartetes Verhalten. Ein `vi.spyOn`, das den Rückgabewert einer Methode überschreibt, bleibt beispielsweise im nächsten Test bestehen, sofern es nicht wiederhergestellt wird.

Am einfachsten aktivieren Sie das automatische Wiederherstellen von Mocks in Ihrer Konfiguration:

```js [vitest.config.js]
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    restoreMocks: true,
  },
})
```

Dadurch wird nach jedem Test [`mockRestore()`](/api/mock#mockrestore) auf jedem Mock aufgerufen. Weitere Details finden Sie im Tutorial [Mock-Funktionen](/guide/learn/mock-functions#resetting-mocks).

## Debugging-Werkzeuge

### Konsolenausgaben

Es spricht nichts dagegen, `console.log` in Ihren Tests zu ergänzen. Das ist der schnellste Weg, Werte zu inspizieren und zu verstehen, was passiert:

```js
test('transforms data correctly', () => {
  const input = getData()
  console.log('input:', input)

  const result = transform(input)
  console.log('result:', result)

  expect(result).toMatchObject({ status: 'ok' })
})
```

Vitest zeigt Konsolenausgaben direkt bei den Testergebnissen an, sodass Sie sehen, welcher Test welche Ausgabe erzeugt hat.

### Vitest UI

Für einen visuellen Überblick über Ihre Testsuite führen Sie Vitest mit dem Flag `--ui` aus:

```bash
vitest --ui
```

Damit öffnet sich ein browserbasiertes Dashboard, in dem Sie alle Ihre Tests, deren Status und deren Ausgabe sehen. Es enthält außerdem einen Modulgraphen, der zeigt, wie Ihre Dateien zusammenhängen — hilfreich, um zu verstehen, warum eine Änderung in einer Datei Fehlschläge in einer anderen verursacht. Weitere Details finden Sie im Leitfaden [Vitest UI](/guide/ui).

### VS-Code-Erweiterung

Mit der [Vitest-VS-Code-Erweiterung](https://vitest.dev/vscode) können Sie einzelne Tests direkt aus Ihrem Editor heraus ausführen und debuggen. Sie können neben jedem Test auf eine „Play“-Schaltfläche klicken, Breakpoints setzen und im VS-Code-Debugger durch den Code steppen. Das ist oft schneller, als zwischen Terminal und Editor hin und her zu wechseln.

### Ausführliche Ausgabe

Wenn die Standardausgabe nicht genug Details zeigt, verwenden Sie den Verbose-Reporter:

```bash
vitest --reporter=verbose
```

Er zeigt jeden Test einzeln (nicht nur die Dateien), was helfen kann, Muster darin zu erkennen, welche Tests grün und welche rot sind.

### Einen Debugger anhängen

Für komplexere Probleme, bei denen Sie Zeile für Zeile durch den Code steppen müssen, können Sie Vitest mit dem Flag `--inspect-brk` ausführen und einen Debugger anhängen. Das Flag `--no-file-parallelism` sorgt dafür, dass Tests im Hauptthread laufen, damit Breakpoints zuverlässig funktionieren:

```bash
vitest --inspect-brk --no-file-parallelism
```

Hängen Sie sich anschließend aus VS Code, IntelliJ oder den Chrome DevTools (`chrome://inspect`) an. Detaillierte Einrichtungsanleitungen für die einzelnen Editoren finden Sie im Leitfaden [Debugging](/guide/debugging).

## Hilfe bekommen

Wenn Sie nicht weiterkommen, helfen diese Ressourcen:

- Die Seite [Häufige Fehler](/guide/common-errors) behandelt konkrete Fehlermeldungen und ihre Lösungen
- [GitHub Issues](https://github.com/vitest-dev/vitest/issues), um nach bekannten Bugs und Workarounds zu suchen
- Die [Discord-Community](https://chat.vitest.dev) für Hilfe in Echtzeit von anderen Vitest-Nutzern und den Maintainern

<style>
.vp-doc code.diff-add {
  color: var(--vp-c-green-2) !important;
}
.vp-doc code.diff-remove {
  color: var(--vp-c-red-2) !important;
}
</style>
