# setupFiles

- **Typ:** `string | string[]`

Pfade zu Setup-Dateien, die relativ zum [`root`](/config/root) aufgelöst werden. Sie laufen vor jeder _Testdatei_ im selben Prozess. Standardmäßig laufen alle Testdateien parallel, Sie können dies aber mit der Option [`sequence.setupFiles`](/config/sequence#sequence-setupfiles) konfigurieren.

Vitest ignoriert sämtliche Exporte aus diesen Dateien.

:::warning
Beachten Sie, dass Setup-Dateien im selben Prozess wie die Tests ausgeführt werden — anders als [`globalSetup`](/config/globalsetup), das einmalig im Hauptthread läuft, bevor irgendein Test-Worker erzeugt wird.
:::

:::info
Das Bearbeiten einer Setup-Datei löst automatisch einen erneuten Lauf aller Tests aus.
:::

Wenn Sie einen aufwendigen Prozess im Hintergrund laufen haben, können Sie darin `process.env.VITEST_POOL_ID` (eine Zeichenkette in Form einer Ganzzahl) verwenden, um zwischen Workern zu unterscheiden und die Last zu verteilen.

:::warning
Wenn [isolation](/config/isolate) deaktiviert ist, werden importierte Module zwischengespeichert, die Setup-Datei selbst wird jedoch vor jeder Testdatei erneut ausgeführt. Das bedeutet, dass Sie vor jeder Testdatei auf dasselbe globale Objekt zugreifen. Achten Sie darauf, nicht mehr als nötig mehrfach zu tun.

Sie könnten sich zum Beispiel auf eine globale Variable stützen:

```ts
import { config } from '@some-testing-lib'

if (!globalThis.setupInitialized) {
  config.plugins = [myCoolPlugin]
  computeHeavyThing()
  globalThis.setupInitialized = true
}

// hooks reset before each test file
afterEach(() => {
  cleanup()
})

globalThis.resetBeforeEachTest = true
```
:::
