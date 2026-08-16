# Warum Vite

Mit dem Wachstum von Webanwendungen in Umfang und Komplexität hatten die Werkzeuge zu ihrer Entwicklung Mühe, Schritt zu halten. Entwicklerinnen und Entwickler großer Projekte erlebten quälend langsame Starts des Dev-Servers, träge Hot Updates und lange Build-Zeiten für die Produktion. Jede Generation von Build-Werkzeugen verbesserte die vorherige, doch diese Probleme blieben bestehen.

Vite wurde geschaffen, um genau das anzugehen. Statt bestehende Ansätze schrittweise zu verbessern, hat es neu durchdacht, wie Code während der Entwicklung ausgeliefert werden sollte. Seitdem hat sich Vite über mehrere Hauptversionen weiterentwickelt und sich jedes Mal an neue Fähigkeiten des Ökosystems angepasst: von der Nutzung nativer ES-Module im Browser bis hin zur Einführung einer vollständig in Rust umgesetzten Toolchain.

Heute treibt Vite viele Frameworks und Werkzeuge an. Seine Architektur ist darauf ausgelegt, sich mit der Webplattform weiterzuentwickeln, statt sich auf einen einzelnen Ansatz festzulegen – und damit ein Fundament, auf dem Sie langfristig aufbauen können.

## Die Anfänge

Als Vite entstand, hatten Browser gerade breite Unterstützung für [ES-Module](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Guide/Modules) (ESM) erhalten, eine Möglichkeit, JavaScript-Dateien direkt zu laden, ohne sie zuvor mit einem Werkzeug in eine einzige Datei bündeln zu müssen. Klassische Build-Werkzeuge (oft _Bundler_ genannt) verarbeiteten Ihre gesamte Anwendung vorab, bevor im Browser überhaupt etwas angezeigt werden konnte. Je größer die App, desto länger die Wartezeit.

Vite ging einen anderen Weg. Es teilte die Arbeit in zwei Teile:

- **Abhängigkeiten** (Bibliotheken, die sich selten ändern) werden einmalig mit schnellen nativen Werkzeugen [vorgebündelt](./dep-pre-bundling.md) und stehen damit sofort bereit.
- **Quellcode** (Ihr Anwendungscode, der sich häufig ändert) wird bei Bedarf über natives ESM ausgeliefert. Der Browser lädt nur, was er für die aktuelle Seite benötigt, und Vite transformiert jede Datei beim Abruf.

