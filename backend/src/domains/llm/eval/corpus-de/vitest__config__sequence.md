# sequence

- **Typ:** `{ sequencer?, shuffle?, seed?, hooks?, setupFiles?, groupOrder }`

Optionen dafür, wie Tests sortiert werden sollen.

Sie können Sequence-Optionen per Punktnotation an die CLI übergeben:

```sh
npx vitest --sequence.shuffle --sequence.seed=1000
```

## sequence.sequencer <CRoot />

- **Typ:** `TestSequencerConstructor`
- **Standard:** `BaseSequencer`

Eine eigene Klasse, die Methoden für Sharding und Sortierung definiert. Sie können `BaseSequencer` aus `vitest/node` erweitern, wenn Sie nur eine der Methoden `sort` und `shard` neu definieren müssen; vorhanden sein müssen aber beide.

Das Sharding erfolgt vor der Sortierung, und nur dann, wenn die Option `--shard` angegeben ist.

Wenn [`sequence.groupOrder`](#sequence-grouporder) angegeben ist, wird der Sequencer einmal pro Gruppe und Pool aufgerufen.

## sequence.groupOrder

- **Typ:** `number`
- **Standard:** `0`

Steuert die Reihenfolge, in der dieses Projekt seine Tests ausführt, wenn mehrere [Projekte](/guide/projects) verwendet werden.

- Projekte mit derselben Gruppenreihenfolge laufen gemeinsam, und die Gruppen werden von der niedrigsten zur höchsten Nummer ausgeführt.
- Wenn Sie diese Option nicht setzen, laufen alle Projekte parallel.
- Wenn mehrere Projekte dieselbe Gruppenreihenfolge verwenden, laufen sie gleichzeitig.

Diese Einstellung beeinflusst nur die Reihenfolge, in der Projekte ausgeführt werden, nicht die Reihenfolge der Tests innerhalb eines Projekts.
Um die Testisolation oder die Reihenfolge der Tests innerhalb eines Projekts zu steuern, verwenden Sie die Optionen [`isolate`](/config/isolate) und [`sequence.sequencer`](/config/sequence#sequence-sequencer).

::: details Beispiel
Betrachten Sie dieses Beispiel:

```ts
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'slow',
          sequence: {
            groupOrder: 0,
          },
        },
      },
      {
        test: {
          name: 'fast',
          sequence: {
            groupOrder: 0,
          },
        },
      },
      {
        test: {
          name: 'flaky',
          sequence: {
            groupOrder: 1,
          },
        },
      },
    ],
  },
})
```

Die Tests in diesen Projekten laufen in dieser Reihenfolge:

```
 0. slow  |
          |> running together
 0. fast  |

 1. flaky |> runs after slow and fast alone
```
:::

## sequence.shuffle

- **Typ:** `boolean | { files?, tests? }`
- **Standard:** `false`
- **CLI:** `--sequence.shuffle`, `--sequence.shuffle=false`

Wenn Dateien und Tests in zufälliger Reihenfolge laufen sollen, können Sie das mit dieser Option oder dem CLI-Argument [`--sequence.shuffle`](/guide/cli) aktivieren.

Vitest nutzt normalerweise einen Cache, um Tests zu sortieren, sodass lang laufende Tests früher starten und die Tests insgesamt schneller durchlaufen. Wenn Ihre Dateien und Tests in zufälliger Reihenfolge laufen, entfällt dieser Geschwindigkeitsvorteil; es kann aber nützlich sein, um Tests aufzuspüren, die versehentlich von einem zuvor ausgeführten Test abhängen.

### sequence.shuffle.files <CRoot /> {#sequence-shuffle-files}

- **Typ:** `boolean`
- **Standard:** `false`
- **CLI:** `--sequence.shuffle.files`, `--sequence.shuffle.files=false`

Ob Dateien zufällig angeordnet werden sollen. Beachten Sie, dass lang laufende Tests nicht mehr früher starten, wenn Sie diese Option aktivieren.

Da die Dateireihenfolge über alle [Projekte](/guide/projects) hinweg geteilt wird, wird diese Option ausschließlich aus der Root-Konfiguration aufgelöst. Ein Projekt kann seine eigenen Tests weiterhin über [`sequence.shuffle.tests`](#sequence-shuffle-tests) zufällig anordnen.

### sequence.shuffle.tests {#sequence-shuffle-tests}

- **Typ:** `boolean`
- **Standard:** `false`
- **CLI:** `--sequence.shuffle.tests`, `--sequence.shuffle.tests=false`

Ob Tests zufällig angeordnet werden sollen.

## sequence.concurrent {#sequence-concurrent}

- **Typ:** `boolean`
- **Standard:** `false`
- **CLI:** `--sequence.concurrent`, `--sequence.concurrent=false`

Wenn Tests parallel laufen sollen, können Sie das mit dieser Option oder dem CLI-Argument [`--sequence.concurrent`](/guide/cli) aktivieren.

::: warning
Wenn Sie Tests mit `sequence.concurrent` und `expect.requireAssertions` auf `true` ausführen, sollten Sie das [lokale expect](/guide/test-context.html#expect) statt des globalen verwenden. Andernfalls kann es [in manchen Situationen (#8469)](https://github.com/vitest-dev/vitest/issues/8469) zu falsch negativen Ergebnissen kommen.
:::

## sequence.seed <CRoot />

- **Typ:** `number`
- **Standard:** `Date.now()`
- **CLI:** `--sequence.seed=1000`

Legt den Seed für die Zufallsanordnung fest, sofern Tests in zufälliger Reihenfolge laufen.

## sequence.hooks

- **Typ:** `'stack' | 'list' | 'parallel'`
- **Standard:** `'stack'`
- **CLI:** `--sequence.hooks=<value>`

Ändert die Reihenfolge, in der Hooks ausgeführt werden.

- `stack` ordnet „after“-Hooks in umgekehrter Reihenfolge an; „before“-Hooks laufen in der Reihenfolge, in der sie definiert wurden
- `list` ordnet alle Hooks in der Reihenfolge an, in der sie definiert wurden
- `parallel` führt Hooks einer einzelnen Gruppe parallel aus (Hooks in übergeordneten Suites laufen weiterhin vor den Hooks der aktuellen Suite). Die tatsächliche Anzahl gleichzeitig laufender Hooks wird durch [`maxConcurrency`](/config/maxconcurrency) begrenzt.

::: tip
Diese Option wirkt sich nicht auf [`onTestFinished`](/api/hooks#ontestfinished) aus. Dieser Hook wird stets in umgekehrter Reihenfolge aufgerufen.
:::

## sequence.setupFiles {#sequence-setupfiles}

- **Typ:** `'list' | 'parallel'`
- **Standard:** `'parallel'`
- **CLI:** `--sequence.setupFiles=<value>`

Ändert die Reihenfolge, in der Setup-Dateien ausgeführt werden.

- `list` führt Setup-Dateien in der Reihenfolge aus, in der sie definiert wurden
- `parallel` führt Setup-Dateien parallel aus
