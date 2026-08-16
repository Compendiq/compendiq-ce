# Setup und Teardown

Beim Schreiben von Tests muss man häufig vor dem Testlauf etwas erledigen (Daten initialisieren, eine Datenbankverbindung aufbauen, einen Server starten) und danach wieder aufräumen. Statt diesen Code in jedem Test zu wiederholen, stellt Vitest Lifecycle-Hooks bereit, die automatisch zum richtigen Zeitpunkt laufen.

## Wiederkehrendes Setup für jeden Test

Die gebräuchlichsten Hooks sind [`beforeEach`](/api/hooks#beforeeach) und [`afterEach`](/api/hooks#aftereach). Wie die Namen nahelegen, läuft `beforeEach` vor jedem Test in der Datei und `afterEach` nach jedem Test, selbst wenn der Test fehlschlägt. Damit eignen sie sich perfekt dafür, sicherzustellen, dass jeder Test mit einem bekannten Zustand startet.

```js
import { afterEach, beforeEach, expect, test } from 'vitest'

let items

beforeEach(() => {
  items = ['apple', 'banana', 'cherry']
})

afterEach(() => {
  items = []
})

test('items starts with 3 fruits', () => {
  expect(items).toHaveLength(3)
})

test('can remove an item', () => {
  items.pop()
  expect(items).toHaveLength(2)
})

test('can add an item', () => {
  items.push('date')
  expect(items).toHaveLength(4)
  // beforeEach reset the array to 3 items before this test ran,
  // proving that mutations from the previous test do not leak.
})
```

Ohne diese Hooks würden Mutationen wie `pop` oder `push` aus früheren Tests die nachfolgenden beeinflussen — eine klassische Quelle für instabile Tests. Die Hooks dagegen garantieren für jeden Test einen sauberen Zustand.

## Einmaliges Setup

Manches Setup ist zu teuer, um es für jeden Test zu wiederholen. Wenn du eine Datenbankverbindung aufbauen, einen Server starten oder eine große Datei laden musst, würde das vor jedem Test deine Suite drastisch verlangsamen. Genau dafür gibt es [`beforeAll`](/api/hooks#beforeall) und [`afterAll`](/api/hooks#afterall). Sie laufen einmal für die gesamte Datei:

```js
import { afterAll, beforeAll, expect, test } from 'vitest'

let db

beforeAll(async () => {
  db = await connectToDatabase()
})

afterAll(async () => {
  await db.close()
})

test('can query users', async () => {
  const users = await db.query('SELECT * FROM users')
  expect(users.length).toBeGreaterThan(0)
})

test('can query products', async () => {
  const products = await db.query('SELECT * FROM products')
  expect(products.length).toBeGreaterThan(0)
})
```

Die Datenbankverbindung wird einmal erzeugt, von allen Tests gemeinsam genutzt und geschlossen, sobald die Datei durchgelaufen ist.

## Geltungsbereich mit `describe`

Hooks, die innerhalb eines `describe`-Blocks definiert sind, gelten nur für die Tests in diesem Block. Hooks auf oberster Ebene gelten für jeden Test in der Datei. So kannst du für verschiedene Testgruppen unterschiedliche Zustände aufbauen:

```js
import { beforeEach, describe, expect, test } from 'vitest'

describe('math operations', () => {
  let value

  beforeEach(() => {
    value = 0
  })

  test('can add', () => {
    value += 5
    expect(value).toBe(5)
  })

  test('can subtract', () => {
    value -= 3
    expect(value).toBe(-3) // value was reset to 0 by beforeEach
  })
})

describe('string operations', () => {
  let text

  beforeEach(() => {
    text = 'hello'
  })

  test('can uppercase', () => {
    expect(text.toUpperCase()).toBe('HELLO')
  })
})
```

Jeder `describe`-Block hat sein eigenes `beforeEach`, das nur die Tests darin betrifft. Die String-Tests wissen nichts von der Variablen `value` und interessieren sich auch nicht dafür — und umgekehrt.

## Ausführungsreihenfolge

Wenn du Hooks auf mehreren Ebenen hast, ist es hilfreich, ihre Ausführungsreihenfolge zu verstehen. Hooks auf oberster Ebene umschließen die inneren Hooks und bilden so eine verschachtelte Struktur:

```js
import { afterAll, afterEach, beforeAll, beforeEach, describe, test } from 'vitest'

beforeAll(() => console.log('1 - beforeAll'))
afterAll(() => console.log('8 - afterAll'))
beforeEach(() => console.log('2 - beforeEach'))
afterEach(() => console.log('5 - afterEach'))

describe('suite', () => {
  beforeEach(() => console.log('3 - inner beforeEach'))
  afterEach(() => console.log('4 - inner afterEach'))

  test('first test', () => {
    console.log('  first test')
  })

  test('second test', () => {
    console.log('  second test')
  })
})
```

Das erzeugt die folgende Ausgabe:

```
1 - beforeAll
2 - beforeEach
3 - inner beforeEach
  first test
4 - inner afterEach
5 - afterEach
2 - beforeEach
3 - inner beforeEach
  second test
4 - inner afterEach
5 - afterEach
8 - afterAll
```

Beachte das Muster: `beforeAll` und `afterAll` laufen einmal für die gesamte Suite, während `beforeEach` und `afterEach` sich für jeden Test wiederholen. Innerhalb jedes Tests läuft zuerst das äußere `beforeEach` (das den weitesten Kontext aufbaut), danach das innere `beforeEach` (das den Kontext eingrenzt). Nach dem Test kehrt sich die Reihenfolge um: Das innere `afterEach` räumt zuerst den engeren Kontext auf, dann übernimmt das äußere `afterEach` das umfassendere Aufräumen.

## Aufräumen mit `onTestFinished`

Manchmal erzeugst du innerhalb eines Tests eine Ressource, die anschließend aufgeräumt werden muss. Du könntest `afterEach` verwenden, aber dann ist das Aufräumen vom Setup getrennt, was den Test schwerer nachvollziehbar macht. Mit [`onTestFinished`](/api/hooks#ontestfinished) kannst du eine Aufräumfunktion genau dort registrieren, wo du die Ressource erzeugst:

```js
import { expect, onTestFinished, test } from 'vitest'

test('creates a temporary file', () => {
  const file = createTempFile()
  onTestFinished(() => {
    deleteTempFile(file)
  })

  expect(file.exists()).toBe(true)
})
```

Ein ähnliches Muster funktioniert mit `beforeEach`. Du kannst eine Aufräumfunktion zurückgeben, und Vitest ruft sie nach jedem Test auf. Das ist besonders angenehm, wenn Setup und Teardown eng zusammengehören:

```js
import { beforeEach } from 'vitest'

beforeEach(() => {
  const server = startServer()
  return () => {
    server.close()
  }
})
```

## Fixtures mit `test.extend`

Die obigen Beispiele verwenden `let`-Variablen und `beforeEach`, um gemeinsam genutzten Zustand aufzubauen. Das funktioniert, hat aber Nachteile: Die Variablendeklarationen sind von der Initialisierung getrennt, die Typen erfordern eine explizite Annotation, und man vergisst leicht das Aufräumen.

Vitest bietet dafür mit [`test.extend`](/guide/test-context#extend-test-context) ein besseres Muster. Du definierst wiederverwendbare **Fixtures**, die für jeden Test automatisch erzeugt und danach aufgeräumt werden:

```js [my-test.js]
import { test as baseTest } from 'vitest'

export const test = baseTest
  .extend('db', async ({}, { onCleanup }) => {
    const db = await createDatabase()
    onCleanup(() => db.close())
    return db
  })
  .extend('user', async ({ db }) => {
    return await db.createUser({ name: 'Alice' })
  })
```

```js [my-test.test.js]
import { expect } from 'vitest'
import { test } from './my-test.js'

test('user is created', ({ db, user }) => {
  expect(user.name).toBe('Alice')
})
```

Fixtures werden nur initialisiert, wenn ein Test sie tatsächlich verwendet (indem er sie aus dem Kontext destrukturiert), und sie können voneinander abhängen. Damit sind sie für die meisten Setup- und Teardown-Muster eine ausgezeichnete Alternative zu `beforeEach`/`afterEach`.

Alle Details zu Fixtures, Geltungsbereichen und Overrides findest du im Leitfaden [Test-Kontext](/guide/test-context).

## Setup-Dateien

Wenn du Setup-Code hast, der vor jeder Testdatei in deinem Projekt laufen soll (etwa Polyfills, globale Konfiguration oder eigene Matcher), kannst du ihn in eine Setup-Datei legen und mit der Konfigurationsoption [`setupFiles`](/config/setupfiles) darauf verweisen:

```js [vitest.config.js]
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    setupFiles: ['./test/setup.js'],
  },
})
```

```js [test/setup.js]
// This runs before every test file
import { expect } from 'vitest'
import { customMatchers } from './custom-matchers.js'

expect.extend(customMatchers)
```

Anders als `beforeAll`, das einmal pro Datei läuft, laufen Setup-Dateien in einer eigenen Phase, bevor die Testdatei überhaupt eingesammelt wird. Damit sind sie der richtige Ort für Dinge wie das Erweitern der `expect`-API oder das Konfigurieren globaler Polyfills.

::: tip
Für fortgeschrittene Fälle, in denen dein Test *innerhalb* eines umschließenden Kontexts laufen muss (etwa einer Datenbanktransaktion oder einer Tracing-Span), siehe die Hooks [`aroundEach`](/api/hooks#aroundeach) und [`aroundAll`](/api/hooks#aroundall). Das vollständige Bild des Lebenszyklus findest du unter [Lebenszyklus eines Testlaufs](/guide/lifecycle).
:::
