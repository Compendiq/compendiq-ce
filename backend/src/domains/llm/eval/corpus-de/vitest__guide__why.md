# Warum Vitest

:::tip HINWEIS
Vitest baut auf Vite auf. Sie müssen Vite nicht kennen, um Vitest zu verwenden, aber ein Verständnis von Vite hilft, einige der besonderen Vorteile von Vitest zu erklären. Um mehr über Vite zu erfahren, lesen Sie den [Why Vite Guide](https://vitejs.dev/guide/why.html) oder sehen Sie sich [Next generation frontend tooling with ViteJS](https://www.youtube.com/watch?v=UJypSr8IhKY) von [Evan You](https://bsky.app/profile/evanyou.me) an.
:::

## Der Bedarf an einem Vite-nativen Test-Runner

Vites sofort einsatzbereite Unterstützung für gängige Web-Muster, Features wie Glob-Importe und SSR-Primitive sowie seine vielen Plugins und Integrationen fördern ein lebendiges Ökosystem. Seine Stärken bei Dev und Build sind entscheidend für seinen Erfolg. Für Dokumentation gibt es mehrere SSG-basierte Alternativen auf Vite-Basis. Bei Unit-Tests war Vites Ansatz jedoch nie klar. Bestehende Optionen wie [Jest](https://jestjs.io/) wurden in einem anderen Kontext geschaffen. Zwischen Jest und Vite gibt es viele Doppelungen, die Nutzer dazu zwingen, zwei unterschiedliche Pipelines zu konfigurieren.

Der Vite-Dev-Server, der Ihre Dateien während des Testens transformiert, ermöglicht einen einfachen Runner, der sich nicht mit der Komplexität der Transformation von Quelldateien befassen muss und sich ganz darauf konzentrieren kann, die beste DX beim Testen zu bieten. Es ist ein Test-Runner, der dieselbe Konfiguration wie Ihre App verwendet (über `vite.config.js`) und sich eine gemeinsame Transformations-Pipeline für Dev, Build und Test teilt. Er ist mit derselben Plugin-API erweiterbar, mit der Sie und die Maintainer Ihrer Werkzeuge eine erstklassige Integration mit Vite bereitstellen können. Es ist ein Werkzeug, das von Anfang an mit Blick auf Vite gebaut wurde und dessen DX-Verbesserungen nutzt, etwa das sofortige Hot Module Replacement (HMR). Das ist Vitest, ein Testing-Framework der nächsten Generation auf Basis von Vite.

Angesichts der enormen Verbreitung von Jest bietet Vitest eine kompatible API, mit der Sie es in den meisten Projekten als direkten Ersatz einsetzen können. Es enthält außerdem die gängigsten Features, die man beim Aufsetzen von Unit-Tests braucht (Mocking, Snapshots, Coverage). Vitest legt großen Wert auf Performance und nutzt Worker-Threads, um so viel wie möglich parallel auszuführen. Bei einigen Portierungen liefen die Tests um eine Größenordnung schneller. Der Watch-Modus ist standardmäßig aktiviert, passend dazu, wie Vite eine Dev-First-Erfahrung vorantreibt. Trotz all dieser DX-Verbesserungen bleibt Vitest schlank, indem es seine Abhängigkeiten sorgfältig auswählt (oder benötigte Teile direkt inlined).

**Vitest möchte sich als Test-Runner der Wahl für Vite-Projekte positionieren – und als solide Alternative auch für Projekte, die Vite nicht verwenden.**

Lesen Sie weiter im [Getting Started Guide](./index)

## Wie unterscheidet sich Vitest von X?

Im Abschnitt [Comparisons](./comparisons) finden Sie mehr Details dazu, wie sich Vitest von anderen ähnlichen Werkzeugen unterscheidet.
