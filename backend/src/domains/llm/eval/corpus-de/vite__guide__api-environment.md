# Environment API

:::info Release Candidate
Die Environment API befindet sich im Wesentlichen in der Release-Candidate-Phase. Wir halten die APIs zwischen Major-Releases stabil, damit das Ökosystem damit experimentieren und darauf aufbauen kann. Beachten Sie jedoch, dass [einige bestimmte APIs](/changes/#considering) weiterhin als experimentell gelten.

Wir planen, diese neuen APIs (mit möglichen Breaking Changes) in einem künftigen Major-Release zu stabilisieren, sobald nachgelagerte Projekte Zeit hatten, mit den neuen Funktionen zu experimentieren und sie zu validieren.

Ressourcen:

- [Feedback-Diskussion](https://github.com/vitejs/vite/discussions/16358), in der wir Rückmeldungen zu den neuen APIs sammeln.
- [Environment-API-PR](https://github.com/vitejs/vite/pull/16471), in dem die neuen APIs implementiert und begutachtet wurden.

Bitte teilen Sie uns Ihr Feedback mit.
:::

## Environments formalisieren

Vite 6 formalisiert das Konzept der Environments. Bis Vite 5 gab es zwei implizite Environments (`client` und optional `ssr`). Die neue Environment API erlaubt es Nutzenden und Framework-Autoren, so viele Environments anzulegen, wie nötig sind, um die Funktionsweise ihrer Apps in der Produktion abzubilden. Diese neue Fähigkeit erforderte ein großes internes Refactoring, doch es wurde viel Aufwand in die Rückwärtskompatibilität gesteckt. Das ursprüngliche Ziel von Vite 6 ist es, das Ökosystem so reibungslos wie möglich auf den neuen Major zu bringen und die Einführung der APIs zu verzögern, bis genügend Nutzende migriert sind und Framework- und Plugin-Autoren das neue Design validiert haben.

## Die Lücke zwischen Build und Dev schließen

Für eine einfache SPA/MPA werden in der Konfiguration keine neuen APIs rund um Environments sichtbar. Intern wendet Vite die Optionen auf ein `client`-Environment an, doch beim Konfigurieren von Vite müssen Sie dieses Konzept nicht kennen. Konfiguration und Verhalten aus Vite 5 sollten hier nahtlos funktionieren.

Wechseln wir zu einer typischen serverseitig gerenderten (SSR) App, haben wir zwei Environments:

- `client`: führt die App im Browser aus.
- `ssr`: führt die App in Node (oder anderen Server-Runtimes) aus und rendert Seiten, bevor sie an den Browser gesendet werden.

In der Entwicklung führt Vite den Server-Code im selben Node-Prozess wie den Vite-Dev-Server aus, was der Produktionsumgebung nahekommt. Server können jedoch auch in anderen JS-Runtimes laufen, etwa [Cloudflares workerd](https://github.com/cloudflare/workerd), die anderen Einschränkungen unterliegen. Moderne Apps können außerdem in mehr als zwei Environments laufen, z. B. einem Browser, einem Node-Server und einem Edge-Server. Vite 5 erlaubte es nicht, diese Environments angemessen abzubilden.

Vite 6 erlaubt es Nutzenden, ihre App sowohl beim Build als auch in der Entwicklung so zu konfigurieren, dass alle ihre Environments abgebildet werden. Während der Entwicklung kann ein einzelner Vite-Dev-Server nun Code in mehreren verschiedenen Environments nebenläufig ausführen. Der Quellcode der App wird weiterhin vom Vite-Dev-Server transformiert. Zusätzlich zum gemeinsamen HTTP-Server, den Middlewares, der aufgelösten Konfiguration und der Plugin-Pipeline verfügt der Vite-Dev-Server nun über eine Reihe unabhängiger Dev-Environments. Jedes davon ist so konfiguriert, dass es der Produktionsumgebung möglichst nahekommt, und ist mit einer Dev-Runtime verbunden, in der der Code ausgeführt wird (bei workerd kann der Server-Code nun lokal in miniflare laufen). Im Client importiert und führt der Browser den Code aus. In anderen Environments holt ein Module Runner den transformierten Code und wertet ihn aus.

![Vite Environments](../images/vite-environments.svg)

## Konfiguration von Environments

Für eine SPA/MPA sieht die Konfiguration ähnlich aus wie in Vite 5. Intern werden diese Optionen verwendet, um das `client`-Environment zu konfigurieren.

```js
export default defineConfig({
  build: {
    sourcemap: false,
  },
  optimizeDeps: {
    include: ['lib'],
  },
})
```

Das ist wichtig, weil wir Vite zugänglich halten und keine neuen Konzepte offenlegen möchten, bevor sie gebraucht werden.

Besteht die App aus mehreren Environments, lassen sich diese über die Konfigurationsoption `environments` explizit konfigurieren.

```js
export default {
  build: {
    sourcemap: false,
  },
  optimizeDeps: {
    include: ['lib'],
  },
  environments: {
    server: {},
    edge: {
      resolve: {
        noExternal: true,
      },
    },
  },
}
```

Sofern nicht ausdrücklich anders dokumentiert, erbt ein Environment die auf oberster Ebene konfigurierten Optionen (die neuen Environments `server` und `edge` erben beispielsweise die Option `build.sourcemap: false`). Eine kleine Zahl von Optionen auf oberster Ebene, etwa `optimizeDeps`, gilt nur für das `client`-Environment, weil sie als Vorgabe für Server-Environments nicht gut funktionieren. Diese Optionen tragen in [der Referenz](/config/) das Abzeichen <NonInheritBadge />. Das `client`-Environment lässt sich über `environments.client` ebenfalls explizit konfigurieren; wir empfehlen jedoch, dafür die Optionen auf oberster Ebene zu verwenden, damit die Client-Konfiguration beim Hinzufügen neuer Environments unverändert bleibt.

Das Interface `EnvironmentOptions` legt alle Optionen pro Environment offen. Es gibt Environment-Optionen, die sowohl für `build` als auch für `dev` gelten, etwa `resolve`. Und es gibt `DevEnvironmentOptions` und `BuildEnvironmentOptions` für dev- bzw. build-spezifische Optionen (wie `dev.warmup` oder `build.outDir`). Manche Optionen wie `optimizeDeps` gelten nur für dev, bleiben aus Gründen der Rückwärtskompatibilität aber auf oberster Ebene statt unter `dev` verschachtelt.

```ts
interface EnvironmentOptions {
  define?: Record<string, any>
  resolve?: EnvironmentResolveOptions
  optimizeDeps: DepOptimizationOptions
  consumer?: 'client' | 'server'
  dev: DevOptions
  build: BuildOptions
}
```

Das Interface `UserConfig` erweitert das Interface `EnvironmentOptions` und erlaubt es, den Client sowie Vorgaben für andere Environments zu konfigurieren, die über die Option `environments` eingerichtet werden. Das `client`-Environment und ein `ssr` benanntes Server-Environment sind während der Entwicklung immer vorhanden. Das ermöglicht Rückwärtskompatibilität zu `server.ssrLoadModule(url)` und `server.moduleGraph`. Während des Builds ist das `client`-Environment immer vorhanden, das `ssr`-Environment nur dann, wenn es explizit konfiguriert wurde (über `environments.ssr` oder aus Gründen der Rückwärtskompatibilität über `build.ssr`). Eine App muss für ihr SSR-Environment nicht den Namen `ssr` verwenden; sie könnte es beispielsweise `server` nennen.

```ts
interface UserConfig extends EnvironmentOptions {
  environments: Record<string, EnvironmentOptions>
  // other options
}
```

Beachten Sie, dass die Eigenschaft `ssr` auf oberster Ebene als deprecated markiert wird, sobald die Environment API stabil ist. Diese Option hat dieselbe Aufgabe wie `environments`, jedoch für das Standard-`ssr`-Environment, und erlaubte nur die Konfiguration einer kleinen Menge von Optionen.

## Eigene Environment-Instanzen

Es stehen Low-Level-Konfigurations-APIs zur Verfügung, damit Runtime-Anbieter Environments mit passenden Vorgaben für ihre Runtimes bereitstellen können. Diese Environments können außerdem weitere Prozesse oder Threads starten, um die Module während der Entwicklung in einer Runtime auszuführen, die der Produktionsumgebung näher kommt.

Beispielsweise nutzt das [Cloudflare-Vite-Plugin](https://developers.cloudflare.com/workers/vite-plugin/) die Environment API, um Code während der Entwicklung in der Cloudflare-Workers-Runtime (`workerd`) auszuführen.

```js
import { customEnvironment } from 'vite-environment-provider'

export default {
  build: {
    outDir: '/dist/client',
  },
  environments: {
    ssr: customEnvironment({
      build: {
        outDir: '/dist/ssr',
      },
    }),
  },
}
```

## Rückwärtskompatibilität

Die derzeitige Vite-Server-API ist noch nicht deprecated und zu Vite 5 rückwärtskompatibel.

`server.moduleGraph` gibt eine gemischte Sicht auf die Modulgraphen von Client und SSR zurück. Aus allen seinen Methoden werden rückwärtskompatible gemischte Modulknoten zurückgegeben. Dasselbe Schema gilt für die Modulknoten, die an `handleHotUpdate` übergeben werden.

Wir empfehlen noch nicht, auf die Environment API umzusteigen. Wir streben an, dass zuvor ein guter Teil der Nutzerbasis Vite 6 übernimmt, damit Plugins nicht zwei Versionen pflegen müssen. Informationen zu künftigen Deprecations und zum Upgrade-Pfad finden Sie im Abschnitt zu künftigen Breaking Changes:

- [`this.environment` in Hooks](/changes/this-environment-in-hooks)
- [HMR-Plugin-Hook `hotUpdate`](/changes/hotupdate-hook)
- [Umstieg auf APIs pro Environment](/changes/per-environment-apis)
- [SSR mit der `ModuleRunner`-API](/changes/ssr-using-modulerunner)
- [Gemeinsame Plugins während des Builds](/changes/shared-plugins-during-build)

## Zielgruppe

Diese Anleitung vermittelt Endnutzenden die grundlegenden Konzepte rund um Environments.

Plugin-Autoren steht eine konsistentere API zur Verfügung, um mit der aktuellen Environment-Konfiguration zu interagieren. Wenn Sie auf Vite aufbauen, beschreibt die Anleitung [Environment API – Plugins](./api-environment-plugins.md), wie die erweiterten Plugin-APIs mehrere eigene Environments unterstützen.

Frameworks können sich entscheiden, Environments auf unterschiedlichen Ebenen offenzulegen. Wenn Sie Framework-Autor sind, lesen Sie weiter in der Anleitung [Environment API – Frameworks](./api-environment-frameworks), um die programmatische Seite der Environment API kennenzulernen.

Für Runtime-Anbieter erläutert die Anleitung [Environment API – Runtimes](./api-environment-runtimes.md), wie sich eigene Environments anbieten lassen, die von Frameworks und Nutzenden konsumiert werden.
