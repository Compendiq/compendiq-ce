# strictTags <Version>4.1.0</Version> {#stricttags}

- **Typ:** `boolean`
- **Standard:** `true`
- **CLI:** `--strict-tags`, `--no-strict-tags`

Soll Vitest einen Fehler werfen, wenn ein Test ein [`tag`](/config/tags) trägt, das nicht in der Konfiguration definiert ist? Damit wird vermieden, dass durch vertippte Namen stillschweigend etwas Überraschendes passiert (die falsche Konfiguration wird angewendet oder der Test wird wegen eines `--tags-filter`-Flags übersprungen).

Beachten Sie, dass Vitest immer einen Fehler wirft, wenn das Flag `--tags-filter` ein Tag angibt, das nicht in der Konfiguration vorhanden ist.

Dieser Test wirft zum Beispiel einen Fehler, weil das Tag `fortnend` einen Tippfehler enthält (es sollte `frontend` heißen):

::: code-group
```js [form.test.js]
test('renders a form', { tags: ['fortnend'] }, () => {
  // ...
})
```
```js [vitest.config.js]
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    tags: [
      { name: 'frontend' },
    ],
  },
})
```
:::
