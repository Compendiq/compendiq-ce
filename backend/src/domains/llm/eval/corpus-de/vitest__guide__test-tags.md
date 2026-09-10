# Test-Tags <Version>4.1.0</Version> {#test-tags}

[`Tags`](/config/tags) erlauben es dir, Tests zu kennzeichnen, sodass du filtern kannst, was ausgeführt wird, und deren Optionen bei Bedarf überschreiben kannst.

## Warum Tags

Tags werden nützlich, sobald eine Suite Gruppen von Tests enthält, die sich Runner-Optionen teilen, etwa ein längeres Timeout für Datenbankabfragen oder Wiederholungen für Integrationstests in der CI. Diese Optionen bei jedem betroffenen Test von Hand zu wiederholen ist fehleranfällig, und die Kategorien decken sich ohnehin oft nicht mit Dateipfaden, sodass eine Aufteilung nach Datei keine Option ist. Insbesondere flaky Tests sammeln sich dort an, wo die Bugs gelandet sind, und nicht in einem `flaky/`-Ordner.

Ein Tag erfasst genau diese Art von Kategorie: Die Definition enthält die gemeinsamen Optionen, und jeder mit dem Tag markierte Test erbt sie. Diese Tag-Namen lassen sich außerdem zu Ausdrücken kombinieren: `--tags-filter='db && !flaky'` führt Datenbanktests aus, die nicht als flaky markiert sind. [`TestRunner.matchesTags`](#checking-tags-filter-at-runtime) stellt denselben Ausdruck zur Laufzeit bereit, nützlich, wenn `globalSetup` aufwendige Arbeit verrichtet, die übersprungen werden sollte, falls keine getaggten Tests eingeplant sind.

## Wann Tags sinnvoll sind

| Wenn du … möchtest | Verwende |
| --- | --- |
| Timeout/Retry auf eine *Kategorie* von Tests anwenden | **Tags** |
| Querschnittskategorien (`flaky`, `slow`, `frontend`) markieren, die über viele Dateien verstreut sind | **Tags** |
| Aufwendiges Setup abhängig vom Filter bedingt ausführen | **Tags** + [`matchesTags`](#checking-tags-filter-at-runtime) |
| Eine Teilmenge anhand des Testnamens ausführen | [`-t` / `testNamePattern`](/config/testnamepattern) |
| Eine Teilmenge anhand des Dateipfads ausführen | `--include` / `--exclude` |
| Verschiedene Dateien mit verschiedenen *Runner-Einstellungen* ausführen (Isolation, Pool, Environment) | [Test-Projekte](/guide/projects) |

Du kannst Projekte und Tags kombinieren. Ein Test, der in einem `Sequential`-Projekt liegt, kann zusätzlich ein `flaky`-Tag tragen, und Vitest wendet beides an.

## Tags definieren

Tags müssen in deiner Konfigurationsdatei definiert werden. Standardmäßig bringt Vitest keine eingebauten Tags mit. Verwendet ein Test ein Tag, das nicht in der Konfiguration definiert ist, wirft der Test-Runner einen Fehler. Das verhindert unerwartetes Verhalten durch vertippte Tag-Namen. Du kannst diese Prüfung mit der Option [`strictTags`](/config/stricttags) deaktivieren.

Du musst einen `name` des Tags definieren und kannst zusätzliche Optionen definieren, die auf jeden mit dem Tag markierten Test angewendet werden, z. B. ein `timeout` oder `retry`. Die vollständige Liste der verfügbaren Optionen findest du unter [`tags`](/config/tags).

```ts [vitest.config.js]
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    tags: [
      {
        name: 'frontend',
        description: 'Tests written for frontend.',
      },
      {
        name: 'backend',
        description: 'Tests written for backend.',
      },
      {
        name: 'db',
        description: 'Tests for database queries.',
        timeout: 60_000,
      },
      {
        name: 'flaky',
        description: 'Flaky CI tests.',
        retry: process.env.CI ? 3 : 0,
        timeout: 30_000,
        priority: 1,
      },
    ],
  },
})
```

Wenn du TypeScript verwendest, kannst du erzwingen, welche Tags verfügbar sind, indem du den Typ `TestTags` um eine Eigenschaft erweiterst, die eine Union von Strings enthält (achte darauf, dass diese Datei von deiner `tsconfig` eingeschlossen wird):

```ts [vitest.shims.ts]
import 'vitest'

declare module 'vitest' {
  interface TestTags {
    tags:
      | 'frontend'
      | 'backend'
      | 'db'
      | 'flaky'
  }
}
```

Um alle deine Tags zu sehen, kannst du den Befehl [`--list-tags`](/guide/cli#listtags) verwenden:

```shell
vitest --list-tags

frontend: Tests written for frontend.
backend: Tests written for backend.
db: Tests for database queries.
flaky: Flaky CI tests.
```

Um es als JSON auszugeben, übergib `--list-tags=json`:

```json
{
  "tags": [
    {
      "name": "frontend",
      "description": "Tests written for frontend."
    },
    {
      "name": "backend",
      "description": "Tests written for backend."
    },
    {
      "name": "db",
      "description": "Tests for database queries.",
      "timeout": 60000
    },
    {
      "name": "flaky",
      "description": "Flaky CI tests.",
      "retry": 0,
      "timeout": 30000,
      "priority": 1
    }
  ],
  "projects": []
}
```

### Konflikte bei Optionen auflösen

Wenn mehrere Tags dieselbe Option definieren und auf denselben Test angewendet werden, werden sie zuerst über `priority` aufgelöst (die niedrigere Zahl gewinnt), dann über die Reihenfolge, in der sie im `tags`-Array des Tests erscheinen. Tags ohne `priority` werden zuerst zusammengeführt und von solchen mit höherer Priorität überschrieben:

```ts
test('flaky database test', { tags: ['flaky', 'db'] })
// { timeout: 30_000, retry: 3 }
```

Das `timeout` beträgt 30 Sekunden (nicht 60), weil `flaky` die Priorität `1` hat, während `db` keine Priorität hat.

Optionen, die am Test selbst definiert sind, gewinnen immer:

```ts
test('flaky database test', { tags: ['flaky', 'db'], timeout: 120_000 })
// { timeout: 120_000, retry: 3 }
```

## Tags in Tests verwenden

Du kannst Tags über die Option `tags` auf einzelne Tests oder ganze Suites anwenden:

```ts
import { describe, test } from 'vitest'

test('renders homepage', { tags: ['frontend'] }, () => {
  // ...
})

describe('API endpoints', { tags: ['backend'] }, () => {
  test('returns user data', () => {
    // This test inherits the "backend" tag from the parent suite
  })

  test('validates input', { tags: ['validation'] }, () => {
    // This test has both "backend" (inherited) and "validation" tags
  })
})
```

Tags werden von übergeordneten Suites vererbt, sodass alle Tests innerhalb eines getaggten `describe`-Blocks dieses Tag automatisch tragen.

Es ist auch möglich, `tags` für jeden Test in der Datei zu definieren, indem du JSDocs `@module-tag` am Anfang der Datei verwendest:

```ts
/**
 * Auth tests
 * @module-tag admin/pages/dashboard
 * @module-tag acceptance
 */

test('dashboard renders items', () => {
  // ...
})
```

::: danger
Ein `@module-tag` in einem JSDoc-Kommentar gilt für alle Tests in dieser Datei, nicht nur für den Test, dem es vorangeht.

Betrachte dieses Beispiel:

```js{3,10}
describe('forms', () => {
  /**
   * @module-tag frontend
   */
  test('renders a form', () => {
    // ...
  })

  /**
   * @module-tag db
   */
  test('db returns users', () => {
    // ...
  })
})
```

In diesem Beispiel trägt jeder Test in der Datei sowohl das Tag `frontend` als auch `db`. Um einzelne Tests zu taggen, verwende stattdessen das Options-Argument:

```js{2,6}
describe('forms', () => {
  test('renders a form', { tags: 'frontend' }, () => {
    // ...
  })

  test('db returns users', { tags: 'db' }, () => {
    // ...
  })
})
```
:::

## Tests nach Tag filtern

Um nur Tests mit bestimmten Tags auszuführen, verwende die CLI-Option [`--tags-filter`](/guide/cli#tagsfilter):

```shell
vitest --tags-filter=frontend
vitest --tags-filter="frontend and backend"
```

Wenn du die Vitest-UI verwendest, kannst du einen Filter mit dem Präfix `tag:` beginnen, um Tests anhand von Tags mit derselben Ausdruckssyntax zu filtern:

<img alt="The tags filter in Vitest UI" img-light src="/ui/light-ui-tags.png">
<img alt="The tags filter in Vitest UI" img-dark src="/ui/dark-ui-tags.png">

Wenn du eine programmatische API verwendest, kannst du eine Option `tagsFilter` an [`startVitest`](/guide/advanced/#startvitest) oder [`createVitest`](/guide/advanced/#createvitest) übergeben:

```ts
import { startVitest } from 'vitest/node'

await startVitest([], {
  tagsFilter: ['frontend and backend'],
})
```

Oder du kannst eine [Test-Spezifikation](/api/advanced/test-specification) mit deinen eigenen Filtern erstellen:

```ts
const specification = vitest.getRootProject().createSpecification(
  '/path-to-file.js',
  {
    testTagsFilter: ['frontend and backend'],
  },
)
```

### Syntax

Du kannst Tags auf verschiedene Weise kombinieren. Vitest unterstützt diese Keywords:

- `and` oder `&&`, um beide Ausdrücke einzuschließen
- `or` oder `||`, um mindestens einen Ausdruck einzuschließen
- `not` oder `!`, um den Ausdruck auszuschließen
- `*`, um beliebig viele Zeichen zu treffen (0 oder mehr)
- `()`, um Ausdrücke zu gruppieren und die Vorrangregeln zu überschreiben

Der Parser folgt der üblichen [Operator-Priorität](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Operators/Operator_precedence): `not`/`!` hat die höchste Priorität, dann `and`/`&&`, dann `or`/`||`. Verwende Klammern, um die Standardpriorität zu überschreiben.

::: warning Reservierte Namen
Tag-Namen dürfen nicht `and`, `or` oder `not` sein (unabhängig von der Groß-/Kleinschreibung), da dies reservierte Keywords sind. Tag-Namen dürfen außerdem keine Sonderzeichen (`(`, `)`, `&`, `|`, `!`, `*`, Leerzeichen) enthalten, da diese vom Ausdrucks-Parser verwendet werden.
:::

### Wildcards

Du kannst eine Wildcard (`*`) verwenden, um beliebig viele Zeichen zu treffen:

```shell
vitest --tags-filter="unit/*"
```

Das trifft Tags wie `unit/components`, `unit/utils` usw.

### Tags ausschließen

Um Tests mit einem bestimmten Tag auszuschließen, füge ein Ausrufezeichen (`!`) am Anfang oder das Keyword „not“ hinzu:

```shell
vitest --tags-filter="!slow and not flaky"
```

### Beispiele

Hier einige gängige Filtermuster:

```shell
# Run only unit tests
vitest --tags-filter="unit"

# Run tests that are both frontend AND fast
vitest --tags-filter="frontend and fast"

# Run tests that are either unit OR e2e
vitest --tags-filter="unit or e2e"

# Run all tests except slow ones
vitest --tags-filter="!slow"

# Run frontend tests that are not flaky
vitest --tags-filter="frontend && !flaky"

# Run tests matching a wildcard pattern
vitest --tags-filter="api/*"

# Complex expression with parentheses
vitest --tags-filter="(unit || e2e) && !slow"

# Run database tests that are either postgres or mysql, but not slow
vitest --tags-filter="db && (postgres || mysql) && !slow"
```

Du kannst auch mehrere `--tags-filter`-Flags übergeben. Sie werden mit UND-Logik kombiniert:

```shell
# Run tests that match (unit OR e2e) AND are NOT slow
vitest --tags-filter="unit || e2e" --tags-filter="!slow"
```

### Den Tags-Filter zur Laufzeit prüfen

Du kannst `TestRunner.matchesTags` verwenden, um zu prüfen, ob der aktuelle Tags-Filter zu einer Menge von Tags passt. Das ist nützlich, um aufwendige Setup-Logik nur dann bedingt auszuführen, wenn relevante Tests enthalten sind:

```ts
import { beforeAll, TestRunner } from 'vitest'

beforeAll(async () => {
  // Seed database when "vitest --tags-filter db" is used
  if (TestRunner.matchesTags(['db'])) {
    await seedDatabase()
  }
})
```

Die Methode akzeptiert ein Array von Tags und gibt `true` zurück, wenn der aktuelle `--tags-filter` einen Test mit diesen Tags einschließen würde. Ist kein Tags-Filter aktiv, gibt sie immer `true` zurück.

## Siehe auch

- [Isolationseinstellungen pro Datei](/guide/recipes/disable-isolation) und [Parallele und sequenzielle Testdateien](/guide/recipes/parallel-sequential) verwenden Projekte, um Tests nach Datei zu partitionieren. Greife zu Projekten, wenn Kategorien andere Runner-Einstellungen benötigen statt anderer Timeouts oder Wiederholungen.
- [Testfilterung](/guide/filtering) behandelt `-t`, `--include` und die übrigen CLI-Filter.
- Konfigurationsreferenz zu [`tags`](/config/tags) und [`strictTags`](/config/stricttags).
