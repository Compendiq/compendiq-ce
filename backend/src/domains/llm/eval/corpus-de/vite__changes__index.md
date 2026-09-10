# Breaking Changes

Liste der Breaking Changes in Vite, einschließlich API-Deprecations, -Entfernungen und -Änderungen. Die meisten der unten aufgeführten Änderungen lassen sich über die [`future`-Option](/config/shared-options.html#future) in Ihrer Vite-Konfiguration gezielt aktivieren.

## Geplant

Diese Änderungen sind für die nächste Major-Version von Vite geplant. Deprecation- und Nutzungswarnungen leiten Sie, wo immer möglich, an die passenden Stellen, und wir gehen auf Framework- und Plugin-Autoren sowie Nutzer zu, damit diese Änderungen übernommen werden.

- [`this.environment` in Hooks](/changes/this-environment-in-hooks)
- [HMR-Plugin-Hook `hotUpdate`](/changes/hotupdate-hook)
- [SSR über die `ModuleRunner`-API](/changes/ssr-using-modulerunner)

## In Erwägung

Diese Änderungen werden erwogen und sind häufig experimentelle APIs, die bestehende Nutzungsmuster verbessern sollen. Da hier nicht alle Änderungen aufgeführt sind, sehen Sie sich für die vollständige Liste bitte das [Experimental-Label in den Vite GitHub Discussions](https://github.com/vitejs/vite/discussions/categories/feedback?discussions_q=label%3Aexperimental+category%3AFeedback) an.

Wir empfehlen noch nicht, auf diese APIs umzusteigen. Sie sind in Vite enthalten, damit wir Feedback sammeln können. Bitte sehen Sie sich diese Vorschläge an und teilen Sie uns in der jeweils verlinkten GitHub Discussion mit, wie sie sich in Ihrem Anwendungsfall bewähren.

- [Umstieg auf Per-Environment-APIs](/changes/per-environment-apis)
- [Gemeinsame Plugins während des Builds](/changes/shared-plugins-during-build)

## Vergangen

Die folgenden Änderungen wurden umgesetzt oder zurückgenommen. Sie sind in der aktuellen Major-Version nicht mehr relevant.

- _Noch keine vergangenen Änderungen_
