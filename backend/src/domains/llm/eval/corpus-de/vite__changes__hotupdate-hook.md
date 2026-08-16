# HMR-Plugin-Hook `hotUpdate`

::: tip Feedback
Geben Sie uns Feedback in der [Diskussion zum Environment-API-Feedback](https://github.com/vitejs/vite/discussions/16358)
:::

Wir planen, den Plugin-Hook `handleHotUpdate` zugunsten des [`hotUpdate`-Hooks](/guide/api-environment-plugins#the-hotupdate-hook) abzukündigen, damit er die [Environment API](/guide/api-environment.md) berücksichtigt und zusätzliche Watch-Ereignisse mit `create` und `delete` behandelt.

Betroffener Bereich: `Vite Plugin Authors`

::: warning Future Deprecation
`hotUpdate` wurde erstmals in `v6.0` eingeführt. Die Abkündigung von `handleHotUpdate` ist für ein zukünftiges Major-Release geplant. Wir empfehlen noch nicht, sich von `handleHotUpdate` zu lösen. Wenn Sie experimentieren und uns Feedback geben möchten, können Sie in Ihrer Vite-Konfiguration `future.removePluginHookHandleHotUpdate` auf `"warn"` setzen.
:::

## Motivation

Der [`handleHotUpdate`-Hook](/guide/api-plugin.md#handlehotupdate) erlaubt eine eigene Behandlung von HMR-Updates. Eine Liste der zu aktualisierenden Module wird im `HmrContext` übergeben.

```ts
interface HmrContext {
  file: string
  timestamp: number
  modules: Array<ModuleNode>
  read: () => string | Promise<string>
  server: ViteDevServer
}
```

Dieser Hook wird einmal für alle Umgebungen aufgerufen, und die übergebenen Module enthalten gemischte Informationen ausschließlich aus der Client- und der SSR-Umgebung. Sobald Frameworks auf eigene Umgebungen umsteigen, wird ein neuer Hook benötigt, der für jede von ihnen aufgerufen wird.

Der neue `hotUpdate`-Hook funktioniert genauso wie `handleHotUpdate`, wird aber für jede Umgebung aufgerufen und erhält eine neue `HotUpdateOptions`-Instanz:

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

Auf die aktuelle Dev-Umgebung kann wie in anderen Plugin-Hooks über `this.environment` zugegriffen werden. Die Liste `modules` enthält nun ausschließlich Modulknoten aus der aktuellen Umgebung. Jede Umgebung kann für Updates eigene Strategien festlegen.

Dieser Hook wird jetzt außerdem für weitere Watch-Ereignisse aufgerufen und nicht nur für `'update'`. Verwenden Sie `type`, um sie zu unterscheiden.

## Migrationsleitfaden

Filtern und verkleinern Sie die Liste der betroffenen Module, damit das HMR präziser wird.

```js
handleHotUpdate({ modules }) {
  return modules.filter(condition)
}

// Migrate to:

hotUpdate({ modules }) {
  return modules.filter(condition)
}
```

Ein leeres Array zurückgeben und ein vollständiges Neuladen durchführen:

```js
handleHotUpdate({ server, modules, timestamp }) {
  // Invalidate modules manually
  const invalidatedModules = new Set()
  for (const mod of modules) {
    server.moduleGraph.invalidateModule(
      mod,
      invalidatedModules,
      timestamp,
      true
    )
  }
  server.ws.send({ type: 'full-reload' })
  return []
}

// Migrate to:

hotUpdate({ modules, timestamp }) {
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

Ein leeres Array zurückgeben und die HMR-Behandlung vollständig selbst übernehmen, indem eigene Ereignisse an den Client gesendet werden:

```js
handleHotUpdate({ server }) {
  server.ws.send({
    type: 'custom',
    event: 'special-update',
    data: {}
  })
  return []
}

// Migrate to...

hotUpdate() {
  this.environment.hot.send({
    type: 'custom',
    event: 'special-update',
    data: {}
  })
  return []
}
```
