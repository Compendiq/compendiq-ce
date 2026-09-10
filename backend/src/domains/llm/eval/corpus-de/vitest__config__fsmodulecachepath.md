# fsModuleCachePath <Version>5.0.0</Version>

- **Typ:** `string`
- **Standard:** `'node_modules/.vitest-cache'` (aufgelöst relativ zum Workspace-Root)
- **CLI:** `--fsModuleCachePath=<path>`

Verzeichnis, in dem der [`fsModuleCache`](/config/fsmodulecache) abgelegt wird.

Dies kann pro Projekt gesetzt werden; Projekte, die es nicht überschreiben, greifen auf das Cache-Verzeichnis des Roots zurück. Die Lockfile-Metadaten, mit denen der Cache invalidiert wird, werden immer im gesamten Workspace geteilt.

Standardmäßig legt Vitest den Cache innerhalb von `node_modules` im Workspace-Root ab. Der Root wird anhand des Lockfiles Ihres Paketmanagers bestimmt (zum Beispiel `.package-lock.json`, `.yarn-state.yml`, `.pnpm/lock.yaml` und so weiter). Dass der Cache innerhalb von `node_modules` liegt, bedeutet, dass er bei jeder Neuinstallation der Abhängigkeiten auf natürliche Weise invalidiert wird.

```ts
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    fsModuleCache: true,
    fsModuleCachePath: 'node_modules/.vitest-cache',
  },
})
```
