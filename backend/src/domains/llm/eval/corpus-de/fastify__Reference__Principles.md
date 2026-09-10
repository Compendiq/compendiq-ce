# Technische Grundsätze

Jede Entscheidung im Fastify-Framework und in seinen offiziellen Plugins richtet sich
nach den folgenden technischen Grundsätzen:

1. „Null" Overhead in der Produktion
2. „Gute" Developer Experience
3. Funktioniert gleichermaßen gut für kleine und große Projekte
4. Einfache Migration zu Microservices (oder sogar Serverless) und zurück
5. Sicherheit und Datenvalidierung
6. Wenn etwas ein Plugin sein könnte, sollte es das wahrscheinlich auch sein
7. Leicht testbar
8. Den Core nicht monkeypatchen
9. Semantic Versioning und Long Term Support
10. Einhaltung von Spezifikationen

## „Null" Overhead in der Produktion

Fastify strebt an, Funktionen mit minimalem Overhead umzusetzen. Erreicht wird das
durch schnelle Algorithmen, Datenstrukturen und JavaScript-spezifische Eigenschaften.

Da JavaScript keine Datenstrukturen ohne Overhead bietet, kann dieser Grundsatz
mit einer großartigen Developer Experience und zusätzlichen Funktionen kollidieren,
da diese üblicherweise einen gewissen Overhead mit sich bringen.

## „Gute" Developer Experience

Fastify strebt an, bei seinem Performance-Niveau die bestmögliche Developer Experience zu bieten.
Es liefert ein hervorragendes Out-of-the-box-Erlebnis, das flexibel genug ist, um sich an
unterschiedliche Situationen anzupassen.

Beispielsweise sind binäre Addons untersagt, weil die meisten JavaScript-Entwickler
keinen Zugriff auf einen Compiler haben.

## Funktioniert gleichermaßen gut für kleine und große Projekte

Die meisten Anwendungen beginnen klein und werden mit der Zeit komplexer. Fastify will
mit dieser Komplexität mitwachsen und bietet fortgeschrittene Funktionen zur Strukturierung von Codebasen.

## Einfache Migration zu Microservices (oder sogar Serverless) und zurück

Wo eine Route deployt wird, sollte keine Rolle spielen. Das Framework sollte „einfach funktionieren".

## Sicherheit und Datenvalidierung

Ein Web-Framework ist der erste Berührungspunkt mit nicht vertrauenswürdigen Daten und muss
die erste Verteidigungslinie des Systems sein.

## Wenn etwas ein Plugin sein könnte, sollte es das wahrscheinlich auch sein

Angesichts der unendlich vielen Anwendungsfälle eines HTTP-Frameworks würde der Versuch, sie
alle in einem einzigen Modul zu bedienen, die Codebasis unwartbar machen. Deshalb werden Hooks und
Optionen bereitgestellt, um das Framework nach Bedarf anzupassen.

## Leicht testbar

Das Testen von Fastify-Anwendungen sollte ein erstklassiges Anliegen sein.

## Den Core nicht monkeypatchen

Node.js-APIs zu monkeypatchen oder Globals zu installieren, die die Laufzeit verändern, erschwert
den Bau modularer Anwendungen und schränkt die Einsatzmöglichkeiten von Fastify ein. Andere
Frameworks tun das; Fastify nicht.

## Semantic Versioning und Long Term Support

Eine klare [Long-Term-Support-Strategie wird bereitgestellt](./LTS.md), damit Entwickler wissen,
wann sie aktualisieren sollten.

## Einhaltung von Spezifikationen

Im Zweifel haben wir uns für das strikte Verhalten entschieden, wie es die einschlägigen
Spezifikationen definieren.
