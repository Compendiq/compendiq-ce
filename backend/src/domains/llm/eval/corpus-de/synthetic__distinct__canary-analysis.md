# Wie die Canary-Analyse über Promotion oder Abbruch entscheidet

Das Deployment-Runbook jedes Teams sagt, man solle „den Canary zehn Minuten lang beobachten".
Diese Seite erklärt, was der Canary-Analyzer tatsächlich vergleicht, damit diese
Zahl kein Aberglaube bleibt.

## Der Vergleich

Der Analyzer hält zwei Populationen vor: die Canary-Replicas auf dem neuen Image und eine
Baseline-Gruppe auf dem aktuellen Image, beide unter Live-Traffic. Er vergleicht
Fehlerrate, p50- und p99-Latenz sowie Sättigung und verlangt vor jedem Urteil eine
Mindeststichprobe – bei einem Service mit wenig Traffic reichen die zehn Minuten
möglicherweise nicht für genügend Requests, und der Analyzer sagt das, statt durchzuwinken.

## Warum er abbricht

Ein Abbruch bedeutet, dass eine Metrik ihren Schwellenwert überschritten hat, mit genügend
Stichproben für ein belastbares Urteil. Der Analyzer führt von sich aus kein Rollback durch; er stoppt
die Promotion und alarmiert den Bereitschaftsdienst, der dann entscheidet.

## Schwellenwerte anpassen

Schwellenwerte gehören zum Service, nicht zur Pipeline. Sie zu lockern, um ein Release
herauszubekommen, ist die mit Abstand häufigste Ursache dafür, dass eine schlechte Änderung
die gesamte Flotte erreicht.
