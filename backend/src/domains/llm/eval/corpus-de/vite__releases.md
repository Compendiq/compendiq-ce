<script setup>
import SupportedVersions from './.vitepress/theme/components/SupportedVersions.vue';
</script>

# Releases

Vite-Releases folgen der [Semantischen Versionierung](https://semver.org/). Die aktuelle stabile Version von Vite findest du auf der [npm-Paketseite von Vite](https://www.npmjs.com/package/vite).

Ein vollständiges Changelog vergangener Releases ist [auf GitHub verfügbar](https://github.com/vitejs/vite/blob/main/packages/vite/CHANGELOG.md).

## Release-Zyklus

Vite hat keinen festen Release-Zyklus.

- **Patch**-Releases werden nach Bedarf veröffentlicht (üblicherweise wöchentlich).
- **Minor**-Releases enthalten immer neue Funktionen und werden nach Bedarf veröffentlicht. Minor-Releases durchlaufen immer eine Beta-Vorabversionsphase (üblicherweise alle zwei Monate).
- **Major**-Releases orientieren sich in der Regel am [EOL-Zeitplan von Node.js](https://endoflife.date/nodejs) und werden vorab angekündigt. Diese Releases durchlaufen langfristige Diskussionen mit dem Ökosystem sowie Alpha- und Beta-Vorabversionsphasen (üblicherweise jährlich).

## Unterstützte Versionen

Zusammengefasst sind dies die aktuell unterstützten Vite-Versionen:

<SupportedVersions />

<br>

Die unterstützten Versionsbereiche werden automatisch bestimmt:

- **Aktuelle Minor** erhält reguläre Fixes.
- **Vorherige Major** (nur für deren letzte Minor) und **vorherige Minor** erhalten wichtige Fixes und Sicherheits-Patches.
- **Vorletzte Major** (nur für deren letzte Minor) und **vorletzte Minor** erhalten Sicherheits-Patches.
- Alle Versionen davor werden nicht mehr unterstützt.

Wir empfehlen, Vite regelmäßig zu aktualisieren. Sieh dir die [Migration Guides](https://vite.dev/guide/migration.html) an, wenn du auf eine neue Major aktualisierst. Das Vite-Team arbeitet eng mit den wichtigsten Projekten im Ökosystem zusammen, um die Qualität neuer Versionen sicherzustellen. Wir testen neue Vite-Versionen vor der Veröffentlichung über das [vite-ecosystem-ci-Projekt](https://github.com/vitejs/vite-ecosystem-ci). Die meisten Projekte, die Vite einsetzen, sollten neue Versionen zügig unterstützen oder auf sie migrieren können, sobald diese erscheinen.

## Sonderfälle der Semantischen Versionierung

### TypeScript-Definitionen

Wir können zwischen Minor-Versionen inkompatible Änderungen an TypeScript-Definitionen ausliefern. Das hat folgende Gründe:

- Manchmal liefert TypeScript selbst inkompatible Änderungen zwischen Minor-Versionen aus, und wir müssen die Typen anpassen, um neuere TypeScript-Versionen zu unterstützen.
- Gelegentlich müssen wir Funktionen übernehmen, die nur in einer neueren TypeScript-Version verfügbar sind, was die minimal erforderliche TypeScript-Version anhebt.
- Wenn du TypeScript verwendest, kannst du einen Semver-Bereich nutzen, der die aktuelle Minor festhält, und manuell aktualisieren, sobald eine neue Minor-Version von Vite erscheint.

### Node.js-Versionen ohne LTS

Node.js-Versionen ohne LTS (ungerade Nummern) werden nicht als Teil der CI von Vite getestet, sollten aber bis zu ihrem [EOL](https://endoflife.date/nodejs) dennoch funktionieren.

## Vorabversionen

Minor-Releases durchlaufen typischerweise eine nicht festgelegte Anzahl von Beta-Releases. Major-Releases durchlaufen eine Alpha- und eine Beta-Phase.

Vorabversionen erlauben es Early Adopters und Maintainern aus dem Ökosystem, Integrations- und Stabilitätstests durchzuführen und Feedback zu geben. Verwende Vorabversionen nicht in Produktion. Alle Vorabversionen gelten als instabil und können zwischendurch Breaking Changes enthalten. Fixiere bei der Nutzung von Vorabversionen immer exakte Versionen.

## Deprecations

Wir markieren regelmäßig Funktionen als deprecated, die in Minor-Releases durch bessere Alternativen abgelöst wurden. Als deprecated markierte Funktionen funktionieren weiterhin, mit einer Warnung im Typsystem oder im Log. Sie werden im nächsten Major-Release nach Eintritt in den Deprecated-Status entfernt. Der [Migration Guide](https://vite.dev/guide/migration.html) jeder Major listet diese Entfernungen auf und dokumentiert einen Upgrade-Pfad dafür.

## Experimentelle Funktionen

Manche Funktionen werden als experimentell gekennzeichnet, wenn sie in einer stabilen Vite-Version erscheinen. Experimentelle Funktionen erlauben es uns, Praxiserfahrung zu sammeln, die in ihr endgültiges Design einfließt. Ziel ist es, Nutzern zu ermöglichen, durch Tests in Produktion Feedback zu geben. Die experimentellen Funktionen selbst gelten als instabil und sollten nur kontrolliert eingesetzt werden. Diese Funktionen können sich zwischen Minors ändern, daher müssen Nutzer ihre Vite-Version fixieren, wenn sie sich darauf verlassen. Wir erstellen für jede experimentelle Funktion [eine GitHub-Discussion](https://github.com/vitejs/vite/discussions/categories/feedback?discussions_q=is%3Aopen+label%3Aexperimental+category%3AFeedback).
