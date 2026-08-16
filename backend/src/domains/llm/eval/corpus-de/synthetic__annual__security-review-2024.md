# Jährliche Sicherheitsüberprüfung 2024 — Feststellungen und Behebung

> Geprüft: 2024 · Status: abgeschlossen

Die jährliche Sicherheitsüberprüfung untersucht Authentifizierung, den Umgang mit
Secrets, die Hygiene der Abhängigkeiten und die Zugriffskontrolle über alle
Produktionsdienste hinweg. Dies ist die Ausgabe 2024; frühere Ausgaben werden zu
Auditzwecken unverändert aufbewahrt und dürfen nicht bearbeitet werden.

## Geltungsbereich

Alle Produktionsdienste, ihre CI-Pipelines und ihre Datenspeicher. Ausgenommen:
Entwickler-Laptops sowie jede Vorproduktionsumgebung, die keine echten Daten enthält.

## Feststellungen

1. **Verzögerte Secret-Rotation.** 6 Dienste hielten Zugangsdaten, die älter als die
   90-Tage-Rotationsrichtlinie waren. Behebung: automatisierte Rotationserinnerungen.
2. **Abhängigkeits-Drift.** 22 direkte Abhängigkeiten lagen mehr als zwei Minor-Versionen
   zurück. Behebung: monatlich geplantes Upgrade-Fenster.
3. **Zu weit gefasste Zugriffsrechte.** 14 Konten behielten Schreibzugriff auf
   Repositories, die sie seit sechs Monaten nicht angefasst hatten. Behebung: vierteljährliche
   Zugriffsüberprüfung mit automatischem Ablauf.

## Stand der Maßnahmen aus dem Vorjahr

Alle früheren Maßnahmen abgeschlossen; die Rotationsautomatisierung wurde ausgeliefert.

## Freigabe

Geprüft von der Platform-Security-Gruppe. Die nächste Überprüfung ist für denselben
Zeitraum im kommenden Jahr angesetzt.
