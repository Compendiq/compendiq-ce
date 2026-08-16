# name

- **Typ:**

```ts
interface UserConfig {
  name?: string | { label: string; color?: LabelColor }
}
```

Weist dem Testprojekt oder dem Vitest-Prozess einen eigenen Namen zu. Der Name ist in der CLI und in der UI sichtbar und über die Node.js-API via [`project.name`](/api/advanced/test-project#name) verfügbar.

Die von CLI und UI verwendete Farbe lässt sich ändern, indem Sie ein Objekt mit einer `color`-Eigenschaft angeben.

## Farben

Die angezeigten Farben hängen vom Farbschema Ihres Terminals ab. In der UI entsprechen die Farben ihren CSS-Äquivalenten.

- black
- red
- green
- yellow
- blue
- magenta
- cyan
- white

## Beispiel

::: code-group
```js [string]
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    name: 'unit',
  },
})
```
```js [object]
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    name: {
      label: 'unit',
      color: 'blue',
    },
  },
})
```
:::

Diese Eigenschaft ist vor allem dann nützlich, wenn Sie mehrere Projekte haben, da sie hilft, diese in Ihrem Terminal zu unterscheiden:

```js{7,11} [vitest.config.js]
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    projects: [
      {
        name: 'unit',
        include: ['./test/*.unit.test.js'],
      },
      {
        name: 'e2e',
        include: ['./test/*.e2e.test.js'],
      },
    ],
  },
})
```

::: tip
Vitest vergibt automatisch einen Namen, wenn keiner angegeben ist. Reihenfolge der Auflösung:

- Ist das Projekt über eine Konfigurationsdatei oder ein Verzeichnis angegeben, verwendet Vitest das Feld `name` aus der package.json.
- Gibt es keine `package.json`, greift Vitest auf den Basisnamen des Projektordners zurück.
- Ist das Projekt inline im `projects`-Array definiert (als Objekt), vergibt Vitest einen numerischen Namen, der dem Array-Index dieses Projekts entspricht (beginnend bei 0).
:::

::: warning
Beachten Sie, dass Projekte nicht denselben Namen haben dürfen. Vitest wirft während der Auflösung der Konfiguration einen Fehler.
:::

Sie können auch verschiedenen Browser-[Instanzen](/config/browser/instances) unterschiedliche Namen zuweisen:

```js{10,11} [vitest.config.js]
import { defineConfig } from 'vitest/config'
import { playwright } from '@vitest/browser-playwright'

export default defineConfig({
  test: {
    browser: {
      enabled: true,
      provider: playwright(),
      instances: [
        { browser: 'chromium', name: 'Chrome' },
        { browser: 'firefox', name: 'Firefox' },
      ],
    },
  },
})
```

::: tip
Browser-Instanzen erben den Namen ihres übergeordneten Projekts, wobei der Browsername in Klammern angehängt wird. Ein Projekt namens `browser` mit einer chromium-Instanz wird zum Beispiel als `browser (chromium)` angezeigt.

Hat das übergeordnete Projekt keinen Namen oder sind die Instanzen auf oberster Ebene definiert (nicht innerhalb eines benannten Projekts), entspricht der Instanzname standardmäßig dem Browser-Wert (z. B. `chromium`). Um dieses Verhalten zu überschreiben, setzen Sie auf der Instanz einen expliziten `name`.
:::
