# Isolationseinstellungen pro Datei

Standardmäßig läuft jede Testdatei in ihrem eigenen isolierten Modulgraphen, was davor schützt, dass eine Datei Zustand in eine andere überträgt. Diese Isolation kostet bei jeder Datei Setup-Zeit – was für Integrationstests, die sie wirklich brauchen, in Ordnung ist, für reine Unit-Tests ohne gemeinsamen veränderlichen Zustand jedoch verschwendet ist.

Verwende [`projects`](/guide/projects), um [`isolate: false`](/config/isolate) auf die Unit-Suite anzuwenden und die Integrations-Suite weiterhin isoliert laufen zu lassen.

## Muster

```ts [vitest.config.ts]
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          // Non-isolated unit tests
          name: 'Unit tests',
          isolate: false,
          exclude: ['**.integration.test.ts'],
        },
      },
      {
        test: {
          // Isolated integration tests
          name: 'Integration tests',
          include: ['**.integration.test.ts'],
        },
      },
    ],
  },
})
```

## Wann Isolation wichtig ist

Eine Testdatei kann gefahrlos deisoliert werden, wenn sie nicht:

- Zustand auf Modulebene verändert (Zähler, Caches, `let`-Bindungen auf oberster Ebene)
- [`vi.stubGlobal`](/api/vi#vi-stubglobal) oder [`vi.stubEnv`](/api/vi#vi-stubenv) aufruft
- Prototypen monkey-patcht (`Date.prototype`, `Array.prototype`, …)
- Listener auf `process` oder anderen langlebigen Emittern registriert
- für `vi.mock`-Factories auf eine frische Modulinstanz angewiesen ist

Trifft eines davon zu, leistet die Isolation echte Arbeit und sollte aktiviert bleiben.

## Prüfen, ob es sicher ist

Führe die Suite zweimal mit Shuffling aus, um dateiübergreifende Verunreinigung sichtbar zu machen:

```sh
vitest --shuffle --run --project='Unit tests'
vitest --shuffle --run --project='Unit tests'
```

Liefert der zweite Lauf andere Ergebnisse, hast du reihenfolgeabhängige Tests. Behebe entweder den Übeltäter oder lass die Isolation für diese Datei aktiviert.

## Isolation pro Pool

`isolate` gilt nur für die Pools [`threads`](/config/pool) und [`forks`](/config/pool). Die Pools `vmThreads` und `vmForks` laufen unabhängig vom Flag stets isoliert, da sie höhere Startkosten gegen stärkere Garantien eintauschen.

## Siehe auch

- [`isolate`](/config/isolate)
- [Testprojekte](/guide/projects)
- [Performance verbessern](/guide/improving-performance)
- [Parallele und sequentielle Testdateien](/guide/recipes/parallel-sequential)
