# Unified Modeling Language

Die **Unified Modeling Language** *(vereinheitlichte Modellierungssprache)*, kurz **UML**, ist eine grafische Modellierungssprache zur Spezifikation, Konstruktion, Dokumentation und Visualisierung von Software-Teilen und anderen Systemen. Sie wird von der Object Management Group (OMG) entwickelt und ist sowohl von ihr als auch von der ISO (ISO/IEC 19505 für Version 2.4.1) genormt. Im Sinne einer Sprache definiert UML dabei Bezeichner für die meisten bei einer Modellierung wichtigen Begriffe und legt mögliche Beziehungen zwischen diesen Begriffen fest. Die UML definiert weiter grafische Notationen für diese Begriffe und für Modelle statischer Strukturen und dynamischer Abläufe, die man mit diesen Begriffen formulieren kann.

Die UML ist die dominierende Sprache für die Softwaresystem-Modellierung. Der erste Kontakt zur UML besteht häufig darin, dass Diagramme in UML im Rahmen der Softwareentwicklung zu erstellen, zu verstehen oder zu beurteilen sind:

- Auftraggeber und Fachvertreter prüfen und bestätigen zum Beispiel Anforderungen an ein System, die Wirtschaftsanalytiker bzw. Business Analysten in Anwendungsfalldiagrammen in UML festgehalten haben;
- Softwareentwickler realisieren Arbeitsabläufe, die Wirtschaftsanalytiker bzw. Business Analysten in Zusammenarbeit mit Fachvertretern in Aktivitätsdiagrammen beschrieben haben;
- Systemingenieure implementieren, installieren und betreiben Softwaresysteme basierend auf einem Implementationsplan, der als Verteilungsdiagramm vorliegt.

Die grafische Notation ist jedoch nur ein Aspekt, der durch UML geregelt wird. UML legt in erster Linie fest, mit welchen Begriffen und welchen Beziehungen zwischen diesen Begriffen sogenannte *Modelle* spezifiziert werden – Diagramme in UML zeigen nur eine graphische Sicht auf Ausschnitte dieser Modelle. UML schlägt weiter ein Format vor, in dem Modelle und Diagramme zwischen Werkzeugen ausgetauscht werden können.

## Entstehungsgeschichte

Die erste Version von UML entstand in den 1990er Jahren als Reaktion auf zahlreiche Vorschläge für Modellierungssprachen und -Methoden, welche die zu dieser Zeit aufkommende objektorientierte Softwareentwicklung unterstützen sollten. Die erste Folge von Sprachversionen, auch bekannt unter dem Namen UML 1.x, wurde 2005 durch eine grundlegend überarbeitete Version, oft als UML2 bezeichnet, abgelöst.

### Von den Anfängen zur Unified Modeling Language 1.x

![](images/unified-modeling-language__1.png)

Die Väter von UML, insbesondere Grady Booch, Ivar Jacobson und James Rumbaugh, auch „Die drei Amigos“ genannt, waren in den 1990er-Jahren bekannte Vertreter der objektorientierten Programmierung. Sie hatten alle bereits ihre eigenen Modellierungssprachen entwickelt. Als sie zusammen beim Unternehmen Rational Software beschäftigt waren, entstand die Idee, die verschiedenen Notationssysteme strukturiert zusammenzuführen. Eine Vielzahl von unterschiedlichen Modellierungssprachen hatte direkten oder indirekten Einfluss auf die Konzeption von UML, darunter OOSE, RDD, OMT, OBA, OODA, SOMA, MOSES und OPEN/OML.

Als Resultat dieser Bemühungen entstand die UML. Die Standardisierung, Pflege und Weiterentwicklung der Sprache wurde an die OMG übergeben, die die Sprache am 19. November 1997 als Standard akzeptierte.

### Entstehungsgeschichte der Unified Modeling Language 2

Im August 1999 stieß die OMG die Entwicklung von UML2 an, indem sie einen entsprechenden Request for Information (RFI) publizierte.

Ein Jahr später, im September 2000, bat die OMG ihre Mitglieder und weitere interessierte Kreise um Vorschläge für UML2. Gemäß der neu für UML2 definierten Architektur publizierte die OMG drei *Requests for Proposals* (RFP): einen UML 2.0 Infrastructure RFP, einen UML 2.0 Superstructure RFP und einen UML 2.0 OCL RFP. Wer Vorschläge einreichen wollte, hatte dazu ungefähr ein weiteres Jahr Zeit.

