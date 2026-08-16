# Testprojekte

::: tip Beispielprojekt

[GitHub](https://github.com/vitest-dev/vitest/tree/main/examples/projects) - [Online ausprobieren](https://stackblitz.com/fork/github/vitest-dev/vitest/tree/main/examples/projects?initialPath=__vitest__/)

:::

::: warning
Diese Funktion ist auch als `workspace` bekannt. Der `workspace` ist seit 3.2 veraltet und wurde durch die Konfiguration `projects` ersetzt. Funktional sind sie identisch.
:::

Vitest bietet eine Möglichkeit, mehrere Projektkonfigurationen innerhalb eines einzigen Vitest-Prozesses zu definieren. Diese Funktion ist besonders für Monorepo-Setups nützlich, kann aber auch verwendet werden, um Tests mit unterschiedlichen Konfigurationen auszuführen, etwa `resolve.alias`, `plugins` oder `test.browser` und mehr.

## Projekte definieren

Sie können Projekte in Ihrer Root-[Konfiguration](/config/) definieren:

```ts [vitest.config.ts]
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    projects: ['packages/*'],
  },
})
```

Projektkonfigurationen sind Inline-Konfigurationen, Dateien oder Glob-Muster, die auf Ihre Projekte verweisen. Wenn Sie zum Beispiel einen Ordner namens `packages` haben, der Ihre Projekte enthält, können Sie in Ihrer Root-Vitest-Konfiguration ein Array definieren:

```ts [vitest.config.ts]
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    projects: ['packages/*'],
  },
})
```

Vitest behandelt jeden Ordner in `packages` als eigenes Projekt, selbst wenn darin keine Konfigurationsdatei liegt. Wenn ein Projekteintrag auf eine Datei verweist (entweder aus einem Glob-Muster oder als direkter Dateipfad), prüft Vitest, ob der Name entweder:

- mit `vitest.config` oder `vite.config` beginnt (zum Beispiel `vitest.config.unit.ts`)
- oder auf `vitest.<name>.config.*` / `vite.<name>.config.*` passt, wobei `<name>` Buchstaben, Zahlen, `_` und `-` enthalten darf

Diese Konfigurationsdateien sind zum Beispiel gültig:

- `vitest.config.ts`
- `vite.config.js`
- `vitest.unit.config.ts`
- `vitest.e2e-node.config.ts`
- `vite.e2e.config.js`
- `vitest.config.unit.js`
- `vite.config.e2e.js`

Um Ordner und Dateien auszuschließen, können Sie das Negationsmuster verwenden:

```ts [vitest.config.ts]
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // include all folders inside "packages" except "excluded"
    projects: [
      'packages/*',
      '!packages/excluded'
    ],
  },
})
```

Wenn Sie eine verschachtelte Struktur haben, in der einige Ordner Projekte sein sollen, andere Ordner aber eigene Unterordner besitzen, müssen Sie Klammern verwenden, um ein Treffen des übergeordneten Ordners zu vermeiden:

```ts [vitest.config.ts]
import { defineConfig } from 'vitest/config'

// For example, this will create projects:
// packages/a
// packages/b
// packages/business/c
// packages/business/d
// Notice that "packages/business" is not a project itself

export default defineConfig({
  test: {
    projects: [
      // matches every folder inside "packages" except "business"
      'packages/!(business)',
      // matches every folder inside "packages/business"
      'packages/business/*',
    ],
  },
})
```

::: warning
Vitest behandelt die Root-Datei `vitest.config` nicht als Projekt, sofern sie nicht ausdrücklich in der Konfiguration angegeben ist. Folglich beeinflusst die Root-Konfiguration nur globale Optionen wie `reporters` und `coverage`. Beachten Sie, dass Vitest bestimmte Plugin-Hooks, die in der Root-Konfigurationsdatei angegeben sind – etwa `apply`, `config`, `configResolved` oder `configureServer` –, immer ausführt. Vitest verwendet dieselben Plugins auch, um globale Setups und einen eigenen Coverage-Provider auszuführen.
:::

Sie können Projekte auch über ihre Konfigurationsdateien referenzieren:

```ts [vitest.config.ts]
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    projects: ['packages/*/vitest.config.{e2e,unit}.ts'],
  },
})
```

Dieses Muster schließt nur Projekte mit einer `vitest.config`-Datei ein, die vor der Dateiendung `e2e` oder `unit` enthält.

Sie können Projekte auch über eine Inline-Konfiguration definieren. Die Konfiguration unterstützt beide Schreibweisen gleichzeitig.

```ts [vitest.config.ts]
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    projects: [
      // matches every folder and file inside the `packages` folder
      'packages/*',
      {
        // inline projects inherit the options
        // from this config file by default
        test: {
          include: ['tests/**/*.{browser}.test.{ts,js}'],
          // it is recommended to define a name when using inline configs
          name: 'happy-dom',
          environment: 'happy-dom',
        }
      },
      {
        // add "extends: false" to ignore
        // the options defined in this config file
        extends: false,
        test: {
          include: ['tests/**/*.{node}.test.{ts,js}'],
          // color of the name label can be changed
          name: { label: 'node', color: 'green' },
          environment: 'node',
        }
      }
    ]
  }
})
```

::: warning
Alle Projekte müssen eindeutige Namen haben; andernfalls wirft Vitest einen Fehler. Wird in der Inline-Konfiguration kein Name angegeben, vergibt Vitest eine Nummer. Bei Projektkonfigurationen, die per Glob-Syntax definiert sind, verwendet Vitest standardmäßig die Eigenschaft "name" aus der nächstgelegenen `package.json`-Datei oder, falls keine existiert, den Ordnernamen.
:::

Projekte unterstützen nicht alle Konfigurationseigenschaften. Für bessere Typsicherheit verwenden Sie in Projektkonfigurationsdateien die Methode `defineProject` statt `defineConfig`:

```ts twoslash [packages/a/vitest.config.ts]
// @errors: 2769
import { defineProject } from 'vitest/config'

export default defineProject({
  test: {
    environment: 'jsdom',
    // "reporters" is not supported in a project config,
    // so it will show an error
    reporters: ['json']
  }
})
```

## Tests ausführen

Um Tests auszuführen, definieren Sie ein Skript in Ihrer Root-`package.json`:

```json [package.json]
{
  "scripts": {
    "test": "vitest"
  }
}
```

Jetzt können die Tests mit Ihrem Paketmanager ausgeführt werden:

::: code-group
```bash [npm]
npm run test
```
```bash [yarn]
yarn test
```
```bash [pnpm]
pnpm run test
```
```bash [bun]
bun run test
```
:::

Wenn Sie Tests nur innerhalb eines einzelnen Projekts ausführen müssen, verwenden Sie die CLI-Option `--project`:

::: code-group
```bash [npm]
npm run test --project e2e
```
```bash [yarn]
yarn test --project e2e
```
```bash [pnpm]
pnpm run test --project e2e
```
```bash [bun]
bun run test --project e2e
```
:::

::: tip
Die CLI-Option `--project` kann mehrfach verwendet werden, um mehrere Projekte herauszufiltern:

::: code-group
```bash [npm]
npm run test --project e2e --project unit
```
```bash [yarn]
yarn test --project e2e --project unit
```
```bash [pnpm]
pnpm run test --project e2e --project unit
```
```bash [bun]
bun run test --project e2e --project unit
```
:::

## Konfiguration

Mit einer Inline-Konfiguration definierte Projekte erben alle Optionen der Konfiguration auf Root-Ebene. Gesteuert wird das über die Option `extends`, die seit Vitest 5.0 standardmäßig aktiviert ist:

```ts [vitest.config.ts]
import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  test: {
    pool: 'threads',
    projects: [
      {
        // inherits options from this config like plugins and pool
        // (`extends: true` is the default)
        test: {
          name: 'unit',
          include: ['**/*.unit.test.ts'],
        },
      },
      {
        // won't inherit any options from this config
        extends: false,
        test: {
          name: 'integration',
          include: ['**/*.integration.test.ts'],
        },
      },
    ],
  },
})
```

Die Option `extends` akzeptiert auch einen Pfad zu einer anderen Konfigurationsdatei, wenn Sie Optionen aus einer anderen Datei als der Root-Konfiguration erben möchten:

```ts [vitest.config.ts]
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    projects: [
      {
        extends: './vitest.shared.ts',
        test: {
          name: 'unit',
          include: ['**/*.unit.test.ts'],
        },
      },
    ],
  },
})
```

Alle Optionen der erweiterten Konfiguration werden mit den eigenen Optionen des Projekts zusammengeführt. Beachten Sie, dass Arrays wie `setupFiles` aneinandergehängt und nicht überschrieben werden. Einige Optionen werden gesondert behandelt:

- `name` und `projects` werden nie vererbt.
- `globalSetup` wird nicht von der Root-Konfiguration geerbt: Das `globalSetup` auf Root-Ebene läuft ohnehin einmal pro Testlauf, sodass eine Vererbung dieselben Dateien für jedes Projekt erneut ausführen würde. Beim Erweitern einer Nicht-Root-Konfigurationsdatei wird es weiterhin geerbt.
- Die eigenen `tags` des Projekts ersetzen das geerbte Array, statt mit ihm zusammengeführt zu werden.

Wenn Sie Vitest über die [Advanced API](/guide/advanced/) ausführen, siehe [Project Configuration Resolution](/guide/advanced/#project-configuration-resolution) dazu, wie die programmatische Konfiguration an der Vererbung teilnimmt.

Projekte, die als Konfigurationsdateien oder Verzeichnisse referenziert werden, erben keinerlei Optionen aus der Root-Konfiguration. Sie können eine gemeinsame Konfigurationsdatei erstellen und sie selbst mit der Projektkonfiguration zusammenführen:

```ts [packages/a/vitest.config.ts]
import { defineProject, mergeConfig } from 'vitest/config'
import configShared from '../vitest.shared.js'

export default mergeConfig(
  configShared,
  defineProject({
    test: {
      environment: 'jsdom',
    }
  })
)
```

::: danger Nicht unterstützte Optionen
Einige der Konfigurationsoptionen sind in einer Projektkonfiguration nicht erlaubt. Besonders hervorzuheben:

- `coverage`: Coverage wird für den gesamten Prozess ermittelt
- `reporters`: Es können nur Reporter auf Root-Ebene unterstützt werden
- `resolveSnapshotPath`: Nur der Resolver auf Root-Ebene wird berücksichtigt
- `attachmentsDir`: Anhänge werden in einem einzigen, von allen Projekten geteilten Verzeichnis auf Root-Ebene gespeichert
- alle weiteren Optionen, die keinen Einfluss auf Test-Runner haben

Alle Konfigurationsoptionen, die innerhalb einer Projektkonfiguration nicht unterstützt werden, sind mit einem <CRoot />-Symbol neben ihrem Namen gekennzeichnet. Sie können nur einmal in der Root-Konfigurationsdatei definiert werden.
:::

## Verschachtelte Projekte

Ein Projekt, das als Konfigurationsdatei (oder als Verzeichnis mit einer solchen) referenziert wird, kann selbst `projects` deklarieren. Eine solche Konfiguration verhält sich wie die Root-Konfiguration: Sie führt selbst keine Tests aus, sondern stellt nur die Projekte bereit, die das tun. Damit lässt sich ein Workspace referenzieren, der bereits eigene Projekte definiert:

```ts [vitest.config.ts]
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    projects: ['./packages/app/vitest.config.ts'],
  },
})
```

```ts [packages/app/vitest.config.ts]
import { defineProject } from 'vitest/config'

export default defineProject({
  test: {
    name: 'app',
    projects: [
      {
        test: {
          name: 'unit',
          include: ['**/*.unit.test.ts'],
        },
      },
      {
        test: {
          name: 'e2e',
          include: ['**/*.e2e.test.ts'],
        },
      },
    ],
  },
})
```

Verschachtelte Projekte funktionieren genauso wie Projekte, die in der Root-Konfiguration definiert sind: Inline-Konfigurationen erweitern die Konfiguration, die sie deklariert (hier die `app`-Konfiguration, nicht die Root-Konfiguration), `extends`-Pfade werden relativ dazu aufgelöst, und ihr eigenes `globalSetup` wird [wie bei jeder anderen Nicht-Root-Konfiguration](#configuration) von den erweiternden Projekten geerbt.

Die Namen verschachtelter Projekte werden mit dem Namen der deklarierenden Konfiguration präfigiert, sodass das obige Beispiel die Projekte `app (unit)` und `app (e2e)` erzeugt. Der Filter `--project` trifft auch auf das Präfix zu: `--project app` führt jedes Projekt der `app`-Konfiguration aus, während `--project "app (unit)"` nur eines davon ausführt.

Um auch die Tests der Konfiguration auszuführen, die `projects` deklariert, referenzieren Sie ihre eigene Konfigurationsdatei:

```ts [packages/app/vitest.config.ts]
import { defineProject } from 'vitest/config'

export default defineProject({
  test: {
    name: 'app',
    include: ['**/*.test.ts'],
    projects: [
      // the "app" project runs its own "include" alongside "app (unit)"
      './vitest.config.ts',
      {
        test: {
          name: 'unit',
          include: ['**/*.unit.test.ts'],
        },
      },
    ],
  },
})
```

Beachten Sie, dass nur Konfigurationsdateien verschachtelte Projekte definieren können. Die Option `projects` innerhalb einer Inline-Konfiguration wird nicht unterstützt.
