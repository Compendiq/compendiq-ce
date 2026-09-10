# Performance

Vite ist standardmäßig schnell, dennoch können sich Performance-Probleme einschleichen, wenn die Anforderungen eines Projekts wachsen. Dieser Leitfaden soll dir helfen, häufige Performance-Probleme zu erkennen und zu beheben, etwa:

- Langsame Server-Starts
- Langsame Seitenladezeiten
- Langsame Builds

## Überprüfe dein Browser-Setup

Manche Browser-Erweiterungen können Requests stören und die Start- und Reload-Zeiten großer Apps verlangsamen, insbesondere bei geöffneten Browser-Entwicklerwerkzeugen. Wir empfehlen, in diesen Fällen ein reines Dev-Profil ohne Erweiterungen anzulegen oder in den Inkognito-Modus zu wechseln, während du Vites Dev-Server verwendest. Der Inkognito-Modus sollte außerdem schneller sein als ein reguläres Profil ohne Erweiterungen.

Der Vite-Dev-Server cacht vorgebündelte Abhängigkeiten aggressiv und liefert schnelle 304-Responses für Quellcode. Den Cache zu deaktivieren, während die Browser-Entwicklerwerkzeuge geöffnet sind, kann sich stark auf Start- und vollständige Reload-Zeiten auswirken. Prüfe bitte, dass „Disable Cache“ nicht aktiviert ist, während du mit dem Vite-Server arbeitest.

## Prüfe die konfigurierten Vite-Plugins

Vites interne und offizielle Plugins sind darauf optimiert, so wenig Arbeit wie möglich zu leisten und dabei Kompatibilität mit dem breiteren Ökosystem zu bieten. Zum Beispiel verwenden Code-Transformationen im Dev-Modus reguläre Ausdrücke, führen im Build aber ein vollständiges Parsen durch, um Korrektheit sicherzustellen.

Die Performance von Community-Plugins liegt jedoch außerhalb von Vites Kontrolle und kann die Developer Experience beeinträchtigen. Auf ein paar Dinge kannst du achten, wenn du zusätzliche Vite-Plugins einsetzt:

