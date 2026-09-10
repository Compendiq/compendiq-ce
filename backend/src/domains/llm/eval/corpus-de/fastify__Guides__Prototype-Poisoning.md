> Der folgende Text ist ein Artikel von Eran Hammer.
> Er wird hier für die Nachwelt [mit Genehmigung](https://github.com/fastify/fastify/issues/1426#issuecomment-817957913) wiedergegeben.
> Er wurde vom ursprünglichen HTML-Quelltext nach Markdown umformatiert,
> ist ansonsten aber unverändert. Das ursprüngliche HTML kann über den
> oben verlinkten Genehmigungshinweis abgerufen werden.

## Die Geschichte hinter Prototype Poisoning
<a id="pp"></a>

Laut dem Artikel von Eran Hammer entsteht das Problem durch einen
Web-Sicherheitsfehler. Es ist zugleich eine perfekte Illustration des Aufwands,
der für die Pflege von Open-Source-Software nötig ist, und der Grenzen
bestehender Kommunikationskanäle.

Zunächst aber: Wenn wir ein JavaScript-Framework verwenden, um eingehende
JSON-Daten zu verarbeiten, sollten wir uns einen Moment Zeit nehmen, um uns
allgemein über [Prototype Poisoning](https://medium.com/intrinsic/javascript-prototype-poisoning-vulnerabilities-in-the-wild-7bc15347c96)
und über die konkreten
[technischen Details](https://github.com/hapijs/hapi/issues/3916) dieses Problems
zu informieren. Das könnte ein kritisches Problem sein, deshalb sollten wir
zuerst den eigenen Code prüfen. Der Text konzentriert sich auf ein bestimmtes
Framework, aber jede Lösung, die `JSON.parse()` zur Verarbeitung externer Daten
verwendet, ist potenziell gefährdet.

### BOOM
<a id="pp-boom"></a>

Das Engineering-Team von Lob (langjährige großzügige Unterstützer meiner Arbeit!)
meldete eine kritische Sicherheitslücke, die es in unserem
Datenvalidierungsmodul — [joi](https://github.com/hapijs/joi) — entdeckt hatte.
Sie lieferten einige technische Details und einen Lösungsvorschlag.

Der Hauptzweck einer Datenvalidierungsbibliothek besteht darin sicherzustellen,
dass die Ausgabe vollständig den definierten Regeln entspricht. Tut sie das
nicht, schlägt die Validierung fehl. Geht sie durch, können wir blind darauf
vertrauen, dass die Daten, mit denen wir arbeiten, sicher sind. Tatsächlich
behandeln die meisten Entwickler validierte Eingaben aus Sicht der
Systemintegrität als vollkommen sicher — was entscheidend ist!

In unserem Fall lieferte das Lob-Team ein Beispiel, in dem bestimmte Daten der
Validierungslogik entkommen konnten und unentdeckt durchgingen. Das ist der
schlimmstmögliche Defekt, den eine Validierungsbibliothek haben kann.

### Prototypen in Kürze
<a id="pp-nutshell"></a>

Um das zu verstehen, müssen wir ein wenig verstehen, wie JavaScript funktioniert.
Jedes Objekt in JavaScript kann einen Prototyp haben. Das ist eine Menge von
Methoden und Eigenschaften, die es von einem anderen Objekt "erbt". Ich habe
"erbt" in Anführungszeichen gesetzt, weil JavaScript keine wirklich
objektorientierte Sprache ist. Es ist eine prototypbasierte objektorientierte
Sprache.

Vor langer Zeit entschied jemand aus einer Reihe hier irrelevanter Gründe, dass
es eine gute Idee sei, den speziellen Eigenschaftsnamen `__proto__` zu verwenden,
um auf den Prototyp eines Objekts zuzugreifen (und ihn zu setzen). Das gilt
inzwischen als veraltet, wird aber dennoch vollständig unterstützt.

Zur Veranschaulichung:

```
> const a = { b: 5 };
> a.b;
5
> a.__proto__ = { c: 6 };
> a.c;
6
> a;
{ b: 5 }
```

Das Objekt hat keine Eigenschaft `c`, aber sein Prototyp hat sie.
Bei der Validierung des Objekts ignoriert die Validierungsbibliothek den
Prototyp und validiert nur die eigenen Eigenschaften des Objekts. Dadurch kann
sich `c` über den Prototyp einschleichen.

Ein weiterer wichtiger Teil ist die Art, wie `JSON.parse()` — ein von der Sprache
bereitgestelltes Hilfsmittel zur Umwandlung von JSON-formatiertem Text in
Objekte — mit diesem magischen Eigenschaftsnamen `__proto__` umgeht.

```
> const text = '{"b": 5, "__proto__": { "c": 6 }}';
> const a = JSON.parse(text);
> a;
{b: 5, __proto__: { c: 6 }}
```
Beachte, dass `a` eine Eigenschaft `__proto__` hat. Das ist keine
Prototyp-Referenz. Es ist ein schlichter Objekt-Eigenschaftsschlüssel, genau wie
`b`. Wie wir am ersten Beispiel gesehen haben, können wir diesen Schlüssel nicht
tatsächlich per Zuweisung erzeugen, da dies die Prototyp-Magie auslöst und einen
echten Prototyp setzt. `JSON.parse()` hingegen setzt eine einfache Eigenschaft
mit diesem giftigen Namen.

Für sich genommen ist das von `JSON.parse()` erzeugte Objekt vollkommen sicher.
Es hat keinen eigenen Prototyp. Es hat eine scheinbar harmlose Eigenschaft, die
sich lediglich zufällig mit einem eingebauten magischen JavaScript-Namen
überschneidet.

Andere Methoden haben jedoch nicht so viel Glück:

```
> const x = Object.assign({}, a);
> x;
{ b: 5}
> x.c;
6;
```

Wenn wir das zuvor von `JSON.parse()` erzeugte Objekt `a` nehmen und es an die
hilfreiche Methode `Object.assign()` übergeben (die eine flache Kopie aller
Eigenschaften der obersten Ebene von `a` in das übergebene leere Objekt `{}`
erstellt), "leckt" die magische Eigenschaft `__proto__` heraus und wird zum
tatsächlichen Prototyp von `x`.

Überraschung!

Wenn du externen Texteingaben bekommst, sie mit `JSON.parse()` parst, dann eine
einfache Manipulation dieses Objekts vornimmst (z. B. flach klonst und eine `id`
hinzufügst) und es an unsere Validierungsbibliothek übergibst, schleicht es sich
über `__proto__` unentdeckt hindurch.

### Oh joi!
<a id="pp-oh-joi"></a>

Die erste Frage lautet natürlich: Warum ignoriert das Validierungsmodul **joi**
den Prototyp und lässt potenziell schädliche Daten durch? Wir haben uns dieselbe
Frage gestellt, und unser erster Gedanke war "das war ein Versehen". Ein Bug —
ein wirklich großer Fehler. Das joi-Modul hätte das nicht zulassen dürfen. Aber …

Während joi in erster Linie zur Validierung von Web-Eingabedaten verwendet wird,
gibt es auch eine beträchtliche Nutzerbasis, die es zur Validierung interner
Objekte einsetzt, von denen einige Prototypen haben. Dass joi den Prototyp
ignoriert, ist ein hilfreiches "Feature". Es erlaubt, die eigenen Eigenschaften
des Objekts zu validieren und dabei eine möglicherweise sehr komplizierte
Prototyp-Struktur (mit vielen Methoden und literalen Eigenschaften) zu ignorieren.

Jede Lösung auf joi-Ebene würde bedeuten, aktuell funktionierenden Code zu
brechen.

### Das Richtige tun
<a id="pp-right-thing"></a>

An diesem Punkt blickten wir auf eine verheerend schlimme Sicherheitslücke.
Ganz oben angesiedelt in den höchsten Rängen epischer Sicherheitsversagen. Alles,
was wir wussten, war, dass unsere äußerst beliebte Datenvalidierungsbibliothek
schädliche Daten nicht blockiert und dass es trivial ist, diese Daten
durchzuschmuggeln. Man muss nur `__proto__` und etwas Mist zu einer JSON-Eingabe
hinzufügen und sie an eine mit unseren Werkzeugen gebaute Anwendung schicken.

(Dramatische Pause)

Wir wussten, dass wir joi reparieren mussten, um das zu verhindern, aber
angesichts des Ausmaßes dieses Problems mussten wir es so tun, dass ein Fix
veröffentlicht wird, ohne allzu viel Aufmerksamkeit darauf zu lenken — ohne die
Ausnutzung zu leicht zu machen — zumindest für ein paar Tage, bis die meisten
Systeme das Update erhalten hatten.

Einen Fix einzuschmuggeln ist nicht das Schwerste auf der Welt. Kombiniert man
ihn mit einem ansonsten zwecklosen Refactoring des Codes und wirft ein paar
unzusammenhängende Bugfixes und vielleicht ein cooles neues Feature hinein, kann
man eine neue Version veröffentlichen, ohne die Aufmerksamkeit auf das
eigentliche behobene Problem zu lenken.

Das Problem war: Der richtige Fix hätte gültige Anwendungsfälle gebrochen. joi
kann nämlich nicht wissen, ob du willst, dass es den von dir gesetzten Prototyp
ignoriert, oder ob es den von einem Angreifer gesetzten Prototyp blockieren soll.
Eine Lösung, die den Exploit behebt, bricht Code — und gebrochener Code zieht
gewöhnlich viel Aufmerksamkeit auf sich.

Veröffentlichten wir andererseits einen ordentlichen ([semantisch
versionierten](https://semver.org/)) Fix, kennzeichneten ihn als Breaking Change
und fügten eine neue API hinzu, mit der man joi explizit mitteilt, was es mit dem
Prototyp tun soll, dann würden wir der Welt zeigen, wie man diese Schwachstelle
ausnutzt, und es zugleich zeitaufwendiger machen, Systeme zu aktualisieren
(Breaking Changes werden von Build-Werkzeugen nie automatisch übernommen).


### Ein Umweg
<a id="pp-detour"></a>

Da es beim vorliegenden Problem um eingehende Request-Payloads ging, mussten wir
innehalten und prüfen, ob es auch Daten betreffen könnte, die über den Query
String, Cookies und Header hereinkommen. Im Grunde alles, was aus Text zu
Objekten serialisiert wird.

Wir konnten schnell bestätigen, dass Nodes Standard-Query-String-Parser ebenso in
Ordnung war wie sein Header-Parser. Ich identifizierte ein potenzielles Problem
mit base64-kodierten JSON-Cookies sowie mit der Verwendung eigener
Query-String-Parser. Wir schrieben außerdem einige Tests, um zu bestätigen, dass
der populärste Drittanbieter-Query-String-Parser —
[qs](https://www.npmjs.com/package/qs) — nicht verwundbar war (er ist es nicht!).

### Eine Entwicklung
<a id="pp-a-development"></a>

Während dieser gesamten Triage gingen wir schlicht davon aus, dass die
problematische Eingabe mit ihrem vergifteten Prototyp aus hapi zu joi kam, dem
Web-Framework, das das hapi.js-Ökosystem verbindet. Weitere Untersuchungen des
Lob-Teams ergaben, dass das Problem etwas differenzierter war.

hapi verwendete `JSON.parse()`, um eingehende Daten zu verarbeiten. Es setzte das
Ergebnisobjekt zunächst als `payload`-Eigenschaft des eingehenden Requests und
übergab dann dasselbe Objekt zur Validierung an joi, bevor es zur Verarbeitung an
die Geschäftslogik der Anwendung weitergereicht wurde. Da `JSON.parse()` die
Eigenschaft `__proto__` nicht tatsächlich leckt, käme es mit einem ungültigen
Schlüssel bei joi an und würde die Validierung nicht bestehen.

hapi bietet jedoch zwei Erweiterungspunkte, an denen die Payload-Daten vor der
Validierung inspiziert (und verarbeitet) werden können. Das ist alles ordentlich
dokumentiert und den meisten Entwicklern gut bekannt. Die Erweiterungspunkte
existieren, damit du aus legitimen (und oft sicherheitsbezogenen) Gründen vor der
Validierung mit den Rohdaten interagieren kannst.

Wenn ein Entwickler an einem dieser beiden Erweiterungspunkte `Object.assign()`
oder eine ähnliche Methode auf die Payload anwendete, leckte die Eigenschaft
`__proto__` heraus und wurde zu einem tatsächlichen Prototyp.

### Ein Aufatmen
<a id="pp-sigh-of-relief"></a>

Wir hatten es nun mit einer ganz anderen Schwere des Übels zu tun. Das
Payload-Objekt vor der Validierung zu manipulieren, ist unüblich, was bedeutete,
dass dies kein Weltuntergangsszenario mehr war. Es war weiterhin potenziell
katastrophal, aber die Exposition sank von jedem joi-Nutzer auf einige sehr
spezifische Implementierungen.

Wir schauten nicht länger auf ein heimliches joi-Release. Das Problem in joi
besteht weiterhin, aber wir können es nun in den kommenden Wochen ordentlich mit
einer neuen API und einem Breaking Release angehen.

Wir wussten außerdem, dass wir diese Schwachstelle auf Framework-Ebene leicht
entschärfen können, da das Framework weiß, welche Daten von außen kommen und
welche intern erzeugt werden. Das Framework ist tatsächlich der einzige Teil, der
Entwickler davor schützen kann, solche unerwarteten Fehler zu machen.

### Gute Nachricht, schlechte Nachricht, gar keine Nachricht?
<a id="pp-good-news-no-news"></a>

Die gute Nachricht war, dass es nicht unsere Schuld war. Es war kein Bug in hapi
oder joi. Es war nur durch eine komplexe Kombination von Handlungen möglich, die
nicht spezifisch für hapi oder joi ist. Das kann bei jedem anderen
JavaScript-Framework passieren. Wenn hapi kaputt ist, dann ist die Welt kaputt.

Großartig — die Schuldfrage haben wir gelöst.

Die schlechte Nachricht ist: Wenn es nichts gibt, dem man die Schuld geben kann
(außer JavaScript selbst), ist es sehr viel schwerer, es beheben zu lassen.

Die erste Frage, die die Leute stellen, sobald ein Sicherheitsproblem gefunden
wird, ist, ob ein CVE veröffentlicht wird. Ein CVE — Common Vulnerabilities and
Exposures — ist eine [Datenbank](https://www.cve.org/) bekannter
Sicherheitsprobleme. Sie ist ein kritischer Bestandteil der Websicherheit. Der
Vorteil der Veröffentlichung eines CVE besteht darin, dass sie sofort Alarme
auslöst, informiert und häufig automatisierte Builds bricht, bis das Problem
behoben ist.

Aber woran sollen wir das festmachen?

Wahrscheinlich an nichts. Wir diskutieren immer noch, ob wir einige Versionen von
hapi mit einer Warnung kennzeichnen sollten. Das "wir" ist der
Node-Security-Prozess. Da wir nun eine neue Version von hapi haben, die das
Problem standardmäßig entschärft, kann sie als Fix betrachtet werden. Aber weil
der Fix nicht ein Problem in hapi selbst behebt, ist es nicht ganz koscher,
ältere Versionen für schädlich zu erklären.

Ein Advisory für frühere Versionen von hapi allein zu dem Zweck zu
veröffentlichen, die Leute zu Aufmerksamkeit und einem Upgrade zu bewegen, ist
ein Missbrauch des Advisory-Prozesses. Ich persönlich habe kein Problem damit,
ihn zugunsten besserer Sicherheit zu missbrauchen, aber das ist nicht meine
Entscheidung. Zum Zeitpunkt dieses Textes wird es noch diskutiert.

### Das Lösungsgeschäft
<a id="pp-solution-business"></a>

Das Problem zu entschärfen war nicht schwer. Es skalierbar und sicher zu machen,
war etwas aufwendiger. Da wir wussten, wo schädliche Daten ins System gelangen
können, und wir wussten, wo wir das problematische `JSON.parse()` verwendeten,
konnten wir es durch eine sichere Implementierung ersetzen.

Ein Problem. Daten zu validieren kann teuer sein, und wir planen nun, jeden
eingehenden JSON-Text zu validieren. Die eingebaute Implementierung von
`JSON.parse()` ist schnell. Wirklich sehr schnell. Es ist unwahrscheinlich, dass
wir einen Ersatz bauen können, der sicherer und annähernd so schnell ist.
Erst recht nicht über Nacht und ohne neue Bugs einzuführen.

Es war offensichtlich, dass wir die bestehende Methode `JSON.parse()` mit
zusätzlicher Logik umhüllen würden. Wir mussten nur sicherstellen, dass das nicht
zu viel Overhead hinzufügt. Das ist nicht nur eine Performance-, sondern auch
eine Sicherheitsfrage. Wenn wir es leicht machen, ein System durch das simple
Senden bestimmter Daten zu verlangsamen, machen wir es leicht, mit sehr geringem
Aufwand einen [DoS-Angriff](https://en.wikipedia.org/wiki/Denial-of-service_attack)
auszuführen.

Mir kam eine dumm einfache Lösung: Zuerst den Text mit den bestehenden Werkzeugen
parsen. Wenn das nicht fehlschlägt, den ursprünglichen Rohtext nach der
problematischen Zeichenkette "__proto__" durchsuchen. Nur wenn wir sie finden,
führen wir einen tatsächlichen Scan des Objekts durch. Wir können nicht jede
Erwähnung von "__proto__" blockieren — manchmal ist es ein völlig gültiger Wert
(etwa wenn man hier darüber schreibt und diesen Text zur Veröffentlichung an
Medium schickt).

Damit war der "Happy Path" praktisch so schnell wie zuvor. Es kam lediglich ein
Funktionsaufruf hinzu, ein schneller Textscan (wiederum eine sehr schnelle
eingebaute Implementierung) und ein bedingtes Return. Die Lösung hatte
vernachlässigbare Auswirkungen auf die überwiegende Mehrheit der Daten, die
erwartungsgemäß durch sie hindurchlaufen.

Nächstes Problem. Die Prototyp-Eigenschaft muss nicht auf der obersten Ebene des
eingehenden Objekts liegen. Sie kann tief darin verschachtelt sein. Das bedeutet,
wir können nicht einfach nur auf der obersten Ebene nach ihr suchen. Wir müssen
rekursiv durch das Objekt iterieren.

Rekursive Funktionen sind zwar ein Lieblingswerkzeug, können beim Schreiben von
sicherheitsbewusstem Code aber katastrophal sein. Rekursive Funktionen erhöhen
nämlich die Größe des Laufzeit-Callstacks. Je öfter man schleift, desto länger
wird der Callstack. Irgendwann — KABUMM — erreicht man die maximale Länge und der
Prozess stirbt.

Wenn du die Form der eingehenden Daten nicht garantieren kannst, wird rekursives
Iterieren zu einer offenen Bedrohung. Ein Angreifer muss nur ein ausreichend
tiefes Objekt basteln, um deine Server zum Absturz zu bringen.

Ich habe eine flache Schleifenimplementierung verwendet, die sowohl
speichereffizienter (weniger Funktionsaufrufe, weniger Übergabe temporärer
Argumente) als auch sicherer ist. Ich weise darauf nicht hin, um anzugeben,
sondern um hervorzuheben, wie grundlegende Engineering-Praktiken
Sicherheitsfallen schaffen (oder vermeiden) können.

### Auf die Probe gestellt
<a id="pp-putting-to-test"></a>

Ich habe den Code an zwei Personen geschickt. Zuerst an [Nathan
LaFreniere](https://github.com/nlf), um die Sicherheitseigenschaften der Lösung
gegenzuprüfen, und dann an [Matteo Collina](https://github.com/mcollina), um die
Performance zu bewerten. Sie gehören zu den Allerbesten in ihrem Fach und sind
oft meine ersten Ansprechpartner.

Die Performance-Benchmarks bestätigten, dass der "Happy Path" praktisch
unbeeinträchtigt blieb. Die interessante Erkenntnis war, dass das Entfernen der
problematischen Werte schneller war als das Werfen einer Exception. Das warf die
Frage auf, was das Standardverhalten des neuen Moduls sein sollte — das ich
[**bourne**](https://github.com/hapijs/bourne) nannte — Fehler oder Bereinigung.

Die Sorge war erneut, die Anwendung einem DoS-Angriff auszusetzen. Wenn das
Senden eines Requests mit `__proto__` die Dinge um 500 % verlangsamt, könnte das
ein leichter Angriffsvektor sein. Aber nach etwas mehr Tests bestätigten wir,
dass das Senden **irgendeines** ungültigen JSON-Textes sehr ähnliche Kosten
verursachte.

Mit anderen Worten: Wenn du JSON parst, kosten dich ungültige Werte mehr,
unabhängig davon, wodurch sie ungültig sind. Wichtig ist außerdem zu bedenken,
dass der Benchmark zwar prozentual erhebliche Kosten für das Scannen verdächtiger
Objekte zeigte, die tatsächlichen Kosten an CPU-Zeit aber weiterhin im Bereich
von Bruchteilen von Millisekunden lagen. Wichtig, das festzuhalten und zu messen,
aber nicht wirklich schädlich.

### hapi und ewig glücklich
<a id="pp-hapi-ever-after"></a>

Es gibt eine ganze Reihe von Dingen, für die man dankbar sein kann.

Die ursprüngliche Meldung durch das Lob-Team war perfekt. Sie erfolgte
vertraulich, an die richtigen Leute, mit den richtigen Informationen. Sie haben
mit zusätzlichen Erkenntnissen nachgelegt und uns die Zeit und den Raum gegeben,
das Problem richtig zu lösen. Lob war über die Jahre außerdem ein wichtiger
Sponsor meiner Arbeit an hapi, und diese finanzielle Unterstützung ist
entscheidend dafür, dass alles andere überhaupt möglich ist. Dazu gleich mehr.

Die Triage war stressig, aber mit den richtigen Leuten besetzt. Menschen wie
[Nicolas Morel](https://github.com/Marsup), Nathan und Matteo verfügbar und
hilfsbereit zu haben, ist entscheidend. Damit umzugehen ist schon ohne Druck
nicht leicht, mit Druck sind Fehler ohne gute Teamzusammenarbeit
wahrscheinlich.

Wir hatten mit der eigentlichen Schwachstelle Glück. Was zunächst wie ein
katastrophales Problem aussah, entpuppte sich als heikles, aber unkompliziert zu
behebendes Problem.

Wir hatten außerdem das Glück, vollen Zugriff zu haben, um es an der Quelle zu
entschärfen — wir mussten keine E-Mails an irgendeinen unbekannten
Framework-Maintainer schicken und auf eine schnelle Antwort hoffen. Die
vollständige Kontrolle von hapi über all seine Abhängigkeiten hat ihren Nutzen
und ihre Sicherheit erneut bewiesen. Du verwendest kein [hapi](https://hapi.dev)?
[Vielleicht solltest
du](https://hueniverse.com/why-you-should-consider-hapi-6163689bd7c2).

### Das "ewig" in "ewig glücklich"
<a id="pp-after-ever-after"></a>

Hier muss ich diesen Vorfall nutzen, um die Kosten und die Notwendigkeit
nachhaltiger und sicherer Open-Source-Software zu betonen.

Allein meine Zeit für dieses eine Problem überstieg 20 Stunden. Das ist eine halbe
Arbeitswoche. Sie fiel ans Ende eines Monats, in dem ich bereits über 30 Stunden
mit der Veröffentlichung eines neuen Major-Releases von hapi verbracht hatte (der
Großteil der Arbeit wurde im Dezember erledigt). Damit stehe ich diesen Monat vor
einem persönlichen finanziellen Verlust von über 5.000 US-Dollar (ich musste
bezahlte Kundenarbeit zurückfahren, um mir die Zeit dafür zu nehmen).

Wenn du dich auf Code verlässt, den ich pflege, ist das genau das Maß an
Unterstützung, Qualität und Engagement, das du willst (und — seien wir ehrlich —
erwartest). Die meisten von euch nehmen das als selbstverständlich hin — nicht
nur meine Arbeit, sondern die Arbeit hunderter anderer engagierter
Open-Source-Maintainer.

Weil diese Arbeit wichtig ist, habe ich beschlossen zu versuchen, sie nicht nur
finanziell nachhaltig zu machen, sondern sie auszubauen und zu erweitern. Es gibt
so viel zu verbessern. Genau das motiviert mich, das neue [kommerzielle
Lizenzmodell](https://web.archive.org/web/20190201220503/https://hueniverse.com/on-hapi-licensing-a-preview-f982662ee898?gi=b54e9a75bac6)
umzusetzen, das im März kommt. Mehr dazu kannst du
[hier](https://web.archive.org/web/20190201220503/https://hueniverse.com/on-hapi-licensing-a-preview-f982662ee898?gi=b54e9a75bac6)
nachlesen.


