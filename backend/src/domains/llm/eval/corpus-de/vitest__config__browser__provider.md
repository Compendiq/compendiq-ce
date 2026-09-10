# browser.provider {#browser-provider}

- **Typ:** `BrowserProviderOption`

Der Rückgabewert der Provider-Factory. Sie können die Factory aus `@vitest/browser-<provider-name>` importieren oder Ihren eigenen Provider schreiben:

```ts{8-10}
import { playwright } from '@vitest/browser-playwright'
import { webdriverio } from '@vitest/browser-webdriverio'
import { preview } from '@vitest/browser-preview'

export default defineConfig({
  test: {
    browser: {
      provider: playwright(),
      provider: webdriverio(),
      provider: preview(),
    },
  },
})
```

Um zu konfigurieren, wie der Provider den Browser initialisiert, können Sie Optionen an die Factory-Funktion übergeben:

```ts{7-13,20-26}
import { playwright } from '@vitest/browser-playwright'

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

## Eigener Provider <Badge type="danger">advanced</Badge> {#custom-provider}

::: danger ADVANCED API
Die API für eigene Provider ist hochgradig experimentell und kann sich zwischen Patch-Versionen ändern. Wenn Sie lediglich Tests in einem Browser ausführen möchten, verwenden Sie stattdessen die Option [`browser.instances`](/config/browser/instances).
:::

```ts
export interface BrowserProvider {
  name: string
  mocker?: BrowserModuleMocker
  readonly initScripts?: string[]
  /**
   * @experimental opt-in into file parallelisation
   */
  supportsParallelism: boolean
  getCommandsContext: (sessionId: string) => Record<string, unknown>
  openPage: (sessionId: string, url: string) => Promise<void>
  getCDPSession?: (sessionId: string) => Promise<CDPSession>
  close: () => Awaitable<void>
}
```
