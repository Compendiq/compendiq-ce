# browser.enabled

- **Typ:** `boolean`
- **Standard:** `false`
- **CLI:** `--browser`, `--browser.enabled=false`

Wenn Sie dieses Flag aktivieren, führt Vitest standardmäßig alle Tests in einem [Browser](/guide/browser/) aus. Wenn Sie weitere Browser-Optionen über die CLI konfigurieren, können Sie `--browser.enabled` zusammen mit ihnen verwenden statt `--browser`:

```sh
vitest --browser.enabled --browser.headless
```

::: warning
Um den [Browser-Modus](/guide/browser/) zu aktivieren, müssen Sie zusätzlich den [`provider`](/config/browser/provider) und mindestens eine [`instance`](/config/browser/instances) angeben. Verfügbare Provider:

- [playwright](/config/browser/playwright)
- [webdriverio](/config/browser/webdriverio)
- [preview](/config/browser/preview)
:::

## Beispiel

```js{7} [vitest.config.js]
import { defineConfig } from 'vitest/config'
import { playwright } from '@vitest/browser-playwright'

export default defineConfig({
  test: {
    browser: {
      enabled: true,
      provider: playwright(),
      instances: [
        { browser: 'chromium' },
      ],
    },
  },
})
```

Wenn Sie TypeScript verwenden, bietet das Feld `browser` in `instances` eine Autovervollständigung auf Basis Ihres Providers.