In einer ersten Runde reichten verschiedene Gruppen und Einzelpersonen Entwürfe ein. Mitte 2002 lagen von diesen Konsortien mehrmals überarbeitete und konsolidierte Antworten auf einzelne Request for Proposals vor. Erst im Oktober 2002 konnten dann beim Treffen der zuständigen Arbeitsgruppe in Helsinki alle Vorschläge für die *UML 2.0 Infrastructure* und die *UML 2.0 Superstructure* präsentiert werden. Einen Termin für eine weitere überarbeitete Version der Vorschläge legte die Arbeitsgruppe auf Anfang Januar 2003 fest. Die Hauptschwierigkeit bestand nun darin, die unterschiedlichen Entwürfe zu *einer* Spezifikation zu verschmelzen. Einerseits wurde Kritik laut, dass sich die unterschiedlichen Philosophien in den eingereichten Vorschlägen nur schwerlich würden bereinigen lassen, andererseits reichte im Januar 2003 ein neues Konsortium unter dem Namen 4M einen Vorschlag (UML4MDA) ein, der die Differenzen zwischen den bisherigen Spezifikationen zu überbrücken versuchte.

Im März 2003 empfahl die zuständige Arbeitsgruppe die Vorschläge des Konsortiums U2 für die *UML 2.0 Infrastructure* und für die *UML 2.0 OCL* zur Freigabe, im Mai dann auch für die *UML 2.0 Superstructure* des gleichen Konsortiums, so dass ab Juni 2003 drei *Finalization Task Forces* der OMG die Arbeit aufnehmen konnten, um die Teilspezifikationen abzuschließen. Die Task Forces konnten ihre Arbeit jedoch nicht wie geplant bis zum April 2004 abschließen und gründeten deshalb eine zweite *Finalization Task Force*, die die verbleibenden Probleme bis zum September 2004 lösen sollte.

Im September 2004 konnten schließlich alle *Finalization Task Forces* ihre Arbeit beenden. Für die *UML 2.0 OCL* und die UML 2.0 Infrastructure lagen damit endgültig abgenommene Dokumente *(Final Adopted Specification)* vor. Nur bei der *UML 2.0 Superstructure* schien sich dieser letzte Schritt noch etwas zu verzögern: im März 2005 bot der OMG-Webauftritt weiterhin nur ein temporäres Dokument mit der informellen Bezeichnung *UML 2.0 Superstructure FTF convenience document* zum Herunterladen an.

Am 21. Oktober 2008 wurde die Beta 1 von UML Version 2.2 durch die OMG veröffentlicht, die dann im Februar 2009 in der finalen Version vorlag.
Neu hinzugekommen ist in der Version 2.2 das Profildiagramm, um eigendefinierte Stereotyp-Sammlungen strukturieren zu können.

Im Mai 2010 wurde UML 2.3 veröffentlicht. Diese Version enthielt vor allem Fehlerkorrekturen am Metamodell und Schärfungen der Semantik von Modellelementen im Spezifikationsdokument der UML. Die Version 2.5 wurde im Juni 2015 veröffentlicht. Die derzeit aktuelle Version 2.5.1 wurde im Dezember 2017 veröffentlicht.

## Strukturierung

Der Umfang der UML ist während der Entwicklung von UML 1.0 bis UML 2 laufend gewachsen. Sowohl für die Entwicklung von UML 2 als auch für die Vermittlung, die Anwendung und nicht zuletzt für die Lesbarkeit der UML 2-Spezifikation ist eine Strukturierung sehr wichtig. Was in den ersten Versionen von UML in einem Dokument spezifiziert werden konnte, muss deshalb für UML 2 in Teilspezifikationen aufgeteilt werden. In den folgenden Abschnitten wird der Aufbau von UML 2 beschrieben.

### Teilspezifikationen

