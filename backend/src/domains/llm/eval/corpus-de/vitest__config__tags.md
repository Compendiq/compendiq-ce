# tags <Version>4.1.0</Version> {#tags}

- **Typ:** `TestTagDefinition[]`
- **Standard:** `[]`

Definiert alle [verfügbaren Tags](/guide/test-tags) in deinem Testprojekt. Standardmäßig wirft Vitest einen Fehler, wenn ein Test einen hier nicht aufgeführten Namen verwendet; das lässt sich über die Option [`strictTags`](/config/stricttags) konfigurieren.

Wenn du [`projects`](/config/projects) verwendest, erben diese automatisch sämtliche globalen Tag-Definitionen.

Verwende [`--tags-filter`](/guide/test-tags#syntax), um Tests nach ihren Tags zu filtern. Verwende [`--list-tags`](/guide/cli#listtags), um jedes Tag in deinem Vitest-Workspace auszugeben.

## name

- **Typ:** `string`
- **Erforderlich:** `true`

Der Name des Tags. Diesen verwendest du in der Option `tags` in Tests.

```ts
export default defineConfig({
  test: {
    tags: [
      { name: 'unit' },
      { name: 'e2e' },
    ],
  },
})
```

::: tip
Wenn du TypeScript verwendest, kannst du festlegen, welche Tags verfügbar sind, indem du den Typ `TestTags` um eine Eigenschaft erweiterst, die eine Union von Strings enthält (stelle sicher, dass diese Datei von deiner `tsconfig` erfasst wird):

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
:::

## description

- **Typ:** `string`

Eine für Menschen lesbare Beschreibung des Tags. Sie wird in der UI und in Fehlermeldungen angezeigt, wenn ein Tag nicht gefunden wird.

```ts
export default defineConfig({
  test: {
    tags: [
      {
        name: 'slow',
        description: 'Tests that take a long time to run.',
      },
    ],
  },
})
```

## priority

- **Typ:** `number`
- **Standard:** `Infinity`

Priorität für das Zusammenführen von Optionen, wenn mehrere Tags mit denselben Optionen auf einen Test angewendet werden. Eine kleinere Zahl bedeutet höhere Priorität (z. B. hat Priorität `1` Vorrang vor Priorität `3`).

```ts
export default defineConfig({
  test: {
    tags: [
      {
        name: 'flaky',
        timeout: 30_000,
        priority: 1, // higher priority
      },
      {
        name: 'db',
        timeout: 60_000,
        priority: 2, // lower priority
      },
    ],
  },
})
```

Hat ein Test beide Tags, beträgt das `timeout` `30_000`, weil `flaky` die höhere Priorität hat.

## Testoptionen

Tags können [Testoptionen](/api/test#test-options) definieren, die auf jeden mit dem Tag markierten Test angewendet werden. Diese Optionen werden mit den eigenen Optionen des Tests zusammengeführt, wobei die Optionen des Tests Vorrang haben.

::: warning
[`retry.condition`](/api/test#retry) darf nur eine Regexp sein, weil die Konfigurationswerte serialisiert werden müssen.

Tags können über diese Optionen außerdem keine weiteren [Tags](/api/test#tags) anwenden.
:::

## Beispiel

```ts
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    tags: [
      {
        name: 'unit',
        description: 'Unit tests.',
      },
      {
        name: 'e2e',
        description: 'End-to-end tests.',
        timeout: 60_000,
      },
      {
        name: 'flaky',
        description: 'Flaky tests that need retries.',
        retry: process.env.CI ? 3 : 0,
        priority: 1,
      },
      {
        name: 'slow',
        description: 'Slow tests.',
        timeout: 120_000,
      },
      {
        name: 'skip-ci',
        description: 'Tests to skip in CI.',
        skip: !!process.env.CI,
      },
    ],
  },
})
```
