# disableConsoleIntercept

- **Typ:** `boolean`
- **CLI:** `--disableConsoleIntercept`
- **Standard:** `false`

Standardmäßig fängt Vitest die Konsolenausgabe während der Tests ab, um Kontext wie die Testdatei und den Testtitel zu ergänzen.

Im [Browser-Modus](/guide/browser/) ist dieses Abfangen erforderlich, um Logs aus den Browser-DevTools an das Terminal weiterzuleiten. Es wird außerdem für die Vorschau von Konsolen-Logs in der Vitest-UI benötigt.

Das Deaktivieren des Konsolen-Abfangens kann nützlich sein, wenn Sie Code mit normaler synchroner Terminal-Ausgabe debuggen möchten.
