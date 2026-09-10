# Fastify-Styleguide

## Willkommen

Willkommen zum *Fastify-Styleguide*. Dieser Leitfaden vermittelt Ihnen einen
einheitlichen Schreibstil für alle, die Entwicklerdokumentation zu unserem
Open-Source-Framework verfassen. Jedes Thema ist präzise und gut erklärt, damit
Sie Dokumentation schreiben können, die Nutzer leicht verstehen und umsetzen.

## Für wen ist dieser Leitfaden gedacht?

Dieser Leitfaden richtet sich an alle, die gerne mit Fastify bauen oder zu
unserer Dokumentation beitragen möchten. Sie müssen kein Experte für technische
Dokumentation sein. Dieser Leitfaden ist da, um Ihnen zu helfen.

Besuchen Sie die Seite [contribute](https://fastify.dev/contribute/) auf unserer
Website oder lesen Sie die Datei
[CONTRIBUTING.md](https://github.com/fastify/fastify/blob/main/CONTRIBUTING.md)
auf GitHub, um sich unseren Open-Source-Leuten anzuschließen.

## Bevor Sie schreiben

Sie sollten sich mit Folgendem auskennen:

* JavaScript
* Node.js
* Git
* GitHub
* Markdown
* HTTP
* NPM

### Denken Sie an Ihre Zielgruppe

Denken Sie vor dem Schreiben an Ihre Zielgruppe. In diesem Fall sollte Ihre
Zielgruppe HTTP, JavaScript, NPM und Node.js bereits kennen. Es ist wichtig, die
Leser im Blick zu behalten, denn sie sind es, die Ihre Inhalte konsumieren. Sie
wollen so viele nützliche Informationen wie möglich vermitteln. Überlegen Sie,
welche zentralen Dinge sie wissen müssen und wie sie diese verstehen können.
Verwenden Sie Wörter und Bezüge, mit denen Leser sich leicht identifizieren
können. Bitten Sie die Community um Feedback; das kann Ihnen helfen, bessere
Dokumentation zu schreiben, die sich auf den Nutzer und Ihr Ziel konzentriert.

### Kommen Sie direkt zur Sache

Geben Sie Ihren Lesern eine klare und präzise Handlungsanweisung. Beginnen Sie
mit dem Wichtigsten. So helfen Sie ihnen, schneller zu finden, was sie brauchen.
Leser lesen meist den ersten Inhalt einer Seite, und viele scrollen nicht
weiter.

**Beispiel**

Weniger so: Doppelpunkte sind sehr wichtig, um einen parametrischen Pfad zu
registrieren. Sie teilen dem Framework mit, dass ein neuer Parameter erzeugt
wurde. Sie können den Doppelpunkt vor den Parameternamen setzen, damit der
parametrische Pfad erzeugt werden kann.

Eher so: Um einen parametrischen Pfad zu registrieren, setzen Sie einen
Doppelpunkt vor den Parameternamen. Der Doppelpunkt teilt dem Framework mit,
dass es sich um einen parametrischen und nicht um einen statischen Pfad handelt.

### Verzichten Sie auf Video- oder Bildinhalte


Fügen Sie der Dokumentation keine Videos oder Screenshots hinzu. So lässt sie
sich leichter unter Versionskontrolle halten. Videos und Bilder veralten
zwangsläufig, während neue Updates entstehen. Setzen Sie stattdessen einen
Verweislink oder ein YouTube-Video. Links fügen Sie im Markdown mit
`[Title](www.websitename.com)` ein.

**Beispiel**

```
To learn more about hooks, see [Fastify hooks](https://fastify.dev/docs/latest/Reference/Hooks/).
```

Ergebnis:
>To learn more about hooks, see [Fastify
>hooks](https://fastify.dev/docs/latest/Reference/Hooks/).



### Vermeiden Sie Plagiate

Achten Sie darauf, die Arbeit anderer nicht zu kopieren. Halten Sie sie so
originell wie möglich. Sie können von der Arbeit anderer lernen und die Quelle
angeben, wenn Sie ein bestimmtes Zitat daraus verwenden.


## Wortwahl

Es gibt einige Dinge, die Sie beim Schreiben Ihrer Dokumentation verwenden bzw.
vermeiden sollten, um die Lesbarkeit zu verbessern und die Dokumentation sauber,
direkt und aufgeräumt zu halten.


### Wann die zweite Person "Sie" als Pronomen zu verwenden ist

Beim Schreiben von Artikeln oder Leitfäden sollten Ihre Inhalte die Leser direkt
in der zweiten Person ("Sie") ansprechen. So lassen sich zu einem bestimmten
Thema leichter direkte Anweisungen geben. Ein Beispiel finden Sie im
[Plugin-Leitfaden](./Plugins-Guide.md).

**Beispiel**

Weniger so: Wir können die folgenden Plugins verwenden.

Eher so: Sie können die folgenden Plugins verwenden.

> Laut [Wikipedia](#) ist ***You*** üblicherweise ein Pronomen der zweiten
> Person. Es wird zudem verwendet, um auf eine unbestimmte Person zu verweisen,
> als gebräuchlichere Alternative zu einem sehr förmlichen Indefinitpronomen.

## Wann die zweite Person "Sie" als Pronomen zu vermeiden ist

Eine der Hauptregeln für förmliches Schreiben, etwa für Referenz- oder
API-Dokumentation, lautet, die zweite Person ("Sie") bzw. die direkte Ansprache
des Lesers zu vermeiden.

**Beispiel**

Weniger so: Sie können die folgende Empfehlung als Beispiel verwenden.

Eher so: Als Beispiel sollten die folgenden Empfehlungen herangezogen werden.

Ein konkretes Beispiel finden Sie im Referenzdokument
[Decorators](../Reference/Decorators.md).


### Vermeiden Sie Kurzformen

Kurzformen sind verkürzte Varianten geschriebener und gesprochener Wortformen,
also etwa "don't" statt "do not". Vermeiden Sie Kurzformen, um einen
förmlicheren Ton zu erzielen.

### Vermeiden Sie herablassende Begriffe

Zu den herablassenden Begriffen zählen:

* Nur
* Einfach
* Simpel
* Im Grunde
* Offensichtlich

Für den Leser mag es nicht einfach sein, das Framework und die Plugins von
Fastify zu verwenden; vermeiden Sie Wörter, die es simpel, einfach, beleidigend
oder unsensibel klingen lassen. Nicht alle, die die Dokumentation lesen, haben
denselben Wissensstand.


### Mit einem Verb beginnen

Beginnen Sie Ihre Beschreibung möglichst mit einem Verb, das macht sie für den
Leser einfach und präzise nachvollziehbar. Bevorzugen Sie das Präsens, weil es
leichter zu lesen und zu verstehen ist als Vergangenheit oder Zukunft.

**Beispiel**

 Weniger so: Es besteht die Notwendigkeit, dass Node.js installiert ist, bevor
 Sie in der Lage sind, Fastify zu verwenden.

 Eher so: Installieren Sie Node.js, um Fastify zu nutzen.

### Grammatische Modi

Grammatische Modi sind ein hervorragendes Mittel, um Ihren Text auszudrücken.
Vermeiden Sie es, bei einer direkten Aussage zu befehlend zu klingen. Wissen
Sie, wann Sie zwischen Indikativ, Imperativ und Konjunktiv wechseln sollten.


**Indikativ** – Verwenden Sie ihn für Tatsachenaussagen oder Fragen.

Beispiel: Da kein Testframework verfügbar ist, "empfiehlt Fastify Wege, Tests zu
schreiben".

**Imperativ** – Verwenden Sie ihn für Anweisungen, Handlungen, Befehle oder wenn
Sie Ihre Überschriften schreiben.

Beispiel: Installieren Sie die Abhängigkeiten, bevor Sie mit der Entwicklung
beginnen.


**Konjunktiv** – Verwenden Sie ihn für Vorschläge, Hypothesen oder Aussagen, die
keine Tatsachen sind.

Beispiel: Es empfiehlt sich, die Dokumentation auf unserer Website zu lesen, um
umfassendes Wissen über das Framework zu erlangen.

### Verwenden Sie das **Aktiv** statt des **Passivs**

Das Aktiv ist eine kompaktere und direktere Art, Ihre Dokumentation zu
vermitteln.

**Beispiel**


Passiv: Die Node-Abhängigkeiten und Pakete werden von npm installiert.

Aktiv:  npm installiert Pakete und Node-Abhängigkeiten.

## Schreibstil

### Titel von Dokumenten

Wenn Sie einen neuen Leitfaden, eine API- oder Referenzseite im Verzeichnis
`/docs/` anlegen, verwenden Sie kurze Titel, die das Thema Ihrer Dokumentation
am besten beschreiben. Benennen Sie Ihre Dateien in kebab-case und vermeiden Sie
Raw oder camelCase. Mehr zu kebab-case erfahren Sie in diesem Medium-Artikel zu
[Case
Styles](https://medium.com/better-programming/string-case-styles-camel-pascal-snake-and-kebab-case-981407998841).

**Beispiele**:

>`hook-and-plugins.md`,

 `adding-test-plugins.md`,

 `removing-requests.md`.

### Hyperlinks

Hyperlinks sollten einen klaren Titel dessen tragen, worauf sie verweisen. So
sollte Ihr Hyperlink aussehen:

```MD
<!-- More like this -->

// Add clear & brief description
[Fastify Plugins] (https://fastify.dev/docs/latest/Plugins/)

<!--Less like this -->

// incomplete description
[Fastify] (https://fastify.dev/docs/latest/Plugins/)

// Adding title in link brackets
[](https://fastify.dev/docs/latest/Plugins/ "fastify plugin")

// Empty title
[](https://fastify.dev/docs/latest/Plugins/)

// Adding links localhost URLs instead of using code strings (``)
[http://localhost:3000/](http://localhost:3000/)

```

Nehmen Sie so viele wesentliche Verweise wie möglich in Ihre Dokumentation auf,
vermeiden Sie aber zahlreiche Links, wenn Sie für Einsteiger schreiben, um
Ablenkungen zu verhindern.
