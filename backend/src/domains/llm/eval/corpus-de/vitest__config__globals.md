# globals

- **Typ:** `boolean`
- **Standard:** `false`
- **CLI:** `--globals`, `--no-globals`, `--globals=false`

Standardmäßig stellt `vitest` aus Gründen der Explizitheit keine globalen APIs bereit. Wenn du die APIs lieber global verwenden möchtest, wie bei Jest, kannst du der CLI die Option `--globals` übergeben oder `globals: true` in die Konfiguration eintragen.

```js
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globals: true,
  },
})
```

::: tip
Beachte, dass einige Bibliotheken, z. B. `@testing-library/react`, darauf angewiesen sind, dass die Globals vorhanden sind, um automatisch aufzuräumen.
:::

Damit TypeScript mit den globalen APIs funktioniert, füge `vitest/globals` dem Feld `types` in deiner `tsconfig.json` hinzu:

```json [tsconfig.json]
{
  "compilerOptions": {
    "types": ["vitest/globals"]
  }
}
```

Wenn du deine [`typeRoots`](https://www.typescriptlang.org/tsconfig/#typeRoots) neu definiert hast, um zusätzliche Typen in die Kompilierung einzubeziehen, musst du `node_modules` wieder hinzufügen, damit `vitest/globals` gefunden wird:

```json [tsconfig.json]
{
  "compilerOptions": {
    "typeRoots": ["./types", "./node_modules/@types", "./node_modules"],
    "types": ["vitest/globals"]
  }
}
```