UML2 ist in drei Teilspezifikationen aufgeteilt. Die *UML 2.0 Infrastructure Specification* legt das Fundament für UML2, indem sie die am häufigsten verwendeten Elemente von UML2 und die Modellelemente beschreibt, die die restlichen Modellelemente spezialisieren. In diesem Dokument werden Konzepte wie die Klasse, die Assoziation oder die Multiplizität eines Attributs spezifiziert. Die *UML 2.0 Superstructure Specification* baut auf dem Fundament der UML 2.0 Infrastructure Specification auf und definiert die Modellelemente von UML2, die sich für bestimmte Einsatzzwecke eignen. Typische Konzepte, die in diesem Dokument spezifiziert werden, sind der Anwendungsfall, die Aktivität oder der Zustandsautomat. Schließlich spezifiziert das Dokument mit dem Titel *UML 2.0 Object Constraint Language* die Object Constraint Language 2.0 (OCL2).

Ein weiterer, vierter Teil beschäftigt sich nicht mit dem semantischen Modell von UML, sondern spezifiziert das Layout der Diagramme. Dieses Dokument trägt den Titel *UML 2.0 Diagram Interchange* und ist eine Neuerung in UML 2.0; UML 1.x kannte kein standardisiertes Format, mit dem das Diagramm-Layout zwischen unterschiedlichen Werkzeugen ausgetauscht werden konnte. Die semantischen Informationen in einem UML-Modell konnte ein Werkzeug auch bisher an ein anderes Werkzeug übergeben; das Aussehen der Diagramme, das heißt die Positionen und Größe einzelner Diagrammelemente, ging dabei aber verloren. Diagram Interchange (DI) soll dieses Manko beseitigen.

### Metamodellierung

![](images/unified-modeling-language__2.png)

Ähnlich wie sich natürliche Sprachen in Lexika oder Grammatiken selbst beschreiben, wurde auch UML als ein Sprachwerkzeug konzipiert, das sich mit einigen Sprachbestandteilen selbst erklärt.

Die Sprachkonzepte sind dazu in vier Schichten *M0* bis *M3* gegliedert.

Mit der Meta Object Facility (MOF) werden Modellelemente von UML2 spezifiziert und dadurch zum Beispiel mit dem Format Meta Interchange XMI austauschbar. Diese MOF ist auf Ebene *M3* und stellt eine der vier Schichten dar. Es ist die Metasprache der Metasprachen (das *Metametamodell*) und beinhaltet grundlegende Elemente (wie Pakete, Klassen, Attribute und Assoziationen). Die Metasprache UML2 *(M2)* ist *in MOF* definiert und stellt die bekannten Sprachmerkmale zur Verfügung, über die Konzepte von MOF hinaus auch noch Anwendungsfälle, Zustandsautomaten und mehr. Die in der Praxis erstellten UML-Modelle befinden sich auf der Ebene *M1*. Damit werden die Objekte der *M0*-Schicht dargestellt. Dies sind die konkreten Laufzeitinstanzen des Systems.

UML 2.0 ist also, wie auch UML1.x, auf der dritten von vier Metamodellierungsebenen eingeordnet. Zu UML 1.x besteht jedoch ein wesentlicher Unterschied: Die auf den Ebenen M2 und M3 verwendeten Modellierungssprachen (also MOF und UML) teilen sich die gemeinsame Spracheinheit der *Infrastrukturbibliothek (Infrastructure Library)*. Sie wird in der *UML 2.0 Infrastructure* definiert und bildet einen Kern der grundlegenden Modellierungselemente, der sowohl in der *UML 2.0 Infrastructure* als auch in der *UML 2.0 Superstructure* und in der *MOF 2.0* eingesetzt wird.

### Spracheinheiten

Die *UML 2.0 Superstructure* ist auf einer ersten Ebene modular in Spracheinheiten (englisch *language units*) aufgebaut. Eine Spracheinheit umfasst eine Menge von eng zusammenhängenden Modellierungselementen, mit denen ein Benutzer einen ausgewählten Aspekt eines Systems mit einem bestimmten Formalismus modellieren kann. Die Spracheinheit *Aktivitäten* (englisch *Activities*) umfasst zum Beispiel Elemente für die Modellierung eines Systemverhaltens, das sich am besten mit dem Formalismus von Daten- und Kontrollflüssen darstellen lässt.

### Einteilung der Spracheinheiten in Schichten

