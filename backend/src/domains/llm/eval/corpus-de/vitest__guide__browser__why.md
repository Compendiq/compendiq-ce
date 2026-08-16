# Warum der Browser-Modus

## Motivation

Wir haben den Browser-Modus von Vitest entwickelt, um Test-Workflows zu verbessern und genauere sowie verlässlichere Testergebnisse zu erzielen. Diese Ergänzung unserer Test-API erlaubt es Entwicklerinnen und Entwicklern, Tests in einer nativen Browserumgebung auszuführen. In diesem Abschnitt betrachten wir die Beweggründe hinter dieser Funktion und ihre Vorteile für das Testen.

### Verschiedene Arten zu testen

Es gibt verschiedene Arten, JavaScript-Code zu testen. Einige Test-Frameworks simulieren Browserumgebungen in Node.js, während andere Tests in echten Browsern ausführen. In diesem Zusammenhang ist [jsdom](https://npmx.dev/package/jsdom) ein Beispiel für eine Spezifikationsimplementierung, die eine Browserumgebung simuliert und zusammen mit einem Test-Runner wie Jest oder Vitest eingesetzt wird, während andere Testwerkzeuge wie [WebdriverIO](https://webdriver.io/) oder [Cypress](https://www.cypress.io/) es erlauben, Anwendungen in einem echten Browser zu testen — beziehungsweise im Fall von [Playwright](https://playwright.dev/) eine Browser-Engine bereitstellen.

### Der Haken an der Simulation

Das Testen von JavaScript-Programmen in simulierten Umgebungen wie jsdom oder happy-dom hat das Test-Setup vereinfacht und eine leicht nutzbare API geliefert, wodurch sie für viele Projekte geeignet sind und das Vertrauen in Testergebnisse steigt. Es ist jedoch entscheidend, im Hinterkopf zu behalten, dass diese Werkzeuge lediglich eine Browserumgebung simulieren und keinen echten Browser darstellen, was zu Abweichungen zwischen der simulierten und der realen Umgebung führen kann. Daher können falsch positive oder falsch negative Testergebnisse auftreten.

Um das höchste Maß an Vertrauen in unsere Tests zu erreichen, ist es entscheidend, in einer echten Browserumgebung zu testen. Deshalb haben wir den Browser-Modus in Vitest entwickelt, der es erlaubt, Tests nativ in einem Browser auszuführen und genauere sowie verlässlichere Ergebnisse zu erhalten. Mit Tests auf Browser-Ebene können Entwicklerinnen und Entwickler sicherer sein, dass ihre Anwendung im realen Einsatz wie beabsichtigt funktioniert.

## Nachteile

Beim Einsatz von Vitest im Browser sind die folgenden Nachteile zu bedenken:

### Kein vollwertiger Ersatz

Der Browser-Modus von Vitest ersetzt eigenständige End-to-End-Test-Runner nicht vollständig. Es wird empfohlen, das Vitest-Browser-Erlebnis um einen eigenständigen browserseitigen Test-Runner wie WebdriverIO, Cypress oder Playwright zu ergänzen.

### Längere Initialisierung

Vitest im Browser erfordert, dass während der Initialisierung der Provider und der Browser hochgefahren werden, was einige Zeit in Anspruch nehmen kann. Das kann im Vergleich zu anderen Testmustern zu längeren Initialisierungszeiten führen.
