# Plugins

:::tip NOTE
Vite möchte gängige Muster der Webentwicklung von Haus aus unterstützen. Bevor du nach einem Vite- oder kompatiblen Rollup-Plugin suchst, wirf einen Blick in den [Features Guide](../guide/features.md). Viele Fälle, in denen man in einem Rollup-Projekt ein Plugin bräuchte, deckt Vite bereits ab.
:::

Informationen zur Verwendung von Plugins findest du unter [Using Plugins](../guide/using-plugins).

## Offizielle Plugins

### [@vitejs/plugin-vue](https://github.com/vitejs/vite-plugin-vue/tree/main/packages/plugin-vue)

Bietet Unterstützung für Vue-3-Single-File-Components.

### [@vitejs/plugin-vue-jsx](https://github.com/vitejs/vite-plugin-vue/tree/main/packages/plugin-vue-jsx)

Bietet Unterstützung für Vue-3-JSX (über eine [dedizierte Babel-Transformation](https://github.com/vuejs/babel-plugin-jsx)).

### [@vitejs/plugin-react](https://github.com/vitejs/vite-plugin-react/tree/main/packages/plugin-react)

Bietet Unterstützung für React Fast Refresh über den [Oxc Transformer](https://oxc.rs/docs/guide/usage/transformer).

### [@vitejs/plugin-react-swc](https://github.com/vitejs/vite-plugin-react/tree/main/packages/plugin-react-swc)

Ersetzt Oxc während der Entwicklung durch [SWC](https://swc.rs/), um SWC-Plugins nutzen zu können. Bei Produktions-Builds werden beim Einsatz von Plugins SWC und der Oxc Transformer zusammen verwendet. Bei großen Projekten, die eigene Plugins benötigen, können Kaltstart und Hot Module Replacement (HMR) deutlich schneller sein, sofern das Plugin auch für SWC verfügbar ist.

### [@vitejs/plugin-rsc](https://github.com/vitejs/vite-plugin-react/tree/main/packages/plugin-rsc)

Vite unterstützt [React Server Components (RSC)](https://react.dev/reference/rsc/server-components) über dieses Plugin. Es nutzt die [Environment API](/guide/api-environment), um Low-Level-Primitive bereitzustellen, mit denen React-Frameworks RSC-Funktionen integrieren können. Eine minimale eigenständige RSC-Anwendung kannst du so ausprobieren:

```bash
npm create vite@latest -- --template rsc
```

Mehr dazu in der [Plugin-Dokumentation](https://github.com/vitejs/vite-plugin-react/tree/main/packages/plugin-rsc).

### [@vitejs/plugin-legacy](https://github.com/vitejs/vite/tree/main/packages/plugin-legacy)

Bietet Unterstützung für ältere Browser im Produktions-Build.

## Community-Plugins

Eine Liste der auf npm veröffentlichten Plugins findest du in der [Vite Plugin Registry](https://registry.vite.dev/plugins).

## Eingebaute Rolldown-Plugins

Vite verwendet intern [Rolldown](https://rolldown.rs/) und bringt darüber einige eingebaute Plugins für gängige Anwendungsfälle mit.

Weitere Informationen findest du im Abschnitt [Rolldown Builtin Plugins](https://rolldown.rs/builtin-plugins/).

## Rolldown- / Rollup-Plugins

[Vite-Plugins](../guide/api-plugin) sind eine Erweiterung der Plugin-Schnittstelle von Rollup. Weitere Informationen findest du im Abschnitt [Rollup Plugin Compatibility](../guide/api-plugin#rolldown-plugin-compatibility).
