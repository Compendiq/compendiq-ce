# ui <CRoot />

- **Typ:** `boolean`
- **Standard:** `false`
- **CLI:** `--ui`, `--ui=false`

Aktiviert die [Vitest UI](/guide/ui).

::: warning
Dieses Feature setzt voraus, dass das Paket [`@vitest/ui`](https://npmx.dev/package/@vitest/ui) installiert ist. Falls Sie es noch nicht haben, installiert Vitest es beim ersten Ausführen des Test-Befehls.
:::

::: danger SICHERHEITSHINWEIS
Stellen Sie sicher, dass Ihr UI-Server nicht im Netzwerk erreichbar ist. Seit Vitest 4.1 deaktiviert das Setzen von [`api.host`](/config/api) auf einen anderen Wert als `localhost` aus Sicherheitsgründen die Schaltflächen zum Speichern von Code oder zum Ausführen von Tests, wodurch die UI faktisch zu einem schreibgeschützten Reporter wird.
:::
