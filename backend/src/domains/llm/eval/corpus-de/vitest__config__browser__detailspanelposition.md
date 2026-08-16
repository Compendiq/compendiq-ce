# browser.detailsPanelPosition

- **Typ:** `'right' | 'bottom'`
- **Standard:** `'right'`
- **CLI:** `--browser.detailsPanelPosition=bottom`, `--browser.detailsPanelPosition=right`

Steuert die Standardposition des Detailbereichs in der Vitest-UI beim Ausführen von Browser-Tests.

- `'right'` – zeigt den Detailbereich auf der rechten Seite mit einer horizontalen Teilung zwischen dem Browser-Viewport und dem Detailbereich an.
- `'bottom'` – zeigt den Detailbereich am unteren Rand mit einer vertikalen Teilung zwischen dem Browser-Viewport und dem Detailbereich an.

```ts [vitest.config.ts]
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    browser: {
      enabled: true,
      detailsPanelPosition: 'bottom', // or 'right'
    },
  },
})
```

## Beispiel

::: tabs
== bottom
<center>
  <img alt="Vitest-UI mit Details am unteren Rand" img-light src="/ui/light-ui-details-bottom.png">
  <img alt="Vitest-UI mit Details am unteren Rand" img-dark src="/ui/dark-ui-details-bottom.png">
</center>
== right
<center>
  <img alt="Vitest-UI mit Details auf der rechten Seite" img-light src="/ui/light-ui-details-right.png">
  <img alt="Vitest-UI mit Details auf der rechten Seite" img-dark src="/ui/dark-ui-details-right.png">
</center>
:::
