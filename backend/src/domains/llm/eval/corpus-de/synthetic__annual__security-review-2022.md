# Jährliche Sicherheitsüberprüfung 2022 — Feststellungen und Maßnahmen

> Geprüft: 2022 · Status: abgeschlossen

Die jährliche Sicherheitsüberprüfung betrachtet Authentifizierung, Umgang mit
Secrets, Hygiene der Abhängigkeiten sowie Zugriffskontrolle über alle
Produktivdienste hinweg. Dies ist die Ausgabe 2022; frühere Ausgaben werden zu
Auditzwecken unverändert aufbewahrt und dürfen nicht bearbeitet werden.

## Geltungsbereich

Alle Produktivdienste, ihre CI-Pipelines und ihre Datenspeicher. Ausgenommen:
Entwickler-Laptops sowie sämtliche Vorproduktionsumgebungen ohne echte Daten.

## Feststellungen

1. **Verzögerte Secret-Rotation.** 11 Dienste hielten Zugangsdaten, die älter
   als die 90-Tage-Rotationsrichtlinie waren. Maßnahme: automatisierte
   Rotationserinnerungen.
2. **Drift bei Abhängigkeiten.** 34 direkte Abhängigkeiten lagen mehr als zwei
   Minor-Versionen zurück. Maßnahme: monatlich geplantes Upgrade-Fenster.
3. **Zu weit gefasste Zugriffsrechte.** 27 Konten behielten Schreibzugriff auf
   Repositories, die sie seit sechs Monaten nicht angefasst hatten. Maßnahme:
   vierteljährliche Zugriffsüberprüfung mit automatischem Ablauf.

## Stand der Maßnahmen aus dem Vorjahr

Alle drei Maßnahmen des Vorjahres wurden abgeschlossen.

## Freigabe

Geprüft durch die Platform-Security-Gruppe. Die nächste Überprüfung ist für
denselben Zeitraum im kommenden Jahr angesetzt.
