# Umstieg auf umgebungsspezifische APIs

::: tip Feedback
Geben Sie uns Feedback in der [Diskussion zum Environment-API-Feedback](https://github.com/vitejs/vite/discussions/16358)
:::

Mehrere APIs von `ViteDevServer`, die den Modulgraphen und Modultransformationen betreffen, sind zu den `DevEnvironment`-Instanzen umgezogen.

Betroffener Bereich: `Vite Plugin Authors`

::: warning Future Deprecation
Die `Environment`-Instanz wurde erstmals in `v6.0` eingeführt. Die Abkündigung von `server.moduleGraph` und weiteren Methoden, die jetzt in den Umgebungen liegen, ist für ein zukünftiges Major-Release geplant. Wir empfehlen noch nicht, sich von den Server-Methoden zu lösen. Um Ihre Verwendung zu ermitteln, setzen Sie Folgendes in Ihrer Vite-Konfiguration.

```ts
future: {
  removeServerModuleGraph: 'warn',
  removeServerReloadModule: 'warn',
  removeServerPluginContainer: 'warn',
  removeServerHot: 'warn',
  removeServerTransformRequest: 'warn',
  removeServerWarmupRequest: 'warn',
}
```

:::

## Motivation

In Vite v5 und davor hatte ein einzelner Vite-Dev-Server immer zwei Umgebungen (`client` und `ssr`). Der `server.moduleGraph` enthielt Module aus beiden Umgebungen gemischt. Die Knoten waren über die Listen `clientImportedModules` und `ssrImportedModules` verbunden (für jeden wurde jedoch nur eine einzige `importers`-Liste geführt). Ein transformiertes Modul wurde durch eine `id` und einen `ssr`-Boolean repräsentiert. Dieser Boolean musste an die APIs übergeben werden, zum Beispiel `server.moduleGraph.getModuleByUrl(url, ssr)` und `server.transformRequest(url, { ssr })`.

In Vite v6 ist es nun möglich, beliebig viele eigene Umgebungen zu erstellen (`client`, `ssr`, `edge` usw.). Ein einzelner `ssr`-Boolean reicht dafür nicht mehr aus. Statt die APIs in die Form `server.transformRequest(url, { environment })` zu bringen, haben wir diese Methoden auf die Umgebungsinstanz verschoben, sodass sie auch ohne einen Vite-Dev-Server aufgerufen werden können.

## Migrationsleitfaden

- `server.moduleGraph` -> [`environment.moduleGraph`](/guide/api-environment-instances#separate-module-graphs)
- `server.reloadModule(module)` -> `environment.reloadModule(module)`
- `server.pluginContainer` -> `environment.pluginContainer`
- `server.transformRequest(url, ssr)` -> `environment.transformRequest(url)`
- `server.warmupRequest(url, ssr)` -> `environment.warmupRequest(url)`
- `server.hot` -> `server.client.environment.hot`
