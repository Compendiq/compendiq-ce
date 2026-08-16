<script setup>
import SupportedVersions from './.vitepress/theme/SupportedVersions.vue';
</script>

# Releases

Vitest-Releases folgen [Semantic Versioning](https://semver.org/). Die aktuelle stabile Version von Vitest findest du auf der [Seite des Vitest-npm-Pakets](https://www.npmjs.com/package/vite).

Ein vollständiges Changelog vergangener Releases ist [auf GitHub verfügbar](https://github.com/vitest-dev/vitest/releases).

## Release-Zyklus

Vitest hat keinen festen Release-Zyklus.

- **Patch**-Releases erscheinen nach Bedarf (üblicherweise wöchentlich).
- **Minor**-Releases enthalten immer neue Funktionen und erscheinen nach Bedarf. Minor-Releases haben stets eine Beta-Vorabphase (üblicherweise alle zwei Monate).
- **Major**-Releases orientieren sich in der Regel an [Vite](https://vite.dev/releases) und am [EOL-Zeitplan von Node.js](https://endoflife.date/nodejs) und werden vorab angekündigt. Diese Releases haben lange Beta-Vorabphasen (üblicherweise jährlich).

## Unterstützte Versionen

Zusammengefasst sind dies die derzeit unterstützten Vitest-Versionen:

<SupportedVersions />

<br>

Die unterstützten Versionsbereiche werden automatisch bestimmt:

- Das **aktuelle Minor** erhält regelmäßige Fixes.
- Das **vorherige Major** (nur für dessen letztes Minor) und das **vorherige Minor** erhalten wichtige Fixes und Sicherheitspatches.
- Alle Versionen davor werden nicht mehr unterstützt.

Wir empfehlen, Vitest regelmäßig zu aktualisieren. Schau dir bei jedem Major-Update die [Migrationsleitfäden](/guide/migration) an. Wir testen neue Vitest-Versionen vor ihrer Veröffentlichung über das [vitest-ecosystem-ci-Projekt](https://github.com/vitest-dev/vitest-ecosystem-ci). Die meisten Projekte, die Vitest verwenden, sollten Unterstützung schnell anbieten oder auf neue Versionen migrieren können, sobald diese erscheinen.

## Sonderfälle bei Semantic Versioning

### TypeScript-Definitionen

Wir liefern zwischen Minor-Versionen möglicherweise inkompatible Änderungen an TypeScript-Definitionen aus. Das hat folgende Gründe:

- Manchmal liefert TypeScript selbst zwischen Minor-Versionen inkompatible Änderungen aus, und wir müssen die Typen anpassen, um neuere TypeScript-Versionen zu unterstützen.
- Gelegentlich müssen wir Funktionen übernehmen, die nur in einer neueren TypeScript-Version verfügbar sind, was die mindestens erforderliche TypeScript-Version anhebt.
- Wenn du TypeScript verwendest, kannst du einen Semver-Bereich nutzen, der das aktuelle Minor festhält, und manuell aktualisieren, sobald eine neue Minor-Version von Vite erscheint.

## Vorabversionen

Minor-Releases durchlaufen typischerweise eine nicht festgelegte Anzahl von Beta-Releases. Major-Releases durchlaufen eine lange Beta-Phase.

Vorabversionen ermöglichen es Early Adoptern und Maintainern aus dem Ökosystem, Integrations- und Stabilitätstests durchzuführen und Feedback zu geben. Verwende Vorabversionen nicht in der Produktion. Alle Vorabversionen gelten als instabil und können zwischendurch Breaking Changes enthalten. Pinne bei der Verwendung von Vorabversionen immer auf exakte Versionen.

## Deprecations

Wir markieren in Minor-Releases regelmäßig Funktionen als veraltet, die durch bessere Alternativen abgelöst wurden. Veraltete Funktionen funktionieren weiterhin, mit einer Warnung im Typsystem oder im Log. Sie werden im nächsten Major-Release nach Eintritt des Deprecated-Status entfernt. Der [Migrationsleitfaden](/guide/migration.html) jedes Majors listet diese Entfernungen auf und dokumentiert einen Upgrade-Pfad dafür.

## Experimentelle Funktionen

Manche Funktionen werden bei der Veröffentlichung in einer stabilen Version von Vite als experimentell gekennzeichnet. Experimentelle Funktionen erlauben es uns, Praxiserfahrung zu sammeln, die in ihr endgültiges Design einfließt. Ziel ist es, Nutzern die Möglichkeit zu geben, durch Tests in der Produktion Feedback zu liefern. Experimentelle Funktionen selbst gelten als instabil und sollten nur kontrolliert eingesetzt werden. Diese Funktionen können sich zwischen Minor-Versionen ändern, daher müssen Nutzer ihre Vite-Version pinnen, wenn sie sich darauf verlassen. Für jede experimentelle Funktion legen wir [eine GitHub-Discussion](https://github.com/vitest-dev/vitest/discussions/categories/feedback?discussions_q=is%3Aopen+label%3Aexperimental+category%3AFeedback) an.
