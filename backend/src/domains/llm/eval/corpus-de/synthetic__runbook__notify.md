# Deployment-Runbook des Notifications-Service

> Owner: Notifications-Team · Bereitschaft: #notify-oncall · PagerDuty: notify-primary

Dieses Runbook beschreibt, wie das Notifications-Team **notify-gateway** in die Produktion deployt. Es
folgt dem Standard-Deployment-Ablauf der Plattform; nur der Servicename, der
Bereitschaftsplan und die Dashboard-Links unterscheiden sich von den Kopien anderer Teams.

## Vor dem Deployment

1. Prüfe den Deployment-Freeze-Kalender. Deploye nicht während eines Freeze-Fensters.
2. Stelle sicher, dass die Änderung einen genehmigten Pull Request und einen grünen CI-Lauf hat.
3. Kündige das Deployment in #notify-oncall mit dem Release-Tag an.
4. Prüfe, dass der Staging-Soak mindestens dreißig Minuten gelaufen ist.

## Deployment

1. Tagge das Release: `git tag -a notify-gateway-vX.Y.Z -m "release"` und pushe das Tag.
2. Die Pipeline baut das Image und promotet es auf die Canary-Stufe.
3. Beobachte den Canary zehn Minuten lang. Die Fehlerrate muss unter 0,5 % bleiben.
4. Promote auf die gesamte Flotte mit der `promote`-Aktion der Pipeline.
5. Prüfe, dass der Version-Endpoint auf jeder Replica das neue Tag meldet.

## Nach dem Deployment

- Poste die Release Notes in #notify-oncall.
- Aktualisiere den Änderungsdatensatz mit dem Tag und dem Zeitstempel der Promotion.
- Lass das Canary-Dashboard weitere dreißig Minuten geöffnet.

## Wenn etwas nicht stimmt

Stoppe die Promotion. Alarmiere den Bereitschaftsdienst über PagerDuty: notify-primary. Die detaillierten
Wiederherstellungsschritte stehen **nicht** in diesem Runbook – folge der Rollback-Prozedur
der Plattform, die separat gepflegt wird und für jeden Service gilt.

## Regelmäßige Prüfungen

- Wöchentlich: prüfen, dass die Pipeline-Credentials nicht abgelaufen sind.
- Monatlich: den Staging-Soak gegen das neueste Base-Image erneut ausführen.
- Quartalsweise: dieses Runbook mit dem Notifications-Team durchgehen und den Bereitschaftsplan aktualisieren.
