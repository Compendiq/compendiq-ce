# Kommandozeilen-Interface

## Dev-Server

### `vite`

Startet den Vite-Dev-Server im aktuellen Verzeichnis. `vite dev` und `vite serve` sind Aliase für `vite`.

#### Verwendung

```bash
vite [root]
```

#### Optionen

| Optionen                  |                                                                                                                                                                                       |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--host [host]`           | Hostnamen angeben (`string`)                                                                                                                                                          |
| `--port <port>`           | Port angeben (`number`)                                                                                                                                                               |
| `--open [path]`           | Browser beim Start öffnen (`boolean \| string`)                                                                                                                                       |
| `--cors`                  | CORS aktivieren (`boolean`)                                                                                                                                                           |
| `--strictPort`            | Beenden, wenn der angegebene Port bereits belegt ist (`boolean`)                                                                                                                      |
| `--force`                 | Den Optimizer zwingen, den Cache zu ignorieren und neu zu bündeln (`boolean`)                                                                                                         |
| `-c, --config <file>`     | Angegebene Konfigurationsdatei verwenden (`string`)                                                                                                                                   |
| `--base <path>`           | Öffentlicher Basispfad (Standard: `/`) (`string`)                                                                                                                                     |
| `-l, --logLevel <level>`  | info \| warn \| error \| silent (`string`)                                                                                                                                            |
| `--clearScreen`           | Bildschirmlöschen beim Logging erlauben/deaktivieren (`boolean`)                                                                                                                      |
| `--configLoader <loader>` | `bundle`, um die Konfiguration mit Rolldown zu bündeln, `runner` (experimentell), um sie im laufenden Betrieb zu verarbeiten, oder `native` (experimentell), um sie mit der nativen Runtime zu laden (Standard: `bundle`) |
| `--profile`               | Eingebauten Node.js-Inspector starten (siehe [Performance-Engpässe](/guide/troubleshooting#performance-bottlenecks))                                                                   |
| `-d, --debug [feat]`      | Debug-Logs anzeigen (`string \| boolean`)                                                                                                                                             |
| `-f, --filter <filter>`   | Debug-Logs filtern (`string`)                                                                                                                                                         |
| `-m, --mode <mode>`       | Env-Modus setzen (`string`)                                                                                                                                                           |
| `-h, --help`              | Verfügbare CLI-Optionen anzeigen                                                                                                                                                      |
| `-v, --version`           | Versionsnummer anzeigen                                                                                                                                                               |

## Build

### `vite build`

Für die Produktion bauen.

#### Verwendung

```bash
vite build [root]
```

#### Optionen

| Optionen                       |                                                                                                                                                                                       |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--target <target>`            | Transpile-Target (Standard: `"baseline-widely-available"`) (`string`)                                                                                                                 |
| `--outDir <dir>`               | Ausgabeverzeichnis (Standard: `dist`) (`string`)                                                                                                                                      |
| `--assetsDir <dir>`            | Verzeichnis unter outDir, in dem Assets abgelegt werden (Standard: `"assets"`) (`string`)                                                                                             |
| `--assetsInlineLimit <number>` | Schwellwert in Bytes für das Base64-Inlining statischer Assets (Standard: `4096`) (`number`)                                                                                          |
| `--ssr [entry]`                | Angegebenen Einstiegspunkt für Server-Side Rendering bauen (`string`)                                                                                                                 |
| `--sourcemap [output]`         | Source Maps für den Build ausgeben (Standard: `false`) (`boolean \| "inline" \| "hidden"`)                                                                                            |
| `--minify [minifier]`          | Minifizierung aktivieren/deaktivieren oder den zu verwendenden Minifier angeben (Standard: `"oxc"`) (`boolean \| "oxc" \| "terser" \| "esbuild"`)                                     |
| `--manifest [name]`            | Build-Manifest-JSON ausgeben (`boolean \| string`)                                                                                                                                    |
| `--ssrManifest [name]`         | SSR-Manifest-JSON ausgeben (`boolean \| string`)                                                                                                                                      |
| `--emptyOutDir`                | Leeren von outDir erzwingen, wenn es außerhalb des Root liegt (`boolean`)                                                                                                             |
| `-w, --watch`                  | Neu bauen, wenn sich Module auf der Festplatte geändert haben (`boolean`)                                                                                                             |
| `-c, --config <file>`          | Angegebene Konfigurationsdatei verwenden (`string`)                                                                                                                                   |
| `--base <path>`                | Öffentlicher Basispfad (Standard: `/`) (`string`)                                                                                                                                     |
| `-l, --logLevel <level>`       | Info \| warn \| error \| silent (`string`)                                                                                                                                            |
| `--clearScreen`                | Bildschirmlöschen beim Logging erlauben/deaktivieren (`boolean`)                                                                                                                      |
| `--configLoader <loader>`      | `bundle`, um die Konfiguration mit Rolldown zu bündeln, `runner` (experimentell), um sie im laufenden Betrieb zu verarbeiten, oder `native` (experimentell), um sie mit der nativen Runtime zu laden (Standard: `bundle`) |
| `--profile`                    | Eingebauten Node.js-Inspector starten (siehe [Performance-Engpässe](/guide/troubleshooting#performance-bottlenecks))                                                                   |
| `-d, --debug [feat]`           | Debug-Logs anzeigen (`string \| boolean`)                                                                                                                                             |
| `-f, --filter <filter>`        | Debug-Logs filtern (`string`)                                                                                                                                                         |
| `-m, --mode <mode>`            | Env-Modus setzen (`string`)                                                                                                                                                           |
| `-h, --help`                   | Verfügbare CLI-Optionen anzeigen                                                                                                                                                      |
| `--app`                        | Alle Environments bauen, entspricht `builder: {}` (`boolean`, experimentell)                                                                                                          |

## Sonstiges

### `vite optimize`

Abhängigkeiten vorab bündeln.

**Veraltet**: Der Pre-Bundle-Vorgang läuft automatisch und muss nicht aufgerufen werden.

#### Verwendung

```bash
vite optimize [root]
```

#### Optionen

| Optionen                  |                                                                                                                                                                                       |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--force`                 | Den Optimizer zwingen, den Cache zu ignorieren und neu zu bündeln (`boolean`)                                                                                                         |
| `-c, --config <file>`     | Angegebene Konfigurationsdatei verwenden (`string`)                                                                                                                                   |
| `--base <path>`           | Öffentlicher Basispfad (Standard: `/`) (`string`)                                                                                                                                     |
| `-l, --logLevel <level>`  | Info \| warn \| error \| silent (`string`)                                                                                                                                            |
| `--clearScreen`           | Bildschirmlöschen beim Logging erlauben/deaktivieren (`boolean`)                                                                                                                      |
| `--configLoader <loader>` | `bundle`, um die Konfiguration mit Rolldown zu bündeln, `runner` (experimentell), um sie im laufenden Betrieb zu verarbeiten, oder `native` (experimentell), um sie mit der nativen Runtime zu laden (Standard: `bundle`) |
| `-d, --debug [feat]`      | Debug-Logs anzeigen (`string \| boolean`)                                                                                                                                             |
| `-f, --filter <filter>`   | Debug-Logs filtern (`string`)                                                                                                                                                         |
| `-m, --mode <mode>`       | Env-Modus setzen (`string`)                                                                                                                                                           |
| `-h, --help`              | Verfügbare CLI-Optionen anzeigen                                                                                                                                                      |

### `vite preview`

Den Produktions-Build lokal in der Vorschau ansehen. Verwende das nicht als Produktionsserver, dafür ist es nicht ausgelegt.

Dieses Kommando startet einen Server im Build-Verzeichnis (standardmäßig `dist`). Führe vorher `vite build` aus, um sicherzustellen, dass das Build-Verzeichnis aktuell ist. Abhängig vom konfigurierten [`appType`](/config/shared-options#apptype) des Projekts nutzt es bestimmte Middleware.

#### Verwendung

```bash
vite preview [root]
```

#### Optionen

| Optionen                  |                                                                                                                                                                                       |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--host [host]`           | Hostnamen angeben (`string`)                                                                                                                                                          |
| `--port <port>`           | Port angeben (`number`)                                                                                                                                                               |
| `--strictPort`            | Beenden, wenn der angegebene Port bereits belegt ist (`boolean`)                                                                                                                      |
| `--open [path]`           | Browser beim Start öffnen (`boolean \| string`)                                                                                                                                       |
| `--outDir <dir>`          | Ausgabeverzeichnis (Standard: `dist`) (`string`)                                                                                                                                      |
| `-c, --config <file>`     | Angegebene Konfigurationsdatei verwenden (`string`)                                                                                                                                   |
| `--base <path>`           | Öffentlicher Basispfad (Standard: `/`) (`string`)                                                                                                                                     |
| `-l, --logLevel <level>`  | Info \| warn \| error \| silent (`string`)                                                                                                                                            |
| `--clearScreen`           | Bildschirmlöschen beim Logging erlauben/deaktivieren (`boolean`)                                                                                                                      |
| `--configLoader <loader>` | `bundle`, um die Konfiguration mit Rolldown zu bündeln, `runner` (experimentell), um sie im laufenden Betrieb zu verarbeiten, oder `native` (experimentell), um sie mit der nativen Runtime zu laden (Standard: `bundle`) |
| `-d, --debug [feat]`      | Debug-Logs anzeigen (`string \| boolean`)                                                                                                                                             |
| `-f, --filter <filter>`   | Debug-Logs filtern (`string`)                                                                                                                                                         |
| `-m, --mode <mode>`       | Env-Modus setzen (`string`)                                                                                                                                                           |
| `-h, --help`              | Verfügbare CLI-Optionen anzeigen                                                                                                                                                      |
