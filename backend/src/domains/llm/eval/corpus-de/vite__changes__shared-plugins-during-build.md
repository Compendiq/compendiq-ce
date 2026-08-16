# Gemeinsame Plugins während des Builds

::: tip Feedback
Geben Sie uns Feedback in der [Feedback-Diskussion zur Environment API](https://github.com/vitejs/vite/discussions/16358)
:::

Siehe [Shared plugins during build](/guide/api-environment-plugins.md#shared-plugins-during-build).

Betroffener Personenkreis: `Vite Plugin Authors`

::: warning Künftige Änderung des Standardwerts
`builder.sharedConfigBuild` wurde erstmals in `v6.0` eingeführt. Sie können die Option auf true setzen, um zu prüfen, wie Ihre Plugins mit einer gemeinsamen Konfiguration funktionieren. Wir sammeln Feedback dazu, den Standardwert in einer künftigen Major-Version zu ändern, sobald das Plugin-Ökosystem so weit ist.
:::

## Motivation

Die Plugin-Pipelines von Dev und Build angleichen.

## Migrations-Guide

Damit Plugins über Environments hinweg geteilt werden können, muss der Plugin-Zustand nach dem aktuellen Environment geschlüsselt sein. Ein Plugin der folgenden Form zählt die Anzahl der transformierten Module über alle Environments hinweg.

```js
function CountTransformedModulesPlugin() {
  let transformedModules
  return {
    name: 'count-transformed-modules',
    buildStart() {
      transformedModules = 0
    },
    transform(id) {
      transformedModules++
    },
    buildEnd() {
      console.log(transformedModules)
    },
  }
}
```

Wenn wir stattdessen die Anzahl der transformierten Module je Environment zählen wollen, müssen wir eine Map führen:

```ts
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
    },
  }
}
```

Um dieses Muster zu vereinfachen, exportiert Vite einen Helfer `perEnvironmentState`:

```ts
function PerEnvironmentCountTransformedModulesPlugin() {
  const state = perEnvironmentState<{ count: number }>(() => ({ count: 0 }))
  return {
    name: 'count-transformed-modules',
    perEnvironmentStartEndDuringDev: true,
    buildStart() {
      state(this).count = 0
    },
    transform(id) {
      state(this).count++
    },
    buildEnd() {
      console.log(this.environment.name, state(this).count)
    },
  }
}
```
