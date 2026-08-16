### root

- **CLI:** `-r, --root <path>`
- **Konfiguration:** [root](/config/root)

Wurzelpfad

### config

- **CLI:** `-c, --config <path>`

Pfad zur Konfigurationsdatei

### update

- **CLI:** `-u, --update [type]`
- **Konfiguration:** [update](/config/update)

Snapshot aktualisieren (akzeptiert boolean, "new", "all" oder "none")

### watch

- **CLI:** `-w, --watch`
- **Konfiguration:** [watch](/config/watch)

Watch-Modus aktivieren

### testNamePattern

- **CLI:** `-t, --testNamePattern <pattern>`
- **Konfiguration:** [testNamePattern](/config/testnamepattern)

Führt Tests aus, deren vollständige Namen auf das angegebene Regexp-Muster passen

### dir

- **CLI:** `--dir <path>`
- **Konfiguration:** [dir](/config/dir)

Basisverzeichnis, das nach den Testdateien durchsucht wird

### ui

- **CLI:** `--ui`

UI aktivieren

### open

- **CLI:** `--open`
- **Konfiguration:** [open](/config/open)

UI automatisch öffnen (Standard: `!process.env.CI`)

### api.port

- **CLI:** `--api.port [port]`

Gibt den Serverport an. Beachten Sie: Ist der Port bereits belegt, versucht Vite automatisch den nächsten freien Port, sodass dies möglicherweise nicht der Port ist, auf dem der Server letztlich lauscht. Bei true wird `51204` gesetzt

### api.host

- **CLI:** `--api.host [host]`

Gibt an, auf welchen IP-Adressen der Server lauschen soll. Setzen Sie dies auf `0.0.0.0` oder `true`, um auf allen Adressen zu lauschen, einschließlich LAN- und öffentlicher Adressen

### api.strictPort

- **CLI:** `--api.strictPort`

Auf true setzen, um bei bereits belegtem Port abzubrechen, statt automatisch den nächsten freien Port zu versuchen

### api.allowExec

