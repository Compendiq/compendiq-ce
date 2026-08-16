# Playwright konfigurieren

Um Tests mit Playwright auszuführen, musst du das npm-Paket [`@vitest/browser-playwright`](https://npmx.dev/package/@vitest/browser-playwright) installieren und dessen `playwright`-Export in der Eigenschaft `test.browser.provider` deiner Konfiguration angeben:

```ts [vitest.config.js]
import { playwright } from '@vitest/browser-playwright'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    browser: {
      provider: playwright(),
      instances: [{ browser: 'chromium' }]
    },
  },
})
```

Du kannst [`launchOptions`](https://playwright.dev/docs/api/class-browsertype#browser-type-launch), [`connectOptions`](https://playwright.dev/docs/api/class-browsertype#browser-type-connect) und [`contextOptions`](https://playwright.dev/docs/api/class-browser#browser-new-context) konfigurieren, wenn du `playwright` auf oberster Ebene oder innerhalb von Instanzen aufrufst:

```ts{7-14,21-26} [vitest.config.js]
import { playwright } from '@vitest/browser-playwright'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    browser: {
      // shared provider options between all instances
      provider: playwright({
        launchOptions: {
          slowMo: 50,
          channel: 'chrome-beta',
        },
        actionTimeout: 5_000,
      }),
      instances: [
        { browser: 'chromium' },
        {
          browser: 'firefox',
          // overriding options only for a single instance
          // this will NOT merge options with the parent one
          provider: playwright({
            launchOptions: {
              firefoxUserPrefs: {
                'browser.startup.homepage': 'https://example.com',
              },
            },
          })
        }
      ],
    },
  },
})
```

::: warning
Anders als der Playwright-Test-Runner öffnet Vitest eine _einzelne_ Seite, um alle Tests auszuführen, die in derselben Datei definiert sind. Das bedeutet, dass die Isolation auf eine einzelne Testdatei beschränkt ist, nicht auf jeden einzelnen Test.
:::

## launchOptions

Diese Optionen werden direkt an den Befehl `playwright[browser].launch` durchgereicht. Mehr zu diesem Befehl und den verfügbaren Argumenten findest du in der [Playwright-Dokumentation](https://playwright.dev/docs/api/class-browsertype#browser-type-launch).

::: warning
Vitest ignoriert die Option `launch.headless`. Verwende stattdessen [`test.browser.headless`](/config/browser/headless).

Beachte, dass Vitest Debugging-Flags an `launch.args` anhängt, wenn [`--inspect`](/guide/cli#inspect) aktiviert ist.
:::

::: tip Den neuen Headless-Modus von Chromium aktivieren
Playwright unterstützt einen [neuen Headless-Modus](https://playwright.dev/docs/browsers#chromium-new-headless-mode) für Chromium, der den echten Chrome-Browser statt der dedizierten Headless-Shell verwendet. Das sorgt für eine authentischere, zuverlässigere Testausführung und macht die Installation eines separaten Headless-Chromium-Builds überflüssig.

Um das zu aktivieren, setze `channel` in `launchOptions` auf `'chromium'`:

```ts [vitest.config.ts]
import { playwright } from '@vitest/browser-playwright'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    browser: {
      headless: true,
      provider: playwright({
        launchOptions: {
          channel: 'chromium',
        },
      }),
      instances: [{ browser: 'chromium' }],
    },
  },
})
```
:::

## connectOptions

Diese Optionen werden direkt an den Befehl `playwright[browser].connect` durchgereicht. Mehr zu diesem Befehl und den verfügbaren Argumenten findest du in der [Playwright-Dokumentation](https://playwright.dev/docs/api/class-browsertype#browser-type-connect).

Verwende `connectOptions.wsEndpoint`, um dich mit einem bestehenden Playwright-Server zu verbinden, statt Browser lokal zu starten. Das ist nützlich, um Browser in Docker, in der CI oder auf einer entfernten Maschine auszuführen.

::: warning

Vitest leitet `launchOptions` über den Header `x-playwright-launch-options` an den Playwright-Server weiter. Das funktioniert nur, wenn der entfernte Playwright-Server diesen Header unterstützt, zum Beispiel bei Verwendung der CLI `playwright run-server`.

:::

::: details Beispiel: Einen Playwright-Server in Docker betreiben
Um Browser in einem Docker-Container auszuführen (siehe [Playwright-Docker-Leitfaden](https://playwright.dev/docs/docker#remote-connection)):

Starte einen Playwright-Server mit Docker Compose:

```yaml [docker-compose.yml]
services:
  playwright:
    image: mcr.microsoft.com/playwright:v1.61.0-noble
    command: /bin/sh -c "npx -y playwright@1.61.0 run-server --port 6677 --host 0.0.0.0"
    init: true
    ipc: host
    user: pwuser
    ports:
      - '6677:6677'
```

```sh
docker compose up -d
```

Konfiguriere dann Vitest so, dass es sich damit verbindet. Die Option [`exposeNetwork`](https://playwright.dev/docs/api/class-browsertype#browser-type-connect-option-expose-network) erlaubt es dem Browser im Container, den Dev-Server von Vitest auf dem Host zu erreichen:

```ts [vitest.config.ts]
import { playwright } from '@vitest/browser-playwright'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    browser: {
      provider: playwright({
        connectOptions: {
          wsEndpoint: 'ws://127.0.0.1:6677/',
          exposeNetwork: '<loopback>',
        },
      }),
      instances: [
        { browser: 'chromium' },
        { browser: 'firefox' },
        { browser: 'webkit' },
      ],
    },
  },
})
```
:::

## contextOptions

Vitest erstellt für jede Testdatei einen neuen Kontext, indem es [`browser.newContext()`](https://playwright.dev/docs/api/class-browsercontext) aufruft. Du kannst dieses Verhalten konfigurieren, indem du [eigene Argumente](https://playwright.dev/docs/api/class-browser#browser-new-context) angibst.

::: tip
Beachte, dass der Kontext für jede _Testdatei_ erstellt wird, nicht für jeden _Test_ wie im Playwright-Test-Runner.
:::

::: warning
Vitest setzt `ignoreHTTPSErrors` immer auf `true`, falls dein Server über HTTPS ausgeliefert wird, und `serviceWorkers` auf `'allow'`, um Modul-Mocking über [MSW](https://mswjs.io) zu unterstützen.

Es wird außerdem empfohlen, [`test.browser.viewport`](/config/browser/headless) zu verwenden, statt dies hier anzugeben, da die Angabe verloren geht, wenn Tests im Headless-Modus laufen.
:::

## `actionTimeout`

- **Standard:** kein Timeout

Dieser Wert konfiguriert das Standard-Timeout, das Playwright wartet, bis alle Accessibility-Prüfungen bestanden sind und [die Aktion](/api/browser/interactivity) tatsächlich abgeschlossen ist.

Du kannst das Action-Timeout auch pro Aktion konfigurieren:

```ts
import { page, userEvent } from 'vitest/browser'

await userEvent.click(page.getByRole('button'), {
  timeout: 1_000,
})
```

## `persistentContext` <Version>4.1.0</Version> {#persistentcontext}

- **Typ:** `boolean | string`
- **Standard:** `false`

Ist dies aktiviert, verwendet Vitest Playwrights [persistenten Kontext](https://playwright.dev/docs/api/class-browsertype#browser-type-launch-persistent-context) statt eines regulären Browser-Kontexts. Damit bleibt der Browser-Zustand (Cookies, localStorage, DevTools-Einstellungen usw.) zwischen Testläufen erhalten.

::: warning
Diese Option wird ignoriert, wenn Tests parallel ausgeführt werden (z. B. im Headless-Modus mit aktiviertem [`fileParallelism`](/config/fileparallelism)), da ein persistenter Kontext nicht über parallele Sessions hinweg geteilt werden kann.
:::

- Auf `true` gesetzt werden die Nutzerdaten in `./node_modules/.cache/vitest-playwright-user-data` gespeichert
- Auf einen String gesetzt wird der Wert als Pfad zum Nutzerdatenverzeichnis verwendet

```ts [vitest.config.js]
import { playwright } from '@vitest/browser-playwright'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    browser: {
      provider: playwright({
        persistentContext: true,
        // or specify a custom directory:
        // persistentContext: './my-browser-data',
      }),
      instances: [{ browser: 'chromium' }],
    },
  },
})
```
