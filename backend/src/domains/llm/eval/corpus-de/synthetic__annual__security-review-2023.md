# Jährliche Sicherheitsprüfung 2023 — Feststellungen und Behebung

> Geprüft: 2023 · Status: abgeschlossen

Die jährliche Sicherheitsprüfung untersucht Authentifizierung, den Umgang mit
Secrets, Dependency-Hygiene und Zugriffskontrolle über alle Produktionsdienste
hinweg. Dies ist die Ausgabe 2023; frühere Ausgaben werden zu Audit-Zwecken
unverändert aufbewahrt und dürfen nicht bearbeitet werden.

## Geltungsbereich

Alle Produktionsdienste, ihre CI-Pipelines und ihre Datenspeicher. Ausgenommen:
Entwickler-Laptops sowie jede Vorproduktionsumgebung, die keine echten Daten
enthält.

## Feststellungen

1. **Verzögerte Secret-Rotation.** 8 Dienste hielten Zugangsdaten, die älter
   waren als die 90-Tage-Rotationsrichtlinie. Behebung: automatisierte
   Rotationserinnerungen.
2. **Dependency-Drift.** 29 direkte Abhängigkeiten lagen mehr als zwei
   Minor-Versionen zurück. Behebung: monatlich geplantes Upgrade-Fenster.
3. **Zu weit gefasste Zugriffsrechte.** 19 Konten behielten Schreibzugriff auf
   Repositories, die sie seit sechs Monaten nicht angefasst hatten. Behebung:
   vierteljährliche Zugriffsprüfung mit automatischem Ablauf.

## Stand der Maßnahmen aus dem Vorjahr

Zwei von drei vorherigen Maßnahmen abgeschlossen; der Dependency-Drift wurde
übernommen.

## Freigabe

Geprüft durch die Platform-Security-Gruppe. Die nächste Prüfung ist für denselben
Zeitraum im kommenden Jahr angesetzt.