Auf einer dritten Stufe sind die meisten Spracheinheiten in mehrere Schichten (englisch *Compliance Level*) gegliedert. Die unterste Schicht umfasst jeweils die einfachsten und am häufigsten verwendeten Modellierungselemente, während höhere Schichten zunehmend komplexere Modellierungselemente einführen. Die Spracheinheit Aktivitäten umfasst beispielsweise *FundamentalActivities* als unterste Schicht und darauf aufbauend die Schicht *BasicActivities*. *FundamentalActivities* definiert zunächst nur, dass Aktivitäten strukturell aus hierarchisch geschachtelten Gruppen von Aktionen bestehen. *BasicActivities* erweitert dieses Gerüst um Kanten und weitere Hilfsknoten zu einem Graphen, den man in UML2 dann visuell als Aktivitätsdiagramm darstellt.

## Spracheinheiten

![](images/unified-modeling-language__3.png)

### Aktionen

Die Spracheinheit *Aktionen* (englisch *actions*) umfasst die Definition der Aktionen in UML2. Aktionen sind die elementaren Bausteine für die Modellierung eines Verhaltens. Sie können Eingabewerte über sogenannte Eingabepins entgegennehmen und Ausgabewerte an sogenannten Ausgabepins produzieren.

UML2 definiert in dieser Spracheinheit mehrere Gruppen von grundlegenden Aktionen, siehe Aktion.

### Aktivitäten

Die Aktivität ist das zentrale Element der Spracheinheit *Aktivitäten*. Sie ist gleichzeitig eine Neuerung von UML2 gegenüber UML 1.4. Eine Aktivität ist ein Modell für ein Verhalten. Sie besteht aus Aktionen, zwischen denen Kontroll- und Datenflüsse existieren. Ein Aktivitätsdiagramm stellt das dynamische Verhalten eines Software-Systems dar.

Aktivitäten haben die Struktur eines Graphen. Knoten dieses Graphen sind Aktionen sowie Punkte, an denen die Flüsse zwischen den Aktionen kontrolliert werden; Kanten stehen für Daten- und Kontrollflüsse. Das Sprachpaket Aktivitäten definiert alle Typen von Knoten und Kanten, die für die Modellierung von Aktivitäten benötigt werden.

Knoten werden in Objekt- und Kontrollknoten unterschieden, Kanten analog dazu in Objekt- und Kontrollflüsse.

Komplexere Aktivitäten können verschachtelt und mit Kontrollstrukturen modularisiert werden.

Aktivitäten werden graphisch in Aktivitätsdiagrammen modelliert.

### Allgemeines Verhalten

Die Spracheinheit *Allgemeines Verhalten* umfasst die allgemeinen Modellelemente für die Spezifikation des Verhaltens eines mit UML2 modellierten Systems. Hier sind die Modellelemente zusammengefasst, die für die Spezifikation von Aktivitäten, Interaktionen oder Zustandsautomaten benötigt werden.

Die Spracheinheit definiert die Gemeinsamkeiten jeder Verhaltensbeschreibung und dass eine aktive Klasse ein eigenes Verhalten haben kann. Verhalten in einem System, das mit UML2 modelliert ist, startet immer aufgrund von diskreten Ereignissen. Dieses Sprachpaket definiert, welche Arten von Ereignissen UML2 unterstützt.

Die Behandlung der Zeit wird ebenfalls weitgehend in diesem Sprachpaket geregelt. Es definiert Metaklassen für die Beobachtung der Zeit *(TimeObservationAction)*, für die Notation von Zeitausdrücken *(TimeExpression)*, für die Definition von Zeitintervallen *(TimeInterval)* sowie für das Konzept einer zeitlichen Dauer *(Duration)*.

### Anwendungsfälle

Die Spracheinheit *Anwendungsfälle* (englisch *use cases*) stellt Elemente für die Modellierung von Anforderungen an ein System zur Verfügung. Das wichtigste Element ist der Anwendungsfall. Anwendungsfälle halten fest, was ein System tun soll. Das zweite wichtige Element ist der Akteur. Akteure spezifizieren, *wer* (im Sinne einer Person) oder *was* (im Sinne eines anderen Systems) etwas mit dem System tun soll.

Graphisch werden Anwendungsfälle in Anwendungsfalldiagrammen dargestellt.

