# retry

Wiederholt den Test eine bestimmte Anzahl von Malen, wenn er fehlschlägt.

- **Typ:** `number | { count?: number, delay?: number, condition?: RegExp }`
- **Standard:** `0`
- **CLI:** `--retry <times>`, `--retry.count <times>`, `--retry.delay <ms>`, `--retry.condition <pattern>`

## Grundlegende Verwendung

Gib eine Zahl an, um fehlgeschlagene Tests zu wiederholen:

```ts
export default defineConfig({
  test: {
    retry: 3,
  },
})
```

## Verwendung über die CLI

Du kannst die Retry-Optionen auch über die Kommandozeile konfigurieren:

```bash
# Simple retry count
vitest --retry 3

# Advanced options using dot notation
vitest --retry.count 3 --retry.delay 500 --retry.condition 'ECONNREFUSED|timeout'
```

## Erweiterte Optionen <Version>4.1.0</Version> {#advanced-options}

Verwende ein Objekt, um das Retry-Verhalten zu konfigurieren:

```ts
export default defineConfig({
  test: {
    retry: {
      count: 3, // Number of times to retry
      delay: 1000, // Delay in milliseconds between retries
      condition: /ECONNREFUSED|timeout/i, // RegExp to match errors that should trigger retry
    },
  },
})
```

### count

Anzahl der Wiederholungen eines Tests, wenn er fehlschlägt. Standard ist `0`.

```ts
export default defineConfig({
  test: {
    retry: {
      count: 2,
    },
  },
})
```

### delay

Verzögerung in Millisekunden zwischen den Wiederholungsversuchen. Nützlich für Tests, die mit ratenbegrenzten APIs interagieren oder Zeit zur Erholung brauchen. Standard ist `0`.

```ts
export default defineConfig({
  test: {
    retry: {
      count: 3,
      delay: 500, // Wait 500ms between retries
    },
  },
})
```

### condition

Ein RegExp-Pattern oder eine Funktion, die anhand des Fehlers bestimmt, ob ein Test wiederholt werden soll.

- Bei einer **RegExp** wird sie gegen die Fehlermeldung geprüft
- Bei einer **Funktion** erhält sie den Fehler und gibt einen Boolean zurück

::: warning
Wenn `condition` als Funktion definiert wird, muss das direkt in einer Testdatei geschehen, nicht in einer Konfigurationsdatei (Konfigurationen werden für Worker-Threads serialisiert).
:::

#### RegExp-Bedingung (in der Konfigurationsdatei):

```ts
export default defineConfig({
  test: {
    retry: {
      count: 2,
      condition: /ECONNREFUSED|ETIMEDOUT/i, // Retry on connection/timeout errors
    },
  },
})
```

#### Funktions-Bedingung (in der Testdatei):

```ts
import { describe, test } from 'vitest'

describe('tests with advanced retry condition', () => {
  test('with function condition', { retry: { count: 2, condition: error => error.message.includes('Network') } }, () => {
    // test code
  })
})
```

## Überschreiben in der Testdatei

Du kannst Retry-Optionen auch pro Test oder Suite in Testdateien definieren:

```ts
import { describe, test } from 'vitest'

describe('flaky tests', {
  retry: {
    count: 2,
    delay: 100,
  },
}, () => {
  test('network request', () => {
    // test code
  })
})

test('another test', {
  retry: {
    count: 3,
    condition: error => error.message.includes('timeout'),
  },
}, () => {
  // test code
})
```
