# watchTriggerPatterns <CRoot /> <Version>3.2.0</Version>

- **Typ:** `WatcherTriggerPattern[]`

Vitest führt Tests auf Basis des Modulgraphen erneut aus, der aus statischen und dynamischen `import`-Anweisungen aufgebaut wird. Wenn Sie jedoch aus dem Dateisystem lesen oder Daten über einen Proxy abrufen, kann Vitest diese Abhängigkeiten nicht erkennen.

Damit diese Tests korrekt erneut ausgeführt werden, können Sie ein Regex-Muster und eine Funktion definieren, die eine Liste der auszuführenden Testdateien zurückgibt.

```ts
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    watchTriggerPatterns: [
      {
        pattern: /src\/(mailers|templates)\/(.*)\.(ts|html|txt)$/,
        testsToRun: (id, match) => {
          // relative to the root value
          return `./api/tests/mailers/${match[2]}.test.ts`
        },
      },
    ],
  },
})
```

::: warning
Zurückgegebene Dateien sollten entweder absolut oder relativ zum Root-Verzeichnis angegeben werden. Beachten Sie, dass dies eine globale Option ist, die nicht innerhalb von [Projekt](/guide/projects)-Konfigurationen verwendet werden kann.
:::
