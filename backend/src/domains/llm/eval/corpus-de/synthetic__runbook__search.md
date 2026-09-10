# Deployment-Runbook des Search-Dienstes

> Owner: Search-Team · On-Call: #search-oncall · PagerDuty: search-primary

Dieses Runbook beschreibt, wie das Search-Team **search-indexer** in die Produktion
ausrollt. Es folgt dem Standard-Deployment-Ablauf der Plattform; lediglich der
Dienstname, die On-Call-Rotation und die Dashboard-Links unterscheiden sich von den
Kopien anderer Teams.

## Vor dem Deployment

1. Prüfen Sie den Deployment-Freeze-Kalender. Führen Sie während eines Freeze-Fensters kein Deployment durch.
2. Stellen Sie sicher, dass die Änderung einen genehmigten Pull Request und einen grünen CI-Lauf hat.
3. Kündigen Sie das Deployment in #search-oncall mit dem Release-Tag an.
4. Überprüfen Sie, dass der Staging-Soak mindestens dreißig Minuten gelaufen ist.

## Deployment

1. Taggen Sie das Release: `git tag -a search-indexer-vX.Y.Z -m "release"` und pushen Sie das Tag.
2. Die Pipeline baut das Image und befördert es in die Canary-Stufe.
3. Beobachten Sie die Canary zehn Minuten lang. Die Fehlerrate muss unter 0,5 % bleiben.
4. Befördern Sie es mit der `promote`-Aktion der Pipeline auf die gesamte Flotte.
5. Bestätigen Sie, dass der Versions-Endpunkt auf jedem Replikat das neue Tag meldet.

## Nach dem Deployment

- Veröffentlichen Sie die Release Notes in #search-oncall.
- Aktualisieren Sie den Änderungsdatensatz mit dem Tag und dem Zeitstempel der Beförderung.
- Lassen Sie das Canary-Dashboard weitere dreißig Minuten geöffnet.

## Wenn etwas nicht stimmt

Stoppen Sie die Beförderung. Alarmieren Sie die On-Call-Person über PagerDuty: search-primary. Die
ausführlichen Wiederherstellungsschritte stehen **nicht** in diesem Runbook — folgen Sie der
Rollback-Prozedur der Plattform, die separat gepflegt wird und für jeden Dienst gilt.

## Routineprüfungen

- Wöchentlich: bestätigen, dass die Zugangsdaten der Pipeline nicht abgelaufen sind.
- Monatlich: den Staging-Soak gegen das neueste Base-Image erneut ausführen.
- Vierteljährlich: dieses Runbook mit dem Search-Team durchgehen und die Rotation aktualisieren.