Damit war der Start des Dev-Servers nahezu unmittelbar, unabhängig von der Größe der Anwendung. Beim Bearbeiten einer Datei nutzte Vite [Hot Module Replacement](./features.md#hot-module-replacement) (HMR) über natives ESM, um genau dieses Modul im Browser zu aktualisieren – ohne vollständigen Seiten-Reload und ohne Warten auf einen Rebuild.

<script setup>
import bundlerSvg from '../images/bundler.svg?raw'
import esmSvg from '../images/esm.svg?raw'
</script>
<svg-image :svg="bundlerSvg" />

_In einem bundle-basierten Dev-Server wird die gesamte Anwendung gebündelt, bevor sie ausgeliefert werden kann._

<svg-image :svg="esmSvg" />

_In einem ESM-basierten Dev-Server werden Module bei Bedarf ausgeliefert, sobald der Browser sie anfordert._

Vite war nicht das erste Werkzeug, das diesen Ansatz erkundet hat. [Snowpack](https://www.snowpack.dev/) hat die ungebündelte Entwicklung wegbereitet und Vites Pre-Bundling von Abhängigkeiten inspiriert. [WMR](https://github.com/preactjs/wmr) vom Preact-Team hat die universelle Plugin-API angeregt, die sowohl im Dev- als auch im Build-Modus funktioniert. [@web/dev-server](https://modern-web.dev/docs/dev-server/overview/) hat die Server-Architektur von Vite 1.0 beeinflusst. Vite hat auf diesen Ideen aufgebaut und sie weitergeführt.

Auch wenn ungebündeltes ESM während der Entwicklung gut funktioniert, ist es in der Produktion wegen zusätzlicher Netzwerk-Roundtrips durch verschachtelte Importe nach wie vor ineffizient. Deshalb ist [Bundling für optimierte Produktions-Builds weiterhin notwendig](https://rolldown.rs/in-depth/why-bundlers).

## Wachsen mit dem Ökosystem

Mit Vites Reifung begannen Frameworks, es als ihre Build-Schicht zu übernehmen. Seine an Rollups Konventionen angelehnte [Plugin-API](./api-plugin.md) machte die Integration selbstverständlich, ohne dass Frameworks um Vites Interna herumarbeiten mussten. [Nuxt](https://nuxt.com/), [SvelteKit](https://svelte.dev/docs/kit), [Astro](https://astro.build/), [React Router](https://reactrouter.com/), [Analog](https://analogjs.org/), [SolidStart](https://start.solidjs.com/) und andere wählten Vite als Fundament. Werkzeuge wie [Vitest](https://vitest.dev/) und [Storybook](https://storybook.js.org/) bauten ebenfalls darauf auf und erweiterten Vites Reichweite über das App-Bundling hinaus. Backend-Frameworks wie [Laravel](https://laravel.com/docs/vite) und [Ruby on Rails](https://vite-ruby.netlify.app/) integrierten Vite für ihre Frontend-Asset-Pipelines.

Dieses Wachstum verlief nicht nur in eine Richtung. Das Ökosystem hat Vite ebenso geprägt wie Vite das Ökosystem. Das Vite-Team betreibt [vite-ecosystem-ci](https://github.com/vitejs/vite-ecosystem-ci), das große Projekte des Ökosystems gegen jede Vite-Änderung testet. Die Gesundheit des Ökosystems ist kein nachgelagerter Gedanke, sondern Teil des Release-Prozesses.

## Eine vereinheitlichte Toolchain

Vite stützte sich ursprünglich auf zwei getrennte Werkzeuge unter der Haube: [esbuild](https://esbuild.github.io/) für schnelle Kompilierung während der Entwicklung und [Rollup](https://rollupjs.org/) für gründliche Optimierung in Produktions-Builds. Das funktionierte, doch die Pflege zweier Pipelines brachte Inkonsistenzen mit sich: unterschiedliches Transformationsverhalten, getrennte Plugin-Systeme und wachsender Glue-Code, um beide im Gleichklang zu halten.

[Rolldown](https://rolldown.rs/) wurde gebaut, um beide in einem einzigen Bundler zu vereinen: in Rust geschrieben für native Geschwindigkeit und kompatibel zu derselben Plugin-API, auf die sich das Ökosystem bereits stützte. Für Parsing, Transformation und Minifizierung nutzt es [Oxc](https://oxc.rs/). Damit erhält Vite eine durchgängige Toolchain, in der Build-Werkzeug, Bundler und Compiler gemeinsam gepflegt werden und sich als Einheit weiterentwickeln.

Das Ergebnis ist eine konsistente Pipeline von der Entwicklung bis in die [Produktion](./build.md). Die Migration erfolgte behutsam: Zuerst erschien eine [Technical Preview](https://voidzero.dev/posts/announcing-rolldown-vite), damit Early Adopter die Änderung validieren konnten, die Ökosystem-CI fing Kompatibilitätsprobleme frühzeitig ab, und eine Kompatibilitätsschicht bewahrte bestehende Konfigurationen.

## Wohin Vite sich entwickelt

Vites Architektur entwickelt sich weiter. Mehrere Vorhaben prägen ihre Zukunft:

- **Full Bundle Mode**: Ungebündeltes ESM war zur Entstehungszeit von Vite der richtige Kompromiss, weil kein Werkzeug zugleich schnell genug war und die HMR- und Plugin-Fähigkeiten mitbrachte, die zum Bündeln während der Entwicklung nötig sind. Rolldown ändert das. Da außergewöhnlich große Codebasen wegen der hohen Zahl ungebündelter Netzwerk-Requests langsame Seitenladezeiten erleben können, erkundet das Team einen Modus, in dem der Dev-Server Code ähnlich wie in der Produktion bündelt und so den Netzwerk-Overhead reduziert.

- **Environment API**: Statt „Client“ und „SSR“ als die einzigen beiden Build-Ziele zu behandeln, erlaubt die [Environment API](./api-environment-instances.md) Frameworks, eigene Environments zu definieren (Edge-Runtimes, Service Worker und andere Deployment-Ziele), jeweils mit eigenen Regeln für Modulauflösung und Ausführung. Während sich weiter diversifiziert, wo und wie Code läuft, wächst Vites Modell mit.

- **Mit JavaScript weiterentwickeln**: Da Oxc und Rolldown eng mit Vite zusammenarbeiten, lassen sich neue Sprachfeatures und Standards zügig in der gesamten Toolchain übernehmen, ohne auf Upstream-Abhängigkeiten warten zu müssen.

Vites Ziel ist nicht, das endgültige Werkzeug zu sein, sondern eines, das sich mit der Webplattform und mit den darauf aufbauenden Entwicklerinnen und Entwicklern stetig weiterentwickelt.
