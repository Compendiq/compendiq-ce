# Commands

Ein Command ist eine Funktion, die eine andere Funktion auf dem Server aufruft und das Ergebnis an den Browser zurückreicht. Vitest stellt mehrere eingebaute Commands bereit, die Sie in Ihren Browser-Tests verwenden können.

## Eingebaute Commands

### Umgang mit Dateien

Sie können die APIs `readFile`, `writeFile` und `removeFile` verwenden, um in Ihren Browser-Tests mit Dateien zu arbeiten. Seit Vitest 3.2 werden alle Pfade relativ zum Wurzelverzeichnis des [Projekts](/guide/projects) aufgelöst (das ist `process.cwd()`, sofern nicht manuell überschrieben). Zuvor wurden Pfade relativ zur Testdatei aufgelöst.

Standardmäßig verwendet Vitest die Kodierung `utf-8`, Sie können sie aber über Optionen überschreiben.

::: tip
Die eingebauten Datei-Commands beachten aus Sicherheitsgründen die Einschränkungen von Vites [`server.fs`](https://vitejs.dev/config/server-options.html#server-fs-allow).

`writeFile` und `removeFile` erfordern zusätzlich Schreibzugriff über [`api.allowWrite`](/config/api#api-allowwrite).
:::

```ts
import { server } from 'vitest/browser'

const { readFile, writeFile, removeFile } = server.commands

it('handles files', async () => {
  const file = './test.txt'

  await writeFile(file, 'hello world')
  const content = await readFile(file)

  expect(content).toBe('hello world')

  await removeFile(file)
})
```

## CDP-Session

Vitest bietet über die aus `vitest/browser` exportierte Methode `cdp` Zugriff auf das rohe Chrome DevTools Protocol. Das ist vor allem für Bibliotheksautoren nützlich, die darauf aufbauende Werkzeuge entwickeln.

```ts
import { cdp } from 'vitest/browser'

const input = document.createElement('input')
document.body.appendChild(input)
input.focus()

await cdp().send('Input.dispatchKeyEvent', {
  type: 'keyDown',
  text: 'a',
})

expect(input).toHaveValue('a')
```

::: warning
Die CDP-Session funktioniert nur mit dem `playwright`-Provider und nur bei Verwendung des Browsers `chromium`. Mehr dazu lesen Sie in Playwrights Dokumentation zu [`CDPSession`](https://playwright.dev/docs/api/class-cdpsession).

CDP ist eine privilegierte Debugging-API. Sie ist nur verfügbar, wenn Schreib- und Ausführungsoperationen der Browser-API über [`api.allowWrite`](/config/api#api-allowwrite) und [`api.allowExec`](/config/api#api-allowexec) aktiviert sind.
:::

## Eigene Commands

Sie können über die Konfigurationsoption [`browser.commands`](/config/browser/commands) auch eigene Commands hinzufügen. Wenn Sie eine Bibliothek entwickeln, können Sie sie über einen `config`-Hook innerhalb eines Plugins bereitstellen:

```ts
import type { Plugin } from 'vitest/config'
import type { BrowserCommand } from 'vitest/node'

const myCustomCommand: BrowserCommand<[arg1: string, arg2: string]> = ({
  testPath,
  provider
}, arg1, arg2) => {
  if (provider.name === 'playwright') {
    console.log(testPath, arg1, arg2)
    return { someValue: true }
  }

  throw new Error(`provider ${provider.name} is not supported`)
}

export default function BrowserCommands(): Plugin {
  return {
    name: 'vitest:custom-commands',
    config() {
      return {
        test: {
          browser: {
            commands: {
              myCustomCommand,
            }
          }
        }
      }
    }
  }
}
```

Anschließend können Sie ihn in Ihrem Test aufrufen, indem Sie ihn aus `vitest/browser` importieren:

```ts
import { commands } from 'vitest/browser'
import { expect, test } from 'vitest'

test('custom command works correctly', async () => {
  const result = await commands.myCustomCommand('test1', 'test2')
  expect(result).toEqual({ someValue: true })
})

// if you are using TypeScript, you can augment the module
declare module 'vitest/browser' {
  interface BrowserCommands {
    myCustomCommand: (arg1: string, arg2: string) => Promise<{
      someValue: true
    }>
  }
}
```

::: warning
Eigene Funktionen überschreiben eingebaute, wenn sie denselben Namen haben.
:::

::: warning Sicherheit
Eigene Commands laufen im Node-Prozess von Vitest und sind aus Browser-Testcode über Vitests Browser-RPC-Verbindung aufrufbar. Sie können auf lokale Dateien, Umgebungsvariablen, Netzwerkdienste, Datenbanken, Shell-Befehle und andere Node-APIs zugreifen.

Vitests eingebaute Datei-Commands validieren Pfade gegen die Einschränkungen von Vites [`server.fs`](https://vite.dev/config/server-options#server-fs-allow) und prüfen getrennt davon, ob Schreibzugriffe erlaubt sind. Eigene Commands erben diese Schutzmaßnahmen nicht automatisch. Wenn ein eigener Command Eingaben aus dem Browser entgegennimmt und sie verwendet, um lokale Ressourcen zu lesen, zu schreiben, zu löschen, auszuführen oder offenzulegen, validieren Sie diese Eingaben vor der Verwendung.

Verwenden Sie für Dateizugriffe oder das Laden von Fixtures `isFileLoadingAllowed` aus `vitest/node` oder eine explizite Allowlist. Für Schreib- und Löschvorgänge verlangen Sie zusätzlich eine explizite Änderungsrichtlinie, etwa [`api.allowWrite`](/config/api#api-allowwrite), sowie ein command-spezifisch erlaubtes Verzeichnis. Bei Commands, die Code, Shell-Befehle oder Projektskripte ausführen, prüfen Sie außerdem [`api.allowExec`](/config/api#api-allowexec).

Wenn Sie zum Beispiel Ihren eigenen Command zum Schreiben von Dateien erstellen, statt Vitests eingebautes `writeFile` zu verwenden, wenden Sie dieselben Prüfungen an:

```ts
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { normalizePath } from 'vite'
import { isFileLoadingAllowed } from 'vitest/node'
import type { BrowserCommand } from 'vitest/node'

function assertFileAccess(path: string, project: any) {
  if (
    !isFileLoadingAllowed(project.vite.config, path)
    && !isFileLoadingAllowed(project.vitest.vite.config, path)
  ) {
    throw new Error(`Access denied to "${path}".`)
  }
}

function assertWrite(project: any) {
  if (!project.config.browser.api.allowWrite || !project.vitest.config.api.allowWrite) {
    throw new Error('Writing files is disabled.')
  }
}

export const myWriteFileCommand: BrowserCommand<[path: string, content: string]> = async (
  { project },
  path,
  content,
) => {
  assertWrite(project)

  const file = resolve(project.config.root, path)
  assertFileAccess(normalizePath(file), project)

  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, content)
}
```

:::

### Trace-Marker aufzeichnen

Eigene Commands können über `context.mark` [Trace-Marker](/api/browser/context#mark) für den Test aufzeichnen, der sie ausgelöst hat. Das ist das serverseitige Äquivalent zu `page.mark` und hilft dabei, die [Trace-Ansicht](/guide/browser/trace-view) mit eigenen, innerhalb eines Commands ausgeführten Aktionen zu annotieren.

```ts
import type { BrowserCommand } from 'vitest/node'

export const uploadFixture: BrowserCommand<[name: string]> = async (
  context,
  name,
) => {
  await context.mark(`upload start: ${name}`, { kind: 'action' })
  // ... do server-side work
  await context.mark(`upload done: ${name}`, { kind: 'action' })
}
```

`context.mark` ist wirkungslos, wenn Browser-Tracing nicht aktiviert ist oder in der Session gerade kein Test läuft. Anders als `page.mark` akzeptiert es keine Callback-Form.

### Eigene `playwright`-Commands

Vitest stellt im Command-Kontext mehrere `playwright`-spezifische Eigenschaften bereit.

- `page` verweist auf die vollständige Seite, die den Test-Iframe enthält. Das ist das Orchestrator-HTML, und Sie sollten es höchstwahrscheinlich nicht anfassen, um nichts kaputtzumachen.
- `frame` ist eine asynchrone Methode, die den [`Frame`](https://playwright.dev/docs/api/class-frame) des Testers auflöst. Sie hat eine ähnliche API wie `page`, unterstützt aber bestimmte Methoden nicht. Wenn Sie ein Element abfragen müssen, sollten Sie stattdessen `context.iframe` bevorzugen, da es stabiler und schneller ist.
- `iframe` ist ein [`FrameLocator`](https://playwright.dev/docs/api/class-framelocator), der zum Abfragen anderer Elemente auf der Seite verwendet werden sollte.
- `context` bezieht sich auf den eindeutigen [BrowserContext](https://playwright.dev/docs/api/class-browsercontext).

```ts
import { BrowserCommand } from 'vitest/node'

export const myCommand: BrowserCommand<[string, number]> = async (
  ctx,
  arg1: string,
  arg2: number
) => {
  if (ctx.provider.name === 'playwright') {
    const element = await ctx.iframe.findByRole('alert')
    const screenshot = await element.screenshot()
    // do something with the screenshot
    return difference
  }
}
```

### Eigene `webdriverio`-Commands

Vitest stellt im Kontextobjekt einige `webdriverio`-spezifische Eigenschaften bereit.

- `browser` ist die API `WebdriverIO.Browser`.

Vitest wechselt den `webdriver`-Kontext automatisch zum Test-Iframe, indem es vor dem Aufruf des Commands `browser.switchFrame` ausführt. Die Methoden `$` und `$$` beziehen sich daher auf die Elemente innerhalb des Iframes und nicht im Orchestrator; Nicht-WebDriver-APIs beziehen sich jedoch weiterhin auf den Kontext des übergeordneten Frames.
