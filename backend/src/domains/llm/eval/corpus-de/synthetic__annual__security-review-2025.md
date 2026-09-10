# Jährliche Sicherheitsüberprüfung 2025 – Feststellungen und Behebung

> Geprüft: 2025 · Status: offen

Die jährliche Sicherheitsüberprüfung untersucht Authentifizierung, den Umgang mit Secrets,
Dependency-Hygiene und Zugriffskontrolle über alle Produktionsservices hinweg. Dies ist die
Ausgabe 2025; frühere Ausgaben werden zu Auditzwecken unverändert aufbewahrt und dürfen
nicht bearbeitet werden.

## Umfang

Alle Produktionsservices, ihre CI-Pipelines und ihre Datenspeicher. Ausgenommen:
Entwickler-Laptops sowie jede Vorproduktionsumgebung ohne echte Daten.

## Feststellungen

1. **Verzögerte Secret-Rotation.** 4 Services hielten Credentials, die älter als die
   90-Tage-Rotationsrichtlinie waren. Behebung: automatisierte Rotationserinnerungen.
2. **Dependency-Drift.** 17 direkte Dependencies lagen mehr als zwei Minor-Versionen
   zurück. Behebung: monatlich geplantes Upgrade-Fenster.
3. **Zu weit gefasste Zugriffsrechte.** 9 Konten behielten Schreibzugriff auf
   Repositories, die sie seit sechs Monaten nicht angefasst hatten. Behebung: quartalsweise
   Zugriffsüberprüfung mit automatischem Ablauf.

## Stand der Maßnahmen aus dem Vorjahr

Frühere Maßnahmen abgeschlossen; die Automatisierung des Zugriffsablaufs ist in Arbeit.

## Freigabe

Geprüft durch die Platform-Security-Gruppe. Die nächste Überprüfung ist für denselben
Zeitraum im kommenden Jahr angesetzt.
