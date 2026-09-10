# allowOnly

- **Typ:** `boolean`
- **Standard:** `!process.env.CI`
- **CLI:** `--allowOnly`, `--allowOnly=false`

Standardmäßig lässt Vitest Tests, die mit dem Flag [`only`](/api/test#test-only) markiert sind, in Continuous-Integration-Umgebungen (CI) nicht zu. In lokalen Entwicklungsumgebungen erlaubt Vitest die Ausführung dieser Tests hingegen.

::: info
Vitest verwendet das Paket [`std-env`](https://npmx.dev/package/std-env), um die Umgebung zu erkennen.
:::

Sie können dieses Verhalten anpassen, indem Sie die Option `allowOnly` explizit auf `true` oder `false` setzen.

::: code-group
```js [vitest.config.js]
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    allowOnly: true,
  },
})
```
```bash [CLI]
vitest --allowOnly
```
:::

Ist die Option aktiviert, lässt Vitest die Test-Suite nicht fehlschlagen, wenn mit [`only`](/api/test#test-only) markierte Tests erkannt werden – auch nicht in CI-Umgebungen.

Ist die Option deaktiviert, lässt Vitest die Test-Suite fehlschlagen, wenn mit [`only`](/api/test#test-only) markierte Tests erkannt werden – auch in lokalen Entwicklungsumgebungen.
