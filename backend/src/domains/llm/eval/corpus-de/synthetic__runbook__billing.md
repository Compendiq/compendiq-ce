# Deployment-Runbook für den Billing-Service

> Owner: Billing-Team · On-Call: #billing-oncall · PagerDuty: billing-primary

Dieses Runbook beschreibt, wie das Billing-Team **billing-worker** in die Produktion deployt. Es
folgt dem Standard-Deployment-Ablauf der Plattform; nur der Servicename, die
Rufbereitschaftsplanung und die Dashboard-Links unterscheiden sich von den Kopien anderer Teams.

## Vor dem Deployment

1. Prüfen Sie den Deployment-Freeze-Kalender. Deployen Sie nicht während eines Freeze-Fensters.
2. Vergewissern Sie sich, dass zur Änderung ein genehmigter Pull Request und ein grüner CI-Lauf vorliegen.
3. Kündigen Sie das Deployment in #billing-oncall mit dem Release-Tag an.
4. Stellen Sie sicher, dass der Staging-Soak mindestens dreißig Minuten gelaufen ist.

## Deployment

1. Taggen Sie das Release: `git tag -a billing-worker-vX.Y.Z -m "release"` und pushen Sie das Tag.
2. Die Pipeline baut das Image und promotet es auf die Canary-Stufe.
3. Beobachten Sie die Canary zehn Minuten lang. Die Fehlerrate muss unter 0,5 % bleiben.
4. Promoten Sie mit der `promote`-Aktion der Pipeline auf die gesamte Flotte.
5. Prüfen Sie, dass der Version-Endpunkt auf jedem Replikat das neue Tag meldet.

## Nach dem Deployment

- Posten Sie die Release Notes in #billing-oncall.
- Aktualisieren Sie den Änderungsdatensatz mit dem Tag und dem Zeitstempel der Promotion.
- Lassen Sie das Canary-Dashboard weitere dreißig Minuten geöffnet.

## Wenn etwas nicht stimmt

Stoppen Sie die Promotion. Alarmieren Sie den Bereitschaftsingenieur über PagerDuty: billing-primary. Die detaillierten
Wiederherstellungsschritte stehen **nicht** in diesem Runbook — folgen Sie der
Rollback-Prozedur der Plattform, die separat gepflegt wird und für jeden Service gilt.

## Routineprüfungen

- Wöchentlich: prüfen, dass die Pipeline-Zugangsdaten nicht abgelaufen sind.
- Monatlich: den Staging-Soak gegen das aktuellste Base-Image erneut ausführen.
- Vierteljährlich: dieses Runbook mit dem Billing-Team durchgehen und die Rufbereitschaftsplanung aktualisieren.
