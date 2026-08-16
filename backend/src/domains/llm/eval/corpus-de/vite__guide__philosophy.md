# Projektphilosophie

## Ein schlanker, erweiterbarer Kern

Vite hat den Anspruch, die gängigsten Muster für den Bau von Web-Apps ab Werk zu unterstützen und dabei den [Vite-Kern](https://github.com/vitejs/vite) langfristig schlank und wartbar zu halten. Wir sind überzeugt, dass sich vielfältige Anwendungsfälle am besten unterstützen lassen, indem starke Primitive und APIs bereitgestellt werden, auf denen Plugins aufbauen können; entsprechend erweitern wir den Kern aktiv, um Vite noch erweiterbarer zu machen. [Vites Plugin-System](./api-plugin.md) basiert auf einer Obermenge von Rollups Plugin-API und ermöglicht Plugins wie [vite-plugin-pwa](https://vite-pwa-org.netlify.app/) sowie die vielen [gut gepflegten Plugins](https://registry.vite.dev/plugins), die Ihre Anforderungen abdecken. Vites Bundler [Rolldown](https://rolldown.rs/) bleibt zur Plugin-Schnittstelle von Rollup kompatibel, sodass Plugins häufig sowohl in Vite- als auch in reinen Rollup-Projekten eingesetzt werden können.

## Das moderne Web voranbringen

Vite bietet meinungsstarke Funktionen, die zum Schreiben von modernem Code anhalten. Zum Beispiel:

- Der Quellcode kann nur in ESM geschrieben werden; Nicht-ESM-Abhängigkeiten müssen [als ESM vorgebündelt](./dep-pre-bundling) werden, damit sie funktionieren.
- Web Worker sollten mit der [`new Worker`-Syntax](./features#web-workers) geschrieben werden, um modernen Standards zu folgen.
- Node.js-Module können im Browser nicht verwendet werden.

Beim Hinzufügen neuer Funktionen werden diese Muster befolgt, um eine zukunftssichere API zu schaffen, die nicht immer mit anderen Build-Werkzeugen kompatibel sein muss.

## Ein pragmatischer Umgang mit Performance

Vite hat sich seit seinen [Anfängen](./why.md) auf Performance konzentriert. Die Architektur des Dev-Servers ermöglicht ein HMR, das auch bei wachsenden Projekten schnell bleibt. Vite basiert auf nativen Werkzeugen wie der [Oxc-Toolchain](https://oxc.rs/) und [Rolldown](https://rolldown.rs/), um rechenintensive Aufgaben umzusetzen, hält den übrigen Code aber in JS, um Geschwindigkeit und Flexibilität auszubalancieren. Wo nötig, greifen Framework-Plugins auf [Babel](https://babeljs.io/) zurück, um Nutzercode zu kompilieren. Dank der Rollup-Plugin-Kompatibilität von Rolldown hat Vite Zugriff auf ein breites Ökosystem an Plugins.

## Frameworks auf Vite aufbauen

Auch wenn Vite direkt von Nutzern eingesetzt werden kann, spielt es seine Stärken als Werkzeug zum Bau von Frameworks aus. Der Vite-Kern ist framework-agnostisch, doch es gibt ausgefeilte Plugins für jedes UI-Framework. Die [JS-API](./api-javascript.md) erlaubt es Autoren von App-Frameworks, Vite-Funktionen zu nutzen, um maßgeschneiderte Erfahrungen für ihre Nutzer zu schaffen. Vite bringt Unterstützung für [SSR-Primitive](./ssr.md) mit, die üblicherweise in höherstufigen Werkzeugen zu finden, für den Bau moderner Web-Frameworks aber grundlegend sind. Vite-Plugins vervollständigen das Bild, indem sie eine Möglichkeit bieten, zwischen Frameworks zu teilen. Vite passt außerdem hervorragend zu [Backend-Frameworks](./backend-integration.md) wie [Ruby](https://vite-ruby.netlify.app/) und [Laravel](https://laravel.com/docs/vite).

## Ein aktives Ökosystem

Die Weiterentwicklung von Vite ist eine Zusammenarbeit zwischen den Maintainern von Frameworks und Plugins, den Nutzern und dem Vite-Team. Wir ermutigen zur aktiven Beteiligung an der Entwicklung des Vite-Kerns, sobald ein Projekt Vite einsetzt. Wir arbeiten eng mit den wichtigsten Projekten des Ökosystems zusammen, um Regressionen bei jedem Release zu minimieren, unterstützt von Werkzeugen wie [vite-ecosystem-ci](https://github.com/vitejs/vite-ecosystem-ci). Damit können wir die CI großer Projekte, die Vite verwenden, für ausgewählte PRs laufen lassen, und erhalten ein klares Bild davon, wie das Ökosystem auf ein Release reagieren würde. Wir bemühen uns, Regressionen zu beheben, bevor sie die Nutzer erreichen, und Projekten zu ermöglichen, unmittelbar nach dem Erscheinen auf die nächste Version zu aktualisieren. Wenn Sie mit Vite arbeiten, laden wir Sie ein, [Vites Discord](https://chat.vite.dev) beizutreten und sich ebenfalls im Projekt einzubringen.
