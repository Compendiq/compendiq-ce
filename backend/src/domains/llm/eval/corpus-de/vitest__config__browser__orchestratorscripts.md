# browser.orchestratorScripts

- **Typ:** `BrowserScript[]`
- **Standard:** `[]`

Eigene Skripte, die in das Orchestrator-HTML eingefügt werden sollen, bevor die Test-Iframes initialisiert werden. Dieses HTML-Dokument richtet lediglich die Iframes ein und importiert deinen Code nicht.

`src` und `content` des Skripts werden von Vite-Plugins verarbeitet. Das Skript sollte in der folgenden Form angegeben werden:

```ts
export interface BrowserScript {
  /**
   * If "content" is provided and type is "module", this will be its identifier.
   *
   * If you are using TypeScript, you can add `.ts` extension here for example.
   * @default `injected-${index}.js`
   */
  id?: string
  /**
   * JavaScript content to be injected. This string is processed by Vite plugins if type is "module".
   *
   * You can use `id` to give Vite a hint about the file extension.
   */
  content?: string
  /**
   * Path to the script. This value is resolved by Vite so it can be a node module or a file path.
   */
  src?: string
  /**
   * If the script should be loaded asynchronously.
   */
  async?: boolean
  /**
   * Script type.
   * @default 'module'
   */
  type?: string
}
```