1. Große Abhängigkeiten, die nur in bestimmten Fällen genutzt werden, sollten dynamisch importiert werden, um die Startzeit von Node.js zu reduzieren. Beispiel-Refactorings: [vite-plugin-react#212](https://github.com/vitejs/vite-plugin-react/pull/212) und [vite-plugin-pwa#244](https://github.com/vite-pwa/vite-plugin-pwa/pull/244).

2. Die Hooks `buildStart`, `config` und `configResolved` sollten keine langen und aufwendigen Operationen ausführen. Auf diese Hooks wird während des Starts des Dev-Servers gewartet, was verzögert, wann du die Seite im Browser aufrufen kannst.

3. Die Hooks `resolveId`, `load` und `transform` können dazu führen, dass manche Dateien langsamer laden als andere. Auch wenn das manchmal unvermeidbar ist, lohnt es sich, nach möglichen Optimierungsstellen zu suchen. Zum Beispiel zu prüfen, ob der `code` ein bestimmtes Keyword enthält oder die `id` zu einer bestimmten Endung passt, bevor die vollständige Transformation durchgeführt wird.

   Je länger die Transformation einer Datei dauert, desto ausgeprägter wird der Request-Wasserfall beim Laden der Seite im Browser.

   Du kannst die Dauer der Transformation einer Datei mit `vite --debug plugin-transform` oder [vite-plugin-inspect](https://github.com/antfu/vite-plugin-inspect) untersuchen. Beachte, dass asynchrone Operationen dazu neigen, ungenaue Zeiten zu liefern; die Zahlen solltest du daher als groben Richtwert behandeln, sie sollten die teureren Operationen aber dennoch offenlegen.

::: tip Profiling
Du kannst `vite --profile` ausführen, die Seite aufrufen und in deinem Terminal `p + enter` drücken, um ein `.cpuprofile` aufzuzeichnen. Ein Werkzeug wie [speedscope](https://www.speedscope.app) kann dann zum Untersuchen des Profils und zum Identifizieren der Engpässe verwendet werden. Du kannst die [Profile auch mit dem Vite-Team teilen](https://chat.vite.dev), damit wir Performance-Probleme leichter finden.
:::

## Reduziere Resolve-Operationen

Das Auflösen von Import-Pfaden kann eine teure Operation sein, wenn der schlechteste Fall häufig eintritt. Zum Beispiel unterstützt Vite das „Erraten“ von Import-Pfaden über die Option [`resolve.extensions`](/config/shared-options.md#resolve-extensions), die standardmäßig `['.mjs', '.js', '.mts', '.ts', '.jsx', '.tsx', '.json']` ist.

Wenn du versuchst, `./Component.jsx` mit `import './Component'` zu importieren, führt Vite diese Schritte zur Auflösung aus:

1. Prüfen, ob `./Component` existiert, nein.
2. Prüfen, ob `./Component.mjs` existiert, nein.
3. Prüfen, ob `./Component.js` existiert, nein.
4. Prüfen, ob `./Component.mts` existiert, nein.
5. Prüfen, ob `./Component.ts` existiert, nein.
6. Prüfen, ob `./Component.jsx` existiert, ja!

Wie zu sehen, sind insgesamt 6 Dateisystem-Prüfungen nötig, um einen Import-Pfad aufzulösen. Je mehr implizite Imports du hast, desto mehr Zeit summiert sich für die Auflösung der Pfade.

Daher ist es meist besser, bei Import-Pfaden explizit zu sein, z. B. `import './Component.jsx'`. Du kannst die Liste in `resolve.extensions` auch einschränken, um die allgemeinen Dateisystem-Prüfungen zu reduzieren, musst aber sicherstellen, dass das auch für Dateien in `node_modules` funktioniert.

Wenn du Plugin-Autor bist, achte darauf, [`this.resolve`](https://rollupjs.org/plugin-development/#this-resolve) nur bei Bedarf aufzurufen, um die Anzahl der obigen Prüfungen zu reduzieren.

::: tip TypeScript
Wenn du TypeScript verwendest, aktiviere `"moduleResolution": "bundler"` und `"allowImportingTsExtensions": true` in den `compilerOptions` deiner `tsconfig.json`, um die Endungen `.ts` und `.tsx` direkt in deinem Code zu verwenden.
:::

## Vermeide Barrel-Dateien

Barrel-Dateien sind Dateien, die die APIs anderer Dateien im selben Verzeichnis re-exportieren. Zum Beispiel:

```js [src/utils/index.js]
export * from './color.js'
export * from './dom.js'
export * from './slash.js'
```

Wenn du nur eine einzelne API importierst, z. B. `import { slash } from './utils'`, müssen alle Dateien in dieser Barrel-Datei geladen und transformiert werden, da sie die API `slash` enthalten könnten und außerdem Seiteneffekte enthalten können, die bei der Initialisierung ausgeführt werden. Das bedeutet, dass du beim initialen Seitenaufbau mehr Dateien lädst als nötig, was zu einer langsameren Ladezeit führt.

Wenn möglich, solltest du Barrel-Dateien vermeiden und die einzelnen APIs direkt importieren, z. B. `import { slash } from './utils/slash.js'`. Weitere Informationen findest du in [Issue #8237](https://github.com/vitejs/vite/issues/8237).

## Wärme häufig genutzte Dateien vor

Der Vite-Dev-Server transformiert Dateien nur, wenn der Browser sie anfordert, wodurch er schnell startet und Transformationen nur für genutzte Dateien anwendet. Er kann Dateien auch vorab transformieren, wenn er erwartet, dass bestimmte Dateien in Kürze angefordert werden. Dennoch können Request-Wasserfälle auftreten, wenn manche Dateien länger zum Transformieren brauchen als andere. Zum Beispiel:

Gegeben ein Import-Graph, in dem die linke Datei die rechte Datei importiert:

```
main.js -> BigComponent.vue -> big-utils.js -> large-data.json
```

Die Import-Beziehung ist erst bekannt, nachdem die Datei transformiert wurde. Wenn `BigComponent.vue` einige Zeit zum Transformieren braucht, muss `big-utils.js` warten, bis es an der Reihe ist, und so weiter. Das erzeugt einen internen Wasserfall, selbst mit eingebauter Vorab-Transformation.

Vite erlaubt es dir, Dateien vorzuwärmen, von denen du weißt, dass sie häufig genutzt werden, z. B. `big-utils.js`, über die Option [`server.warmup`](/config/server-options.md#server-warmup). So ist `big-utils.js` bereit und zwischengespeichert, um bei Anforderung sofort ausgeliefert zu werden.

Häufig genutzte Dateien findest du, indem du `vite --debug transform` ausführst und die Logs untersuchst:

```bash
vite:transform 28.72ms /@vite/client +1ms
vite:transform 62.95ms /src/components/BigComponent.vue +1ms
vite:transform 102.54ms /src/utils/big-utils.js +1ms
```

```js [vite.config.js]
export default defineConfig({
  server: {
    warmup: {
      clientFiles: [
        './src/components/BigComponent.vue',
        './src/utils/big-utils.js',
      ],
    },
  },
})
```

Beachte, dass du nur häufig genutzte Dateien vorwärmen solltest, um den Vite-Dev-Server beim Start nicht zu überlasten. Weitere Informationen findest du bei der Option [`server.warmup`](/config/server-options.md#server-warmup).

Auch [`--open` bzw. `server.open`](/config/server-options.html#server-open) bringt einen Performance-Schub, da Vite den Einstiegspunkt deiner App oder die angegebene zu öffnende URL automatisch vorwärmt.

## Nutze weniger oder native Werkzeuge

Vite bei wachsender Codebasis schnell zu halten bedeutet, den Arbeitsaufwand für die Quelldateien (JS/TS/CSS) zu reduzieren.

Beispiele für weniger Arbeit:

- Verwende, wenn möglich, CSS statt Sass/Less/Stylus (Verschachtelung kann von PostCSS / Lightning CSS übernommen werden)
- Transformiere SVGs nicht in Komponenten eines UI-Frameworks (React, Vue usw.). Importiere sie stattdessen als Strings oder URLs.

Beispiele für die Nutzung nativer Werkzeuge:

Der Kern von Vite basiert zwar auf nativen Werkzeugen, manche Funktionen nutzen jedoch standardmäßig weiterhin nicht-native Werkzeuge, um bessere Kompatibilität und einen größeren Funktionsumfang zu bieten. Bei größeren Anwendungen kann sich der Umstieg aber lohnen.

- Probiere die experimentelle Unterstützung für [LightningCSS](https://github.com/vitejs/vite/discussions/13835) aus