- **CLI:** `--api.allowExec`
- **Konfiguration:** [api.allowExec](/config/api#api-allowexec)

Erlaubt der API, Code auszuführen. (Vorsicht beim Aktivieren dieser Option in nicht vertrauenswürdigen Umgebungen)

### api.allowWrite

- **CLI:** `--api.allowWrite`
- **Konfiguration:** [api.allowWrite](/config/api#api-allowwrite)

Erlaubt der API, Dateien zu bearbeiten. (Vorsicht beim Aktivieren dieser Option in nicht vertrauenswürdigen Umgebungen)

### silent

- **CLI:** `--silent [value]`
- **Konfiguration:** [silent](/config/silent)

Unterdrückt die Konsolenausgabe aus Tests. Verwenden Sie `'passed-only'`, um nur Logs fehlschlagender Tests zu sehen.

### hideSkippedTests

- **CLI:** `--hideSkippedTests`

Blendet Logs für übersprungene Tests aus

### reporters

- **CLI:** `--reporter <name>`
- **Konfiguration:** [reporters](/config/reporters)

Gibt die Reporter an (default, agent, minimal, blob, verbose, dot, json, tap, tap-flat, junit, tree, hanging-process, github-actions)

### outputFile

- **CLI:** `--outputFile <filename/-s>`
- **Konfiguration:** [outputFile](/config/outputfile)

Schreibt die Testergebnisse in eine Datei, wenn zusätzlich ein unterstützender Reporter angegeben ist; verwenden Sie cacs Punktnotation für einzelne Ausgaben mehrerer Reporter (Beispiel: `--outputFile.tap=./tap.txt`)

### coverage.provider

- **CLI:** `--coverage.provider <name>`
- **Konfiguration:** [coverage.provider](/config/coverage#coverage-provider)

Wählt das Werkzeug zur Coverage-Erfassung; verfügbare Werte sind: "v8", "istanbul" und "custom"

### coverage.enabled

- **CLI:** `--coverage.enabled`
- **Konfiguration:** [coverage.enabled](/config/coverage#coverage-enabled)

Aktiviert die Coverage-Erfassung. Kann über die CLI-Option `--coverage` überschrieben werden (Standard: `false`)

### coverage.include

- **CLI:** `--coverage.include <pattern>`
- **Konfiguration:** [coverage.include](/config/coverage#coverage-include)

In die Coverage einbezogene Dateien als Glob-Muster. Kann bei mehreren Mustern mehrfach angegeben werden. Standardmäßig werden nur Dateien einbezogen, die von Tests abgedeckt sind.

### coverage.exclude

- **CLI:** `--coverage.exclude <pattern>`
- **Konfiguration:** [coverage.exclude](/config/coverage#coverage-exclude)

Von der Coverage auszuschließende Dateien. Kann bei mehreren Erweiterungen mehrfach angegeben werden.

### coverage.clean

- **CLI:** `--coverage.clean`
- **Konfiguration:** [coverage.clean](/config/coverage#coverage-clean)

Löscht Coverage-Ergebnisse vor dem Ausführen der Tests (Standard: true)

### coverage.cleanOnRerun

- **CLI:** `--coverage.cleanOnRerun`
- **Konfiguration:** [coverage.cleanOnRerun](/config/coverage#coverage-cleanonrerun)

Löscht den Coverage-Report bei einem erneuten Lauf im Watch-Modus (Standard: true)

### coverage.reportsDirectory

- **CLI:** `--coverage.reportsDirectory <path>`
- **Konfiguration:** [coverage.reportsDirectory](/config/coverage#coverage-reportsdirectory)

Verzeichnis, in das der Coverage-Report geschrieben wird (Standard: ./coverage)

### coverage.reporter

- **CLI:** `--coverage.reporter <name>`
- **Konfiguration:** [coverage.reporter](/config/coverage#coverage-reporter)

Zu verwendende Coverage-Reporter. Weitere Informationen unter [`coverage.reporter`](/config/coverage#coverage-reporter) (Standard: `["text", "html", "clover", "json"]`)

### coverage.reportOnFailure

- **CLI:** `--coverage.reportOnFailure`
- **Konfiguration:** [coverage.reportOnFailure](/config/coverage#coverage-reportonfailure)

Erzeugt den Coverage-Report auch dann, wenn Tests fehlschlagen (Standard: `false`)

### coverage.allowExternal

- **CLI:** `--coverage.allowExternal`
- **Konfiguration:** [coverage.allowExternal](/config/coverage#coverage-allowexternal)

Erfasst Coverage für Dateien außerhalb des Projekt-Roots (Standard: `false`)

### coverage.skipFull

- **CLI:** `--coverage.skipFull`
- **Konfiguration:** [coverage.skipFull](/config/coverage#coverage-skipfull)

Zeigt keine Dateien mit 100 % Statement-, Branch- und Function-Coverage an (Standard: `false`)

### coverage.thresholds.100

- **CLI:** `--coverage.thresholds.100`
- **Konfiguration:** [coverage.thresholds.100](/config/coverage#coverage-thresholds-100)

Kurzform, um alle Coverage-Schwellwerte auf 100 zu setzen (Standard: `false`)

### coverage.thresholds.perFile

- **CLI:** `--coverage.thresholds.perFile <boolean>`
- **Konfiguration:** [coverage.thresholds.perFile](/config/coverage#coverage-thresholds-perfile)

Prüft die Schwellwerte pro Datei. Die tatsächlichen Schwellwerte finden Sie unter `--coverage.thresholds.lines`, `--coverage.thresholds.functions`, `--coverage.thresholds.branches` und `--coverage.thresholds.statements` (Standard: `false`). Die Objektform ist nur in Konfigurationsdateien verfügbar.

### coverage.thresholds.autoUpdate

- **CLI:** `--coverage.thresholds.autoUpdate <boolean|function>`
- **Konfiguration:** [coverage.thresholds.autoUpdate](/config/coverage#coverage-thresholds-autoupdate)

Aktualisiert die Schwellwerte "lines", "functions", "branches" und "statements" in der Konfigurationsdatei, wenn die aktuelle Coverage über den konfigurierten Schwellwerten liegt (Standard: `false`)

### coverage.thresholds.lines

- **CLI:** `--coverage.thresholds.lines <number>`

Schwellwert für Zeilen. Weitere Informationen finden Sie bei [istanbuljs](https://github.com/istanbuljs/nyc#coverage-thresholds). Diese Option ist für eigene Provider nicht verfügbar

### coverage.thresholds.functions

- **CLI:** `--coverage.thresholds.functions <number>`

Schwellwert für Funktionen. Weitere Informationen finden Sie bei [istanbuljs](https://github.com/istanbuljs/nyc#coverage-thresholds). Diese Option ist für eigene Provider nicht verfügbar

### coverage.thresholds.branches

- **CLI:** `--coverage.thresholds.branches <number>`

Schwellwert für Branches. Weitere Informationen finden Sie bei [istanbuljs](https://github.com/istanbuljs/nyc#coverage-thresholds). Diese Option ist für eigene Provider nicht verfügbar

### coverage.thresholds.statements

- **CLI:** `--coverage.thresholds.statements <number>`

Schwellwert für Statements. Weitere Informationen finden Sie bei [istanbuljs](https://github.com/istanbuljs/nyc#coverage-thresholds). Diese Option ist für eigene Provider nicht verfügbar

### coverage.ignoreClassMethods

- **CLI:** `--coverage.ignoreClassMethods <name>`
- **Konfiguration:** [coverage.ignoreClassMethods](/config/coverage#coverage-ignoreclassmethods)

Array von Klassenmethodennamen, die bei der Coverage ignoriert werden. Weitere Informationen finden Sie bei [istanbuljs](https://github.com/istanbuljs/nyc#ignoring-methods). Diese Option ist nur für die istanbul-Provider verfügbar (Standard: `[]`)

### coverage.processingConcurrency

- **CLI:** `--coverage.processingConcurrency <number>`
- **Konfiguration:** [coverage.processingConcurrency](/config/coverage#coverage-processingconcurrency)

Nebenläufigkeitsgrenze bei der Verarbeitung der Coverage-Ergebnisse. (Standard: Minimum aus 20 und der Anzahl der CPUs)

### coverage.customProviderModule

- **CLI:** `--coverage.customProviderModule <path>`
- **Konfiguration:** [coverage.customProviderModule](/config/coverage#coverage-customprovidermodule)

Gibt den Modulnamen oder Pfad für das eigene Coverage-Provider-Modul an. Weitere Informationen unter [Custom Coverage Provider](/guide/coverage#custom-coverage-provider). Diese Option ist nur für eigene Provider verfügbar

### coverage.watermarks.statements

- **CLI:** `--coverage.watermarks.statements <watermarks>`

Oberer und unterer Schwellwert für Statements im Format `<high>,<low>`

### coverage.watermarks.lines

- **CLI:** `--coverage.watermarks.lines <watermarks>`

Oberer und unterer Schwellwert für Zeilen im Format `<high>,<low>`

### coverage.watermarks.branches

- **CLI:** `--coverage.watermarks.branches <watermarks>`

Oberer und unterer Schwellwert für Branches im Format `<high>,<low>`

### coverage.watermarks.functions

- **CLI:** `--coverage.watermarks.functions <watermarks>`

Oberer und unterer Schwellwert für Funktionen im Format `<high>,<low>`

### coverage.changed

- **CLI:** `--coverage.changed <commit/branch>`
- **Konfiguration:** [coverage.changed](/config/coverage#coverage-changed)

Erfasst Coverage nur für Dateien, die seit einem bestimmten Commit oder Branch geändert wurden (z. B. `origin/main` oder `HEAD~1`). Übernimmt den Wert standardmäßig von `--changed`.

### coverage.excludeAfterRemap

- **CLI:** `--coverage.excludeAfterRemap`
- **Konfiguration:** [coverage.excludeAfterRemap](/config/coverage#coverage-excludeafterremap)

Wendet die Ausschlüsse erneut an, nachdem die Coverage auf die ursprünglichen Quellen zurückgemappt wurde. (Standard: false)

### coverage.htmlDir

- **CLI:** `--coverage.htmlDir <path>`
- **Konfiguration:** [coverage.htmlDir](/config/coverage#coverage-htmldir)

Verzeichnis der HTML-Coverage-Ausgabe, die im UI-Modus und vom HTML-Reporter ausgeliefert wird.

### coverage.autoAttachSubprocess

- **CLI:** `--coverage.autoAttachSubprocess`
- **Konfiguration:** [coverage.autoAttachSubprocess](/config/coverage#coverage-autoattachsubprocess)

Erfasst die Coverage von `node:child_process` und `node:worker_threads`, die während des Testlaufs gestartet werden. Wird nur vom Provider `v8` unterstützt. (Standard: false)

### mode

- **CLI:** `--mode <name>`
- **Konfiguration:** [mode](/config/mode)

Überschreibt den Vite-Modus (Standard: `test`)

### isolate

- **CLI:** `--isolate`
- **Konfiguration:** [isolate](/config/isolate)

Führt jede Testdatei isoliert aus. Um die Isolation zu deaktivieren, verwenden Sie `--no-isolate` (Standard: `true`)

### globals

- **CLI:** `--globals`
- **Konfiguration:** [globals](/config/globals)

Stellt die APIs global bereit

### injectCjsGlobals

- **CLI:** `--injectCjsGlobals`
- **Konfiguration:** [injectCjsGlobals](/config/injectcjsglobals)

Fügt CommonJS-Variablen (`module`, `exports`, `require`, `__filename`, `__dirname`) in jedes Testmodul ein. Zum Deaktivieren verwenden Sie `--no-inject-cjs-globals` (Standard: `true`)

### dom

- **CLI:** `--dom`

Mockt die Browser-API mit happy-dom

### browser.enabled

- **CLI:** `--browser.enabled`
- **Konfiguration:** [browser.enabled](/config/browser/enabled)

Führt Tests im Browser aus. Entspricht `--browser.enabled` (Standard: `false`)

### browser.name

- **CLI:** `--browser.name <name>`

Führt alle Tests in einem bestimmten Browser aus. Manche Browser sind nur für bestimmte Provider verfügbar (siehe `--browser.provider`).

### browser.headless

- **CLI:** `--browser.headless`
- **Konfiguration:** [browser.headless](/config/browser/headless)

Führt den Browser im Headless-Modus aus (also ohne die GUI (grafische Benutzeroberfläche) zu öffnen). Wenn Sie Vitest in der CI ausführen, ist das standardmäßig aktiviert (Standard: `process.env.CI`)

### browser.ui

- **CLI:** `--browser.ui`
- **Konfiguration:** [browser.ui](/config/browser/ui)

Zeigt die Vitest UI beim Ausführen der Tests an (Standard: `!process.env.CI`)

### browser.detailsPanelPosition

- **CLI:** `--browser.detailsPanelPosition <position>`
- **Konfiguration:** [browser.detailsPanelPosition](/config/browser/detailspanelposition)

Standardposition des Detailbereichs im Browser-Modus. Entweder `right` (horizontale Teilung) oder `bottom` (vertikale Teilung) (Standard: `right`)

### browser.connectTimeout

- **CLI:** `--browser.connectTimeout <timeout>`
- **Konfiguration:** [browser.connectTimeout](/config/browser/connecttimeout)

Dauert der Verbindungsaufbau zum Browser länger, schlägt die Test-Suite fehl (Standard: `60_000`)

### browser.dependencySourcemaps

- **CLI:** `--browser.dependencySourcemaps`
- **Konfiguration:** [browser.dependencySourcemaps](/config/browser/dependencysourcemaps)

Liefert bei Headless-Läufen Sourcemaps von Abhängigkeiten an den Browser aus; sie werden von den Devtools beim Debuggen in `node_modules` verwendet. Gemeldete Testfehler werden ohnehin über Source Maps aufgelöst. Verwenden Sie `--browser.dependencySourcemaps=false`, um Testläufe zu beschleunigen, wenn Sie nicht in Abhängigkeitscode hineinspringen (Standard: `true`)

### browser.trackUnhandledErrors

- **CLI:** `--browser.trackUnhandledErrors`
- **Konfiguration:** [browser.trackUnhandledErrors](/config/browser/trackunhandlederrors)

Steuert, ob Vitest nicht abgefangene Exceptions auffängt, damit sie gemeldet werden können (Standard: `true`)

### browser.trace

- **CLI:** `--browser.trace <mode>`
- **Konfiguration:** [browser.trace](/config/browser/trace)

Aktiviert den Trace-View-Modus. Unterstützt: "on", "off", "on-first-retry", "on-all-retries", "retain-on-failure".

### browser.traceView.enabled

- **CLI:** `--browser.traceView.enabled`
- **Konfiguration:** [browser.traceView.enabled](/config/browser/traceview#traceview-enabled)

Aktiviert die Erfassung der Vitest-Trace-View für Browser-Tests (Standard: `false`)

### browser.traceView.recordCanvas

- **CLI:** `--browser.traceView.recordCanvas`
- **Konfiguration:** [browser.traceView.recordCanvas](/config/browser/traceview#traceview-recordcanvas)

Erfasst Canvas-Pixel in Trace-View-Snapshots (Standard: `false`)

### browser.traceView.inlineImages

- **CLI:** `--browser.traceView.inlineImages`
- **Konfiguration:** [browser.traceView.inlineImages](/config/browser/traceview#traceview-inlineimages)

Bettet geladene Bildpixel inline in Trace-View-Snapshots ein (Standard: `false`)

### browser.locators.exact

- **CLI:** `--browser.locators.exact`
- **Konfiguration:** [browser.locators.exact](/config/browser/locators#locators-exact)

Sollen Locators den Text standardmäßig exakt abgleichen (Standard: `true`)

### pool

- **CLI:** `--pool <pool>`
- **Konfiguration:** [pool](/config/pool)

Gibt den Pool an, wenn nicht im Browser ausgeführt wird (Standard: `forks`)

### execArgv

- **CLI:** `--execArgv <option>`
- **Konfiguration:** [execArgv](/config/execargv)

Übergibt zusätzliche Argumente an den `node`-Prozess beim Starten von `worker_threads` oder `child_process`.

### vmMemoryLimit

- **CLI:** `--vmMemoryLimit <limit>`
- **Konfiguration:** [vmMemoryLimit](/config/vmmemorylimit)

Speichergrenze für VM-Pools. Wenn Sie Speicherlecks feststellen, versuchen Sie, an diesem Wert zu drehen.

### fileParallelism

- **CLI:** `--fileParallelism`
- **Konfiguration:** [fileParallelism](/config/fileparallelism)

Sollen alle Testdateien parallel laufen. Verwenden Sie `--no-file-parallelism` zum Deaktivieren (Standard: `true`)

### maxWorkers

- **CLI:** `--maxWorkers <workers>`
- **Konfiguration:** [maxWorkers](/config/maxworkers)

Maximale Anzahl oder maximaler Prozentsatz an Workern, in denen Tests laufen

### environment

- **CLI:** `--environment <name>`
- **Konfiguration:** [environment](/config/environment)

Gibt die Runner-Umgebung an, wenn nicht im Browser ausgeführt wird (Standard: `node`)

### passWithNoTests

- **CLI:** `--passWithNoTests`
- **Konfiguration:** [passWithNoTests](/config/passwithnotests)

Gilt als erfolgreich, wenn keine Tests gefunden werden

### logHeapUsage

- **CLI:** `--logHeapUsage`
- **Konfiguration:** [logHeapUsage](/config/logheapusage)

Zeigt beim Ausführen in node die Heap-Größe für jeden Test an

### detectAsyncLeaks

- **CLI:** `--detectAsyncLeaks`
- **Konfiguration:** [detectAsyncLeaks](/config/detectasyncleaks)

Erkennt asynchrone Ressourcen, die aus der Testdatei entweichen (Standard: `false`)

### allowOnly

- **CLI:** `--allowOnly`
- **Konfiguration:** [allowOnly](/config/allowonly)

Erlaubt Tests und Suites, die als only markiert sind (Standard: `!process.env.CI`)

### dangerouslyIgnoreUnhandledErrors

- **CLI:** `--dangerouslyIgnoreUnhandledErrors`
- **Konfiguration:** [dangerouslyIgnoreUnhandledErrors](/config/dangerouslyignoreunhandlederrors)

Ignoriert alle auftretenden, nicht behandelten Fehler

### changed

- **CLI:** `--changed [since]`
- **Konfiguration:** [changed](/config/changed)

Führt Tests aus, die von den geänderten Dateien betroffen sind (Standard: `false`)

### sequence.shuffle.files

- **CLI:** `--sequence.shuffle.files`
- **Konfiguration:** [sequence.shuffle.files](/config/sequence#sequence-shuffle-files)

Führt Dateien in zufälliger Reihenfolge aus. Lang laufende Tests starten dadurch nicht früher. (Standard: `false`)

### sequence.shuffle.tests

- **CLI:** `--sequence.shuffle.tests`
- **Konfiguration:** [sequence.shuffle.tests](/config/sequence#sequence-shuffle-tests)

Führt Tests in zufälliger Reihenfolge aus (Standard: `false`)

### sequence.concurrent

- **CLI:** `--sequence.concurrent`
- **Konfiguration:** [sequence.concurrent](/config/sequence#sequence-concurrent)

Lässt Tests parallel laufen (Standard: `false`)

### sequence.seed

- **CLI:** `--sequence.seed <seed>`
- **Konfiguration:** [sequence.seed](/config/sequence#sequence-seed)

Setzt den Zufalls-Seed. Diese Option hat keine Wirkung, wenn `--sequence.shuffle` falsy ist. Weitere Informationen auf der [Seite "Random Seed"](https://en.wikipedia.org/wiki/Random_seed)

### sequence.hooks

- **CLI:** `--sequence.hooks <order>`
- **Konfiguration:** [sequence.hooks](/config/sequence#sequence-hooks)

Ändert die Reihenfolge, in der Hooks ausgeführt werden. Akzeptierte Werte sind: "stack", "list" und "parallel". Weitere Informationen unter [`sequence.hooks`](/config/sequence#sequence-hooks) (Standard: `"parallel"`)

### sequence.setupFiles

- **CLI:** `--sequence.setupFiles <order>`
- **Konfiguration:** [sequence.setupFiles](/config/sequence#sequence-setupfiles)

Ändert die Reihenfolge, in der Setup-Dateien ausgeführt werden. Akzeptierte Werte sind: "list" und "parallel". Bei "list" werden die Setup-Dateien in der Reihenfolge ihrer Definition ausgeführt. Bei "parallel" werden sie parallel ausgeführt (Standard: `"parallel"`)

### inspect

- **CLI:** `--inspect [[host:]port]`

Aktiviert den Node.js-Inspector (Standard: `127.0.0.1:9229`)

### inspectBrk

- **CLI:** `--inspectBrk [[host:]port]`

Aktiviert den Node.js-Inspector und hält vor dem Start des Tests an

### testTimeout

- **CLI:** `--testTimeout <timeout>`
- **Konfiguration:** [testTimeout](/config/testtimeout)

Standard-Timeout eines Tests in Millisekunden (Standard: `5000`). Verwenden Sie `0`, um das Timeout vollständig zu deaktivieren.

### hookTimeout

- **CLI:** `--hookTimeout <timeout>`
- **Konfiguration:** [hookTimeout](/config/hooktimeout)

Standard-Timeout eines Hooks in Millisekunden (Standard: `10000`). Verwenden Sie `0`, um das Timeout vollständig zu deaktivieren.

### bail

- **CLI:** `--bail <number>`
- **Konfiguration:** [bail](/config/bail)

Bricht die Testausführung ab, wenn die angegebene Anzahl an Tests fehlgeschlagen ist (Standard: `0`)

### retry.count

- **CLI:** `--retry.count <times>`
- **Konfiguration:** [retry.count](/config/retry#retry-count)

Anzahl der Wiederholungen eines Tests, wenn er fehlschlägt (Standard: `0`)

### retry.delay

- **CLI:** `--retry.delay <ms>`
- **Konfiguration:** [retry.delay](/config/retry#retry-delay)

Verzögerung in Millisekunden zwischen Wiederholungsversuchen (Standard: `0`)

### retry.condition

- **CLI:** `--retry.condition <pattern>`
- **Konfiguration:** [retry.condition](/config/retry#retry-condition)

Regex-Muster, das auf Fehlermeldungen passen muss, damit ein erneuter Versuch ausgelöst wird. Nur Fehler, die auf dieses Muster passen, führen zu einer Wiederholung (Standard: Wiederholung bei allen Fehlern)

### repeats

- **CLI:** `--repeats <number>`
- **Konfiguration:** [repeats](/config/repeats)

Wiederholt jeden Test unabhängig vom Ergebnis eine bestimmte Anzahl von Malen (Standard: `0`)

### diff.aAnnotation

- **CLI:** `--diff.aAnnotation <annotation>`
- **Konfiguration:** [diff.aAnnotation](/config/diff#diff-aannotation)

Annotation für erwartete Zeilen (Standard: `Expected`)

### diff.aIndicator

- **CLI:** `--diff.aIndicator <indicator>`
- **Konfiguration:** [diff.aIndicator](/config/diff#diff-aindicator)

Kennzeichen für erwartete Zeilen (Standard: `-`)

### diff.bAnnotation

- **CLI:** `--diff.bAnnotation <annotation>`
- **Konfiguration:** [diff.bAnnotation](/config/diff#diff-bannotation)

Annotation für erhaltene Zeilen (Standard: `Received`)

### diff.bIndicator

- **CLI:** `--diff.bIndicator <indicator>`
- **Konfiguration:** [diff.bIndicator](/config/diff#diff-bindicator)

Kennzeichen für erhaltene Zeilen (Standard: `+`)

### diff.commonIndicator

- **CLI:** `--diff.commonIndicator <indicator>`
- **Konfiguration:** [diff.commonIndicator](/config/diff#diff-commonindicator)

Kennzeichen für gemeinsame Zeilen (Standard: ` `)

### diff.contextLines

- **CLI:** `--diff.contextLines <lines>`
- **Konfiguration:** [diff.contextLines](/config/diff#diff-contextlines)

Anzahl der Kontextzeilen, die um jede Änderung herum angezeigt werden (Standard: `5`)

### diff.emptyFirstOrLastLinePlaceholder

- **CLI:** `--diff.emptyFirstOrLastLinePlaceholder <placeholder>`
- **Konfiguration:** [diff.emptyFirstOrLastLinePlaceholder](/config/diff#diff-emptyfirstorlastlineplaceholder)

Platzhalter für eine leere erste oder letzte Zeile (Standard: `""`)

### diff.expand

- **CLI:** `--diff.expand`
- **Konfiguration:** [diff.expand](/config/diff#diff-expand)

Klappt alle gemeinsamen Zeilen auf (Standard: `true`)

### diff.includeChangeCounts

- **CLI:** `--diff.includeChangeCounts`
- **Konfiguration:** [diff.includeChangeCounts](/config/diff#diff-includechangecounts)

Nimmt Vergleichszähler in die Diff-Ausgabe auf (Standard: `false`)

### diff.omitAnnotationLines

- **CLI:** `--diff.omitAnnotationLines`
- **Konfiguration:** [diff.omitAnnotationLines](/config/diff#diff-omitannotationlines)

Lässt Annotationszeilen in der Ausgabe weg (Standard: `false`)

### diff.printBasicPrototype

- **CLI:** `--diff.printBasicPrototype`
- **Konfiguration:** [diff.printBasicPrototype](/config/diff#diff-printbasicprototype)

Gibt den Basisprototyp Object und Array aus (Standard: `true`)

### diff.maxDepth

- **CLI:** `--diff.maxDepth <maxDepth>`
- **Konfiguration:** [diff.maxDepth](/config/diff#diff-maxdepth)

Begrenzt die Rekursionstiefe beim Ausgeben verschachtelter Objekte (Standard: `20`)

### diff.truncateThreshold

- **CLI:** `--diff.truncateThreshold <threshold>`
- **Konfiguration:** [diff.truncateThreshold](/config/diff#diff-truncatethreshold)

Anzahl der Zeilen, die vor und nach jeder Änderung angezeigt werden (Standard: `0`)

### diff.truncateAnnotation

- **CLI:** `--diff.truncateAnnotation <annotation>`
- **Konfiguration:** [diff.truncateAnnotation](/config/diff#diff-truncateannotation)

Annotation für gekürzte Zeilen (Standard: `... Diff result is truncated`)

### exclude

- **CLI:** `--exclude <glob>`
- **Konfiguration:** [exclude](/config/exclude)

Zusätzliche Datei-Globs, die vom Test ausgeschlossen werden

### expandSnapshotDiff

- **CLI:** `--expandSnapshotDiff`
- **Konfiguration:** [expandSnapshotDiff](/config/expandsnapshotdiff)

Zeigt das vollständige Diff, wenn ein Snapshot fehlschlägt

### disableConsoleIntercept

- **CLI:** `--disableConsoleIntercept`
- **Konfiguration:** [disableConsoleIntercept](/config/disableconsoleintercept)

Deaktiviert das automatische Abfangen von Konsolenausgaben (Standard: `false`)

### typecheck.enabled

- **CLI:** `--typecheck.enabled`
- **Konfiguration:** [typecheck.enabled](/config/typecheck#typecheck-enabled)

Aktiviert die Typprüfung parallel zu den Tests (Standard: `false`)

### typecheck.only

- **CLI:** `--typecheck.only`
- **Konfiguration:** [typecheck.only](/config/typecheck#typecheck-only)

Führt nur Typecheck-Tests aus. Das aktiviert automatisch typecheck (Standard: `false`)

### typecheck.checker

- **CLI:** `--typecheck.checker <name>`
- **Konfiguration:** [typecheck.checker](/config/typecheck#typecheck-checker)

Gibt den zu verwendenden Typechecker an. Verfügbare Werte sind: "tsc" und "vue-tsc" sowie ein Pfad zu einer ausführbaren Datei (Standard: `"tsc"`)

### typecheck.allowJs

- **CLI:** `--typecheck.allowJs`
- **Konfiguration:** [typecheck.allowJs](/config/typecheck#typecheck-allowjs)

Erlaubt die Typprüfung von JavaScript-Dateien. Übernimmt den Wert standardmäßig aus der tsconfig.json

### typecheck.ignoreSourceErrors

- **CLI:** `--typecheck.ignoreSourceErrors`
- **Konfiguration:** [typecheck.ignoreSourceErrors](/config/typecheck#typecheck-ignoresourceerrors)

Ignoriert Typfehler aus Quelldateien

### typecheck.build

- **CLI:** `--typecheck.build`
- **Konfiguration:** [typecheck.build](/config/typecheck#typecheck-build)

Verwendet den TypeScript-Build-Modus

### typecheck.tsconfig

- **CLI:** `--typecheck.tsconfig <path>`
- **Konfiguration:** [typecheck.tsconfig](/config/typecheck#typecheck-tsconfig)

Pfad zu einer eigenen tsconfig-Datei

### typecheck.spawnTimeout

- **CLI:** `--typecheck.spawnTimeout <time>`
- **Konfiguration:** [typecheck.spawnTimeout](/config/typecheck#typecheck-spawntimeout)

Mindestzeit in Millisekunden, die das Starten des Typecheckers dauert

### project

- **CLI:** `-p, --project <name>`

Der Name des auszuführenden Projekts, wenn Sie das Workspace-Feature von Vitest verwenden. Das lässt sich für mehrere Projekte wiederholen: `--project=1 --project=2`. Sie können Projekte auch über Wildcards wie `--project=packages*` filtern und mit `--project=!pattern` ausschließen.

### slowTestThreshold

- **CLI:** `--slowTestThreshold <threshold>`
- **Konfiguration:** [slowTestThreshold](/config/slowtestthreshold)

Schwellwert in Millisekunden, ab dem ein Test oder eine Suite als langsam gilt (Standard: `300`)

### teardownTimeout

- **CLI:** `--teardownTimeout <timeout>`
- **Konfiguration:** [teardownTimeout](/config/teardowntimeout)

Standard-Timeout einer Teardown-Funktion in Millisekunden (Standard: `10000`)

### maxConcurrency

- **CLI:** `--maxConcurrency <number>`
- **Konfiguration:** [maxConcurrency](/config/maxconcurrency)

Maximale Anzahl nebenläufiger Tests und Suites während der Ausführung einer Testdatei (Standard: `5`)

### fsModuleCache

- **CLI:** `--fsModuleCache`
- **Konfiguration:** [fsModuleCache](/config/fsmodulecache)

Cacht transformierte Module im Dateisystem und verwendet sie zwischen erneuten Läufen wieder (Standard: `false`)

### fsModuleCachePath

- **CLI:** `--fsModuleCachePath <path>`
- **Konfiguration:** [fsModuleCachePath](/config/fsmodulecachepath)

Verzeichnis, in dem der `fsModuleCache` abgelegt wird (Standard: `node_modules/.vitest-cache`)

### expect.requireAssertions

- **CLI:** `--expect.requireAssertions`
- **Konfiguration:** [expect.requireAssertions](/config/expect#expect-requireassertions)

Verlangt, dass alle Tests mindestens eine Assertion enthalten

### expect.poll.interval

- **CLI:** `--expect.poll.interval <interval>`
- **Konfiguration:** [expect.poll.interval](/config/expect#expect-poll-interval)

Poll-Intervall in Millisekunden für `expect.poll()`-Assertions (Standard: `50`)

### expect.poll.timeout

- **CLI:** `--expect.poll.timeout <timeout>`
- **Konfiguration:** [expect.poll.timeout](/config/expect#expect-poll-timeout)

Poll-Timeout in Millisekunden für `expect.poll()`-Assertions (Standard: `1000`)

### printConsoleTrace

- **CLI:** `--printConsoleTrace`
- **Konfiguration:** [printConsoleTrace](/config/printconsoletrace)

Gibt immer Konsolen-Stacktraces aus

### includeTaskLocation

- **CLI:** `--includeTaskLocation`
- **Konfiguration:** [includeTaskLocation](/config/includetasklocation)

Erfasst Test- und Suite-Positionen in der Eigenschaft `location`

### attachmentsDir

- **CLI:** `--attachmentsDir <dir>`
- **Konfiguration:** [attachmentsDir](/config/attachmentsdir)

Das Verzeichnis, in dem Attachments aus `context.annotate` abgelegt werden (Standard: `.vitest/attachments`)

### run

- **CLI:** `--run`

Deaktiviert den Watch-Modus

### color

- **CLI:** `--no-color`

Entfernt Farben aus der Konsolenausgabe

### clearScreen

- **CLI:** `--clearScreen`

Leert den Terminalbildschirm beim erneuten Ausführen der Tests im Watch-Modus (Standard: `true`)

### configLoader

- **CLI:** `--configLoader <loader>`

Verwenden Sie `bundle`, um die Konfiguration mit esbuild zu bündeln, oder `runner` (experimentell), um sie zur Laufzeit zu verarbeiten. Das ist nur ab vite-Version 6.1.0 verfügbar. (Standard: `bundle`)

### standalone

- **CLI:** `--standalone`

Startet Vitest, ohne Tests auszuführen. Tests laufen nur bei Änderungen. Ist der Browser-Modus aktiviert, wird die UI automatisch geöffnet. Diese Option wird ignoriert, wenn CLI-Dateifilter übergeben werden. (Standard: `false`)

### listTags

- **CLI:** `--listTags [type]`

Listet alle verfügbaren Tags auf, statt Tests auszuführen. `--list-tags=json` gibt die Tags im JSON-Format aus, sofern Tags vorhanden sind.

### clearCache

- **CLI:** `--clearCache`

Löscht alle Vitest-Caches einschließlich des `fsModuleCache`, ohne Tests auszuführen. Das verringert die Performance des darauffolgenden Testlaufs.

### tagsFilter

- **CLI:** `--tagsFilter <expression>`

Führt nur Tests mit den angegebenen Tags aus. Sie können die logischen Operatoren `&&` (und), `||` (oder) und `!` (nicht) verwenden, um komplexe Ausdrücke zu bilden; weitere Informationen unter [Test Tags](/guide/test-tags#syntax).

### strictTags

- **CLI:** `--strictTags`
- **Konfiguration:** [strictTags](/config/stricttags)

Soll Vitest einen Fehler werfen, wenn ein Test ein Tag hat, das nicht in der Konfiguration definiert ist. (Standard: `true`)

### experimental.importDurations.print

- **CLI:** `--experimental.importDurations.print <boolean|on-warn>`
- **Konfiguration:** [experimental.importDurations.print](/config/experimental#experimental-importdurations-print)

Wann die Import-Aufschlüsselung im CLI-Terminal ausgegeben wird. Verwenden Sie `true`, um sie immer auszugeben, `false`, um sie nie auszugeben, oder `on-warn`, um sie nur auszugeben, wenn Importe den Warn-Schwellwert überschreiten (Standard: false).

### experimental.importDurations.limit

- **CLI:** `--experimental.importDurations.limit <number>`
- **Konfiguration:** [experimental.importDurations.limit](/config/experimental#experimental-importdurations-limit)

Maximale Anzahl an Importen, die erfasst und angezeigt werden (Standard: 0, oder 10, wenn print oder die UI aktiviert ist).

### experimental.importDurations.failOnDanger

- **CLI:** `--experimental.importDurations.failOnDanger`
- **Konfiguration:** [experimental.importDurations.failOnDanger](/config/experimental#experimental-importdurations-failondanger)

Lässt den Testlauf fehlschlagen, wenn ein Import den Danger-Schwellwert überschreitet (Standard: false).

### experimental.importDurations.thresholds.warn

- **CLI:** `--experimental.importDurations.thresholds.warn <number>`
- **Konfiguration:** [experimental.importDurations.thresholds.warn](/config/experimental#experimental-importdurations-thresholds-warn)

Warn-Schwellwert – Importe, die ihn überschreiten, werden gelb/orange dargestellt (Standard: 100).

### experimental.importDurations.thresholds.danger

- **CLI:** `--experimental.importDurations.thresholds.danger <number>`
- **Konfiguration:** [experimental.importDurations.thresholds.danger](/config/experimental#experimental-importdurations-thresholds-danger)

Danger-Schwellwert – Importe, die ihn überschreiten, werden rot dargestellt (Standard: 500).

### experimental.viteModuleRunner

- **CLI:** `--experimental.viteModuleRunner`
- **Konfiguration:** [experimental.viteModuleRunner](/config/experimental#experimental-vitemodulerunner)

Steuert, ob Vitest den Module Runner von Vite zum Ausführen des Codes verwendet oder auf das native `import` zurückfällt. (Standard: `true`)

### experimental.nodeLoader

- **CLI:** `--experimental.nodeLoader`
- **Konfiguration:** [experimental.nodeLoader](/config/experimental#experimental-nodeloader)

Steuert, ob Vitest die Loader-API von Node.js verwendet, um In-Source- oder gemockte Dateien zu verarbeiten. Das hat keine Wirkung, wenn `viteModuleRunner` aktiviert ist. Das Deaktivieren kann die Performance steigern. (Standard: `true`)

### experimental.vcsProvider

- **CLI:** `--experimental.vcsProvider <path>`
- **Konfiguration:** [experimental.vcsProvider](/config/experimental#experimental-vcsprovider)

Eigener Provider zum Erkennen geänderter Dateien. (Standard: `git`)

### experimental.preParse

- **CLI:** `--experimental.preParse`
- **Konfiguration:** [experimental.preParse](/config/experimental#experimental-preparse)

Parst Testspezifikationen, bevor sie ausgeführt werden. Dadurch werden das Flag `.only` und das Testnamensmuster über alle Dateien hinweg angewendet, ohne sie auszuführen. (Standard: `false`)

### experimental.diagnostics.isolate

- **CLI:** `--experimental.diagnostics.isolate`
- **Konfiguration:** [experimental.diagnostics.isolate](/config/experimental#experimental-diagnostics-isolate)

Gibt einen Hinweis mit einer Schätzung aus, wie viel Zeit `isolate: false` sparen würde, wenn `isolate: true` erhebliche Zeit damit verbringt, pro Testdatei einen Worker zu starten. (Standard: `true`)

### experimental.diagnostics.environment

- **CLI:** `--experimental.diagnostics.environment`
- **Konfiguration:** [experimental.diagnostics.environment](/config/experimental#experimental-diagnostics-environment)

Gibt einen Hinweis aus, wenn das Neuerstellen einer DOM-Umgebung für jede Testdatei den Lauf dominiert und ein `vm`-Pool sie einmal pro Worker einrichten würde. (Standard: `true`)

### experimental.diagnostics.import

- **CLI:** `--experimental.diagnostics.import`
- **Konfiguration:** [experimental.diagnostics.import](/config/experimental#experimental-diagnostics-import)

Gibt einen Hinweis aus, wenn Testdateien wiederholt denselben Modulgraphen auswerten (typisch für Barrel-File-Importe) und `isolate: false` ihn einmal pro Worker auswerten würde. (Standard: `true`)

### experimental.diagnostics.transform

- **CLI:** `--experimental.diagnostics.transform`
- **Konfiguration:** [experimental.diagnostics.transform](/config/experimental#experimental-diagnostics-transform)

Gibt einen Hinweis aus, wenn das Transformieren von Modulen den Lauf dominiert und `fsModuleCache` die Ergebnisse über Läufe hinweg erhalten würde. (Standard: `true`)
