# Lebenszyklus eines Testlaufs

::: tip
Suchen Sie eine praxisnahe Einführung zu `beforeEach`, `afterEach` und anderen Hooks? Siehe das Tutorial [Setup and Teardown](/guide/learn/setup-teardown).
:::

Den Lebenszyklus eines Testlaufs zu verstehen ist entscheidend, um wirkungsvolle Tests zu schreiben, Probleme zu debuggen und Ihre Test-Suite zu optimieren. Dieser Guide erklärt, wann und in welcher Reihenfolge die verschiedenen Lebenszyklusphasen in Vitest ablaufen – von der Initialisierung bis zum Teardown.

## Überblick

Ein typischer Vitest-Testlauf durchläuft diese Hauptphasen:

1. **Initialisierung:** Laden der Konfiguration und Einrichten der Projekte
2. **Global Setup:** Einmaliges Setup, bevor irgendwelche Tests laufen
3. **Worker-Erzeugung:** Test-Worker werden basierend auf der [Pool](/config/pool)-Konfiguration gestartet
4. **Erfassen der Testdateien:** Testdateien werden ermittelt und organisiert
5. **Testausführung:** Tests laufen mit ihren Hooks und Assertions
6. **Reporting:** Ergebnisse werden gesammelt und gemeldet
7. **Global Teardown:** Abschließendes Aufräumen, nachdem alle Tests abgeschlossen sind

Die Phasen 4–6 laufen einmal pro Testdatei, werden also über Ihre Test-Suite hinweg mehrfach ausgeführt und können bei mehr als [1 Worker](/config/maxworkers) auch parallel über verschiedene Dateien hinweg laufen.

## Die Lebenszyklusphasen im Detail

### 1. Initialisierungsphase

Wenn Sie `vitest` ausführen, lädt das Framework zunächst Ihre Konfiguration und bereitet die Testumgebung vor.

**Was passiert:**
- [Kommandozeilenargumente](/guide/cli) werden geparst
- Die [Konfigurationsdatei](/config/) wird geladen
- Die Projektstruktur wird validiert

Diese Phase kann erneut ablaufen, wenn sich die Konfigurationsdatei oder einer ihrer Importe ändert.

**Geltungsbereich:** Hauptprozess (bevor Test-Worker erzeugt werden)

### 2. Global-Setup-Phase

Wenn Sie [`globalSetup`](/config/globalsetup)-Dateien konfiguriert haben, laufen diese einmal, bevor Test-Worker erzeugt werden.

**Was passiert:**
- Die `setup()`-Funktionen (oder die exportierte `default`-Funktion) aus den Global-Setup-Dateien werden nacheinander ausgeführt
- Mehrere Global-Setup-Dateien laufen in der Reihenfolge, in der sie definiert sind

**Geltungsbereich:** Hauptprozess (getrennt von den Test-Workern)

**Wichtige Hinweise:**
- Global Setup läuft in einem **anderen globalen Scope** als Ihre Tests
- Tests können nicht auf Variablen zugreifen, die im Global Setup definiert wurden (verwenden Sie stattdessen [`provide`/`inject`](/config/provide))
- Global Setup läuft nur, wenn mindestens ein Test in der Warteschlange steht

```ts [globalSetup.ts]
export function setup(project) {
  // Runs once before all tests
  console.log('Global setup')

  // Share data with tests
  project.provide('apiUrl', 'http://localhost:3000')
}

export function teardown() {
  // Runs once after all tests
  console.log('Global teardown')
}
```

### 3. Phase der Worker-Erzeugung

Nach Abschluss des Global Setup erzeugt Vitest Test-Worker basierend auf Ihrer [Pool-Konfiguration](/config/pool).

