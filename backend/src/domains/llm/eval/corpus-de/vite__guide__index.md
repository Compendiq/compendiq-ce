# Erste Schritte

<audio id="vite-audio">
  <source src="/vite.mp3" type="audio/mpeg">
</audio>

## Überblick

Vite (französisch für "schnell", ausgesprochen `/viːt/`<button style="border:none;padding:3px;border-radius:4px;vertical-align:bottom" id="play-vite-audio" aria-label="pronounce" onclick="document.getElementById('vite-audio').play();"><svg style="height:2em;width:2em"><use href="../images/voice.svg?no-inline#voice" /></svg></button>, wie "wiet") ist ein Build-Werkzeug, das eine schnellere und schlankere Entwicklungserfahrung für moderne Webprojekte bieten will. Es besteht aus zwei wesentlichen Teilen:

- Einem Dev-Server, der [umfangreiche Feature-Erweiterungen](./features) gegenüber [nativen ES-Modulen](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Guide/Modules) bietet, zum Beispiel extrem schnelles [Hot Module Replacement (HMR)](./features#hot-module-replacement).

- Einem Build-Kommando, das deinen Code mit [Rolldown](https://rolldown.rs) bündelt und vorkonfiguriert hochoptimierte statische Assets für die Produktion ausgibt.

Vite ist meinungsstark und bringt von Haus aus sinnvolle Standardwerte mit. Was alles möglich ist, liest du im [Features-Leitfaden](./features). Unterstützung für Frameworks oder die Integration anderer Werkzeuge ist über [Plugins](./using-plugins) möglich. Der [Konfigurationsabschnitt](../config/) erklärt, wie du Vite bei Bedarf an dein Projekt anpasst.

Vite ist außerdem über seine [Plugin-API](./api-plugin) und die [JavaScript-API](./api-javascript) mit vollständiger Typunterstützung hochgradig erweiterbar.

Mehr über die Beweggründe hinter dem Projekt erfährst du im Abschnitt [Warum Vite](./why).

<ScrimbaLink href="https://scrimba.com/intro-to-vite-c03p6pbbdq?via=vite" title="Free Vite Course on Scrimba">Lerne Vite mit interaktiven Tutorials auf Scrimba</ScrimbaLink>

## Browser-Unterstützung

Während der Entwicklung geht Vite davon aus, dass ein moderner Browser verwendet wird. Das bedeutet, der Browser unterstützt die meisten der neuesten JavaScript- und CSS-Features. Aus diesem Grund setzt Vite [`esnext` als Transform-Target](https://oxc.rs/docs/guide/usage/transformer/lowering.html#target). Das verhindert ein Herunterstufen der Syntax und erlaubt Vite, Module so nah wie möglich am Originalquellcode auszuliefern. Vite injiziert etwas Runtime-Code, damit der Entwicklungsserver funktioniert. Dieser Code nutzt Features, die zum Zeitpunkt jedes Major-Releases in [Baseline](https://web-platform-dx.github.io/baseline/) Newly Available enthalten sind (2026-01-01 für dieses Major-Release).

Für Produktions-Builds zielt Vite standardmäßig auf die Browserversionen ab, die zu einem für jedes Major-Release festgelegten Datum [Baseline](https://web-platform-dx.github.io/baseline/) Widely Available sind. Für dieses Major-Release entspricht das [Browserversionen, die etwa Mitte 2023 erschienen sind](https://web-platform-dx.github.io/supported-browsers/?widelyAvailableOnDate=2026-01-01). Das Target kann per Konfiguration abgesenkt werden. Zusätzlich lassen sich ältere Browser über das offizielle [@vitejs/plugin-legacy](https://github.com/vitejs/vite/tree/main/packages/plugin-legacy) unterstützen. Weitere Details findest du im Abschnitt [Für die Produktion bauen](./build).

## Vite online ausprobieren

Du kannst Vite online auf [StackBlitz](https://vite.new/) ausprobieren. Dort läuft das Vite-basierte Build-Setup direkt im Browser, ist also nahezu identisch mit dem lokalen Setup, erfordert aber keine Installation auf deinem Rechner. Über `vite.new/{template}` wählst du aus, welches Framework verwendet werden soll.

Die unterstützten Template-Voreinstellungen sind:

|             JavaScript              |                TypeScript                 |
| :---------------------------------: | :---------------------------------------: |
| [vanilla](https://vite.new/vanilla) | [vanilla-ts](https://vite.new/vanilla-ts) |
|     [vue](https://vite.new/vue)     |     [vue-ts](https://vite.new/vue-ts)     |
|   [react](https://vite.new/react)   |   [react-ts](https://vite.new/react-ts)   |
|  [preact](https://vite.new/preact)  |  [preact-ts](https://vite.new/preact-ts)  |
|     [lit](https://vite.new/lit)     |     [lit-ts](https://vite.new/lit-ts)     |
|  [svelte](https://vite.new/svelte)  |  [svelte-ts](https://vite.new/svelte-ts)  |
|   [solid](https://vite.new/solid)   |   [solid-ts](https://vite.new/solid-ts)   |
|    [qwik](https://vite.new/qwik)    |    [qwik-ts](https://vite.new/qwik-ts)    |

## Dein erstes Vite-Projekt aufsetzen

::: code-group

```bash [npm]
$ npm create vite@latest
```

```bash [Yarn]
$ yarn create vite
```

```bash [pnpm]
$ pnpm create vite
```

```bash [Bun]
$ bun create vite
```

```bash [Deno]
$ deno init --npm vite
```

:::

Folge dann den Eingabeaufforderungen!

<ScrimbaLink href="https://scrimba.com/intro-to-vite-c03p6pbbdq/~0yhj?via=vite" title="Scaffolding Your First Vite Project">Sieh dir eine interaktive Lektion auf Scrimba an</ScrimbaLink>

::: tip Hinweis zur Kompatibilität
Vite erfordert [Node.js](https://nodejs.org/en/) in Version 20.19+ oder 22.12+. Manche Templates benötigen jedoch eine höhere Node.js-Version; bitte aktualisiere, wenn dein Paketmanager dich darauf hinweist.
:::

:::: details create vite mit Kommandozeilenoptionen verwenden

Du kannst den Projektnamen und das gewünschte Template auch direkt über zusätzliche Kommandozeilenoptionen angeben. Um zum Beispiel ein Vite-+-Vue-Projekt aufzusetzen, führe aus:

::: code-group

```bash [npm]
# npm 7+, extra double-dash is needed:
$ npm create vite@latest my-vue-app -- --template vue
```

```bash [Yarn]
$ yarn create vite my-vue-app --template vue
```

```bash [pnpm]
$ pnpm create vite my-vue-app --template vue
```

```bash [Bun]
$ bun create vite my-vue-app --template vue
```

```bash [Deno]
$ deno init --npm vite my-vue-app --template vue
```

:::

Weitere Details zu jedem unterstützten Template findest du unter [create-vite](https://github.com/vitejs/vite/tree/main/packages/create-vite): `vanilla`, `vanilla-ts`, `vue`, `vue-ts`, `react`, `react-compiler`, `react-ts`, `react-compiler-ts`, `preact`, `preact-ts`, `lit`, `lit-ts`, `svelte`, `svelte-ts`, `solid`, `solid-ts`, `qwik`, `qwik-ts`.

Du kannst `.` als Projektnamen verwenden, um im aktuellen Verzeichnis aufzusetzen.

Um ein Projekt ohne interaktive Eingabeaufforderungen zu erstellen, kannst du das Flag `--no-interactive` verwenden.

::::

## Community-Templates

create-vite ist ein Werkzeug, um schnell ein Projekt aus einem einfachen Template für populäre Frameworks zu starten. Sieh dir Awesome Vite für [von der Community gepflegte Templates](https://github.com/vitejs/awesome-vite#templates) an, die andere Werkzeuge einbinden oder auf andere Frameworks abzielen.

Ein Template unter `https://github.com/user/project` kannst du online über `https://github.stackblitz.com/user/project` ausprobieren (füge dazu `.stackblitz` hinter `github` in der Projekt-URL ein).

Du kannst dein Projekt auch mit einem Werkzeug wie [tiged](https://github.com/tiged/tiged) aus einem der Templates aufsetzen. Angenommen, das Projekt liegt auf GitHub und verwendet `main` als Standard-Branch, erstellst du eine lokale Kopie mit:

```bash
npx tiged user/project my-project
cd my-project

npm install
npm run dev
```

## Manuelle Installation

In deinem Projekt kannst du die `vite`-CLI so installieren:

::: code-group

```bash [npm]
$ npm install -D vite
```

```bash [Yarn]
$ yarn add -D vite
```

```bash [pnpm]
$ pnpm add -D vite
```

```bash [Bun]
$ bun add -D vite
```

```bash [Deno]
$ deno add -D npm:vite
```

:::

Und lege eine `index.html`-Datei wie diese an:

```html
<p>Hello Vite!</p>
```

Führe dann das passende CLI-Kommando in deinem Terminal aus:

::: code-group

```bash [npm]
$ npx vite
```

```bash [Yarn]
$ yarn vite
```

```bash [pnpm]
$ pnpm vite
```

```bash [Bun]
$ bunx vite
```

```bash [Deno]
$ deno run -A npm:vite
```

:::

Die `index.html` wird unter `http://localhost:5173` ausgeliefert.

## `index.html` und Projekt-Root

Vielleicht ist dir aufgefallen, dass `index.html` in einem Vite-Projekt an vorderster Stelle steht, statt in `public` versteckt zu sein. Das ist Absicht: Während der Entwicklung ist Vite ein Server, und `index.html` ist der Einstiegspunkt deiner Anwendung.

Vite behandelt `index.html` als Quellcode und als Teil des Modulgraphen. Es löst `<script type="module" src="...">` auf, das auf deinen JavaScript-Quellcode verweist. Selbst Inline-`<script type="module">` und über `<link href>` referenziertes CSS profitieren von Vite-spezifischen Features. Zusätzlich werden URLs innerhalb von `index.html` automatisch neu basiert, sodass keine speziellen `%PUBLIC_URL%`-Platzhalter nötig sind.

Ähnlich wie statische HTTP-Server kennt Vite das Konzept eines "Root-Verzeichnisses", aus dem deine Dateien ausgeliefert werden. Im weiteren Verlauf der Dokumentation wird es als `<root>` bezeichnet. Absolute URLs in deinem Quellcode werden mit dem Projekt-Root als Basis aufgelöst, sodass du Code schreiben kannst, als würdest du mit einem gewöhnlichen statischen Dateiserver arbeiten (nur weit mächtiger!). Vite kann außerdem mit Abhängigkeiten umgehen, die auf Dateisystempfade außerhalb des Root verweisen, was es auch in einem Monorepo-basierten Setup nutzbar macht.

Vite unterstützt außerdem [Multi-Page-Apps](./build#multi-page-app) mit mehreren `.html`-Einstiegspunkten.

#### Einen alternativen Root angeben

Ein Aufruf von `vite` startet den Dev-Server mit dem aktuellen Arbeitsverzeichnis als Root. Einen alternativen Root gibst du mit `vite serve some/sub/dir` an.
Beachte, dass Vite auch [seine Konfigurationsdatei (also `vite.config.js`)](/config/#configuring-vite) innerhalb des Projekt-Roots auflöst, du musst sie also verschieben, wenn sich der Root ändert.

## Kommandozeilen-Interface

In einem Projekt, in dem Vite installiert ist, kannst du das `vite`-Binary in deinen npm-Skripten verwenden oder es direkt mit `npx vite` ausführen. Hier sind die Standard-npm-Skripte eines aufgesetzten Vite-Projekts:

<!-- prettier-ignore -->
```json [package.json]
{
  "scripts": {
    "dev": "vite", // start dev server, aliases: `vite dev`, `vite serve`
    "build": "vite build", // build for production
    "preview": "vite preview" // locally preview production build
  }
}
```

Du kannst zusätzliche CLI-Optionen wie `--port` oder `--open` angeben. Eine vollständige Liste der CLI-Optionen erhältst du mit `npx vite --help` in deinem Projekt.

Mehr dazu erfährst du unter [Kommandozeilen-Interface](./cli.md).

## Unveröffentlichte Commits verwenden

Wenn du nicht auf ein neues Release warten kannst, um die neuesten Features zu testen, kannst du einen bestimmten Commit von Vite über https://pkg.pr.new installieren:

::: code-group

```bash [npm]
$ npm install -D https://pkg.pr.new/vite@SHA
```

```bash [Yarn]
$ yarn add -D https://pkg.pr.new/vite@SHA
```

```bash [pnpm]
$ pnpm add -D https://pkg.pr.new/vite@SHA
```

```bash [Bun]
$ bun add -D https://pkg.pr.new/vite@SHA
```

:::

Ersetze `SHA` durch einen beliebigen [Commit-SHA von Vite](https://github.com/vitejs/vite/commits/main/). Beachte, dass nur Commits aus dem letzten Monat funktionieren, da ältere Commit-Releases entfernt werden.

Alternativ kannst du auch das [vite-Repository](https://github.com/vitejs/vite) auf deinen lokalen Rechner klonen und es selbst bauen und verlinken ([pnpm](https://pnpm.io/) ist erforderlich):

```bash
git clone https://github.com/vitejs/vite.git
cd vite
pnpm install
cd packages/vite
pnpm run build
pnpm link # use your preferred package manager for this step
```

Wechsle danach in dein Vite-basiertes Projekt und führe `pnpm link vite` aus (oder den Paketmanager, mit dem du `vite` global verlinkt hast). Starte nun den Entwicklungsserver neu, um auf dem allerneuesten Stand zu arbeiten!

Mehr darüber, wie und wann Vite Releases veröffentlicht, erfährst du in der Dokumentation zu den [Releases](../releases.md).

::: tip Abhängigkeiten, die Vite verwenden
Um die von Abhängigkeiten transitiv verwendete Vite-Version zu ersetzen, solltest du [npm overrides](https://docs.npmjs.com/cli/v11/configuring-npm/package-json#overrides) oder [pnpm overrides](https://pnpm.io/settings#overrides) verwenden.
:::

## Community

Wenn du Fragen hast oder Hilfe brauchst, wende dich an die Community auf [Discord](https://chat.vite.dev) und in den [GitHub Discussions](https://github.com/vitejs/vite/discussions).
