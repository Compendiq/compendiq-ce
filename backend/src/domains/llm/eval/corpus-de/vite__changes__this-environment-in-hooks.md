# `this.environment` in Hooks

::: tip Feedback
Gib uns Feedback in der [Feedback-Diskussion zur Environment API](https://github.com/vitejs/vite/discussions/16358)
:::

Vor Vite 6 gab es nur zwei Umgebungen: `client` und `ssr`. Ein einzelnes Hook-Argument `options.ssr` in `resolveId`, `load` und `transform` erlaubte es Plugin-Autoren, beim Verarbeiten von Modulen in Plugin-Hooks zwischen diesen beiden Umgebungen zu unterscheiden. In Vite 6 kann eine Vite-Anwendung beliebig viele benannte Umgebungen definieren. Wir führen daher `this.environment` im Plugin-Kontext ein, um in Hooks mit der Umgebung des aktuellen Moduls zu arbeiten.

Betroffener Bereich: `Vite Plugin Authors`

::: warning Future Deprecation
`this.environment` wurde in `v6.0` eingeführt. Die Abkündigung von `options.ssr` ist für ein künftiges Major-Release geplant. Ab dann werden wir empfehlen, deine Plugins auf die neue API zu migrieren. Um deine Verwendung zu ermitteln, setze `future.removePluginHookSsrArgument` in deiner Vite-Konfiguration auf `"warn"`.
:::

## Motivation

`this.environment` erlaubt der Hook-Implementierung eines Plugins nicht nur, den Namen der aktuellen Umgebung zu kennen, sondern gibt auch Zugriff auf die Konfigurationsoptionen der Umgebung, Informationen zum Modulgraphen und die Transform-Pipeline (`environment.config`, `environment.moduleGraph`, `environment.transformRequest()`). Da die Environment-Instanz im Kontext verfügbar ist, können Plugin-Autoren auf die Abhängigkeit zum gesamten Dev-Server verzichten (die typischerweise beim Start über den Hook `configureServer` zwischengespeichert wird).

## Migrationsleitfaden

Für eine schnelle Migration bestehender Plugins ersetzt du das Argument `options.ssr` in den Hooks `resolveId`, `load` und `transform` durch `this.environment.config.consumer === 'server'`:

```ts
import { Plugin } from 'vite'

export function myPlugin(): Plugin {
  return {
    name: 'my-plugin',
    resolveId(id, importer, options) {
      const isSSR = options.ssr // [!code --]
      const isSSR = this.environment.config.consumer === 'server' // [!code ++]

      if (isSSR) {
        // SSR specific logic
      } else {
        // Client specific logic
      }
    },
  }
}
```

Für eine langfristig robustere Umsetzung sollte der Plugin-Hook [mehrere Umgebungen](/guide/api-environment-plugins.html#accessing-the-current-environment-in-hooks) über feingranulare Environment-Optionen behandeln, statt sich auf den Namen der Umgebung zu verlassen.
