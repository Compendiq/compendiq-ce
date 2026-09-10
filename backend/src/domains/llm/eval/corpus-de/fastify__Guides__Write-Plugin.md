<h1 style="text-align: center;">Fastify</h1>

# Wie man ein gutes Plugin schreibt
Zunächst einmal vielen Dank, dass Sie sich entschieden haben, ein Plugin für
Fastify zu schreiben. Fastify ist ein minimalistisches Framework und Plugins sind
seine Stärke – also nochmals danke.

Die Grundprinzipien von Fastify sind Performance, geringer Overhead und ein gutes
Erlebnis für unsere Anwender. Beim Schreiben eines Plugins ist es wichtig, diese
Prinzipien im Hinterkopf zu behalten. Deshalb analysieren wir in diesem Dokument,
was ein hochwertiges Plugin auszeichnet.

*Brauchen Sie Inspiration? Sie können in unserem Issue-Tracker das Label ["plugin
suggestion"](https://github.com/fastify/fastify/issues?q=is%3Aissue+is%3Aopen+label%3A%22plugin+suggestion%22)
verwenden!*

## Code
Fastify nutzt verschiedene Techniken, um seinen Code zu optimieren; viele davon
sind in unseren Guides dokumentiert. Wir empfehlen Ihnen dringend, [den Anhalter-
Guide zu Plugins](./Plugins-Guide.md) zu lesen, um alle APIs zu entdecken, die
Sie zum Bau Ihres Plugins verwenden können, und zu lernen, wie man sie einsetzt.

Haben Sie eine Frage oder brauchen Sie einen Rat? Wir helfen Ihnen sehr gerne!
Öffnen Sie einfach ein Issue in unserem [Hilfe-Repository](https://github.com/fastify/help).

Sobald Sie ein Plugin für unsere [Ökosystem-Liste](./Ecosystem.md) einreichen,
prüfen wir Ihren Code und helfen Ihnen bei Bedarf, ihn zu verbessern.

## Dokumentation
Dokumentation ist außerordentlich wichtig. Wenn Ihr Plugin nicht gut dokumentiert
ist, nehmen wir es nicht in die Ökosystem-Liste auf. Fehlende hochwertige
Dokumentation erschwert es Anwendern, Ihr Plugin zu nutzen, und führt
wahrscheinlich dazu, dass es ungenutzt bleibt.

Wenn Sie gute Beispiele dafür sehen möchten, wie man ein Plugin dokumentiert,
werfen Sie einen Blick auf:
- [`@fastify/caching`](https://github.com/fastify/fastify-caching)
- [`@fastify/compress`](https://github.com/fastify/fastify-compress)
- [`@fastify/cookie`](https://github.com/fastify/fastify-cookie)
- [`@fastify/under-pressure`](https://github.com/fastify/under-pressure)
- [`@fastify/view`](https://github.com/fastify/point-of-view)

## Lizenz
Sie können Ihr Plugin lizenzieren, wie Sie möchten; wir schreiben keinerlei
Lizenz vor.

Wir bevorzugen die [MIT-Lizenz](https://choosealicense.com/licenses/mit/), weil
wir denken, dass sie es mehr Menschen erlaubt, den Code frei zu verwenden. Eine
Liste alternativer Lizenzen finden Sie in der [OSI-Liste](https://opensource.org/licenses)
oder auf GitHubs [choosealicense.com](https://choosealicense.com/).

## Beispiele
Legen Sie immer eine Beispieldatei in Ihr Repository. Beispiele sind für Anwender
sehr hilfreich und bieten eine sehr schnelle Möglichkeit, Ihr Plugin
auszuprobieren. Ihre Anwender werden es Ihnen danken.

## Tests
Ein Plugin **muss** gründlich getestet werden, um sicherzustellen, dass es
korrekt funktioniert.

Ein Plugin ohne Tests wird nicht in die Ökosystem-Liste aufgenommen. Fehlende
Tests schaffen kein Vertrauen und garantieren auch nicht, dass der Code über
verschiedene Versionen seiner Abhängigkeiten hinweg weiter funktioniert.

Wir schreiben keine Testbibliothek vor. Wir verwenden [`node:test`](https://nodejs.org/api/test.html),
da es paralleles Testen und Code Coverage von Haus aus bietet, aber die Wahl
Ihrer bevorzugten Bibliothek liegt bei Ihnen.
Wir empfehlen Ihnen dringend, [Plugin Testing](./Testing.md#plugins) zu lesen, um
zu erfahren, wie Sie Ihre Plugins testen.

## Code-Linter
Es ist nicht verpflichtend, aber wir empfehlen Ihnen dringend, in Ihrem Plugin
einen Code-Linter zu verwenden. Er sorgt für einen einheitlichen Codestil und
hilft Ihnen, viele Fehler zu vermeiden.

Wir verwenden [`standard`](https://standardjs.com/), da es ohne Konfiguration
funktioniert und sich sehr leicht in eine Test-Suite integrieren lässt.

## Continuous Integration
Es ist nicht verpflichtend, aber wenn Sie Ihren Code als Open Source
veröffentlichen, hilft es, Continuous Integration einzusetzen, um
sicherzustellen, dass Beiträge Ihr Plugin nicht kaputt machen, und um zu zeigen,
dass das Plugin wie beabsichtigt funktioniert. Sowohl
[CircleCI](https://circleci.com/) als auch [GitHub
Actions](https://github.com/features/actions) sind für Open-Source-Projekte
kostenlos und leicht einzurichten.

Darüber hinaus können Sie Dienste wie [Dependabot](https://github.com/dependabot)
aktivieren, die Ihnen helfen, Ihre Abhängigkeiten aktuell zu halten und zu
erkennen, ob ein neues Release von Fastify Probleme mit Ihrem Plugin verursacht.

## Los geht's!
Großartig, jetzt wissen Sie alles, was Sie darüber wissen müssen, wie man ein
gutes Plugin für Fastify schreibt! Wenn Sie eines (oder mehrere!) gebaut haben,
lassen Sie es uns wissen! Wir fügen es dem Abschnitt
[Ökosystem](https://github.com/fastify/fastify#ecosystem) unserer Dokumentation
hinzu!

Wenn Sie einige Beispiele aus der Praxis sehen möchten, schauen Sie sich das an:
- [`@fastify/view`](https://github.com/fastify/point-of-view) Plugin-Unterstützung
  für Template-Rendering (*ejs, pug, handlebars, marko*) in Fastify.
- [`@fastify/mongodb`](https://github.com/fastify/fastify-mongodb) Fastify-Plugin
  für MongoDB-Verbindungen; damit können Sie denselben MongoDB-Connection-Pool in
  jedem Teil Ihres Servers verwenden.
- [`@fastify/multipart`](https://github.com/fastify/fastify-multipart)
  Multipart-Unterstützung für Fastify.
- [`@fastify/helmet`](https://github.com/fastify/fastify-helmet) Wichtige
  Security-Header für Fastify.
