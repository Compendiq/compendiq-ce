# snapshotEnvironment

- **Typ:** `string`

Pfad zu einer eigenen Implementierung der Snapshot-Umgebung. Das ist nützlich, wenn Sie Ihre Tests in einer Umgebung ausführen, die keine Node.js-APIs unterstützt. Diese Option hat keine Auswirkung auf einen Browser-Runner.

Dieses Objekt sollte die Form von `SnapshotEnvironment` haben und wird verwendet, um Snapshot-Dateien aufzulösen sowie zu lesen und zu schreiben:

```ts
export interface SnapshotEnvironment {
  getVersion: () => string
  getHeader: () => string
  resolvePath: (filepath: string) => Promise<string>
  resolveRawPath: (testPath: string, rawPath: string) => Promise<string>
  saveSnapshotFile: (filepath: string, snapshot: string) => Promise<void>
  readSnapshotFile: (filepath: string) => Promise<string | null>
  removeSnapshotFile: (filepath: string) => Promise<void>
}
```

Sie können das voreingestellte `VitestSnapshotEnvironment` aus dem Einstiegspunkt `vitest/snapshot` erweitern, wenn Sie nur einen Teil der API überschreiben müssen.

::: warning
Dies ist eine Low-Level-Option und sollte nur für fortgeschrittene Fälle verwendet werden, in denen Sie keinen Zugriff auf die standardmäßigen Node.js-APIs haben.

Wenn Sie lediglich die Snapshot-Funktion konfigurieren möchten, verwenden Sie die Optionen [`snapshotFormat`](/config/snapshotformat) oder [`resolveSnapshotPath`](/config/resolvesnapshotpath).
:::
