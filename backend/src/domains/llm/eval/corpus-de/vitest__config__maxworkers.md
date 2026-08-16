# maxWorkers

- **Typ:** `number | string`
- **Standard:**
  - wenn [`watch`](/config/watch) deaktiviert ist, wird die gesamte verfügbare Parallelität genutzt
  - wenn [`watch`](/config/watch) aktiviert ist, wird die Hälfte der verfügbaren Parallelität genutzt

Legt die maximale Nebenläufigkeit für Test-Worker fest. Akzeptiert entweder eine Zahl oder einen Prozentwert als Zeichenkette.

- Zahl: startet bis zu der angegebenen Anzahl von Workern.
- Prozentwert als Zeichenkette (z. B. "50%"): berechnet die Anzahl der Worker als den angegebenen Prozentsatz der auf der Maschine verfügbaren Parallelität.

## Beispiel

### Zahl

::: code-group
```js [vitest.config.js]
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    maxWorkers: 4,
  },
})
```
```bash [CLI]
vitest --maxWorkers=4
```
:::

### Prozent

::: code-group
```js [vitest.config.js]
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    maxWorkers: '50%',
  },
})
```
```bash [CLI]
vitest --maxWorkers=50%
```
:::

Vitest verwendet [`os.availableParallelism`](https://nodejs.org/api/os.html#osavailableparallelism), um die maximal verfügbare Parallelität zu ermitteln.