**Was passiert:**
- Worker werden gemäß der Einstellung `browser.enabled` oder `pool` (`threads`, `forks`, `vmThreads` oder `vmForks`) gestartet
- Jeder Worker erhält seine eigene isolierte Umgebung (sofern [Isolation](/config/isolate) nicht deaktiviert ist)
- Standardmäßig werden Worker nicht wiederverwendet, um Isolation zu gewährleisten. Worker werden nur wiederverwendet, wenn:
  - [Isolation](/config/isolate) deaktiviert ist
  - ODER der Pool `vmThreads` oder `vmForks` ist, weil die [VM](https://nodejs.org/api/vm.html) genügend Isolation bietet

**Geltungsbereich:** Worker-Prozesse/-Threads

### 4. Setup-Phase der Testdatei

Vor der Ausführung jeder Testdatei werden die [Setup-Dateien](/config/setupfiles) ausgeführt.

**Was passiert:**
- Setup-Dateien laufen im selben Prozess wie Ihre Tests
- Standardmäßig laufen Setup-Dateien **parallel** (konfigurierbar über [`sequence.setupFiles`](/config/sequence#sequence-setupfiles))
- Setup-Dateien werden vor **jeder Testdatei** ausgeführt
- Jeder globale _Zustand_ und jede Konfiguration kann hier initialisiert werden

**Geltungsbereich:** Worker-Prozess (derselbe wie Ihre Tests)

**Wichtige Hinweise:**
- Wenn [Isolation](/config/isolate) deaktiviert ist, laufen Setup-Dateien trotzdem vor jeder Testdatei erneut, um Seiteneffekte auszulösen, aber importierte Module werden zwischengespeichert
- Das Bearbeiten einer Setup-Datei löst im Watch-Modus einen erneuten Lauf aller Tests aus

```ts [setupFile.ts]
import { afterEach } from 'vitest'

// Runs before each test file
console.log('Setup file executing')

// Register hooks that apply to all tests
afterEach(() => {
  cleanup()
})
```

### 5. Phase der Testerfassung und -ausführung

Das ist die Hauptphase, in der Ihre Tests tatsächlich laufen.

#### Ausführungsreihenfolge der Testdateien

Testdateien werden gemäß Ihrer Konfiguration ausgeführt:

- **Standardmäßig sequenziell** innerhalb eines Workers
- Dateien laufen über verschiedene Worker hinweg **parallel**, konfiguriert über [`maxWorkers`](/config/maxworkers)
- Die Reihenfolge kann mit [`sequence.shuffle`](/config/sequence#sequence-shuffle) zufällig gemacht oder mit [`sequence.sequencer`](/config/sequence#sequence-sequencer) feinjustiert werden
- Lang laufende Tests starten typischerweise früher (basierend auf dem Cache), sofern Shuffle nicht aktiviert ist

#### Innerhalb jeder Testdatei

Die Ausführung folgt dieser Reihenfolge:

1. **Code auf Dateiebene:** Sämtlicher Code außerhalb von `describe`-Blöcken läuft sofort
2. **Testerfassung:** `describe`-Blöcke werden verarbeitet, und Tests werden als Seiteneffekt des Imports der Testdatei registriert
3. **[`aroundAll`](/api/hooks#aroundall)-Hooks:** Umschließen alle Tests der Suite (müssen `runSuite()` aufrufen)
4. **[`beforeAll`](/api/hooks#beforeall)-Hooks:** Laufen einmal vor allen Tests der Suite
5. **Für jeden Test:**
   - [`aroundEach`](/api/hooks#aroundeach)-Hooks umschließen den Test (müssen `runTest()` aufrufen)
   - `beforeEach`-Hooks werden ausgeführt (in der definierten Reihenfolge oder gemäß [`sequence.hooks`](/config/sequence#sequence-hooks))
   - Die Testfunktion wird ausgeführt
   - `afterEach`-Hooks werden ausgeführt (standardmäßig in umgekehrter Reihenfolge mit `sequence.hooks: 'stack'`)
   - Von `beforeEach`-Hooks zurückgegebene Aufräumfunktionen werden ausgeführt (standardmäßig in umgekehrter Reihenfolge mit `sequence.hooks: 'stack'`)
   - [`onTestFinished`](/api/hooks#ontestfinished)-Callbacks laufen (immer in umgekehrter Reihenfolge)
   - Wenn der Test fehlgeschlagen ist: [`onTestFailed`](/api/hooks#ontestfailed)-Callbacks laufen
   - Hinweis: Wenn `repeats` oder `retry` gesetzt sind, werden alle diese Schritte erneut ausgeführt
6. **[`afterAll`](/api/hooks#afterall)-Hooks:** Laufen einmal, nachdem alle Tests der Suite abgeschlossen sind
7. **Von `beforeAll`-Hooks zurückgegebene Aufräumfunktionen:** Laufen einmal, nachdem alle Tests der Suite abgeschlossen sind

**Beispielhafter Ausführungsablauf:**

```ts
// This runs immediately (collection phase)
console.log('File loaded')

describe('User API', () => {
  // This runs immediately (collection phase)
  console.log('Suite defined')

  aroundAll(async (runSuite) => {
    // Wraps around all tests in this suite
    console.log('aroundAll before')
    await runSuite()
    console.log('aroundAll after')
  })

  beforeAll(() => {
    // Runs once before all tests in this suite
    console.log('beforeAll')

    return function beforeAllCleanup() {
      // Runs once afterAll hooks have run
      console.log('beforeAllCleanup')
    }
  })

  aroundEach(async (runTest) => {
    // Wraps around each test
    console.log('aroundEach before')
    await runTest()
    console.log('aroundEach after')
  })

  beforeEach(() => {
    // Runs before each test
    console.log('beforeEach')

    return function beforeEachCleanup() {
      // Runs after afterEach hooks have run
      console.log('beforeEachCleanup')
    }
  })

  test('creates user', () => {
    // Test executes
    console.log('test 1')
  })

  test('updates user', () => {
    // Test executes
    console.log('test 2')
  })

  afterEach(() => {
    // Runs after each test
    console.log('afterEach')
  })

  afterAll(() => {
    // Runs once after all tests in this suite
    console.log('afterAll')
  })
})

// Output:
// File loaded
// Suite defined
// aroundAll before
//   beforeAll
//   aroundEach before
//     beforeEach
//       test 1
//     afterEach
//     beforeEachCleanup
//   aroundEach after
//   aroundEach before
//     beforeEach
//       test 2
//     afterEach
//     beforeEachCleanup
//   aroundEach after
//   afterAll
//   beforeAllCleanup
// aroundAll after
```

#### Verschachtelte Suites

Bei verschachtelten `describe`-Blöcken folgen Hooks einem hierarchischen Muster. Die Hooks `aroundAll` und `aroundEach` umschließen ihre jeweiligen Geltungsbereiche, wobei übergeordnete Hooks die untergeordneten umschließen:

```ts
describe('outer', () => {
  aroundAll(async (runSuite) => {
    console.log('outer aroundAll before')
    await runSuite()
    console.log('outer aroundAll after')
  })

  beforeAll(() => console.log('outer beforeAll'))

  aroundEach(async (runTest) => {
    console.log('outer aroundEach before')
    await runTest()
    console.log('outer aroundEach after')
  })

  beforeEach(() => console.log('outer beforeEach'))

  test('outer test', () => console.log('outer test'))

  describe('inner', () => {
    aroundAll(async (runSuite) => {
      console.log('inner aroundAll before')
      await runSuite()
      console.log('inner aroundAll after')
    })

    beforeAll(() => console.log('inner beforeAll'))

    aroundEach(async (runTest) => {
      console.log('inner aroundEach before')
      await runTest()
      console.log('inner aroundEach after')
    })

    beforeEach(() => console.log('inner beforeEach'))

    test('inner test', () => console.log('inner test'))

    afterEach(() => console.log('inner afterEach'))
    afterAll(() => console.log('inner afterAll'))
  })

  afterEach(() => console.log('outer afterEach'))
  afterAll(() => console.log('outer afterAll'))
})

// Output:
// outer aroundAll before
//   outer beforeAll
//   outer aroundEach before
//     outer beforeEach
//       outer test
//     outer afterEach
//   outer aroundEach after
//   inner aroundAll before
//     inner beforeAll
//     outer aroundEach before
//       inner aroundEach before
//         outer beforeEach
//           inner beforeEach
//             inner test
//           inner afterEach
//         outer afterEach
//       inner aroundEach after
//     outer aroundEach after
//     inner afterAll
//   inner aroundAll after
//   outer afterAll
// outer aroundAll after
```

#### Nebenläufige Tests

Bei Verwendung von `test.concurrent` oder [`sequence.concurrent`](/config/sequence#sequence-concurrent):

- Tests innerhalb derselben Datei können parallel laufen
- Jeder nebenläufige Test führt weiterhin seine eigenen `beforeEach`- und `afterEach`-Hooks aus
- Verwenden Sie für nebenläufige Snapshots den [Test-Kontext](/guide/test-context): `test.concurrent('name', async ({ expect }) => {})`

### 6. Reporting-Phase

Während des gesamten Testlaufs erhalten Reporter Lebenszyklusereignisse und stellen Ergebnisse dar.

**Was passiert:**
- Reporter erhalten Ereignisse, während die Tests fortschreiten
- Ergebnisse werden gesammelt und formatiert
- Testzusammenfassungen werden erzeugt
- Coverage-Berichte werden erzeugt (falls aktiviert)

Detaillierte Informationen zum Lebenszyklus der Reporter finden Sie im Guide [Reporters](/api/advanced/reporters).

### 7. Global-Teardown-Phase

Nachdem alle Tests abgeschlossen sind, werden die Global-Teardown-Funktionen ausgeführt.

**Was passiert:**
- Die `teardown()`-Funktionen aus den [`globalSetup`](/config/globalsetup)-Dateien laufen
- Mehrere Teardown-Funktionen laufen in **umgekehrter Reihenfolge** ihres Setups
- Im Watch-Modus läuft der Teardown vor dem Prozessende, nicht zwischen erneuten Testläufen

**Geltungsbereich:** Hauptprozess

```ts [globalSetup.ts]
export function teardown() {
  // Clean up global resources
  console.log('Global teardown complete')
}
```

## Der Lebenszyklus in verschiedenen Geltungsbereichen

Zu verstehen, wo Code ausgeführt wird, ist entscheidend, um verbreitete Fallstricke zu vermeiden:

| Phase | Geltungsbereich | Zugriff auf den Test-Kontext | Läuft |
|-------|-------|----------------------|------|
| Konfigurationsdatei | Hauptprozess | ❌ Nein | Einmal pro Vitest-Lauf |
| Global Setup | Hauptprozess | ❌ Nein (verwenden Sie `provide`/`inject`) | Einmal pro Vitest-Lauf |
| Setup-Dateien | Worker (derselbe wie Tests) | ✅ Ja | Vor jeder Testdatei |
| Code auf Dateiebene | Worker | ✅ Ja | Einmal pro Testdatei |
| `aroundAll` | Worker | ✅ Ja | Einmal pro Suite (umschließt alle Tests) |
| `beforeAll` / `afterAll` | Worker | ✅ Ja | Einmal pro Suite |
| `aroundEach` | Worker | ✅ Ja | Pro Test (umschließt jeden Test) |
| `beforeEach` / `afterEach` | Worker | ✅ Ja | Pro Test |
| Testfunktion | Worker | ✅ Ja | Einmal (oder öfter bei Retries/Repeats) |
| Global Teardown | Hauptprozess | ❌ Nein | Einmal pro Vitest-Lauf |

## Lebenszyklus im Watch-Modus

Im Watch-Modus wiederholt sich der Lebenszyklus mit einigen Unterschieden:

1. **Erster Lauf:** Vollständiger Lebenszyklus wie oben beschrieben
2. **Bei einer Dateiänderung:**
   - Ein neuer [Testlauf](/api/advanced/reporters#ontestrunstart) startet
   - Nur die betroffenen Testdateien werden erneut ausgeführt
   - [Setup-Dateien](/config/setupfiles) laufen für diese Testdateien erneut
   - [Global Setup](/config/globalsetup) läuft **nicht** erneut (verwenden Sie [`project.onTestsRerun`](/config/globalsetup#handling-test-reruns) für Logik, die speziell für erneute Läufe gilt)
3. **Beim Beenden:**
   - Global Teardown wird ausgeführt
   - Der Prozess wird beendet

## Überlegungen zur Performance

Das Verständnis des Lebenszyklus hilft, die Test-Performance zu optimieren:

- **Global Setup** ist ideal für aufwendige einmalige Operationen (Befüllen der Datenbank, Serverstart)
- **Setup-Dateien** laufen vor jeder Testdatei – vermeiden Sie hier aufwendige Operationen, wenn Sie viele Testdateien haben
- **`beforeAll`** ist besser als `beforeEach` für aufwendiges Setup, das keine Isolation benötigt
- **Das Deaktivieren der [Isolation](/config/isolate)** verbessert die Performance, aber Setup-Dateien werden weiterhin vor jeder Datei ausgeführt
- **Die [Pool-Konfiguration](/config/pool)** beeinflusst die Parallelisierung und die verfügbaren APIs

Tipps zur Verbesserung der Performance finden Sie im Guide [Improving Performance](/guide/improving-performance).

## Verwandte Dokumentation

- [Konfiguration des Global Setup](/config/globalsetup)
- [Konfiguration der Setup-Dateien](/config/setupfiles)
- [Optionen zur Testreihenfolge](/config/sequence)
- [Konfiguration der Isolation](/config/isolate)
- [Pool-Konfiguration](/config/pool)
- [Reporter erweitern](/guide/advanced/reporters) – für Lebenszyklusereignisse von Reportern
- [Test-API-Referenz](/api/hooks) – für Hook-APIs
