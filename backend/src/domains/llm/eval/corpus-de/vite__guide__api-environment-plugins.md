# Environment API für Plugins

:::info Release Candidate
Die Environment API befindet sich im Wesentlichen in der Release-Candidate-Phase. Wir halten die APIs zwischen Major-Releases stabil, damit das Ökosystem damit experimentieren und darauf aufbauen kann. Beachten Sie jedoch, dass [einige bestimmte APIs](/changes/#considering) weiterhin als experimentell gelten.

Wir planen, diese neuen APIs (mit möglichen Breaking Changes) in einem künftigen Major-Release zu stabilisieren, sobald nachgelagerte Projekte Zeit hatten, mit den neuen Funktionen zu experimentieren und sie zu validieren.

Ressourcen:

- [Feedback-Diskussion](https://github.com/vitejs/vite/discussions/16358), in der wir Rückmeldungen zu den neuen APIs sammeln.
- [Environment-API-PR](https://github.com/vitejs/vite/pull/16471), in dem die neuen APIs implementiert und geprüft wurden.

Bitte teilen Sie uns Ihr Feedback mit.
:::

## Hooks pro Environment und globale Hooks

Plugins laufen in einer gemeinsamen Pipeline, aber ihre Hooks fallen in zwei Kategorien, je nachdem, ob sie einmal für den gesamten Server oder einmal pro Environment laufen.

Globale Hooks werden ein einziges Mal aufgerufen, unabhängig von den konfigurierten Environments. Sie behandeln app-weite Belange wie das Auflösen der Konfiguration oder das Einrichten der Dev- und Preview-Server, sodass `this.environment` für sie nicht relevant ist. Hooks rund um die Konfigurationsauflösung und serverbezogene Hooks sind globale Hooks.

Hooks pro Environment werden einmal für jedes Environment aufgerufen und stellen das aktuelle Environment über `this.environment` in ihrem Kontext bereit. Alle [Rolldown-Hooks](/guide/api-plugin#rolldown-hooks) sind Hooks pro Environment, ebenso wie andere Vite-spezifische Hooks, die Module behandeln. Beachten Sie jedoch, dass `buildStart` und `buildEnd` ohne [das Flag `perEnvironmentStartEndDuringDev: true`](#per-environment-state-in-plugins) nur für das Client-Environment aufgerufen werden.

## Zugriff auf das aktuelle Environment in Hooks

Da es bis Vite 6 nur zwei Environments gab (`client` und `ssr`), reichte ein `ssr`-Boolean aus, um das aktuelle Environment in Vite-APIs zu identifizieren. Plugin-Hooks erhielten im letzten Optionsparameter ein `ssr`-Boolean, und mehrere APIs erwarteten einen optionalen letzten `ssr`-Parameter, um Module korrekt dem richtigen Environment zuzuordnen (zum Beispiel `server.moduleGraph.getModuleByUrl(url, { ssr })`).

Mit dem Aufkommen konfigurierbarer Environments haben wir nun einen einheitlichen Weg, in Plugins auf deren Optionen und Instanz zuzugreifen. Plugin-Hooks stellen jetzt `this.environment` in ihrem Kontext bereit, und APIs, die zuvor ein `ssr`-Boolean erwarteten, sind nun auf das passende Environment bezogen (zum Beispiel `environment.moduleGraph.getModuleByUrl(url)`).

Der Vite-Server hat eine gemeinsame Plugin-Pipeline, aber wenn ein Modul verarbeitet wird, geschieht das immer im Kontext eines bestimmten Environments. Die `environment`-Instanz ist im Plugin-Kontext verfügbar.

Ein Plugin könnte die `environment`-Instanz nutzen, um zu ändern, wie ein Modul verarbeitet wird – abhängig von der Konfiguration des Environments (auf die über `environment.config` zugegriffen werden kann).

```ts
  transform(code, id) {
    console.log(this.environment.config.resolve.conditions)
  }
```

## Neue Environments über Hooks registrieren

Plugins können im `config`-Hook neue Environments hinzufügen. Zum Beispiel verwendet die [RSC-Unterstützung](/plugins/#vitejs-plugin-rsc) ein zusätzliches Environment, um einen separaten Modulgraphen mit der Bedingung `react-server` zu erhalten:

```ts
  config(config: UserConfig) {
    return {
      environments: {
        rsc: {
          resolve: {
            conditions: ['react-server', ...defaultServerConditions],
          },
        },
      },
    }
  }
```

Ein leeres Objekt genügt, um das Environment zu registrieren; dabei werden die Standardwerte aus der Environment-Konfiguration auf Root-Ebene verwendet.

## Environments mit dem Hook `configEnvironment` konfigurieren

- **Typ:** `(name: string, config: EnvironmentOptions, env: { mode: string, command: 'build' | 'serve', isSsrBuild?: boolean, isPreview?: boolean, isSsrTargetWebworker?: boolean }) => EnvironmentOptions | null | void`
- **Art:** `async`, `sequential`
- **Geltungsbereich:** [Pro Environment](#per-environment-hooks-and-global-hooks)

Während der `config`-Hook läuft, ist die vollständige Liste der Environments noch nicht bekannt, und die Environments können sowohl durch die Standardwerte aus der Environment-Konfiguration auf Root-Ebene als auch explizit über das Record `config.environments` beeinflusst werden.
Plugins sollten Standardwerte über den `config`-Hook setzen. Um jedes Environment zu konfigurieren, können sie den neuen Hook `configEnvironment` verwenden. Dieser Hook wird für jedes Environment mit dessen teilweise aufgelöster Konfiguration einschließlich der Auflösung der endgültigen Standardwerte aufgerufen.

```ts
  configEnvironment(name: string, options: EnvironmentOptions) {
    // add "workerd" condition to the rsc environment
    if (name === 'rsc') {
      return {
        resolve: {
          conditions: ['workerd'],
        },
      }
    }
  }
```

## Der Hook `hotUpdate`

- **Typ:** `(this: { environment: DevEnvironment }, options: HotUpdateOptions) => Array<EnvironmentModuleNode> | void | Promise<Array<EnvironmentModuleNode> | void>`
- **Art:** `async`, `sequential`
- **Geltungsbereich:** [Pro Environment](#per-environment-hooks-and-global-hooks)
- **Siehe auch:** [HMR API](./api-hmr)

Der Hook `hotUpdate` erlaubt es Plugins, die Behandlung von HMR-Updates für ein bestimmtes Environment selbst zu übernehmen. Wenn sich eine Datei ändert, wird der HMR-Algorithmus nacheinander für jedes Environment in der Reihenfolge von `server.environments` ausgeführt, sodass der Hook `hotUpdate` mehrfach aufgerufen wird. Der Hook erhält ein Kontextobjekt mit der folgenden Signatur:

```ts
interface HotUpdateOptions {
  type: 'create' | 'update' | 'delete'
  file: string
  timestamp: number
  modules: Array<EnvironmentModuleNode>
  read: () => string | Promise<string>
  server: ViteDevServer
}
```

- `this.environment` ist das Modul-Ausführungs-Environment, in dem gerade ein Datei-Update verarbeitet wird.

- `modules` ist ein Array von Modulen in diesem Environment, die von der geänderten Datei betroffen sind. Es ist ein Array, weil eine einzelne Datei auf mehrere ausgelieferte Module abgebildet werden kann (z. B. Vue-SFCs).

- `read` ist eine asynchrone Lesefunktion, die den Inhalt der Datei zurückgibt. Sie wird bereitgestellt, weil auf manchen Systemen der Callback für Dateiänderungen zu früh feuern kann, bevor der Editor das Aktualisieren der Datei abgeschlossen hat, und ein direktes `fs.readFile` dann leeren Inhalt zurückgibt. Die übergebene Lesefunktion normalisiert dieses Verhalten.

Der Hook kann sich entscheiden:

- Die Liste der betroffenen Module zu filtern und einzugrenzen, damit das HMR präziser wird.

- Ein leeres Array zurückzugeben und einen vollständigen Reload durchzuführen:

  ```js
  hotUpdate({ modules, timestamp }) {
    if (this.environment.name !== 'client')
      return

    // Invalidate modules manually
    const invalidatedModules = new Set()
    for (const mod of modules) {
      this.environment.moduleGraph.invalidateModule(
        mod,
        invalidatedModules,
        timestamp,
        true
      )
    }
    this.environment.hot.send({ type: 'full-reload' })
    return []
  }
  ```

- Ein leeres Array zurückzugeben und die HMR-Behandlung vollständig selbst zu übernehmen, indem eigene Events an den Client gesendet werden:

  ```js
  hotUpdate() {
    if (this.environment.name !== 'client')
      return

    this.environment.hot.send({
      type: 'custom',
      event: 'special-update',
      data: {}
    })
    return []
  }
  ```

  Der Client-Code sollte den entsprechenden Handler über die [HMR API](./api-hmr) registrieren (das könnte durch den `transform`-Hook desselben Plugins eingefügt werden):

  ```js
  if (import.meta.hot) {
    import.meta.hot.on('special-update', (data) => {
      // perform custom update
    })
  }
  ```

## Zustand pro Environment in Plugins

Da dieselbe Plugin-Instanz für verschiedene Environments verwendet wird, muss der Plugin-Zustand mit `this.environment` als Schlüssel abgelegt werden. Das ist dasselbe Muster, das das Ökosystem bereits verwendet hat, um Zustand über Module mit dem `ssr`-Boolean als Schlüssel zu halten und so das Vermischen von Client- und SSR-Modulzustand zu vermeiden. Eine `Map<Environment, State>` kann verwendet werden, um den Zustand für jedes Environment getrennt zu halten. Beachten Sie, dass `buildStart` und `buildEnd` aus Gründen der Abwärtskompatibilität ohne das Flag `perEnvironmentStartEndDuringDev: true` nur für das Client-Environment aufgerufen werden. Dasselbe gilt für `watchChange` und das Flag `perEnvironmentWatchChangeDuringDev: true`.

```js
function PerEnvironmentCountTransformedModulesPlugin() {
  const state = new Map<Environment, { count: number }>()
  return {
    name: 'count-transformed-modules',
    perEnvironmentStartEndDuringDev: true,
    buildStart() {
      state.set(this.environment, { count: 0 })
    },
    transform(id) {
      state.get(this.environment).count++
    },
    buildEnd() {
      console.log(this.environment.name, state.get(this.environment).count)
    }
  }
}
```

## Plugins pro Environment mit dem Hook `applyToEnvironment`

- **Typ:** `(environment: PartialEnvironment) => boolean | PluginOption | Promise<boolean>`
- **Art:** `async`, `sequential`
- **Geltungsbereich:** [Pro Environment](#per-environment-hooks-and-global-hooks)

Ein Plugin kann mit der Funktion `applyToEnvironment` festlegen, auf welche Environments es angewendet werden soll.

```js
const UnoCssPlugin = () => {
  // shared global state
  return {
    buildStart() {
      // init per-environment state with WeakMap<Environment,Data>
      // using this.environment
    },
    configureServer() {
      // use global hooks normally
    },
    applyToEnvironment(environment) {
      // return true if this plugin should be active in this environment,
      // or return a new plugin to replace it.
      // if the hook is not used, the plugin is active in all environments
    },
    resolveId(id, importer) {
      // only called for environments this plugin apply to
    },
  }
}
```

Wenn ein Plugin nicht Environment-bewusst ist und Zustand hält, der nicht nach dem aktuellen Environment geschlüsselt ist, erlaubt der Hook `applyToEnvironment`, es auf einfache Weise pro Environment zu betreiben.

```js
import { nonShareablePlugin } from 'non-shareable-plugin'

export default defineConfig({
  plugins: [
    {
      name: 'per-environment-plugin',
      applyToEnvironment(environment) {
        return nonShareablePlugin({ outputName: environment.name })
      },
    },
  ],
})
```

Vite exportiert einen Helfer `perEnvironmentPlugin`, um diese Fälle zu vereinfachen, wenn keine weiteren Hooks erforderlich sind:

```js
import { nonShareablePlugin } from 'non-shareable-plugin'

export default defineConfig({
  plugins: [
    perEnvironmentPlugin('per-environment-plugin', (environment) =>
      nonShareablePlugin({ outputName: environment.name }),
    ),
  ],
})
```

Der Hook `applyToEnvironment` wird zur Konfigurationszeit aufgerufen, derzeit nach `configResolved`, weil Projekte im Ökosystem die Plugins darin verändern. Die Auflösung der Environment-Plugins könnte künftig vor `configResolved` verschoben werden.

## Kommunikation zwischen Anwendung und Plugin

`environment.hot` erlaubt es Plugins, für ein bestimmtes Environment mit dem Code auf der Anwendungsseite zu kommunizieren. Das ist das Äquivalent zur [Funktion Client-Server-Kommunikation](/guide/api-plugin#client-server-communication), unterstützt aber auch andere Environments als das Client-Environment.

:::warning Hinweis

Beachten Sie, dass diese Funktion nur für Environments verfügbar ist, die HMR unterstützen.

:::

### Die Anwendungsinstanzen verwalten

Beachten Sie, dass im selben Environment mehrere Anwendungsinstanzen laufen können. Wenn Sie zum Beispiel mehrere Tabs im Browser geöffnet haben, ist jeder Tab eine eigene Anwendungsinstanz und hat eine eigene Verbindung zum Server.

Wenn eine neue Verbindung aufgebaut wird, wird auf der `hot`-Instanz des Environments ein Event `vite:client:connect` ausgelöst. Wird die Verbindung geschlossen, wird ein Event `vite:client:disconnect` ausgelöst.

Jeder Event-Handler erhält als zweites Argument den `NormalizedHotChannelClient`. Der Client ist ein Objekt mit einer Methode `send`, mit der Nachrichten an genau diese Anwendungsinstanz gesendet werden können. Die Client-Referenz bleibt für dieselbe Verbindung immer gleich, sodass Sie sie behalten können, um die Verbindung zu verfolgen.

### Beispielverwendung

Die Plugin-Seite:

```js
configureServer(server) {
  server.environments.ssr.hot.on('my:greetings', (data, client) => {
    // do something with the data,
    // and optionally send a response to that application instance
    client.send('my:foo:reply', `Hello from server! You said: ${data}`)
  })

  // broadcast a message to all application instances
  server.environments.ssr.hot.send('my:foo', 'Hello from server!')
}
```

Die Anwendungsseite ist identisch mit der Funktion Client-Server-Kommunikation. Sie können das Objekt `import.meta.hot` verwenden, um Nachrichten an das Plugin zu senden.

## Environment in Build-Hooks

Genau wie während der Entwicklung erhalten Plugin-Hooks auch beim Build die Environment-Instanz, die das `ssr`-Boolean ersetzt.
Das gilt auch für `renderChunk`, `generateBundle` und andere Hooks, die es nur beim Build gibt.

## Geteilte Plugins während des Builds

Vor Vite 6 funktionierten die Plugin-Pipelines während der Entwicklung und beim Build unterschiedlich:

- **Während der Entwicklung:** Plugins werden geteilt
- **Während des Builds:** Plugins sind pro Environment isoliert (in verschiedenen Prozessen: `vite build`, dann `vite build --ssr`).

Das zwang Frameworks dazu, Zustand zwischen dem `client`-Build und dem `ssr`-Build über ins Dateisystem geschriebene Manifest-Dateien zu teilen. In Vite 6 bauen wir nun alle Environments in einem einzigen Prozess, sodass die Plugin-Pipeline und die Kommunikation zwischen Environments an die Entwicklung angeglichen werden können.

In einem künftigen Major könnten wir vollständige Angleichung erreichen:

- **Sowohl während der Entwicklung als auch beim Build:** Plugins werden geteilt, mit [Filterung pro Environment](#per-environment-plugins-using-the-applytoenvironment-hook)

Es wird zudem eine einzige `ResolvedConfig`-Instanz geben, die während des Builds geteilt wird und Caching auf Ebene des gesamten App-Build-Prozesses ermöglicht – so, wie wir es während der Entwicklung mit `WeakMap<ResolvedConfig, CachedData>` gemacht haben.

Für Vite 6 müssen wir einen kleineren Schritt gehen, um Abwärtskompatibilität zu wahren. Plugins aus dem Ökosystem verwenden derzeit `config.build` statt `environment.config.build`, um auf die Konfiguration zuzugreifen, daher müssen wir standardmäßig pro Environment eine neue `ResolvedConfig` erzeugen. Ein Projekt kann sich für das Teilen der vollständigen Konfiguration und Plugin-Pipeline entscheiden, indem es `builder.sharedConfigBuild` auf `true` setzt.

Diese Option würde zunächst nur für einen kleinen Teil der Projekte funktionieren, daher können Plugin-Autoren für ein bestimmtes Plugin das Teilen aktivieren, indem sie das Flag `sharedDuringBuild` auf `true` setzen. Das erlaubt es, Zustand auch bei gewöhnlichen Plugins leicht zu teilen:

```js
function myPlugin() {
  // Share state among all environments in dev and build
  const sharedState = ...
  return {
    name: 'shared-plugin',
    transform(code, id) { ... },

    // Opt-in into a single instance for all environments
    sharedDuringBuild: true,
  }
}
```
