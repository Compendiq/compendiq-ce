# Debugging

:::tip
Beim Debuggen von Tests möchten Sie möglicherweise die folgenden Optionen verwenden:

- [`--test-timeout=0`](/guide/cli#testtimeout), um zu verhindern, dass Tests beim Anhalten an Breakpoints in einen Timeout laufen
- [`--no-file-parallelism`](/guide/cli#fileparallelism), um zu verhindern, dass Testdateien parallel ausgeführt werden

:::

## VS Code

Die [offizielle VS-Code-Erweiterung](https://vitest.dev/vscode) unterstützt das Debuggen von Tests über die Schaltfläche „Debug Tests“. Vitest stellt darüber hinaus jedoch auch Werkzeuge bereit, um eine eigene Konfiguration zu definieren.

Ein schneller Weg, Tests in VS Code zu debuggen, führt über das `JavaScript Debug Terminal`. Öffnen Sie ein neues `JavaScript Debug Terminal` und führen Sie `npm run test` oder direkt `vitest` aus. *Das funktioniert mit jedem in Node ausgeführten Code und damit mit den meisten JS-Test-Frameworks.*

![image](https://user-images.githubusercontent.com/5594348/212169143-72bf39ce-f763-48f5-822a-0c8b2e6a8484.png)

Sie können in VS Code auch eine dedizierte Launch-Konfiguration hinzufügen, um eine Testdatei zu debuggen:

```json
{
  // For more information, visit: https://go.microsoft.com/fwlink/?linkid=830387
  "version": "0.2.0",
  "configurations": [
    {
      "type": "node",
      "request": "launch",
      "name": "Debug Current Test File",
      "autoAttachChildProcesses": true,
      "skipFiles": ["<node_internals>/**", "**/node_modules/**"],
      "program": "${workspaceRoot}/node_modules/vitest/vitest.mjs",
      "args": ["run", "${relativeFile}"],
      "smartStep": true,
      "console": "integratedTerminal"
    }
  ]
}
```

Stellen Sie anschließend im Debug-Tab sicher, dass „Debug Current Test File“ ausgewählt ist. Sie können dann die zu debuggende Testdatei öffnen und mit F5 das Debugging starten.

### Browser-Modus

Der einfachste Weg, Browser-Tests zu debuggen, ist die [offizielle VS-Code-Erweiterung](https://vitest.dev/vscode).

Sie können jedoch auch `--inspect` oder `--inspect-brk` auf der CLI übergeben oder in Ihrer Vitest-Konfiguration definieren:

::: code-group
```bash [CLI]
vitest --inspect-brk --browser --no-file-parallelism
```
```ts [vitest.config.js]
import { defineConfig } from 'vitest/config'
import { playwright } from '@vitest/browser-playwright'

export default defineConfig({
  test: {
    inspectBrk: true,
    fileParallelism: false,
    browser: {
      provider: playwright(),
      instances: [{ browser: 'chromium' }]
    },
  },
})
```
:::

Standardmäßig verwendet Vitest den Port `9229` als Debugging-Port. Sie können ihn überschreiben, indem Sie einen Wert an `--inspect-brk` übergeben:

```bash
vitest --inspect-brk=127.0.0.1:3000 --browser --no-file-parallelism
```

Verwenden Sie die folgende [VSCode-Compound-Konfiguration](https://code.visualstudio.com/docs/editor/debugging#_compound-launch-configurations), um Vitest zu starten und den Debugger im Browser anzuhängen:

```json
{
  "version": "0.2.0",
  "configurations": [
    {
      "type": "node",
      "request": "launch",
      "name": "Run Vitest Browser",
      "program": "${workspaceRoot}/node_modules/vitest/vitest.mjs",
      "console": "integratedTerminal",
      "args": ["--inspect-brk", "--browser", "--no-file-parallelism"]
    },
    {
      "type": "chrome",
      "request": "attach",
      "name": "Attach to Vitest Browser",
      "port": 9229
    }
  ],
  "compounds": [
    {
      "name": "Debug Vitest Browser",
      "configurations": ["Attach to Vitest Browser", "Run Vitest Browser"],
      "stopAll": true
    }
  ]
}
```

## IntelliJ IDEA

Legen Sie eine [vitest](https://www.jetbrains.com/help/idea/vitest.html#createRunConfigVitest)-Run-Konfiguration an. Verwenden Sie die folgenden Einstellungen, um alle Tests im Debug-Modus auszuführen:

Einstellung | Wert
 --- | ---
Arbeitsverzeichnis | `/path/to/your-project-root`

Führen Sie diese Konfiguration anschließend im Debug-Modus aus. Die IDE hält an den im Editor gesetzten JS/TS-Breakpoints an.

## Node Inspector, z. B. Chrome DevTools

Vitest unterstützt das Debuggen von Tests auch ohne IDE. Voraussetzung ist allerdings, dass die Tests nicht parallel ausgeführt werden. Verwenden Sie einen der folgenden Befehle, um Vitest zu starten.

```sh
# To run in a single worker
vitest --inspect-brk --no-file-parallelism

# To run in browser mode
vitest --inspect-brk --browser --no-file-parallelism
```

Sobald Vitest startet, hält es die Ausführung an und wartet darauf, dass Sie Entwicklerwerkzeuge öffnen, die sich mit dem [Node.js-Inspector](https://nodejs.org/en/docs/guides/debugging-getting-started/) verbinden können. Sie können dafür die Chrome DevTools verwenden, indem Sie im Browser `chrome://inspect` öffnen.

Im Watch-Modus können Sie den Debugger über die Option `--isolate false` während erneuter Testläufe geöffnet halten.
