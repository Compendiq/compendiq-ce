# Häufige Fehler

## Cannot find module './relative-path'

Wenn Sie einen Fehler erhalten, dass ein Modul nicht gefunden werden kann, kann das mehrere verschiedene Dinge bedeuten:

1. Sie haben den Pfad falsch geschrieben. Stellen Sie sicher, dass der Pfad korrekt ist.

2. Möglicherweise verlassen Sie sich auf `baseUrl` in Ihrer `tsconfig.json`. Vite berücksichtigt `tsconfig.json` standardmäßig nicht, daher müssen Sie eventuell selbst [`vite-tsconfig-paths`](https://npmx.dev/package/vite-tsconfig-paths) installieren, wenn Sie sich auf dieses Verhalten verlassen.

```ts
import { defineConfig } from 'vitest/config'
import tsconfigPaths from 'vite-tsconfig-paths'

export default defineConfig({
  plugins: [tsconfigPaths()]
})
```

Oder schreiben Sie Ihren Pfad so um, dass er nicht relativ zum Root ist:

```diff
- import helpers from 'src/helpers'
+ import helpers from '../src/helpers'
```

3. Stellen Sie sicher, dass Sie keine relativen [Aliase](/config/alias) verwenden. Vite behandelt sie relativ zu der Datei, in der der Import steht, und nicht relativ zum Root.

```ts
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    alias: {
      '@/': './src/', // [!code --]
      '@/': new URL('./src/', import.meta.url).pathname, // [!code ++]
    }
  }
})
```

## Failed to Terminate Worker

Dieser Fehler kann auftreten, wenn das `fetch` von NodeJS zusammen mit [`pool: 'threads'`](/config/pool#threads) verwendet wird. Details finden Sie in [#3077](https://github.com/vitest-dev/vitest/issues/3077).

Der Standardwert [`pool: 'forks'`](/config/pool#forks) hat dieses Problem nicht. Wenn Sie `pool: 'threads'` explizit gesetzt haben, behebt der Wechsel zurück zu `'forks'` oder die Verwendung von [`'vmForks'`](/config/pool#vmforks) das Problem.

## Eigene Paket-Conditions werden nicht aufgelöst

Wenn Sie eigene Conditions in den [exports](https://nodejs.org/api/packages.html#package-entry-points) oder [Subpath-Imports](https://nodejs.org/api/packages.html#subpath-imports) Ihrer `package.json` verwenden, werden Sie feststellen, dass Vitest diese Conditions standardmäßig nicht berücksichtigt.

Wenn Sie zum Beispiel Folgendes in Ihrer `package.json` haben:

```json
{
  "exports": {
    ".": {
      "custom": "./lib/custom.js",
      "import": "./lib/index.js"
    }
  },
  "imports": {
    "#internal": {
      "custom": "./src/internal.js",
      "default": "./lib/internal.js"
    }
  }
}
```

Standardmäßig verwendet Vitest nur die Conditions `import` und `default`. Damit Vitest eigene Conditions berücksichtigt, müssen Sie [`ssr.resolve.conditions`](https://vite.dev/config/ssr-options#ssr-resolve-conditions) in Ihrer Vitest-Konfiguration setzen:

```ts [vitest.config.js]
import { defineConfig } from 'vitest/config'

export default defineConfig({
  ssr: {
    resolve: {
      conditions: ['custom', 'import', 'default'],
    },
  },
})
```

::: tip Warum `ssr.resolve.conditions` und nicht `resolve.conditions`?
Vitest folgt der Konfigurationskonvention von Vite:
- [`resolve.conditions`](https://vite.dev/config/shared-options#resolve-conditions) gilt für Vites `client`-Umgebung, die dem Browser-Modus von Vitest, jsdom, happy-dom oder eigenen Umgebungen mit `viteEnvironment: 'client'` entspricht.
- [`ssr.resolve.conditions`](https://vite.dev/config/ssr-options#ssr-resolve-conditions) gilt für Vites `ssr`-Umgebung, die der node-Umgebung von Vitest oder eigenen Umgebungen mit `viteEnvironment: 'ssr'` entspricht.

Da Vitest standardmäßig die `node`-Umgebung verwendet (die `viteEnvironment: 'ssr'` nutzt), erfolgt die Modulauflösung über `ssr.resolve.conditions`. Das gilt sowohl für Paket-Exports als auch für Subpath-Imports.

Mehr über Vite-Umgebungen und Vitest-Umgebungen erfahren Sie unter [`environment`](/config/environment).
:::

## Segfaults und Fehler in nativem Code

Das Ausführen [nativer NodeJS-Module](https://nodejs.org/api/addons.html) mit `pool: 'threads'` kann zu kryptischen Fehlern aus dem nativen Code führen.

- `Segmentation fault (core dumped)`
- `thread '<unnamed>' panicked at 'assertion failed`
- `Abort trap: 6`
- `internal error: entered unreachable code`

In diesen Fällen ist das native Modul wahrscheinlich nicht multithread-sicher gebaut. Als Workaround können Sie zu `pool: 'forks'` wechseln, das die Testfälle in mehreren `node:child_process` statt in mehreren `node:worker_threads` ausführt.

::: code-group
```ts [vitest.config.js]
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    pool: 'forks',
  },
})
```
```bash [CLI]
vitest --pool=forks
```
:::

## Unhandled Promise Rejection

Dieser Fehler tritt auf, wenn ein Promise rejected wird, ihm aber vor dem Leeren der Microtask-Queue kein `.catch()`-Handler und kein `await` beigefügt ist. Dieses Verhalten kommt von JavaScript selbst und ist nicht Vitest-spezifisch. Mehr dazu in der [Node.js-Dokumentation](https://nodejs.org/api/process.html#event-unhandledrejection).

Eine häufige Ursache ist der Aufruf einer asynchronen Funktion ohne `await`:

```ts
async function fetchUser(id) {
  const res = await fetch(`/api/users/${id}`)
  if (!res.ok) {
    throw new Error(`User ${id} not found`) // [!code highlight]
  }
  return res.json()
}

test('fetches user', async () => {
  fetchUser(123) // [!code error]
})
```

Da `fetchUser()` nicht mit `await` versehen ist, hat die Rejection keinen Handler und Vitest meldet:

```
Unhandled Rejection: Error: User 123 not found
```

### Behebung

Versehen Sie das Promise mit `await`, damit Vitest den Fehler auffangen kann:

```ts
test('fetches user', async () => {
  await fetchUser(123) // [!code ++]
})
```

Wenn Sie erwarten, dass der Aufruf einen Fehler wirft, verwenden Sie [`expect().rejects`](/api/expect#rejects):

```ts
test('rejects for missing user', async () => {
  await expect(fetchUser(123)).rejects.toThrow('User 123 not found')
})
```

## Ein Paket lässt sich in Vitest nicht laden, funktioniert aber in Ihrer Anwendung

Manche Pakete funktionieren in einem App-Build, scheitern aber in Vitest, weil sie erst gültig sind, nachdem ein Bundler sie umgeschrieben oder aufgelöst hat. Wenn Vitest eine Abhängigkeit externalisiert, lädt Node.js sie direkt, sodass die ESM- und Paketregeln von Node greifen. Die genauen Regeln finden Sie in der Node.js-Dokumentation zu [ECMAScript-Modulen](https://nodejs.org/docs/latest/api/esm.html) und [Paketen](https://nodejs.org/docs/latest/api/packages.html).

Häufige Beispiele sind Pakete, die

- ESM-Syntax in `.js`-Dateien ausliefern, ohne `"type": "module"` zu setzen
- relative Importe ohne Dateiendung in ESM-Dateien verwenden
- fehlerhafte Einträge unter `exports`, `imports`, `main` oder `module` haben
- CommonJS- und ESM-Einstiegspunkte so mischen, dass es nur nach dem Bundling funktioniert
- CSS oder andere Nicht-JavaScript-Dateien importieren, deren Verarbeitung ein Bundler übernehmen soll

Sie sehen dann möglicherweise Fehler wie:

- `Cannot find module './relative-path' imported from ...`
- `Unexpected token 'export'`
- `Cannot use import statement outside a module`
- `Module ... seems to be an ES Module but shipped in a CommonJS package.`
- `Unknown file extension ".css"`

Beheben Sie das Paket nach Möglichkeit so, dass Node.js es direkt laden kann: Fügen Sie `"type": "module"` für ESM-`.js`-Dateien hinzu, verwenden Sie `.mjs`, geben Sie in ESM-Importen explizite Dateiendungen an und stellen Sie sicher, dass `exports` auf Dateien zeigt, die Node.js laden kann.

Wenn Sie das Paket selbst nicht korrigieren können, inlinen Sie es, damit Vite es verarbeitet, statt es als externe Abhängigkeit an Node.js weiterzureichen. Inlinen Sie die gesamte Abhängigkeitskette, die zu dem fehlerhaften Paket führt. Wenn Ihr Quellcode `wrapper-package` importiert und `wrapper-package` wiederum `broken-package`, inlinen Sie beide Pakete:

```ts [vitest.config.js]
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    server: {
      deps: {
        inline: ['wrapper-package', 'broken-package'],
      },
    },
  },
})
```

Sie können zum selben Zweck auch Vites [`ssr.resolve.noExternal`](https://vite.dev/config/ssr-options#ssr-resolve-noexternal) verwenden. Vitest führt `ssr.resolve.noExternal` mit [`server.deps.inline`](/config/server#server-deps-inline) zusammen, was nützlich ist, wenn die Abhängigkeit auch in SSR-Builds von Vite gebündelt werden muss:

```ts [vitest.config.js]
import { defineConfig } from 'vitest/config'

export default defineConfig({
  ssr: {
    resolve: {
      noExternal: ['wrapper-package', 'broken-package'],
    },
  },
})
```
