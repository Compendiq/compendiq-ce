# Ereignisgesteuerte Prozesskette

![](images/ereignisgesteuerte-prozesskette__1.png)

Die **Ereignisgesteuerte Prozesskette** (**EPK**) ist eine grafische Modellierungssprache zur Darstellung von Geschäftsprozessen einer Organisation bei der Geschäftsprozessmodellierung / Darstellung der Prozessorganisation (Abläufe und Arbeitsschritte) bei der Unternehmensabbildung.
Sie wurde 1992 von Gerhard Keller, Markus Nüttgens und August-Wilhelm Scheer an der Universität des Saarlandes in Saarbrücken im Rahmen eines Forschungsprojektes mit der SAP SE zur semiformalen Beschreibung von Geschäftsprozessen entwickelt. Die Methode wurde im Rahmen der Architektur Integrierter Informationssysteme (ARIS) zur sichtenorientierten Modellierung von Geschäftsprozessen entwickelt und ist ein wesentliches Element des ARIS-Konzepts.

## Grundlagen

EPK stellen Arbeitsprozesse in einer semiformalen Modellierungssprache grafisch mit Syntaxregeln dar. Dadurch sollen betriebliche Vorgänge systematisiert und parallelisiert werden, um Zeit und Geld einsparen zu können. Da innerhalb des Prozesses Entscheidungen auf Basis von Bedingungen und Regeln getroffen werden, gibt es in der EPK Verknüpfungsoperatoren („und“, „oder“, „exklusiv-oder“). Das Grundmodell der Ereignisgesteuerten Prozesskette umfasst neben diesen Operatoren auch Ereignisse und Funktionen. Dazu werden Objekte in gerichteten Graphen mit Verknüpfungslinien und -pfeilen in einer 1:1-Zuordnung verbunden (Ausnahme bei logischen Verknüpfungen). In einer solchen Verknüpfungskette wechseln die Objekte sich in ihrer Bedeutung zwischen Ereignis und Funktion ab, das heißt, sie bilden eine alternierende Folge, die zu einem bipartiten Graphen führt.

## Symbole und Syntaxregeln

Topologisch sind Prozessketten gerichtete Graphen ohne Schleife. Die Knoten sind Entitäten einer Organisation, Methoden eines Prozesses oder Hilfsknoten der Strukturierung. Die Kanten sind Informationsflüsse. Feedback oder Iterationen werden in diesem Ablauf nicht visualisiert. Die Prozesse der Kette münden in einem gemeinsamen Geschäftsziel.

- Ein Ereignis ist ein Zustand, der vor oder nach einer Funktion auftritt. Das Symbol für ein Ereignis ist sechseckig. Im obigen Beispiel: „Auftrag ist angenommen“.
- Eine Funktion (Prozess) ist eine Aktion oder Aufgabe, die auf ein Ereignis folgt. Funktionen werden durch Rechtecke mit abgerundeten Ecken symbolisiert. Im obigen Beispiel: „Auftrag prüfen“.
- Konnektoren dienen zum Aufspalten oder Vereinigen des Kontrollflusses. Es stehen die drei Konnektoren UND, ODER und XOR zur Verfügung, die jeweils in einem kleinen Kreis mit dem entsprechenden Symbol dargestellt werden.
- Prozesswegweiser sind Hinweise auf andere Prozesse. Sie werden durch ein Rechteck symbolisiert, hinter dem sich ein Sechseck verbirgt.
- Informationsobjekte stellen Dokumente oder sonstige Datenspeicher dar. Das Symbol für ein Informationsobjekt ist ein Rechteck. Beispiel: „Kundendatenbank“
- Organisationseinheiten (Symbol: Ellipse, die vor dem linken Rand eine senkrechte Linie enthält) symbolisieren Rollen oder Personen, die für den Prozess verantwortlich sind. Organisationseinheiten werden per durchgehender Linie mit Funktionen verbunden. Beispiele für Organisationseinheiten sind „Kunde“ oder „Marketingabteilung“.

Hierbei sind Organisationseinheiten und Informationsobjekte Symbole der erweiterten Ereignisgesteuerten Prozessketten (eEPK). Der Informationsfluss zwischen den einzelnen Symbolen wird durch Pfeile dargestellt. Funktionen und Ereignisse besitzen genau einen eingehenden und einen ausgehenden Pfeil (Ausnahmen: Bei Anfangsereignissen geht keine gerichtete Kante ein, bei Endereignissen geht kein Pfeil hinaus). Falls mehrere Ereignisse zu einer Funktion führen sollen, so müssen Konnektoren (zum Beispiel UND) vorgeschaltet werden.