### Informationsflüsse

Den Techniken, die UML2 für die Spezifikation des Verhaltens eines Systems anbietet, liegen präzise semantische Modelle zugrunde. Das gilt insbesondere für Verhaltensbeschreibungen mit Hilfe von Interaktionen oder Aktivitäten, die zudem darauf ausgerichtet sind, das Verhalten eines Systems sehr feingranular zu spezifizieren. Soll das Modell eines Systems nur einige grundlegende Informationsflüsse im System aufzeigen, eignen sich diese Techniken deshalb nur bedingt.

Die Spracheinheit *Informationsflüsse*, die in UML2 neu eingeführt wurde, stellt Modellelemente zur Verfügung, um diese Situation zu verbessern. Sie bietet die Modellelemente Informationseinheit und Informationsfluss an, mit denen ein Modellierer Informationsflüsse in einem System auf hoher Abstraktionsstufe festhalten kann.

Informationsflüsse können dabei eine Vielzahl von anderen Modellelementen von UML2 verbinden, insbesondere Klassen, Anwendungsfälle, Ausprägungsspezifikationen, Akteure, Schnittstellen, Ports und noch einige mehr.

UML2 gibt keinen Diagrammtyp für Informationsflüsse vor. Die graphische Notation für Informationsflüsse und Informationseinheiten kann in allen Strukturdiagrammen vorkommen.

### Interaktionen

Das Verhalten eines modellierten Systems kann in UML2 auf unterschiedliche Art und Weise spezifiziert werden. Eine davon ist die Modellierung von Interaktionen. Eine Interaktion ist die Spezifikation eines Verhaltens, das am besten über den Austausch von Meldungen zwischen eigenständigen Objekten beschrieben wird. Die Spracheinheit stellt dafür die geeigneten Modellelemente zur Verfügung.

Wer Interaktionen modelliert, geht davon aus, dass das modellierte System aus einem Netzwerk von Objekten besteht, die untereinander Meldungen austauschen. Schickt ein Objekt einem anderen Objekt eine Meldung, kann man zwei Ereignisauftritte identifizieren: erstens das Auftreten eines Meldungsereignisses, wenn die Meldung vom ersten Objekt abgeschickt wird sowie zweitens eines Meldungsereignisses, wenn die Meldung beim zweiten Objekt ankommt. Weitere Ereignisse treten auf, wenn eine Aktion oder ein anderes Verhalten im Kontext eines Objekts beginnt oder endet. Eine *Spur (trace)* bezeichnet eine Folge solcher Ereignisse. Interaktionen spezifizieren nun ein Verhalten als zwei Mengen von Spuren, einer Menge *gültiger* und einer Menge *ungültiger* Spuren.

Damit ist präziser gesagt, was wir meinen, wenn wir von Interaktionen sprechen: die *Bedeutung* (Semantik) einer Interaktion ist durch Mengen von Spuren gegeben. *Modelliert* werden Interaktionen jedoch als Mengen von Lebenslinien, auf denen Aktionen und andere Verhaltensweisen ablaufen und zwischen denen Nachrichten ausgetauscht werden.

Interaktionen modelliert man graphisch in Kommunikationsdiagrammen, in Sequenzdiagrammen oder in Zeitverlaufsdiagrammen.

### Klassen

Die Spracheinheit *Klassen* umfasst den eigentlichen Kern der Modellierungssprache. Sie definiert insbesondere, was man in UML2 unter einer Klasse versteht und welche Beziehungen zwischen Klassen möglich sind. In dieser Spracheinheit sind grundlegende Prinzipien von UML2 definiert. Die Metaklasse *Element* ist das Wurzelelement für alle anderen Modellelemente. Jedes Element kann andere Elemente besitzen, auch beliebig viele Kommentare, die wiederum auch mehrere andere Elemente kommentieren können. Zwischen Elementen können Beziehungen definiert werden. Elemente können benannt sein und gehören in diesem Fall zu einem Namensraum. Weiter können gewisse Elemente einen Typ haben. Sie werden dann als *typisierte Elemente* bezeichnet. Einem Element kann eine Multiplizität mit einer unteren und einer oberen Schranke zugeordnet sein.

