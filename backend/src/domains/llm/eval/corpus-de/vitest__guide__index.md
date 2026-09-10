# Erste Schritte

## Überblick

Vitest (ausgesprochen _„veetest“_) ist ein Testframework der nächsten Generation,
angetrieben von
Vite.

Mehr zu den Beweggründen hinter dem Projekt erfahren Sie im Abschnitt [Warum Vitest](/guide/why).

## Vitest online ausprobieren

Sie können Vitest online auf [StackBlitz](https://vitest.new) ausprobieren. Dort läuft Vitest direkt im Browser und verhält sich nahezu identisch zum lokalen Setup, ohne dass Sie irgendetwas auf Ihrem Rechner installieren müssen.

## Vitest zu Ihrem Projekt hinzufügen

<CourseLink href="https://vueschool.io/lessons/how-to-install-vitest?friend=vueuse">Installation per Video lernen</CourseLink>

::: code-group
```bash [npm]
npm install -D vitest
```
```bash [yarn]
yarn add -D vitest
```
```bash [pnpm]
pnpm add -D vitest
```
```bash [bun]
bun add -D vitest
```
```bash [deno]
deno add -D vitest
```
:::

:::tip
Vitest benötigt Vite >=v6.4.0 und Node >=v22.12.0
:::

Es wird empfohlen, mit einer der oben genannten Methoden eine Kopie von `vitest` in Ihrer `package.json` zu installieren. Wenn Sie `vitest` jedoch lieber direkt ausführen möchten, können Sie `npx vitest` verwenden (das Werkzeug `npx` wird mit npm und Node.js mitgeliefert).

Das Werkzeug `npx` führt den angegebenen Befehl aus. Standardmäßig prüft `npx` zuerst, ob der Befehl in den Binaries des lokalen Projekts existiert. Wird er dort nicht gefunden, sucht `npx` im `$PATH` des Systems und führt ihn aus, falls vorhanden. Findet sich der Befehl an keiner der beiden Stellen, installiert `npx` ihn vor der Ausführung an einem temporären Ort.

Vitest und Integrationen von Drittanbietern können das Verzeichnis `.vitest` nutzen, um erzeugte Artefakte abzulegen. Es empfiehlt sich, dieses in Ihre `.gitignore` aufzunehmen.

``` sh [.gitignore]
# Vitest reports and artifacts
.vitest/
```

## Tests schreiben

Als Beispiel schreiben wir einen einfachen Test, der die Ausgabe einer Funktion prüft, die zwei Zahlen addiert.

``` js [sum.js]
export function sum(a, b) {
  return a + b
}
```

``` js [sum.test.js]
import { expect, test } from 'vitest'
import { sum } from './sum.js'

test('adds 1 + 2 to equal 3', () => {
  expect(sum(1, 2)).toBe(3)
})
```

::: tip
Standardmäßig müssen Tests `.test.` oder `.spec.` im Dateinamen enthalten.
:::

Um den Test auszuführen, fügen Sie als Nächstes folgenden Abschnitt zu Ihrer `package.json` hinzu:

```json [package.json]
{
  "scripts": {
    "test": "vitest"
  }
}
```

Führen Sie schließlich je nach Paketmanager `npm run test`, `yarn test` oder `pnpm test` aus, und Vitest gibt diese Meldung aus:

```txt
✓ sum.test.js (1)
  ✓ adds 1 + 2 to equal 3

Test Files  1 passed (1)
     Tests  1 passed (1)
  Start at  02:15:44
  Duration  311ms
```

::: warning
Wenn Sie Bun als Paketmanager verwenden, nutzen Sie unbedingt den Befehl `bun run test` statt `bun test`, sonst führt Bun seinen eigenen Test-Runner aus.
:::

Ihr erster Test ist grün! Weiter geht es mit [Tests schreiben](/guide/learn/writing-tests), wo Sie lernen, wie Sie Tests organisieren, die Testausgabe lesen und die grundlegenden Testmuster einsetzen, die Sie täglich brauchen werden.

Um Tests einmalig auszuführen, ohne auf Dateiänderungen zu achten, verwenden Sie `vitest run`. Sie können auch zusätzliche Flags wie `--reporter` oder `--coverage` übergeben. Eine vollständige Liste der CLI-Optionen erhalten Sie mit `npx vitest --help` oder im [CLI-Leitfaden](/guide/cli).

## Vitest konfigurieren

Vitest liest standardmäßig Ihre `vite.config.*`, sodass Ihre bestehenden Vite-Plugins und -Konfigurationen ohne weiteres Zutun funktionieren. Sie können außerdem eine eigene `vitest.config.*` für testspezifische Einstellungen anlegen. Details finden Sie in der [Konfigurationsreferenz](/config/).

## IDE-Integrationen

Wir stellen außerdem eine offizielle Erweiterung für Visual Studio Code bereit, die Ihre Testerfahrung mit Vitest verbessert.

[Aus dem VS Code Marketplace installieren](https://marketplace.visualstudio.com/items?itemName=vitest.explorer)

Mehr zu [IDE-Integrationen](/guide/ide)

## Beispiele

| Beispiel | Quellcode | Playground |
|---|---|---|
| `basic` | [GitHub](https://github.com/vitest-dev/vitest/tree/main/examples/basic) | [Online ausprobieren](https://stackblitz.com/fork/github/vitest-dev/vitest/tree/main/examples/basic?initialPath=__vitest__/) |
| `fastify` | [GitHub](https://github.com/vitest-dev/vitest/tree/main/examples/fastify) | [Online ausprobieren](https://stackblitz.com/fork/github/vitest-dev/vitest/tree/main/examples/fastify?initialPath=__vitest__/) |
| `in-source-test` | [GitHub](https://github.com/vitest-dev/vitest/tree/main/examples/in-source-test) | [Online ausprobieren](https://stackblitz.com/fork/github/vitest-dev/vitest/tree/main/examples/in-source-test?initialPath=__vitest__/) |
| `lit` | [GitHub](https://github.com/vitest-dev/vitest/tree/main/examples/lit) | [Online ausprobieren](https://stackblitz.com/fork/github/vitest-dev/vitest/tree/main/examples/lit?initialPath=__vitest__/) |
| `vue` | [GitHub](https://github.com/vitest-tests/browser-examples/tree/main/examples/vue) | [Online ausprobieren](https://stackblitz.com/fork/github/vitest-tests/browser-examples/tree/main/examples/vue?initialPath=__vitest__/) |
| `marko` | [GitHub](https://github.com/vitest-tests/browser-examples/tree/main/examples/marko) | [Online ausprobieren](https://stackblitz.com/fork/github/vitest-tests/browser-examples/tree/main/examples/marko?initialPath=__vitest__/) |
| `preact` | [GitHub](https://github.com/vitest-tests/browser-examples/tree/main/examples/preact) | [Online ausprobieren](https://stackblitz.com/fork/github/vitest-tests/browser-examples/tree/main/examples/preact?initialPath=__vitest__/) |
| `qwik` | [GitHub](https://github.com/vitest-tests/browser-examples/tree/main/examples/qwik) | [Online ausprobieren](https://stackblitz.com/fork/github/vitest-tests/browser-examples/tree/main/examples/qwik?initialPath=__vitest__/) |
| `react` | [GitHub](https://github.com/vitest-tests/browser-examples/tree/main/examples/react) | [Online ausprobieren](https://stackblitz.com/fork/github/vitest-tests/browser-examples/tree/main/examples/react?initialPath=__vitest__/) |
| `solid` | [GitHub](https://github.com/vitest-tests/browser-examples/tree/main/examples/solid) | [Online ausprobieren](https://stackblitz.com/fork/github/vitest-tests/browser-examples/tree/main/examples/solid?initialPath=__vitest__/) |
| `svelte` | [GitHub](https://github.com/vitest-tests/browser-examples/tree/main/examples/svelte) | [Online ausprobieren](https://stackblitz.com/fork/github/vitest-tests/browser-examples/tree/main/examples/svelte?initialPath=__vitest__/) |
| `profiling` | [GitHub](https://github.com/vitest-dev/vitest/tree/main/examples/profiling) | Nicht verfügbar |
| `typecheck` | [GitHub](https://github.com/vitest-dev/vitest/tree/main/examples/typecheck) | [Online ausprobieren](https://stackblitz.com/fork/github/vitest-dev/vitest/tree/main/examples/typecheck?initialPath=__vitest__/) |
| `projects` | [GitHub](https://github.com/vitest-dev/vitest/tree/main/examples/projects) | [Online ausprobieren](https://stackblitz.com/fork/github/vitest-dev/vitest/tree/main/examples/projects?initialPath=__vitest__/) |

## Community

Wenn Sie Fragen haben oder Hilfe brauchen, wenden Sie sich an die Community auf [Discord](https://chat.vitest.dev) und in den [GitHub Discussions](https://github.com/vitest-dev/vitest/discussions).
