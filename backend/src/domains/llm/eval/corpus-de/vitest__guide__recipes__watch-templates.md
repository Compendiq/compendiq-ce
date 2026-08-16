# Nicht importierte Dateien überwachen

Im Watch-Modus verfolgt Vitest den Import-Graphen: Wenn du eine Datei änderst, laufen alle Tests erneut, deren Imports diese Datei erreichen. Das deckt die meisten Fälle ab. Nicht erfasst werden Tests, die von Dateien abhängen, die sie nicht per `import` einbinden – etwa E-Mail-Templates, die mit `fs.readFile` geladen werden, JSON-Fixtures, die zur Laufzeit geparst werden, HTML oder CSS, das über einen Build-Schritt hereinkommt, oder generierte Artefakte, gegen die die Tests prüfen. Das Bearbeiten einer solchen Datei lässt die zugehörigen Tests veralten, und die Watch-Schleife kann davon nichts wissen.

[`watchTriggerPatterns`](/config/watchtriggerpatterns) <Version>3.2.0</Version> macht diese Abhängigkeiten explizit. Du deklarierst eine Regex über Dateipfade und einen Callback, der zurückgibt, welche Tests bei einer Änderung einer passenden Datei erneut laufen sollen.

## Muster

```ts [vitest.config.ts]
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    watchTriggerPatterns: [
      {
        pattern: /src\/templates\/(.*)\.(ts|html|txt)$/,
        testsToRun: (file, match) => {
          // edit `src/templates/welcome.html` ⇒ rerun `api/tests/mailers/welcome.test.ts`
          return `api/tests/mailers/${match[1]}.test.ts`
        },
      },
    ],
  },
})
```

`testsToRun` gibt einen oder mehrere Pfade zu Testdateien zurück, die erneut laufen sollen (als String oder String-Array), oder `undefined`, wenn keine Tests erneut laufen sollen. Pfade werden relativ zum Workspace-Root aufgelöst und nicht als Globs interpretiert. `match` ist das Ergebnis von `RegExp.exec` gegen die geänderte Datei.

## Varianten

Mehrere Patterns können nebeneinander bestehen. Das erste unten leitet den Testpfad aus dem Verzeichnis der geänderten Datei ab; das zweite bildet ein einzelnes gemeinsames Fixture auf eine feste Liste von Testdateien ab:

```ts [vitest.config.ts]
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    watchTriggerPatterns: [
      {
        pattern: /src\/(.*)\/schema\.json$/,
        testsToRun: (_file, match) => `src/${match[1]}/__tests__/index.test.ts`,
      },
      {
        pattern: /test\/shared-fixture\.json$/,
        testsToRun: () => [
          'test/integration/users.test.ts',
          'test/integration/billing.test.ts',
        ],
      },
    ],
  },
})
```

[`forceRerunTriggers`](/config/forcereruntriggers) deckt dieselbe grundsätzliche Lücke ab, führt bei jedem Treffer aber sämtliche Tests erneut aus. `watchTriggerPatterns` führt nur die Tests erneut aus, die du einem bestimmten Pattern zuordnest, und hält die Watch-Schleife dadurch schnell.

## Siehe auch

- [`watchTriggerPatterns`](/config/watchtriggerpatterns)
- [`forceRerunTriggers`](/config/forcereruntriggers)
