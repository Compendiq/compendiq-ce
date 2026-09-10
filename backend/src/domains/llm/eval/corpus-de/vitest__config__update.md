# update <CRoot /> {#update}

- **Typ:** `boolean | 'new' | 'all' | 'none'`
- **Standard:** `false`
- **CLI:** `-u`, `--update`, `--update=false`, `--update=new`, `--update=none`

Legt das Verhalten beim Aktualisieren von Snapshots fest.

- `true` oder `'all'`: aktualisiert alle geänderten Snapshots und löscht veraltete
- `new`: erzeugt neue Snapshots, ohne veraltete zu ändern oder zu löschen
- `none`: schreibt keine Snapshots und schlägt bei Snapshot-Abweichungen, fehlenden Snapshots und veralteten Snapshots fehl

Wenn `update` auf `false` steht (der Standard), ermittelt Vitest den Snapshot-Aktualisierungsmodus anhand der Umgebung:

- Lokale Läufe (ohne CI): verhält sich wie `new`
- CI-Läufe (`process.env.CI` ist truthy): verhält sich wie `none`
