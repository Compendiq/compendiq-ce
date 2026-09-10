# isolate

- **Typ:** `boolean`
- **Standard:** `true`
- **CLI:** `--no-isolate`, `--isolate=false`

Führt Tests in einer isolierten Umgebung aus. Diese Option hat keine Auswirkung auf die Pools `vmThreads` und `vmForks`.

Das Deaktivieren dieser Option kann [die Performance verbessern](/guide/improving-performance), wenn Ihr Code nicht auf Seiteneffekte angewiesen ist (was für Projekte mit `node`-Umgebung meist zutrifft).

::: tip
Sie können die Isolation für einzelne Testdateien deaktivieren, indem Sie Vitest-Workspaces verwenden und die Isolation pro Projekt abschalten.
:::
