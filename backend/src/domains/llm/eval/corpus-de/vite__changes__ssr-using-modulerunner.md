# SSR mit der `ModuleRunner`-API

::: tip Feedback
Gib uns Feedback in der [Feedback-Diskussion zur Environment API](https://github.com/vitejs/vite/discussions/16358)
:::

`server.ssrLoadModule` wurde durch den Import aus einem [Module Runner](/guide/api-environment-runtimes#modulerunner) ersetzt.

Betroffener Bereich: `Vite Plugin Authors`

::: warning Future Deprecation
`ModuleRunner` wurde erstmals in `v6.0` eingeführt. Die Abkündigung von `server.ssrLoadModule` ist für ein künftiges Major-Release geplant. Um deine Verwendung zu ermitteln, setze `future.removeSsrLoadModule` in deiner Vite-Konfiguration auf `"warn"`.
:::

## Motivation

`server.ssrLoadModule(url)` erlaubt nur den Import von Modulen in der Umgebung `ssr` und kann die Module ausschließlich im selben Prozess wie den Vite-Dev-Server ausführen. Bei Anwendungen mit eigenen Umgebungen ist jede Umgebung mit einem `ModuleRunner` verknüpft, der in einem separaten Thread oder Prozess laufen kann. Zum Importieren von Modulen steht nun `moduleRunner.import(url)` zur Verfügung.

## Migrationsleitfaden

Sieh dir den [Leitfaden zur Environment API für Frameworks](../guide/api-environment-frameworks.md) an.

`server.ssrFixStacktrace` und `server.ssrRewriteStacktrace` müssen bei Verwendung der Module-Runner-APIs nicht aufgerufen werden. Die Stacktraces werden aktualisiert, sofern `sourcemapInterceptor` nicht auf `false` gesetzt ist.
