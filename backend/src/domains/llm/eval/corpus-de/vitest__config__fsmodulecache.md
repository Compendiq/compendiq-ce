# fsModuleCache <Version>5.0.0</Version>

- **Typ:** `boolean`
- **Standard:** `false`
- **CLI:** `--fsModuleCache`, `--fsModuleCache=false`

Im Watch-Modus hält Vitest alle transformierten Dateien im Arbeitsspeicher vor, was erneute Läufe schnell macht. Dieser Cache wird jedoch verworfen, sobald der Testlauf endet. Das Aktivieren dieser Option erlaubt es Vitest, die transformierten Module im Dateisystem zu persistieren, sodass sie über erneute Läufe und über separate Vitest-Prozesse hinweg wiederverwendet werden können.

Ein einziges Cache-Verzeichnis wird von jedem Projekt im Workspace geteilt. Standardmäßig liegt es in `node_modules` im Workspace-Root (sodass es beim Neuinstallieren der Abhängigkeiten auf natürliche Weise invalidiert wird); verwenden Sie [`fsModuleCachePath`](/config/fsmodulecachepath), um seinen Ort zu ändern. Sie können den Cache löschen, indem Sie [`vitest --clearCache`](/guide/cli#clearcache) ausführen.

::: warning BROWSER-UNTERSTÜTZUNG
Derzeit hat diese Option keine Auswirkung auf [den Browser](/guide/browser/).
:::

Sie können nachvollziehen, ob Ihre Module gecacht werden, indem Sie vitest mit der Umgebungsvariablen `DEBUG=vitest:cache:fs` ausführen:

```shell
DEBUG=vitest:cache:fs vitest --fsModuleCache
```

::: tip
Der Ort des Caches ist ein einzelnes, workspace-weites Verzeichnis. Siehe [`fsModuleCachePath`](/config/fsmodulecachepath), um es zu verschieben.
:::

## Bekannte Probleme

Vitest erzeugt einen persistenten Datei-Hash auf Basis des Dateiinhalts, ihrer Id, der Environment-Konfiguration von Vite und des Coverage-Status. Vitest versucht, so viele Informationen über die Konfiguration wie möglich einzubeziehen, doch diese sind nach wie vor unvollständig. Derzeit ist es nicht möglich, Ihre Plugin-Optionen nachzuverfolgen, weil es dafür keine Standardschnittstelle gibt.

Wenn Sie ein Plugin haben, das auf Dinge außerhalb des Dateiinhalts oder der öffentlichen Konfiguration angewiesen ist (etwa das Lesen einer anderen Datei oder eines Ordners), kann der Cache veralten. Um das zu umgehen, können Sie einen [Cache-Key-Generator](/api/advanced/plugin#definecachekeygenerator) definieren, um eine dynamische Option anzugeben oder das Caching für dieses Modul abzuwählen:

```js [vitest.config.js]
import { defineConfig } from 'vitest/config'

export default defineConfig({
  plugins: [
    {
      name: 'vitest-cache',
      configureVitest({ defineCacheKeyGenerator }) {
        defineCacheKeyGenerator(({ id, sourceCode }) => {
          // never cache this id
          if (id.includes('do-not-cache')) {
            return false
          }

          // cache this file based on the value of a dynamic variable
          if (sourceCode.includes('myDynamicVar')) {
            return process.env.DYNAMIC_VAR_VALUE
          }
        })
      }
    }
  ],
  test: {
    fsModuleCache: true,
  },
})
```

Wenn Sie Plugin-Autor sind, erwägen Sie, in Ihrem Plugin einen [Cache-Key-Generator](/api/advanced/plugin#definecachekeygenerator) zu definieren, sofern es mit unterschiedlichen Optionen registriert werden kann, die das Transformationsergebnis beeinflussen.

Umgekehrt können Sie, wenn Ihr Plugin den Cache-Key nicht beeinflussen soll, dies abwählen, indem Sie `api.vitest.ignoreFsModuleCache` auf `true` setzen:

```js [vitest.config.js]
import { defineConfig } from 'vitest/config'

export default defineConfig({
  plugins: [
    {
      name: 'vitest-cache',
      api: {
        vitest: {
          ignoreFsModuleCache: true,
        },
      },
    },
  ],
  test: {
    fsModuleCache: true,
  },
})
```

Beachten Sie, dass Sie den Cache-Key-Generator auch dann definieren können, wenn das Plugin das Modul-Caching abwählt.
