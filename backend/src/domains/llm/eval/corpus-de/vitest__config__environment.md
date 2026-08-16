# environment

- **Typ:** `'node' | 'jsdom' | 'happy-dom' | 'edge-runtime' | string`
- **Standard:** `'node'`
- **CLI:** `--environment=<env>`

Die Umgebung, die zum Testen verwendet wird. Die Standardumgebung in Vitest
ist eine Node.js-Umgebung. Wenn Sie eine Webanwendung bauen, können Sie
stattdessen eine browserähnliche Umgebung über [`jsdom`](https://github.com/jsdom/jsdom)
oder [`happy-dom`](https://github.com/capricorn86/happy-dom) verwenden.
Wenn Sie Edge Functions bauen, können Sie die Umgebung [`edge-runtime`](https://edge-runtime.vercel.app/packages/vm) verwenden

::: tip
Sie können auch den [Browser-Modus](/guide/browser/) verwenden, um Integrations- oder Unit-Tests im Browser auszuführen, ohne die Umgebung zu mocken.
:::

Um eigene Optionen für Ihre Umgebung zu definieren, verwenden Sie [`environmentOptions`](/config/environmentoptions).

Indem Sie einen `@vitest-environment`-Docblock oder -Kommentar an den Anfang der Datei setzen,
können Sie eine andere Umgebung für alle Tests in dieser Datei festlegen:

Docblock-Stil:

```js
/**
 * @vitest-environment jsdom
 */

test('use jsdom in this test file', () => {
  const element = document.createElement('div')
  expect(element).not.toBeNull()
})
```

Kommentar-Stil:

```js
// @vitest-environment happy-dom

test('use happy-dom in this test file', () => {
  const element = document.createElement('div')
  expect(element).not.toBeNull()
})
```

Zur Kompatibilität mit Jest gibt es außerdem `@jest-environment`:

```js
/**
 * @jest-environment jsdom
 */

test('use jsdom in this test file', () => {
  const element = document.createElement('div')
  expect(element).not.toBeNull()
})
```

Sie können auch eine eigene Umgebung definieren. Wenn eine nicht eingebaute Umgebung verwendet wird, versucht Vitest, die Datei zu laden, sofern sie relativ oder absolut angegeben ist, oder ein Paket `vitest-environment-${name}`, wenn der Name ein Bare Specifier ist.

Die Datei der eigenen Umgebung sollte ein Objekt in der Form von `Environment` exportieren:

```ts [environment.js]
import type { Environment } from 'vitest'

export default <Environment>{
  name: 'custom',
  viteEnvironment: 'ssr',
  setup() {
    // custom setup
    return {
      teardown() {
        // called after all tests with this env have been run
      }
    }
  }
}
```

::: tip
Das Feld `viteEnvironment` entspricht der Umgebung, die durch die [Vite Environment API](https://vite.dev/guide/api-environment#environment-api) definiert wird. Standardmäßig stellt Vite die Umgebungen `client` (für den Browser) und `ssr` (für den Server) bereit.
:::

Vitest stellt außerdem `builtinEnvironments` über den Einstiegspunkt `vitest/environments` bereit, falls Sie diese lediglich erweitern möchten. Mehr zum Erweitern von Umgebungen lesen Sie in [unserem Guide](/guide/environment).

::: tip
Die jsdom-Umgebung stellt die globale Variable `jsdom` bereit, die der aktuellen [JSDOM](https://github.com/jsdom/jsdom)-Instanz entspricht. Wenn TypeScript sie erkennen soll, können Sie `vitest/jsdom` zu Ihrer `tsconfig.json` hinzufügen, wenn Sie diese Umgebung verwenden:

```json [tsconfig.json]
{
  "compilerOptions": {
    "types": ["vitest/jsdom"]
  }
}
```
:::