Diese Spracheinheit enthält vier Unterpakete. Das Unterpaket *Kernel* umfasst zentrale Modellierungselemente, die aus der *UML 2.0 Infrastructure* wiederverwendet werden. Dazu gehören die Klasse, die Ausprägungsspezifikation, der Namensraum, das Paket, das Attribut, die Assoziation, die Abhängigkeitsbeziehung, der Paketimport, die Paketverschmelzung und die Generalisierung. Das zweite Unterpaket, *AssociationClasses*, umfasst die Definition von Assoziationsklassen. *Interfaces*, das dritte Unterpaket, stellt die Definition von Schnittstellen bereit. Schließlich deklariert das Unterpaket *PowerTypes* Modellelemente für die sogenannten PowerTypes.

Elemente aus dieser Spracheinheit werden meistens in Klassendiagrammen, Objektdiagrammen und Paketdiagrammen dargestellt.

### Komponenten

Komponenten sind modulare Teile eines Systems, die so strukturiert sind, dass sie in ihrer Umgebung durch eine andere, äquivalente Komponente ersetzt werden könnten. In der Softwareentwicklung verwendet man insbesondere das Konzept der Softwarekomponente, um ein Softwaresystem in modulare Teile zu gliedern. Die Spracheinheit *Komponenten* von UML2 stellt Konstrukte zur Verfügung, um Systeme, die aus Komponenten aufgebaut sind, zu modellieren.

Das wichtigste Element ist die Komponente, die eine innere Struktur gegen außen abgrenzt. Die Spezifikation einer Komponente deklariert vor allem den von außen sichtbaren Rand und definiert damit eine Black-Box-Sicht auf die Komponente. Sichtbar sind eine Menge von angebotenen und erforderlichen Schnittstellen sowie allenfalls eine Menge von Ports.

Die Spracheinheit umfasst ferner den Delegations- und den Kompositionskonnektor. Der Delegationskonnektor verbindet Ports auf der Hülle einer Komponente mit Elementen im Innern der Komponente. Der Kompositionskonnektor verbindet angebotene Schnittstellen einer Komponente mit benötigten Schnittstellen einer anderen Komponente.

Die Elemente dieser Spracheinheit werden meistens in Komponentendiagrammen, zum Teil aber auch in Klassendiagrammen oder Verteilungsdiagrammen dargestellt.

### Kompositionsstrukturen

Die Spracheinheit *Kompositionsstrukturen* (englisch Structures) bereichert UML2 um einen neuen Ansatz für die Modellierung der inneren Struktur eines zusammengesetzten Ganzen. Das „Ganze“ wird dabei als gekapselter Classifier modelliert, für die „Teile“ stellt diese Spracheinheit die Parts zur Verfügung. Untereinander können Parts durch Konnektoren verbunden sein. Der gekapselte Classifier steht also für ein System mit klarer Abgrenzung von Innen und Außen, dessen innere Struktur mit Hilfe von Parts und Konnektoren spezifiziert ist. Damit die Grenze zwischen Innen und Außen zumindest teilweise durchlässig ist, kann der gekapselte Classifier auf der Hülle über eine Menge von Ein- und Ausgangspunkten, sogenannten Ports, verfügen.

Elemente aus dieser Spracheinheit werden meistens in Kompositionsstrukturdiagrammen dargestellt.

### Modelle

Die Spracheinheit *Modelle* umfasst nur ein Modellelement: das Modell.

### Profile

UML2 stellt mit der Spracheinheit *Profile* (englisch Profiles) einen leichtgewichtigen Erweiterungsmechanismus zur Verfügung, mit dem sie spezifischen Einsatzgebieten angepasst werden kann. Der Mechanismus wird als leichtgewichtig bezeichnet, weil er das Metamodell von UML2 unverändert lässt, oft ein entscheidender Vorteil, denn auf dem Markt erhältliche Werkzeuge für die Erstellung und Pflege von UML2-Modellen können oft nur mit Modellen basierend auf dem standardisierten UML2-Metamodell umgehen.

