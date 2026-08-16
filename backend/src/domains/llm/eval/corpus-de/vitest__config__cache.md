# cache <CRoot />

- **Typ:** `false`
- **CLI:** `--no-cache`, `--cache=false`

Verwende diese Option, wenn du das Caching deaktivieren möchtest. Derzeit speichert Vitest die Testergebnisse im Cache, um die langsameren und die fehlgeschlagenen Tests zuerst auszuführen.

Das Cache-Verzeichnis wird über die Vite-Option [`cacheDir`](https://vitejs.dev/config/shared-options.html#cachedir) gesteuert:

```ts
import { defineConfig } from 'vitest/config'

export default defineConfig({
  cacheDir: 'custom-folder/.vitest'
})
```

Mit `process.env.VITEST` kannst du das Verzeichnis auf Vitest beschränken:

```ts
import { defineConfig } from 'vitest/config'

export default defineConfig({
  cacheDir: process.env.VITEST ? 'custom-folder/.vitest' : undefined
})
```
