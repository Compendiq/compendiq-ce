# Testumgebung

Vitest stellt die Option [`environment`](/config/environment) bereit, um Code in einer bestimmten Umgebung auszuführen. Das Verhalten der Umgebung lässt sich über die Option [`environmentOptions`](/config/environmentoptions) anpassen.

Standardmäßig stehen folgende Umgebungen zur Verfügung:

- `node` ist die Standardumgebung
- `jsdom` emuliert eine Browserumgebung, indem es die Browser-API bereitstellt, und verwendet das Paket [`jsdom`](https://github.com/jsdom/jsdom)
- `happy-dom` emuliert eine Browserumgebung, indem es die Browser-API bereitstellt, gilt als schneller als jsdom, es fehlen jedoch einige APIs; verwendet das Paket [`happy-dom`](https://github.com/capricorn86/happy-dom)
- `edge-runtime` emuliert Vercels [edge-runtime](https://edge-runtime.vercel.app/) und verwendet das Paket [`@edge-runtime/vm`](https://npmx.dev/package/@edge-runtime/vm)

::: info
Bei Verwendung der Umgebungen `jsdom` oder `happy-dom` folgt Vitest denselben Regeln wie Vite beim Importieren von [CSS](https://vitejs.dev/guide/features.html#css) und [Assets](https://vitejs.dev/guide/features.html#static-assets). Falls der Import einer externen Abhängigkeit mit dem Fehler `unknown extension .css` fehlschlägt, müssen Sie die gesamte Importkette manuell inlinen, indem Sie alle Pakete zu [`server.deps.inline`](/config/server#inline) hinzufügen. Tritt der Fehler zum Beispiel in `package-3` dieser Importkette auf: `source code -> package-1 -> package-2 -> package-3`, müssen Sie alle drei Pakete zu `server.deps.inline` hinzufügen.

Das `require` von CSS und Assets innerhalb externer Abhängigkeiten wird automatisch aufgelöst.
:::

::: warning
"Umgebungen" existieren nur, wenn Tests in Node.js ausgeführt werden.

`browser` gilt in Vitest nicht als Umgebung. Wenn Sie einen Teil Ihrer Tests im [Browser-Modus](/guide/browser/) ausführen möchten, können Sie ein [Testprojekt](/guide/browser/#projects-config) anlegen.
:::

## Umgebungen für bestimmte Dateien

Wenn Sie die Option `environment` in Ihrer Konfiguration setzen, gilt sie für alle Testdateien Ihres Projekts. Für eine feinere Steuerung können Sie Steuerkommentare verwenden, um die Umgebung für bestimmte Dateien festzulegen. Steuerkommentare beginnen mit `@vitest-environment`, gefolgt vom Namen der Umgebung:

```ts
// @vitest-environment jsdom

import { expect, test } from 'vitest'

test('test', () => {
  expect(typeof window).not.toBe('undefined')
})
```

## Eigene Umgebung

Sie können ein eigenes Paket erstellen, um die Vitest-Umgebung zu erweitern. Erstellen Sie dazu ein Paket mit dem Namen `vitest-environment-${name}` oder geben Sie einen Pfad zu einer gültigen JS-/TS-Datei an. Dieses Paket sollte ein Objekt in der Form von `Environment` exportieren:

```ts
import type { Environment } from 'vitest/runtime'

export default <Environment>{
  name: 'custom',
  viteEnvironment: 'ssr',
  // optional - only if you support "vmForks" or "vmThreads" pools
  async setupVM() {
    const vm = await import('node:vm')
    const context = vm.createContext()
    return {
      getVmContext() {
        return context
      },
      teardown() {
        // called after all tests with this env have been run
      }
    }
  },
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

::: warning
Vitest benötigt die Option `viteEnvironment` auf dem Umgebungsobjekt (fällt standardmäßig auf den Namen der Vitest-Umgebung zurück). Sie sollte `ssr`, `client` oder dem Namen einer beliebigen eigenen [Vite-Umgebung](https://vite.dev/guide/api-environment) entsprechen. Dieser Wert bestimmt, welche Umgebung zur Verarbeitung der Datei verwendet wird.
:::

Über den Einstiegspunkt `vitest/runtime` haben Sie außerdem Zugriff auf die Standardumgebungen von Vitest:

```ts
import { builtinEnvironments, populateGlobal } from 'vitest/runtime'

console.log(builtinEnvironments) // { jsdom, happy-dom, node, edge-runtime }
```

Vitest stellt zusätzlich die Hilfsfunktion `populateGlobal` bereit, mit der sich Eigenschaften eines Objekts in den globalen Namensraum verschieben lassen:

```ts
interface PopulateOptions {
  // should non-class functions be bind to the global namespace
  bindFunctions?: boolean
}

interface PopulateResult {
  // a list of all keys that were copied, even if value doesn't exist on original object
  keys: Set<string>
  // a map of property descriptors for keys that might have been overridden
  // you can restore them with `Object.defineProperty` inside `teardown`
  originals: Map<string | symbol, PropertyDescriptor>
}

export function populateGlobal(global: any, original: any, options: PopulateOptions): PopulateResult
```
