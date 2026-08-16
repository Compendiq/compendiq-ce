# Beitrag zu Fastify
<a id="contributing"></a>

Vielen Dank für Ihr Interesse daran, zu Fastify beizutragen. Wir freuen uns über Ihre Unterstützung und Ihr Wissen. Dieser Leitfaden ist unser Versuch, Ihnen dabei zu helfen, uns zu helfen.

> ## Hinweis
> Dies ist ein informativer Leitfaden. Für vollständige Details lesen Sie bitte das formelle
> [CONTRIBUTING-Dokument](https://github.com/fastify/fastify/blob/main/CONTRIBUTING.md)
> und unser [Developer Certificate of Origin](https://en.wikipedia.org/wiki/Developer_Certificate_of_Origin).

## Inhaltsverzeichnis
<a id="contributing-toc"></a>

- [Inhaltsverzeichnis](#table-of-contents)
- [Art der Beiträge, die wir suchen](#types-of-contributions-were-looking-for)
- [Grundregeln & Erwartungen](#ground-rules--expectations)
- [Wie man beiträgt](#how-to-contribute)
- [Einrichten Ihrer Umgebung](#setting-up-your-environment)
  - [Verwendung von Visual Studio Code](#using-visual-studio-code)

## Art der Beiträge, die wir suchen
<a id="contribution-types"></a>

Kurz gesagt, wir begrüßen jeden Beitrag, den Sie leisten möchten. Kein Beitrag ist zu klein. Wir freuen uns über Beiträge wie:

* Dokumentationsverbesserungen: von kleinen Tippfehlerkorrekturen bis hin zu großen Überarbeitungen
* Hilfe für andere durch Beantwortung von Fragen in Pull Requests und [Diskussionen](https://github.com/fastify/fastify/discussions)
* Behebung [bekannter Fehler](https://github.com/fastify/fastify/issues?q=is%3Aissue+is%3Aopen+label%3Abug)
* Meldung bisher unbekannter Fehler durch Eröffnung eines Issues mit minimaler Reproduktion

## Grundregeln & Erwartungen
<a id="contributing-rules"></a>

Bevor wir beginnen, gibt es ein paar Dinge, die wir von Ihnen erwarten (und die Sie auch von anderen erwarten sollten):

* Seien Sie in Ihren Gesprächen über dieses Projekt respektvoll und nachdenklich. Dieses Projekt wird von einer vielfältigen Gruppe von Menschen aus aller Welt gepflegt. Jeder hat seine eigenen Ansichten und Meinungen zu dem Projekt. Versuchen Sie, einander zuzuhören und zu einem Einigungspunkt oder Kompromiss zu gelangen.
* Wir haben einen [Code of Conduct](https://github.com/fastify/fastify/blob/main/CODE_OF_CONDUCT.md). Sie müssen sich daran halten, um an diesem Projekt teilzunehmen.
* Wenn Sie einen Pull Request öffnen, stellen Sie bitte sicher, dass Ihr Beitrag alle Tests besteht. Wenn Testfehler vorliegen, müssen diese behoben werden, bevor wir Ihren Beitrag mergen können.

## Wie man beiträgt
<a id="contributing-how-to"></a>

Wenn Sie beitragen möchten, beginnen Sie damit, die [Issues](https://github.com/fastify/fastify/issues) und [Pull Requests](https://github.com/fastify/fastify/pulls) durchzusuchen, um herauszufinden, ob jemand anderes bereits eine ähnliche Idee oder Frage geäußert hat.

Wenn Sie Ihre Idee dort nicht finden und glauben, dass sie zu den Zielen dieses Leitfadens passt, tun Sie eines der folgenden:
* **Wenn Ihr Beitrag geringfügig ist**, wie z. B. eine Tippfehlerkorrektur, öffnen Sie einen Pull Request.
* **Wenn Ihr Beitrag wesentlich ist**, wie z. B. ein neues Feature, beginnen Sie zuerst mit der Eröffnung eines Issues. So können andere vorab zur Diskussion beitragen, bevor Sie Arbeit investieren.

<!--
TODO: add link to a style guide, when we have one, here as in
https://github.com/github/opensource.guide/blob/2868efbf0c14aec821909c19e210c3603a4a7805/CONTRIBUTING.md#style-guide
-->

## Einrichten Ihrer Umgebung
<a id="contributing-environment"></a>

Bitte halten Sie sich an den Code- und Dokumentationsstil des Projekts. Einige beliebte Tools, die Code und Dokumentation automatisch „korrigieren“, folgen nicht dem Stil dieses Projekts. Insbesondere verwendet dieses Projekt [StandardJS](https://standardjs.com) für die Code-Formatierung.

[![Open in Gitpod](https://gitpod.io/button/open-in-gitpod.svg)](https://gitpod.io/#https://github.com/fastify/fastify)

### Verwendung von Visual Studio Code
<a id="contributing-vscode"></a>

Dies beschreibt, wie Sie [Visual Studio Code (VSCode) portable](https://code.visualstudio.com/docs/setup/portable) verwenden, um eine Fastify-spezifische Umgebung einzurichten. Dieser Leitfaden ist so geschrieben, als würden Sie die Umgebung unter macOS einrichten, aber die Prinzipien sind auf allen Plattformen gleich. Sehen Sie sich den zuvor verlinkten VSCode portable Leitfaden für Hilfe bei anderen Plattformen an.

Laden Sie zuerst [VSCode](https://code.visualstudio.com/download) herunter und entpacken Sie es unter `/Applications/VSCodeFastify/`. Wenn Sie dies getan haben, sollte Folgendes im Terminal ausgegeben werden:
```sh
[ -d /Applications/VSCodeFastify/Visual\ Studio\ Code.app ] && echo "found"
```
Wie im VSCode portable Guide erwähnt, müssen wir die Anwendung aus der Sandbox holen, damit der portable Modus korrekt funktioniert. Geben Sie daher im Terminal Folgendes ein:
```sh
xattr -dr com.apple.quarantine /Applications/VSCodeFastify/Visual\ Studio\ Code.app
```
Als Nächstes die erforderlichen Datenverzeichnisse für VSCode erstellen:
```sh
mkdir -p /Applications/VSCodeFastify/code-portable-data/{user-data,extensions}
```
Bevor wir fortfahren, müssen wir den Befehl `code` zu Ihrem Terminal-`PATH` hinzufügen.
Dazu fügen wir VSCode [manuell dem `PATH` hinzu](https://code.visualstudio.com/docs/setup/mac#_launch-vs-code-from-the-command-line).
Wie in diesem Dokument beschrieben, variieren die Anweisungen je nach Ihrer Standard-Shell, daher sollten Sie der Anleitung in diesem Leitfaden folgen, die für Ihre bevorzugte Shell gilt. Wir werden sie jedoch leicht anpassen, indem wir einen Alias definieren, anstatt eine direkte Referenz auf das `code`-Tool. Dies dient dazu, dass wir mit anderen VSCode-Installationen, die Sie möglicherweise haben, keinen Konflikt verursachen und diesen Leitfaden spezifisch für Fastify halten. Letztendlich wollen wir also Folgendes:
```sh
alias code-fastify="/Applications/VSCodeFastify/Visual\ Studio\ Code.app/Contents/Resources/app/bin/code"
```
Das Ergebnis sollte sein, dass `code-fastify --version` etwas wie folgendes ausgibt:
```sh
❯ code-fastify --version
1.50.0
93c2f0fbf16c5a4b10e4d5f89737d9c2c25488a3
x64
```
Da VSCode installiert ist und wir es über die Kommandozeile nutzen können, müssen wir eine Extension installieren, die dabei hilft, jegliches JavaScript, das Sie für das Projekt schreiben, nach dem Stil des Projekts formatiert zu halten:
```sh
code-fastify --install-extension dbaeumer.vscode-eslint
```
Nach erfolgreicher Ausführung des vorherigen Befehls sollte der folgende Befehl
„found“ ausgeben:
```sh
[ -d /Applications/VSCodeFastify/code-portable-data/extensions/dbaeumer.vscode-eslint-* ] && echo "found"
```
Nun können wir von innerhalb des Verzeichnisses Ihres lokalen Klonen des Fastify-Projekts VSCode öffnen:
```sh
code-fastify .
```
Ein neues VSCode-Fenster sollte sich öffnen und Sie sollten die Fastify-Projektdateien in der linken Seitenleiste sehen. Aber warten Sie! Wir sind noch nicht ganz fertig. Es gibt noch ein paar Basis-Einstellungen, die vorgenommen werden sollten, bevor VSCode bereit ist.

Drücken Sie `cmd+shift+p`, um die VSCode-Befehlseingabeaufforderung aufzurufen. Geben Sie `open settings (json)` ein. Drei [VSCode Setting](https://code.visualstudio.com/docs/configure/settings)-Optionen werden im Dropdown-Menü angezeigt: Workspace, Default und User settings. Wir empfehlen die Auswahl von Default. Dadurch wird ein Dokument geöffnet, das die Einstellungen für den Editor enthält. Fügen Sie das folgende JSON in dieses Dokument ein und überschreiben Sie dabei jeglichen vorhandenen Text, und speichern Sie es:
```json
{
    "[javascript]": {
        "editor.defaultFormatter": "dbaeumer.vscode-eslint",
        "editor.codeActionsOnSave": {
            "source.fixAll": true
        }
    },

    "workbench.colorCustomizations": {
        "statusBar.background": "#178bb9"
    }
}
```
Wählen Sie abschließend in der Menüleiste „Terminal > New Terminal“, um ein neues Terminal im Editor zu öffnen. Führen Sie `npm i` aus, um die Fastify-Abhängigkeiten zu installieren.

An dieser Stelle ist alles eingerichtet mit einer benutzerdefinierten VSCode-Instanz, die für die Arbeit an Fastify-Beiträgen verwendet werden kann. Wenn Sie JavaScript-Dateien bearbeiten und speichern, korrigiert der Editor automatisch Stilprobleme.