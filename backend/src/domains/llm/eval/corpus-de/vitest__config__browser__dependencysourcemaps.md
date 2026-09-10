# browser.dependencySourcemaps

- **Typ:** `boolean`
- **Standard:** `true`

Liefert die Sourcemaps Ihrer Abhängigkeiten (Dateien in `node_modules`) während Headless-Testläufen an den Browser aus.

Diese Sourcemaps werden von den Browser-Devtools genutzt: Mit `dependencySourcemaps: false` zeigt ein Haltepunkt innerhalb von Abhängigkeitscode den kompilierten Code, den der Browser tatsächlich ausführt, statt der ursprünglichen Quellen der Abhängigkeit. Wenn Sie auf diese Weise nicht in Ihre Abhängigkeiten hinein debuggen, macht das Deaktivieren die Testläufe schneller: Der Server erzeugt die Maps nicht und bettet sie nicht ein, und jeder Browser-Tab lädt ein Vielfaches weniger Bytes herunter.

Gemeldete Testfehler sind davon nicht betroffen: Wenn ein Fehler innerhalb einer vorgebündelten Abhängigkeit geworfen wird, bildet Vitest dessen Stack-Frames anhand der auf der Festplatte gespeicherten Sourcemaps ab, selbst wenn diese Option deaktiviert ist. Frames aus Abhängigkeiten, die ohne Pre-Bundling ausgeliefert werden (zum Beispiel [verlinkte Pakete](https://vite.dev/guide/dep-pre-bundling#monorepos-and-linked-dependencies)) und die keine eigenen Sourcemaps mitbringen, fallen auf die Position im ausgelieferten Code zurück, die üblicherweise der Originaldatei entspricht.

Vitest liefert in Headless-Läufen niemals Sourcemaps seiner eigenen vorgebauten Module aus (es sei denn, [`--inspect`](/guide/cli#inspect) wird verwendet) – deren Frames werden ohnehin aus Stacktraces ausgeblendet. Sourcemaps Ihrer eigenen Quelldateien werden immer ausgeliefert.

::: tip
Wenn Teile Ihres Workspace-Codes auf einen `node_modules`-Pfad aufgelöst werden (zum Beispiel mit `resolve.preserveSymlinks`), setzen Sie [`server.sourcemapIgnoreList`](https://vite.dev/config/server-options#server-sourcemapignorelist), um deren Sourcemaps auch bei deaktivierter Option beizubehalten.
:::
