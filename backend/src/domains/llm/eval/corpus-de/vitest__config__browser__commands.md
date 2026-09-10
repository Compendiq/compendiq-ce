# browser.commands

- **Typ:** `Record<string, BrowserCommand>`
- **Standard:** `{ readFile, writeFile, ... }`

Eigene [Commands](/api/browser/commands), die während Browser-Tests aus `vitest/browser` importiert werden können.

::: warning Security
Commands laufen im Node-Prozess von Vitest. Wenn ein Command auf Basis von Eingaben aus dem Browser Zugriff auf Dateisystem, Prozess, Netzwerk, Datenbank oder Shell freigibt, müssen diese Eingaben innerhalb des Commands validiert und eingeschränkt werden. Die eingebauten Datei-Commands wenden die `server.fs`-Prüfungen von Vite sowie Schreibzugriffsprüfungen an, eigene Commands sind jedoch selbst für ihre Absicherung verantwortlich.

Siehe [Sicherheitshinweise zu eigenen Commands](/api/browser/commands#custom-commands).
:::
