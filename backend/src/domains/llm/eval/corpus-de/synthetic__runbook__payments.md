# Deployment-Runbook für den Payments-Service

> Owner: Payments-Team · Bereitschaft: #payments-oncall · PagerDuty: payments-primary

Dieses Runbook beschreibt, wie das Payments-Team **payments-api** in die Produktion
deployt. Es folgt dem Standard-Deployment-Ablauf der Plattform; lediglich der
Service-Name, der Bereitschaftsplan und die Dashboard-Links unterscheiden sich von
den Kopien anderer Teams.

## Vor dem Deployment

1. Prüfe den Deployment-Freeze-Kalender. Deploye nicht während eines Freeze-Fensters.
2. Stelle sicher, dass die Änderung einen genehmigten Pull Request und einen grünen CI-Lauf hat.
3. Kündige das Deployment in #payments-oncall mit dem Release-Tag an.
4. Prüfe, dass der Staging-Soak mindestens dreißig Minuten gelaufen ist.

## Deployen

1. Tagge das Release: `git tag -a payments-api-vX.Y.Z -m "release"` und pushe den Tag.
2. Die Pipeline baut das Image und promotet es auf die Canary-Stufe.
3. Beobachte den Canary zehn Minuten lang. Die Fehlerrate muss unter 0,5 % bleiben.
4. Promote auf die gesamte Flotte mit der `promote`-Aktion der Pipeline.
5. Prüfe, dass der Version-Endpunkt auf jeder Replica den neuen Tag meldet.

## Nach dem Deployment

- Poste die Release Notes in #payments-oncall.
- Aktualisiere den Change-Eintrag mit dem Tag und dem Zeitstempel der Promotion.
- Lass das Canary-Dashboard weitere dreißig Minuten geöffnet.

## Wenn etwas nicht stimmt

Stoppe die Promotion. Alarmiere den Bereitschaftsingenieur über PagerDuty: payments-primary. Die
detaillierten Wiederherstellungsschritte stehen **nicht** in diesem Runbook — folge dem
Plattform-Rollback-Verfahren, das separat gepflegt wird und für jeden Service gilt.

## Routineprüfungen

- Wöchentlich: prüfen, dass die Pipeline-Zugangsdaten nicht abgelaufen sind.
- Monatlich: den Staging-Soak gegen das aktuelle Base-Image erneut ausführen.
- Vierteljährlich: dieses Runbook mit dem Payments-Team durchgehen und den Bereitschaftsplan aktualisieren.
