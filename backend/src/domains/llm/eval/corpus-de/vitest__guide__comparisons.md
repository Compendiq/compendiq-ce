# Vergleiche mit anderen Test-Runnern

## Jest

[Jest](https://jestjs.io/) hat den Bereich der Testing-Frameworks erobert, indem es für die meisten JavaScript-Projekte Unterstützung out of the box, eine angenehme API (`it` und `expect`) und das komplette Paket an Testfunktionen bot, das die meisten Setups benötigen (Snapshots, Mocks, Coverage). Wir sind dem Jest-Team und der Community dankbar dafür, eine herrliche Testing-API geschaffen und viele der Testmuster vorangetrieben zu haben, die heute im Web-Ökosystem Standard sind.

Es ist möglich, Jest in Vite-Setups zu verwenden. [@sodatea](https://bsky.app/profile/haoqun.dev) hat [vite-jest](https://github.com/sodatea/vite-jest#readme) gebaut, das eine erstklassige Vite-Integration für [Jest](https://jestjs.io/) bieten will. Die letzten [Blocker in Jest](https://github.com/sodatea/vite-jest/blob/main/packages/vite-jest/README.md#vite-jest) sind gelöst, sodass dies eine valide Option für Ihre Unit-Tests ist.

In einer Welt, in der [Vite](https://vitejs.dev) jedoch Unterstützung für das gängigste Web-Tooling bietet (TypeScript, JSX, die populärsten UI-Frameworks), stellt Jest eine Verdopplung der Komplexität dar. Wenn Ihre App von Vite angetrieben wird, sind zwei verschiedene Pipelines zum Konfigurieren und Pflegen nicht zu rechtfertigen. Mit Vitest definieren Sie die Konfiguration für Ihre Entwicklungs-, Build- und Testumgebungen als eine einzige Pipeline, die dieselben Plugins und dieselbe vite.config.js nutzt.

Selbst wenn Ihre Bibliothek Vite nicht verwendet (etwa wenn sie mit esbuild oder Rollup gebaut wird), ist Vitest eine interessante Option, da es Ihnen einen schnelleren Lauf Ihrer Unit-Tests und dank des standardmäßigen Watch-Modus mit Vites sofortigem Hot Module Reload (HMR) einen Sprung in der DX beschert. Vitest ist mit dem größten Teil der Jest-API und deren Ökosystem-Bibliotheken kompatibel, sodass es in den meisten Projekten ein direkter Ersatz für Jest sein sollte.

## Cypress

[Cypress](https://www.cypress.io/) ist ein browserbasierter Test-Runner und ein ergänzendes Werkzeug zu Vitest. Wenn Sie Cypress verwenden möchten, empfehlen wir Vitest für die gesamte headless-Logik Ihrer Anwendung und Cypress für die gesamte browserbasierte Logik.

Cypress ist als End-to-End-Testwerkzeug bekannt, aber sein [neuer Component-Test-Runner](https://on.cypress.io/component) unterstützt das Testen von Vite-Komponenten hervorragend und ist eine ideale Wahl, um alles zu testen, was in einem Browser gerendert wird.

Browserbasierte Runner wie Cypress, WebdriverIO und Web Test Runner finden Probleme, die Vitest nicht finden kann, weil sie den echten Browser und echte Browser-APIs verwenden.

Der Test-Treiber von Cypress ist darauf ausgerichtet, festzustellen, ob Elemente sichtbar, zugänglich und interaktiv sind. Cypress ist eigens für UI-Entwicklung und -Tests gebaut, und seine DX dreht sich darum, Ihre visuellen Komponenten testgetrieben zu entwickeln. Sie sehen Ihre Komponente neben dem Test-Reporter gerendert. Nach Abschluss des Tests bleibt die Komponente interaktiv, und Sie können auftretende Fehlschläge mit den Browser-Devtools debuggen.

Vitest hingegen konzentriert sich darauf, die bestmögliche DX für blitzschnelles, *headless* Testen zu liefern. Node-basierte Runner wie Vitest unterstützen verschiedene teilweise implementierte Browser-Umgebungen wie `jsdom`, die genug implementieren, damit Sie jeden Code, der Browser-APIs referenziert, schnell im Unit-Test prüfen können. Der Kompromiss ist, dass diese Browser-Umgebungen Grenzen haben, was sie implementieren können. Zum Beispiel [fehlen jsdom eine Reihe von Funktionen](https://github.com/jsdom/jsdom/issues?q=is%3Aissue+is%3Aopen+sort%3Acomments-desc) wie `window.navigation` oder eine Layout-Engine (`offsetTop` usw.).

Schließlich ist der Cypress-Test-Runner im Gegensatz zum Web Test Runner eher eine IDE als ein Test-Runner, weil Sie zusätzlich die tatsächlich gerenderte Komponente im Browser sehen, samt Testergebnissen und Logs.

Cypress hat außerdem [Vite in seine Produkte integriert](https://www.youtube.com/watch?v=7S5cbY8iYLk): Die UI der App wurde mit [Vitesse](https://github.com/antfu/vitesse) neu gebaut, und Vite wird für die testgetriebene Entwicklung des Projekts eingesetzt.

Wir sind der Meinung, dass Cypress keine gute Option für Unit-Tests von headless Code ist, dass aber die Kombination aus Cypress (für E2E- und Komponententests) und Vitest (für Unit-Tests) den Testbedarf Ihrer App abdeckt.

## WebdriverIO

[WebdriverIO](https://webdriver.io/) ist, ähnlich wie Cypress, ein browserbasierter alternativer Test-Runner und ein ergänzendes Werkzeug zu Vitest. Es kann als End-to-End-Testwerkzeug sowie zum Testen von [Web Components](https://webdriver.io/docs/component-testing) eingesetzt werden. Es nutzt sogar Bestandteile von Vitest unter der Haube, etwa für [Mocking und Stubbing](https://webdriver.io/docs/mocksandspies/) in Komponententests.

WebdriverIO bringt dieselben Vorteile wie Cypress mit und erlaubt es Ihnen, Ihre Logik im echten Browser zu testen. Allerdings nutzt es für die Automatisierung tatsächliche [Web-Standards](https://w3c.github.io/webdriver/), was einige der Kompromisse und Einschränkungen beim Ausführen von Tests in Cypress überwindet. Darüber hinaus erlaubt es Ihnen, Tests auch auf Mobilgeräten auszuführen, sodass Sie Ihre Anwendung in noch mehr Umgebungen testen können.

## Web Test Runner

[@web/test-runner](https://modern-web.dev/docs/test-runner/overview/) führt Tests in einem Headless-Browser aus und bietet damit dieselbe Ausführungsumgebung wie Ihre Webanwendung, ohne dass Browser-APIs oder das DOM gemockt werden müssen. Das macht es außerdem möglich, in einem echten Browser mit den Devtools zu debuggen – allerdings wird keine Oberfläche zum schrittweisen Durchlaufen des Tests angezeigt, wie es bei Cypress-Tests der Fall ist.

Um @web/test-runner mit einem Vite-Projekt zu verwenden, nutzen Sie [@remcovaes/web-test-runner-vite-plugin](https://github.com/remcovaes/web-test-runner-vite-plugin). @web/test-runner enthält keine Assertion- oder Mocking-Bibliotheken, deren Ergänzung liegt also bei Ihnen.

## uvu

[uvu](https://github.com/lukeed/uvu) ist ein Test-Runner für Node.js und den Browser. Es führt Tests in einem einzigen Thread aus, sodass Tests nicht isoliert sind und über Dateien hinweg durchsickern können. Vitest hingegen verwendet Worker-Threads, um Tests zu isolieren und parallel auszuführen.

Zum Transformieren Ihres Codes setzt uvu auf require- und Loader-Hooks. Vitest verwendet [Vite](https://vitejs.dev), sodass Dateien mit der vollen Mächtigkeit von Vites Plugin-System transformiert werden. In einer Welt, in der Vite Unterstützung für das gängigste Web-Tooling bietet (TypeScript, JSX, die populärsten UI-Frameworks), stellt uvu eine Verdopplung der Komplexität dar. Wenn Ihre App von Vite angetrieben wird, sind zwei verschiedene Pipelines zum Konfigurieren und Pflegen nicht zu rechtfertigen. Mit Vitest definieren Sie die Konfiguration für Ihre Entwicklungs-, Build- und Testumgebungen als eine einzige Pipeline, die dieselben Plugins und dieselbe Konfiguration nutzt.

uvu bietet keinen intelligenten Watch-Modus, der die geänderten Tests erneut ausführt, während Vitest Ihnen dank des standardmäßigen Watch-Modus mit Vites sofortigem Hot Module Reload (HMR) eine großartige DX bietet.

uvu ist eine schnelle Option zum Ausführen einfacher Tests, aber Vitest kann bei komplexeren Tests und Projekten schneller und zuverlässiger sein.

## Mocha

[Mocha](https://mochajs.org) ist ein Test-Framework, das unter Node.js und im Browser läuft. Mocha ist eine beliebte Wahl für serverseitiges Testen. Mocha ist hochgradig konfigurierbar und bringt bestimmte Funktionen standardmäßig nicht mit. Zum Beispiel liefert es keine Assertion-Bibliothek mit – die Idee dahinter ist, dass Nodes eingebauter Assertion-Runner für die meisten Anwendungsfälle gut genug ist. Eine weitere beliebte Wahl für Assertions mit Mocha ist [Chai](https://www.chaijs.com).

Vitest bietet außerdem für einige weitere Funktionen ein Setup out of the box, das in Mocha zusätzliche Konfiguration oder das Hinzufügen weiterer Bibliotheken erfordert, zum Beispiel:

- Snapshot-Testing
- TypeScript
- JSX-Unterstützung
- Code Coverage
- Mocking
- Intelligenter Watch-Modus (führt nur betroffene Tests erneut aus)

Mocha unterstützt zwar natives ESM, hat dabei aber Einschränkungen und Konfigurationsvorgaben. Der Watch-Modus funktioniert zum Beispiel nicht mit ES-Modul-Dateien.

Performance-seitig führt Mocha Tests standardmäßig seriell aus, unterstützt aber parallele Ausführung mit dem Flag `--parallel` (wobei einige Reporter und Funktionen im Parallelmodus nicht funktionieren).

Wenn Sie Vite bereits in Ihrer Build-Pipeline verwenden, erlaubt Vitest Ihnen, dieselbe Konfiguration und dieselben Plugins auch zum Testen wiederzuverwenden, während Mocha ein separates Test-Setup erfordern würde. Vitest bietet eine Jest-kompatible API und unterstützt zugleich Mochas vertraute Syntax mit `describe`, `it` und Hooks, was die Migration für die meisten Test-Suites unkompliziert macht.

Mocha bleibt eine solide Wahl für Projekte, die einen minimalen, flexiblen Test-Runner mit vollständiger Kontrolle über ihren Test-Stack benötigen. Wenn Sie jedoch ein modernes Testerlebnis wollen, bei dem alles out of the box enthalten ist – besonders für Vite-basierte Anwendungen –, ist Vitest die richtige Wahl.

## Playwright

[Playwright](https://playwright.dev) ist ein Test-Framework von Microsoft, das sich beim End-to-End-Testen über mehrere Browser hinweg (Chromium, Firefox und WebKit) auszeichnet. Es steuert echte Browser, um vollständige Nutzer-Workflows zu testen – vom Anmelden und Navigieren in Ihrer App bis hin zum Absenden von Formularen und Überprüfen der Ergebnisse. Vitest hingegen ist auf schnelle, isolierte Unit- und Komponententests in einer Headless-Umgebung optimiert. Diese Unterschiede machen es zu einer idealen Ergänzung von Vitest.

Ein übliches Setup verwendet Vitest für alle Unit- und Komponententests (Geschäftslogik, Utilities, Hooks und Tests von UI-Komponenten) und Playwright für End-to-End-Tests, die kritische Nutzerpfade und die browserübergreifende Kompatibilität überprüfen. Diese Kombination gibt Ihnen mit Vitest schnelles Feedback während der Entwicklung und stellt mit Playwright sicher, dass Ihre vollständige Anwendung in echten Browsern korrekt funktioniert.

Vitest hat kürzlich den [Browser-Modus](https://vitest.dev/guide/browser) eingeführt, der Tests in echten Browsern ausführt. Es gibt jedoch grundlegende architektonische Unterschiede: Playwrights Komponententests laufen in einem Node.js-Prozess und steuern den Browser fern. Vitests Browser-Modus führt Tests nativ im Browser aus und bleibt damit konsistent mit Vitests Test-Runner und Entwicklererfahrung, hat aber einige [Einschränkungen](https://vitest.dev/guide/browser/#limitations).