Aufgrund der Denkweise, dass Ereignisse passiv und Funktionen aktiv sind, gilt: Ein Ereignis darf nicht über einen OR- oder einen XOR-Konnektor zu zwei Funktionen aufgespaltet werden, da ein Ereignis über keine Entscheidungsgewalt verfügt.

## Erweiterte Ereignisgesteuerte Prozesskette (eEPK)

![](images/ereignisgesteuerte-prozesskette__2.png)

Eine erweiterte Form der Modellierungsmethode EPK stellt die erweiterte Ereignisgesteuerte Prozesskette (eEPK) dar. Die in der EPK dargestellten logischen Abläufe eines Geschäftsprozesses werden anhand der eEPK um die Elemente der Organisations-, Daten- und Leistungsmodellierung erweitert. So kann bspw. jede Funktion zusätzlich mit einem Informationsobjekt verbunden werden, aus dem Informationen geladen oder in das Informationen gespeichert werden.

Beispielsweise können hier zusätzliche Informationen über Ausführende, unterstützende Systeme, verwendete Daten, erzeugte Dateien usw. ergänzt werden, die die Verbindung zu anderen Modellsichten des ARIS-Hauses herstellen. Des Weiteren werden Informationsobjekte verwendet (zum Beispiel Datenbanken, Kundendaten), welche Einfluss auf Funktionen haben (verändern) oder Informationen von ihnen holen können.

Die Fähigkeiten der EPK werden bei der erweiterten EPK im Wesentlichen um die Elemente und Beziehungen des Funktionszuordnungsdiagramms ergänzt. Im Rahmen der eEPK ist es dann zusätzlich möglich, Abbildungen von Datenflüssen, Organisationseinheiten oder Anwendungssystemen zu erstellen.

Die dadurch zusätzlich möglichen Beziehungen von Funktionen zu den weiteren Elementen werden auch als *nicht strukturbildende Beziehungen* bezeichnet, weil sie weder die funktionale Aufbaustruktur noch die Ablaufstruktur einer Organisation beschreiben. Die Kanten, die zwischen den grafischen Objekten bestehen, werden in der eEPK als Rollen verstanden. Beispielsweise stellt eine Kante zwischen einer Organisationseinheit und einer Funktion die Rolle einer Organisationseinheit im Hinblick auf die Funktionsausführung dar (zum Beispiel „führt aus“, „ist fachlich verantwortlich“).

## Einsatzgebiete

EPKs können für verschiedene Aufgaben eingesetzt werden:

- Evaluation und Implementierung von Standardsoftware
- Darstellung von Abläufen bei Eigenentwicklungen
- Prozessoptimierung beim Business Process Reengineering
- Analyse und Optimierung von Geschäftsprozessen im Rahmen des Process Performance Management
- Veranschaulichung von Abläufen bei Anwenderschulungen
- Geschäftsprozessmodellierung (Standard in kleinen und mittleren Unternehmen)
- Prozesskostenrechnung
- Modellierung von BPEL-Prozessen
- Simulation von Workflows
- Prozessdokumentation nach ISO 900x

Erweiterte Ereignisgesteuerte Prozessketten (eEPKs) mit ihrer freien Platzierung der Elemente auf der Zeichenfläche werden in ganz ähnlicher Weise verwendet und können die gleichen Sachverhalte darstellen wie Vorgangskettendiagramme (VKDs) mit ihrer spaltenweisen Sortierung der Elemente.

### Vorteile

- Ereignisgesteuerte Prozessketten bieten durch die freie Platzierung der Elemente auf der Zeichenfläche Vorteile bei der Darstellung von alternativen oder parallelen Abläufen und bei Rückschleifen sowie bei der Ausnutzung der vorhandenen Zeichenfläche.
- Beschreibung standardisierter Abläufe möglich
- Sehr umfangreiche Tool-Unterstützung
- Große Nähe zu Standard-Softwaresystemen

### Nachteile

- Bei der Erkennung von Organisationsbrüchen (Wechsel der Organisationseinheit), Systembrüchen (Wechsel des Anwendungssystems) oder Datenbrüchen (Wechsel des Datenträgers oder Datenformats) sind Ereignisgesteuerte Prozessketten gegenüber Vorgangskettendiagrammen im Nachteil, weil Vorgangskettendiagramme eine spaltenweise Sortierung der Elemente nach Typen bieten.
- Probleme bei der Abbildung kreativer und komplexer Tätigkeiten
- Probleme bei der Modellierung von Überwachungs- und Kontrolltätigkeiten
- Erfassung rein formaler Strukturen und Abläufe
- Gegenüber der BPMN fehlt der EPK die Standardisierung durch eine entsprechende Organisation, wodurch die Verbreitung außerhalb des deutschsprachigen Raums geringer ausfällt.
