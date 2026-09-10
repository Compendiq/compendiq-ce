# resolveSnapshotPath <CRoot />

- **Typ:** `(testPath: string, snapExtension: string, context: { config: SerializedConfig }) => string`
- **Standard:** legt Snapshot-Dateien im Verzeichnis `__snapshots__` ab

Überschreibt den Standardpfad für Snapshots. Um Snapshots beispielsweise neben den Testdateien abzulegen:

```ts
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    resolveSnapshotPath: (testPath, snapExtension) => testPath + snapExtension,
  },
})
```

Über den Parameter `context` kannst du außerdem auf die serialisierte Konfiguration des Projekts zugreifen. Das ist nützlich, wenn du mehrere [Projekte](/guide/projects) hast und Snapshots je nach Projektname an unterschiedlichen Orten ablegen möchtest:

```ts
import { basename, dirname, join } from 'node:path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    resolveSnapshotPath(testPath, snapExtension, context) {
      return join(
        dirname(testPath),
        '__snapshots__',
        context.config.name ?? 'default',
        basename(testPath) + snapExtension,
      )
    },
  },
})
```
