# browser.instances

- **Typ:** `BrowserConfig`
- **Standard:** `[]`

Definiert mehrere Browser-Setups. Jede Konfiguration muss mindestens ein `browser`-Feld haben.

Du kannst die meisten [Projektoptionen](/config/) angeben (jene ohne <CRoot />-Symbol) sowie einige der `browser`-Optionen wie `browser.testerHtmlPath`.

::: warning
Jede Browser-Konfiguration erbt Optionen von der Root-Konfiguration:

```ts{3,9} [vitest.config.ts]
export default defineConfig({
  test: {
    setupFile: ['./root-setup-file.js'],
    browser: {
      enabled: true,
      testerHtmlPath: './custom-path.html',
      instances: [
        {
          // will have both setup files: "root" and "browser"
          setupFile: ['./browser-setup-file.js'],
          // implicitly has "testerHtmlPath" from the root config // [!code warning]
          // testerHtmlPath: './custom-path.html', // [!code warning]
        },
      ],
    },
  },
})
```

Weitere Beispiele findest du im [Leitfaden „Multiple Setups"](/guide/browser/multiple-setups).
:::

Liste der verfügbaren `browser`-Optionen:

- `browser` (der Name des Browsers)
- [`headless`](/config/browser/headless)
- [`locators`](/config/browser/locators)
- [`viewport`](/config/browser/viewport)
- [`testerHtmlPath`](/config/browser/testerhtmlpath)
- [`screenshotDirectory`](/config/browser/screenshotdirectory)
- [`screenshotFailures`](/config/browser/screenshotfailures)
- [`provider`](/config/browser/provider)

Intern wandelt Vitest diese Instanzen in separate [Testprojekte](/api/advanced/test-project) um, die sich für eine bessere Caching-Leistung einen einzigen Vite-Server teilen.
