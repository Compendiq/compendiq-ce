# Mehrere Setups

Mit der Option [`browser.instances`](/config/browser/instances) kannst du mehrere unterschiedliche Browser-Setups angeben.

Der wesentliche Vorteil von `browser.instances` gegenüber [Test-Projekten](/guide/projects) ist das verbesserte Caching. Jedes Projekt nutzt denselben Vite-Server, sodass die Transformation der Dateien und das [Pre-Bundling der Abhängigkeiten](https://vite.dev/guide/dep-pre-bundling.html) nur einmal erfolgen müssen.

## Mehrere Browser

Über das Feld `browser.instances` kannst du Optionen für verschiedene Browser angeben. Möchtest du beispielsweise dieselben Tests in verschiedenen Browsern ausführen, sieht die minimale Konfiguration so aus:

```ts [vitest.config.ts]
import { defineConfig } from 'vitest/config'
import { playwright } from '@vitest/browser-playwright'

export default defineConfig({
  test: {
    browser: {
      enabled: true,
      provider: playwright(),
      headless: true,
      instances: [
        { browser: 'chromium' },
        { browser: 'firefox' },
        { browser: 'webkit' },
      ],
    },
  },
})
```

## Unterschiedliche Setups

Du kannst auch unabhängig vom Browser unterschiedliche Konfigurationsoptionen angeben (wobei die Instanzen _auch_ `browser`-Felder haben können):

::: code-group
```ts [vitest.config.ts]
import { defineConfig } from 'vitest/config'
import { playwright } from '@vitest/browser-playwright'

export default defineConfig({
  test: {
    browser: {
      enabled: true,
      provider: playwright(),
      headless: true,
      instances: [
        {
          browser: 'chromium',
          name: 'chromium-1',
          setupFiles: ['./ratio-setup.ts'],
          provide: {
            ratio: 1,
          },
        },
        {
          browser: 'chromium',
          name: 'chromium-2',
          provide: {
            ratio: 2,
          },
        },
      ],
    },
  },
})
```
```ts [example.test.ts]
import { expect, inject, test } from 'vitest'
import { globalSetupModifier } from './example.js'

test('ratio works', () => {
  expect(inject('ratio') * globalSetupModifier).toBe(14)
})
```
:::

In diesem Beispiel führt Vitest alle Tests im Browser `chromium` aus, führt die Datei `'./ratio-setup.ts'` aber nur in der ersten Konfiguration aus und injiziert je nach [`provide`-Feld](/config/provide) einen anderen `ratio`-Wert.

::: warning
Beachte, dass du einen eigenen `name`-Wert definieren musst, wenn du denselben Browsernamen mehrfach verwendest, da Vitest sonst `browser` als Projektnamen vergibt.
:::

## Filtern

Mit dem [`--project`-Flag](/guide/cli#project) kannst du filtern, welche Projekte ausgeführt werden. Vitest vergibt den Browsernamen automatisch als Projektnamen, sofern keiner manuell gesetzt wurde. Hat die Root-Konfiguration bereits einen Namen, führt Vitest beide zusammen: `custom` -> `custom (browser)`.

```shell
$ vitest --project=chromium
```

::: code-group
```ts{6,8} [default]
export default defineConfig({
  test: {
    browser: {
      instances: [
        // name: chromium
        { browser: 'chromium' },
        // name: custom
        { browser: 'firefox', name: 'custom' },
      ]
    }
  }
})
```
```ts{3,7,9} [custom]
export default defineConfig({
  test: {
    name: 'custom',
    browser: {
      instances: [
        // name: custom (chromium)
        { browser: 'chromium' },
        // name: manual
        { browser: 'firefox', name: 'manual' },
      ]
    }
  }
})
```
:::
