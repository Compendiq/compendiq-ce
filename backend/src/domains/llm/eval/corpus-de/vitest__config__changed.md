### changed <CRoot />

- **Typ:** `boolean | string`
- **Standard:** `false`
- **CLI:** `--changed`, `--changed=HEAD~1`

Führt Tests nur für geänderte Dateien aus. Wird kein Wert angegeben, werden die Tests für nicht committete Änderungen ausgeführt (einschließlich gestageter und ungestageter Änderungen).

Um Tests für die Änderungen des letzten Commits auszuführen, kannst du `--changed HEAD~1` verwenden. Du kannst auch einen Commit-Hash (z. B. `--changed 09a9920`) oder einen Branch-Namen (z. B. `--changed origin/develop`) übergeben.

In Kombination mit der Code-Coverage enthält der Bericht nur die Dateien, die mit den Änderungen zusammenhängen.

Zusammen mit der Konfigurationsoption [`forceRerunTriggers`](/config/forcereruntriggers) wird die gesamte Test-Suite ausgeführt, sobald sich mindestens eine der in der `forceRerunTriggers`-Liste aufgeführten Dateien ändert. Standardmäßig führen Änderungen an der Vitest-Konfigurationsdatei und an der `package.json` immer zu einem erneuten Lauf der gesamten Suite.
