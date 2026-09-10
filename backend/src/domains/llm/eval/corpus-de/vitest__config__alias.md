# alias

- **Typ:** `Record<string, string> | Array<{ find: string | RegExp, replacement: string, customResolver?: ResolverFunction | ResolverObject }>`

Definiert eigene Aliase für die Ausführung innerhalb von Tests. Sie werden mit den Aliassen aus `resolve.alias` zusammengeführt.

::: warning
Vitest nutzt zur Testausführung die SSR-Primitive von Vite, was [einige Fallstricke](https://vitejs.dev/guide/ssr.html#ssr-externals) mit sich bringt.

1. Aliase wirken sich nur auf Module aus, die direkt mit dem Schlüsselwort `import` von einem [inlined](/config/server#server-deps-inline) Modul importiert werden (standardmäßig wird der gesamte Quellcode inlined).
2. Vitest unterstützt kein Aliasing von `require`-Aufrufen.
3. Wenn du eine externe Abhängigkeit aliasierst (z. B. `react` -> `preact`), solltest du stattdessen die tatsächlichen `node_modules`-Pakete aliasieren, damit es auch für externalisierte Abhängigkeiten funktioniert. Sowohl [Yarn](https://classic.yarnpkg.com/en/docs/cli/add/#toc-yarn-add-alias) als auch [pnpm](https://pnpm.io/aliases/) unterstützen Aliasing über das Präfix `npm:`.
:::
