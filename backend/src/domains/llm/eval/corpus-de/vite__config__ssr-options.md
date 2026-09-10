# SSR-Optionen

Sofern nicht anders vermerkt, gelten die Optionen in diesem Abschnitt sowohl für die Entwicklung als auch für den Build.

## ssr.external

- **Typ:** `string[] | true`
- **Verwandt:** [SSR Externals](/guide/ssr#ssr-externals)

Externalisiert die angegebenen Abhängigkeiten und ihre transitiven Abhängigkeiten für SSR. Standardmäßig werden alle Abhängigkeiten externalisiert, mit Ausnahme verlinkter Abhängigkeiten (wegen HMR). Wenn du eine verlinkte Abhängigkeit dennoch externalisieren möchtest, kannst du ihren Namen an diese Option übergeben.

Bei `true` werden alle Abhängigkeiten einschließlich der verlinkten externalisiert.

Beachte, dass explizit aufgeführte Abhängigkeiten (über den Typ `string[]`) immer Vorrang haben, wenn sie zusätzlich in `ssr.noExternal` (mit beliebigem Typ) aufgeführt sind.

## ssr.noExternal

- **Typ:** `string | RegExp | (string | RegExp)[] | true`
- **Verwandt:** [SSR Externals](/guide/ssr#ssr-externals)

Verhindert, dass die aufgeführten Abhängigkeiten für SSR externalisiert werden, sodass sie im Build gebündelt werden. Standardmäßig werden nur verlinkte Abhängigkeiten nicht externalisiert (wegen HMR). Wenn du eine verlinkte Abhängigkeit externalisieren möchtest, kannst du ihren Namen an die Option `ssr.external` übergeben.

Bei `true` werden keine Abhängigkeiten externalisiert. Explizit in `ssr.external` (über den Typ `string[]`) aufgeführte Abhängigkeiten können jedoch Vorrang haben und trotzdem externalisiert werden. Ist `ssr.target: 'node'` gesetzt, werden standardmäßig auch die Node.js-Builtins externalisiert.

Beachte: Sind sowohl `ssr.noExternal: true` als auch `ssr.external: true` konfiguriert, hat `ssr.noExternal` Vorrang und es werden keine Abhängigkeiten externalisiert.

## ssr.target

- **Typ:** `'node' | 'webworker'`
- **Standard:** `node`

Build-Target für den SSR-Server.

## ssr.resolve.conditions

- **Typ:** `string[]`
- **Standard:** `['module', 'node', 'development|production']` (`defaultServerConditions`) (`['module', 'browser', 'development|production']` (`defaultClientConditions`) bei `ssr.target === 'webworker'`)
- **Verwandt:** [Resolve Conditions](./shared-options.md#resolve-conditions)

Diese Conditions werden in der Plugin-Pipeline verwendet und wirken sich während des SSR-Builds nur auf nicht externalisierte Abhängigkeiten aus. Verwende `ssr.resolve.externalConditions`, um externalisierte Importe zu beeinflussen.

## ssr.resolve.externalConditions

- **Typ:** `string[]`
- **Standard:** `['node', 'module-sync']`

Conditions, die beim SSR-Import (einschließlich `ssrLoadModule`) externalisierter direkter Abhängigkeiten verwendet werden (externe Abhängigkeiten, die von Vite importiert werden).

:::tip

Wenn du diese Option verwendest, achte darauf, Node sowohl in der Entwicklung als auch im Build mit dem [`--conditions`-Flag](https://nodejs.org/docs/latest/api/cli.html#-c-condition---conditionscondition) und denselben Werten auszuführen, um ein konsistentes Verhalten zu erhalten.

Setzt du beispielsweise `['node', 'custom']`, solltest du in der Entwicklung `NODE_OPTIONS='--conditions custom' vite` und nach dem Build `NODE_OPTIONS="--conditions custom" node ./dist/server.js` ausführen.

:::

## ssr.resolve.mainFields

- **Typ:** `string[]`
- **Standard:** `['module', 'jsnext:main', 'jsnext']`

Liste der Felder in der `package.json`, die beim Auflösen des Einstiegspunkts eines Pakets probiert werden. Beachte, dass sie eine niedrigere Priorität haben als bedingte Exporte aus dem Feld `exports`: Wird ein Einstiegspunkt erfolgreich über `exports` aufgelöst, wird das Main-Feld ignoriert. Diese Einstellung betrifft nur nicht externalisierte Abhängigkeiten.
