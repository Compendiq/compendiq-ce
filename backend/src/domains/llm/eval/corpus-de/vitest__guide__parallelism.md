# Parallelität

Vitest kennt zwei Ebenen der Parallelität: Es kann mehrere *Testdateien* gleichzeitig ausführen, und innerhalb jeder Datei kann es mehrere *Tests* gleichzeitig ausführen. Den Unterschied zwischen beiden zu verstehen ist wichtig, denn sie funktionieren unterschiedlich und haben unterschiedliche Abwägungen.

## Parallelität auf Dateiebene

Standardmäßig führt Vitest Testdateien parallel über mehrere Worker hinweg aus. Jede Datei erhält ihre eigene isolierte Umgebung, sodass sich Tests in verschiedenen Dateien nicht gegenseitig beeinflussen können.

Welchen Mechanismus Vitest zum Erzeugen der Worker verwendet, hängt vom konfigurierten [`pool`](/config/pool) ab:

- `forks` (der Standard) und `vmForks` führen jede Datei in einem eigenen [Kindprozess](https://nodejs.org/api/child_process.html) aus
- `threads` und `vmThreads` führen jede Datei in einem eigenen [Worker-Thread](https://nodejs.org/api/worker_threads.html) aus

Mit der Option [`maxWorkers`](/config/maxworkers) steuerst du, wie viele Worker gleichzeitig laufen. Mehr Worker bedeuten, dass mehr Dateien parallel laufen, aber auch mehr Speicher- und CPU-Verbrauch. Die richtige Zahl hängt von deiner Maschine und davon ab, wie aufwendig deine Tests sind.

Für die meisten Projekte ist die Parallelität auf Dateiebene der mit Abstand größte Faktor für die Geschwindigkeit der Test-Suite. Es gibt allerdings Fälle, in denen du sie deaktivieren möchtest — etwa wenn deine Tests eine externe Ressource wie eine Datenbank teilen, die keinen gleichzeitigen Zugriff verträgt. Setze [`fileParallelism`](/config/fileparallelism) auf `false`, um Dateien nacheinander auszuführen.

Mehr zum Tuning der Performance findest du im [Performance-Leitfaden](/guide/improving-performance).

## Parallelität auf Testebene

Innerhalb einer einzelnen Datei führt Vitest Tests standardmäßig sequenziell aus. Die Tests laufen in der Reihenfolge ihrer Definition, einer nach dem anderen. Das ist der sicherste Standard, weil Tests innerhalb einer Datei häufig Setup und Zustand über Lifecycle-Hooks wie `beforeEach` teilen.

Wenn die Tests einer Datei unabhängig voneinander sind, kannst du sie mit dem Modifier [`concurrent`](/api/test#test-concurrent) gleichzeitig ausführen lassen:

```ts
import { expect, test } from 'vitest'

test.concurrent('fetches user profile', async () => {
  const user = await fetchUser(1)
  expect(user.name).toBe('Alice')
})

test.concurrent('fetches user posts', async () => {
  const posts = await fetchPosts(1)
  expect(posts).toHaveLength(3)
})
```

Wenn Tests als `concurrent` markiert sind, fasst Vitest sie zusammen und führt sie mit [`Promise.all`](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Promise/all) aus. Die Anzahl der gleichzeitig laufenden Tests wird durch die Option [`maxConcurrency`](/config/maxconcurrency) begrenzt.

::: tip Wann hilft `concurrent` tatsächlich?
Vitest erzeugt für nebenläufige Tests keine zusätzlichen Worker — sie laufen alle im selben Worker wie die Datei, zu der sie gehören. Das bedeutet, dass `concurrent` nur dann beschleunigt, wenn deine Tests Zeit mit *Warten* verbringen (auf Netzwerk-Requests, Timer, Datei-I/O usw.). Rein synchrone Tests profitieren nicht, weil sie weiterhin den einzelnen JavaScript-Thread blockieren:

```ts
// These run one after another despite `concurrent`,
// because there is nothing to await
test.concurrent('the first test', () => {
  expect(1).toBe(1)
})

test.concurrent('the second test', () => {
  expect(2).toBe(2)
})
```
:::

Du kannst `concurrent` auch auf eine ganze Suite anwenden:

```ts
import { describe, expect, test } from 'vitest'

describe.concurrent('user API', () => {
  test('fetches profile', async () => {
    const user = await fetchUser(1)
    expect(user.name).toBe('Alice')
  })

  test('fetches posts', async () => {
    const posts = await fetchPosts(1)
    expect(posts).toHaveLength(3)
  })
})
```

Wenn du möchtest, dass *alle* Tests in deinem Projekt standardmäßig nebenläufig laufen, setze [`sequence.concurrent`](/config/sequence#sequence-concurrent) in deiner Konfiguration auf `true`.

Einzelne Tests oder Suites kannst du mit `concurrent: false` von der geerbten Nebenläufigkeit ausnehmen:

```ts
test('uses a shared resource', { concurrent: false }, async () => {
  // ...
})

describe('shared resource suite', { concurrent: false }, () => {
  test('step 1', async () => { /* ... */ })
  test('step 2', async () => { /* ... */ })
})
```

### Hooks bei nebenläufigen Tests

Wenn Tests nebenläufig ausgeführt werden, verhalten sich Lifecycle-Hooks anders. `beforeAll` und `afterAll` laufen weiterhin einmal für die Gruppe, aber `beforeEach` und `afterEach` laufen für jeden Test — möglicherweise gleichzeitig, da sich die Tests selbst überlappen.

Die Ausführungsreihenfolge der Hooks wird über [`sequence.hooks`](/config/sequence#sequence-hooks) gesteuert. Mit `sequence.hooks: 'parallel'` werden auch die Hooks durch das Limit [`maxConcurrency`](/config/maxconcurrency) begrenzt.