UML2 umfasst in ihren Spracheinheiten verschiedene Möglichkeiten für die Modellierung der Struktur und des Verhaltens eines Systems, muss dabei aber auf einer generischen Ebene bleiben. Sie verwendet zum Beispiel die generischen Begriffe Aktivität oder Artefakt und kennt den spezifischen Begriff Geschäftsprozess aus der Geschäftsmodellierung oder Enterprise JavaBeans der Java-Plattform nicht. Falls diese Begriffe in der Modellierung benötigt werden, müssen sie über den Erweiterungsmechanismus der Profile zu UML2 hinzugefügt werden. Auch spezielle Notationen, zum Beispiel eine realistischere Zeichnung anstelle des Strichmännchens, das einen Akteur darstellt, können UML2 mit Hilfe der Profile hinzugefügt werden. Weiter können Profile Lücken in der Semantik-Definition der UML2 schließen, die dort absichtlich für spezifische Einsatzgebiete offen gelassen wurden (englisch *semantic variation points*). Schließlich können Profile Einschränkungen definieren, um die Art und Weise zu beschränken, wie ein Element aus UML2 verwendet wird.

Mit Hilfe des Erweiterungsmechanismus der Profile kann das Metamodell von UML2 jedoch nicht beliebig angepasst werden. So können zum Beispiel keine Elemente aus dem Metamodell von UML2 entfernt, keine Einschränkungen aufgehoben und keine echten neuen Metaklassen, sondern nur Erweiterungen (Stereotype) bestehender Metaklassen deklariert werden.

Die Spracheinheit definiert zunächst das Konzept eines Profils. Ein Profil ist eine Sammlung von Stereotypen und definiert die eigentliche Erweiterung. Ein Profil *ist* ein Paket und wird auf andere Pakete angewandt, womit die Erweiterung, die das Profil definiert, für das entsprechende Paket gilt.

UML2 kennt seit der UML 2.2 einen speziellen Diagrammtyp für Profile. Die graphischen Notationen für Elemente aus dieser Spracheinheit kommen sowohl in Paketdiagrammen als auch in Klassendiagrammen vor.

### Schablonen

Die Spracheinheit Schablonen (englisch *Templates*) umfasst Modellelemente für die Parametrisierung von Klassifizierern, Klassen und Paketen.

### Verteilungen

Die Spracheinheit *Verteilungen* (englisch *Deployments*) ist auf ein sehr spezifisches Einsatzgebiet ausgerichtet, nämlich auf die Verteilung von lauffähiger Software in einem Netzwerk. UML2 bezeichnet eine so installierbare Einheit als Artefakt und geht davon aus, dass diese auf Knoten installiert werden. Knoten können entweder Geräte oder Ausführungsumgebungen sein. Eine Verteilungsbeziehung, das heißt eine spezielle Abhängigkeitsbeziehung, modelliert, dass ein Artefakt auf einem Knoten installiert wird.

Elemente aus dieser Spracheinheit werden normalerweise in Verteilungsdiagrammen dargestellt.

### Zustandsautomaten

Die Spracheinheit *Zustandsautomaten* (englisch *state machines*) umfasst Modellelemente, die für die Modellierung von Zustandsautomaten eingesetzt werden.

UML2 setzt Zustandsautomaten in erster Linie für die Spezifikation des Verhaltens eines Systems ein. So kann ein Zustandsautomat zum Beispiel das Verhalten der Instanzen einer aktiven Klasse modellieren. Zusätzlich können Zustandsautomaten aber auch eingesetzt werden, um eine zulässige Nutzung einer Schnittstelle oder eines Ports zu spezifizieren. Der Zustandsautomat modelliert dabei zum Beispiel, in welcher Reihenfolge Operationen einer Schnittstelle aufgerufen werden dürfen. Im ersten Fall spricht man von einem Verhaltenszustandsautomaten, im zweiten von einem Protokollzustandsautomaten.

Zustandsautomaten werden graphisch in Zustandsdiagrammen dargestellt. Diese sind in UML eine Variante der klassischen Statecharts.

### Diagrammtypen

Die Diagramme in UML lassen sich in zwei Hauptgruppen aufteilen: Strukturdiagramme und Verhaltensdiagramme.

UML2.3 kennt sieben Strukturdiagramme:

- das Klassendiagramm,
- das Kompositionsstrukturdiagramm (auch: Montagediagramm),
- das Komponentendiagramm,
- das Verteilungsdiagramm,
- das Objektdiagramm,
- das Paketdiagramm und
- das Profildiagramm.

