# environmentOptions

- **Typ:** `Record<'jsdom' | 'happyDOM' | string, unknown>`
- **Standard:** `{}`

Diese Optionen werden an die Setup-Methode der aktuellen [Umgebung](/config/environment) übergeben. Standardmäßig können Sie nur Optionen für `jsdom` und `happyDOM` konfigurieren, wenn Sie diese als Testumgebung verwenden.

## Beispiel

```js [vitest.config.js]
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environmentOptions: {
      jsdom: {
        url: 'http://localhost:3000',
      },
      happyDOM: {
        width: 300,
        height: 400,
      },
    },
  },
})
```

::: warning
Die Optionen sind auf ihre jeweilige Umgebung beschränkt. Legen Sie zum Beispiel jsdom-Optionen unter dem Schlüssel `jsdom` und happy-dom-Optionen unter dem Schlüssel `happyDOM` ab. So können Sie mehrere Umgebungen innerhalb desselben Projekts mischen.
:::
