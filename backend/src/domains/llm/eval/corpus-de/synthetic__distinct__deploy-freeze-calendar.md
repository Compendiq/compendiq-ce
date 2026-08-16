# Deployment-Freeze-Kalender und Ausnahmen

Deployment-Freezes existieren, damit keine Änderungen ausgerollt werden, während
die Personen, die ein Problem bemerken würden, nicht verfügbar sind. Das Runbook
jedes Service-Teams weist Sie an, vor einem Deployment diese Seite zu prüfen;
dies ist diese Seite.

## Feste Freeze-Zeitfenster

- Jeden Freitag ab 16:00 Uhr Ortszeit bis Montag 09:00 Uhr.
- Die letzten beiden Dezemberwochen.
- Jeder Zeitraum, in dem ein unternehmensweiter Incident mit Schweregrad 1 oder 2 offen ist.
- Die 48 Stunden vor und nach einer vierteljährlichen Vorstandsdemonstration.

## Eine Ausnahme beantragen

Ausnahmen werden von der On-Call-Leitung der Plattform gewährt, nicht vom
anfragenden Team. Geben Sie die Änderung an, den Blast Radius, wer sie beobachten
wird und warum sie nicht warten kann. Sicherheitspatches mit einem veröffentlichten
Exploit sind vorab genehmigt und benötigen lediglich eine Ankündigung.

## Was ein Freeze nicht blockiert

Konfigurationsänderungen hinter einem bestehenden Flag, Dokumentations-Updates und
Rollbacks. Ein Rollback ist während eines Freeze immer zulässig — das Rückgängigmachen
einer schlechten Änderung ist nie das, wovor ein Freeze schützen soll.