Dazu kommen sieben Verhaltensdiagramme:

- das Aktivitätsdiagramm,
- das Anwendungsfalldiagramm (auch: Use-Case o. Nutzfalldiagramm genannt),
- das Interaktionsübersichtsdiagramm,
- das Kommunikationsdiagramm,
- das Sequenzdiagramm,
- das Zeitverlaufsdiagramm und
- das Zustandsdiagramm.

Die Grenzen zwischen den vierzehn Diagrammtypen verlaufen weniger scharf, als diese Klassifizierung vermuten lässt. UML2 verbietet nicht, dass ein Diagramm graphische Elemente enthält, die eigentlich zu unterschiedlichen Diagrammtypen gehören. Es ist sogar denkbar, dass Elemente aus einem Strukturdiagramm und aus einem Verhaltensdiagramm auf dem gleichen Diagramm dargestellt werden, wenn damit eine besonders treffende Aussage zu einem Modell erreicht wird.

UML2 geht aber in anderer Hinsicht weit formaler mit Diagrammen um als UML 1.4. Neu definiert UML2 unter dem Namen *UML 2.0 Diagram Interchange* ein Austauschformat für Diagramme, so dass unterschiedliche Werkzeuge, mit denen Modelle basierend auf UML2 erstellt werden, die Diagramme austauschen und wiederverwenden können. In UML 1.x war das nur für die Repository-Modelle „hinter“ den Diagrammen möglich, aber nicht für die eigentlichen Diagramme.

### Erstellen von Diagrammen

Diagramme von UML2 können auf verschiedene Arten erstellt werden. Wenn die Notation von UML2 als gemeinsame Sprache eingesetzt wird, um in einem Analyseteam Entwürfe von Analysemodellen an der Weißwandtafel *(Whiteboard)* festzuhalten, reichen Stifte und Papier als Werkzeug. Häufig werden Diagramme von UML2 jedoch mit Hilfe von speziellen Programmen (UML-Werkzeugen) erstellt, die man in zwei Klassen einteilen kann.

Programme in der ersten Gruppe helfen beim Zeichnen von Diagrammen der UML2, ohne dass sie die Modellelemente, welche den graphischen Elementen auf den Diagrammen entsprechen, in einem Repository ablegen. Zu dieser Gruppe gehören alle Programme zum Erstellen von Zeichnungen.

Die zweite Gruppe besteht aus Programmen, die die Erstellung von Modellen und das Zeichnen von Diagrammen von UML2 unterstützen.

Siehe auch: UML-Werkzeug

## Austausch von Modellen und Diagrammen

Damit Modelle von einem Werkzeug an andere übergeben werden können, definiert die Object Management Group ein standardisiertes Austauschformat, das auch für UML-Modelle eingesetzt wird. Das Format basiert auf der Auszeichnungssprache XML und heißt XML Metadata Interchange (XMI). Die Grundlage für die Austauschbarkeit ist das MOF, auf dessen Konzept beide Sprachen, XMI und UML, beruhen.

Für die UML-Versionen 1.x sah das Format keine Möglichkeit vor, Diagramme in einem standardisierten Format auszutauschen, was von vielen Anwendern als wesentliche Lücke wahrgenommen wurde. Parallel zur Entwicklung von UML2 hat die OMG deshalb auch das standardisierte Austauschformat XMI überarbeitet. Unter anderem wurde die beschriebene Lücke geschlossen, indem die Spezifikation unter dem Namen *UML 2.0 Diagram Interchange* um ein Format für den Austausch von Diagrammen erweitert wurde.

Ein Austausch mit anderen Modellierungssprachen ist auch mittels Modell-zu-Modell-Transformation möglich. Dazu hat die OMG den Standard MOF QVT definiert. Im Gegensatz zu einem reinen Austauschformat kann eine Transformation auch eine eigene Semantik enthalten. So kann zum Beispiel festgelegt werden, wie ein Klassenmodell auf ein ER-Modell abzubilden ist. Die damit einhergehende Flexibilität ist insbesondere auch beim Austausch zwischen Werkzeugen nützlich, da verschiedene Anbieter praktisch immer auch individuelle Varianten des UML-Metamodells haben.
