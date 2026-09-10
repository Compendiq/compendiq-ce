# browser.trace

- **Typ:** `'on' | 'off' | 'on-first-retry' | 'on-all-retries' | 'retain-on-failure' | object`
- **CLI:** `--browser.trace=on`, `--browser.trace=retain-on-failure`
- **Standard:** `'off'`

Zeichnet einen Trace deiner Browser-Testläufe auf. Traces kannst du mit dem [Playwright Trace Viewer](https://trace.playwright.dev/) ansehen.

Den vollständigen Ablauf beschreibt [Playwright Traces](/guide/browser/playwright-traces).

Diese Option unterstützt die folgenden Werte:

- `'on'` – Trace für alle Tests aufzeichnen. (nicht empfohlen, da sehr performanceintensiv)
- `'off'` – keine Traces aufzeichnen.
- `'on-first-retry'` – Trace nur beim ersten Wiederholungsversuch des Tests aufzeichnen.
- `'on-all-retries'` – Trace bei jedem Wiederholungsversuch des Tests aufzeichnen.
- `'retain-on-failure'` – Trace nur für fehlgeschlagene Tests aufzeichnen. Traces bestandener Tests werden automatisch gelöscht.
- `object` – ein Objekt der folgenden Form:

```ts
interface TraceOptions {
  mode: 'on' | 'off' | 'on-first-retry' | 'on-all-retries' | 'retain-on-failure'
  /**
   * The directory where all traces will be stored. By default, Vitest
   * stores all traces in `__traces__` folder close to the test file.
   */
  tracesDir?: string
  /**
   * Whether to capture screenshots during tracing. Screenshots are used to build a timeline preview.
   * @default true
   */
  screenshots?: boolean
  /**
   * If this option is true tracing will
   * - capture DOM snapshot on every action
   * - record network activity
   * @default true
   */
  snapshots?: boolean
}
```

::: danger WARNING
Diese Option wird nur vom Provider [**playwright**](/config/browser/playwright) unterstützt.
:::
