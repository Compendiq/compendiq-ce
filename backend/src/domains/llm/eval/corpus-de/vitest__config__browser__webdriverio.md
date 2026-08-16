# WebdriverIO konfigurieren

::: info Community maintained
Der WebdriverIO-Provider ([`@vitest/browser-webdriverio`](https://github.com/vitest-community/vitest-webdriverio)) wird von der Vitest-Community in der Organisation [`vitest-community`](https://github.com/vitest-community) gepflegt, getrennt von den Kernpaketen von Vitest. Bitte melde providerspezifische Probleme in dessen Repository.
:::

Um Tests mit WebdriverIO auszuführen, musst du das npm-Paket [`@vitest/browser-webdriverio`](https://npmx.dev/package/@vitest/browser-webdriverio) installieren und dessen `webdriverio`-Export in der Eigenschaft `test.browser.provider` deiner Konfiguration angeben:

```ts [vitest.config.js]
import { webdriverio } from '@vitest/browser-webdriverio'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    browser: {
      provider: webdriverio(),
      instances: [{ browser: 'chrome' }]
    },
  },
})
```

Du kannst alle Parameter konfigurieren, die die Funktion [`remote`](https://webdriver.io/docs/api/modules/#remoteoptions-modifier) akzeptiert:

```ts{8-12,19-25} [vitest.config.js]
import { webdriverio } from '@vitest/browser-webdriverio'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    browser: {
      // shared provider options between all instances
      provider: webdriverio({
        capabilities: {
          browserVersion: '82',
        },
      }),
      instances: [
        { browser: 'chrome' },
        {
          browser: 'firefox',
          // overriding options only for a single instance
          // this will NOT merge options with the parent one
          provider: webdriverio({
            capabilities: {
              'moz:firefoxOptions': {
                args: ['--disable-gpu'],
              },
            },
          })
        },
      ],
    },
  },
})
```

Die meisten verfügbaren Optionen findest du in der [WebdriverIO-Dokumentation](https://webdriver.io/docs/configuration/). Beachte, dass Vitest alle Test-Runner-Optionen ignoriert, da wir ausschließlich die Browser-Capabilities von `webdriverio` nutzen.

::: tip
Die nützlichsten Optionen befinden sich im Objekt `capabilities`. WebdriverIO erlaubt verschachtelte Capabilities, Vitest ignoriert diese Optionen jedoch, da wir für das Starten mehrerer Browser einen anderen Mechanismus verwenden.

Beachte, dass Vitest `capabilities.browserName` ignoriert; verwende stattdessen [`test.browser.instances.browser`](/config/browser/instances#browser).
:::

## Chrome mit sichtbarem Fenster in CI

Vitest aktiviert [`browser.headless`](/config/browser/headless) in CI automatisch.
Wenn du für Chrome auf einem Linux-CI-Runner explizit `headless: false` setzt, benötigt
Chrome trotzdem einen Display-Server. Ohne einen solchen können WebDriverIO oder
ChromeDriver mit einer irreführenden Fehlermeldung fehlschlagen, etwa `session not created:
probably user data directory is already in use`.

Führe den Testbefehl über `xvfb-run` aus, wenn du Chrome mit sichtbarem Fenster in GitHub
Actions oder einer anderen Linux-CI-Umgebung brauchst:

```bash
xvfb-run npm test
```

Alternativ lässt du `browser.headless` in CI aktiviert und nutzt den Modus mit sichtbarem
Fenster nur zum lokalen Debuggen.
