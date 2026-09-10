# Plattform-Rollback-Verfahren für fehlgeschlagene Deployments

Dies ist das einzige verbindliche Verfahren, um ein schiefgelaufenes Deployment
rückgängig zu machen. Das Deployment-Runbook jedes Service-Teams verweist auf
dieses Dokument, statt es zu wiederholen, damit die Wiederherstellungsschritte
nicht je Team auseinanderdriften können.

## Entscheiden, ob zurückgerollt wird

Rolle sofort zurück, wenn nach der Promotion einer der folgenden Punkte zutrifft:

- Fehlerrate über 2 %, anhaltend über fünf Minuten
- p99-Latenz mehr als doppelt so hoch wie die Baseline vor dem Deploy
- irgendein Hinweis auf Datenkorruption, wie klein auch immer
- der Bereitschaftsingenieur ist unsicher und die Änderung ist nicht dringend

Versuche unter Druck keinen Forward Fix. Erst zurückrollen, danach diagnostizieren.

## Rollback durchführen

1. Stoppe jede laufende Promotion in der Pipeline.
2. Wähle aus dem Release-Ledger den vorherigen, als funktionsfähig bekannten Image-Digest aus.
3. Führe die `rollback`-Aktion der Pipeline gegen diesen Digest aus.
4. Beobachte, wie die Replicas zurückgetauscht werden. Eine vollständige Umkehr der Flotte dauert etwa vier Minuten.
5. Prüfe, dass der Version-Endpunkt überall den vorherigen Tag meldet.

## Datenbankänderungen erschweren das Rollback

Enthielt das Release eine Migration, reicht das Zurückrollen des Images allein
nicht aus. Additive Migrationen können bedenkenlos bestehen bleiben. Destruktive
Migrationen müssen mit der zugehörigen Down-Migration rückgängig gemacht werden,
bevor das alte Image startet, und eine Migration, die eine Spalte entfernt hat,
lässt sich ohne Restore nicht rückgängig machen.

## Nach dem Rollback

Lege einen Incident-Eintrag an, hänge die Screenshots des Canary-Dashboards an
und setze innerhalb von zwei Arbeitstagen ein Postmortem an.
