# Preview konfigurieren

::: warning
Die Hauptfunktion des `preview`-Providers besteht darin, Tests in einer echten Browserumgebung anzuzeigen. Er unterstützt jedoch keine fortgeschrittenen Browser-Automatisierungsfunktionen wie mehrere Browser-Instanzen oder den Headless-Modus. Für komplexere Szenarien solltest du [Playwright](/config/browser/playwright) oder [WebdriverIO](/config/browser/webdriverio) in Betracht ziehen.
:::

Um deine Tests in einem echten Browser laufen zu sehen, musst du das npm-Paket [`@vitest/browser-preview`](https://npmx.dev/package/@vitest/browser-preview) installieren und dessen `preview`-Export in der Eigenschaft `test.browser.provider` deiner Konfiguration angeben:

```ts [vitest.config.js]
import { preview } from '@vitest/browser-preview'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    browser: {
      provider: preview(),
      instances: [{ browser: 'chromium' }]
    },
  },
})
```

Dadurch wird ein neues Browserfenster in deinem Standardbrowser geöffnet, um die Tests auszuführen. Welcher Browser verwendet wird, kannst du über die Eigenschaft `browser` im `instances`-Array konfigurieren. Vitest versucht, diesen Browser automatisch zu öffnen, was jedoch in manchen Umgebungen nicht funktioniert. In diesem Fall kannst du die angegebene URL manuell in deinem gewünschten Browser öffnen.

## Unterschiede zu anderen Providern

Der Preview-Provider hat gegenüber anderen Providern wie [Playwright](/config/browser/playwright) oder [WebdriverIO](/config/browser/webdriverio) einige Einschränkungen:

- Er unterstützt keinen Headless-Modus; das Browserfenster ist immer sichtbar.
- Er unterstützt keine mehrfachen Instanzen desselben Browsers; jede Instanz muss einen anderen Browser verwenden.
- Er unterstützt keine fortgeschrittenen Browser-Capabilities oder -Optionen; du kannst nur den Browsernamen angeben.
- Er unterstützt keine CDP-Befehle (Chrome DevTools Protocol) oder andere Low-Level-Browser-Interaktionen. Anders als bei Playwright oder WebdriverIO wird die [`userEvent`](/api/browser/interactivity)-API lediglich aus [`@testing-library/user-event`](https://npmx.dev/package/@testing-library/user-event) re-exportiert und hat keine besondere Integration mit dem Browser.
