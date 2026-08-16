# Worker-Optionen

Sofern nicht anders angegeben, gelten die Optionen in diesem Abschnitt gleichermaßen für dev, build und preview.

## worker.format

- **Typ:** `'es' | 'iife'`
- **Standard:** `'iife'`

Ausgabeformat für das Worker-Bundle.

## worker.plugins

- **Typ:** [`() => (Plugin | Plugin[])[]`](./shared-options#plugins)

Vite-Plugins, die auf die Worker-Bundles angewendet werden. Beachte, dass [config.plugins](./shared-options#plugins) nur im Dev-Modus auf Worker angewendet wird; für den Build muss stattdessen hier konfiguriert werden.
Die Funktion sollte neue Plugin-Instanzen zurückgeben, da sie in parallelen Rolldown-Worker-Builds verwendet werden. Aus demselben Grund wird das Ändern der `config.worker`-Optionen im `config`-Hook ignoriert.

## worker.rolldownOptions

- **Typ:** [`RolldownOptions`](https://rolldown.rs/reference/)

Rolldown-Optionen zum Bauen des Worker-Bundles.

## worker.rollupOptions

- **Typ:** `RolldownOptions`
- **Veraltet**

Diese Option ist ein Alias für die Option `worker.rolldownOptions`. Verwende stattdessen `worker.rolldownOptions`.
