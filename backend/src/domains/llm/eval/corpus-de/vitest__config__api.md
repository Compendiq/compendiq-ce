# api

- **Typ:** `boolean | number | object`
- **Standard:** `false`
- **CLI:** `--api`, `--api.port`, `--api.host`, `--api.strictPort`

Lauscht auf einem Port und stellt die API für [die UI](/guide/ui) oder den [Browser-Server](/guide/browser/) bereit. Bei `true` ist der Standardport `51204` beziehungsweise `63315`, wenn im Browser Mode gearbeitet wird.

## api.allowWrite <Version>4.1.0</Version> {#api-allowwrite}

- **Typ:** `boolean`
- **Standard:** `true`, wenn nicht im Netzwerk exponiert, sonst `false`

Der Vitest-Server kann Testdateien oder Snapshot-Dateien über die API speichern. Damit kann jeder, der sich mit der API verbinden kann, beliebigen Code auf deinem Rechner ausführen.

Im Browser Mode speichert Vitest [Annotation-Anhänge](/guide/test-annotations), [Artefakte](/api/advanced/artifacts) und [Snapshots](/guide/snapshot), indem es eine WebSocket-Verbindung vom Browser entgegennimmt. Damit kann jeder, der sich mit der API verbinden kann, beliebigen Code innerhalb des Projekt-Roots auf deinen Rechner schreiben (konfiguriert über [`fs.allow`](https://vite.dev/config/server-options#server-fs-allow)). Diese Option kontrolliert außerdem privilegierte Browser-APIs, die indirekt Dateien schreiben können, etwa den rohen Zugriff auf das Chrome DevTools Protocol über [`cdp()`](/api/browser/context#cdp).

::: danger SECURITY ADVICE
Vitest stellt die API standardmäßig nicht ins Internet und lauscht nur auf `localhost`. Wird `host` jedoch manuell im Netzwerk exponiert, kann jeder, der sich verbindet, beliebigen Code auf deinem Rechner ausführen, sofern `api.allowWrite` und `api.allowExec` nicht auf `false` gesetzt sind.

Ist der Host auf etwas anderes als `localhost` oder `127.0.0.1` gesetzt, setzt Vitest `api.allowWrite` und `api.allowExec` standardmäßig auf `false`. Das bedeutet, dass Schreiboperationen (etwa das Ändern von Code in der UI) nicht funktionieren. Wenn du die sicherheitsrelevanten Auswirkungen verstehst, kannst du diese Werte jedoch überschreiben.
:::

## api.allowExec <Version>4.1.0</Version> {#api-allowexec}

- **Typ:** `boolean`
- **Standard:** `true`, wenn nicht im Netzwerk exponiert, sonst `false`

Erlaubt das Ausführen beliebiger Testdateien über die UI. Das betrifft die interaktiven Elemente (und den dahinterliegenden Server-Code) in der [UI](/guide/ui), die Code ausführen können. Diese Option kontrolliert außerdem privilegierte Browser-APIs, die indirekt Code ausführen können, etwa den rohen Zugriff auf das Chrome DevTools Protocol über [`cdp()`](/api/browser/context#cdp).
