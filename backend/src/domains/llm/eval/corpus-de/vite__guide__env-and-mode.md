# Env-Variablen und Modi

Vite stellt bestimmte Konstanten unter dem speziellen Objekt `import.meta.env` bereit. Diese Konstanten werden während der Entwicklung als globale Variablen definiert und zur Build-Zeit statisch ersetzt, damit Tree-Shaking wirksam ist.

:::details Beispiel

```js
if (import.meta.env.DEV) {
  // code inside here will be tree-shaken in production builds
  console.log('Dev mode')
}
```

:::

<ScrimbaLink href="https://scrimba.com/intro-to-vite-c03p6pbbdq/~05an?via=vite" title="Env Variables in Vite">Sehen Sie sich eine interaktive Lektion auf Scrimba an</ScrimbaLink>

## Eingebaute Konstanten

Einige eingebaute Konstanten sind in allen Fällen verfügbar:

- **`import.meta.env.MODE`**: {string} der [Modus](#modes), in dem die App läuft.

- **`import.meta.env.BASE_URL`**: {string} die Basis-URL, unter der die App ausgeliefert wird. Sie wird durch die [Konfigurationsoption `base`](/config/shared-options.md#base) bestimmt.

- **`import.meta.env.PROD`**: {boolean} ob die App in der Produktion läuft (Dev-Server mit `NODE_ENV='production'` oder eine mit `NODE_ENV='production'` gebaute App).

- **`import.meta.env.DEV`**: {boolean} ob die App in der Entwicklung läuft (immer das Gegenteil von `import.meta.env.PROD`)

- **`import.meta.env.SSR`**: {boolean} ob die App auf dem [Server](./ssr.md#conditional-logic) läuft.

## Env-Variablen

Vite stellt Env-Variablen automatisch als Strings unter dem Objekt `import.meta.env` bereit.

Variablen mit dem Präfix `VITE_` werden nach dem Vite-Bundling im clientseitigen Quellcode sichtbar. Um zu verhindern, dass Env-Variablen versehentlich an den Client gelangen, vermeiden Sie dieses Präfix. Betrachten Sie als Beispiel Folgendes:

```[.env]
VITE_SOME_KEY=123
DB_PASSWORD=foobar
```

Der geparste Wert von `VITE_SOME_KEY` – `"123"` – wird auf dem Client sichtbar, der Wert von `DB_PASSWORD` hingegen nicht. Sie können das testen, indem Sie Folgendes in Ihren Code aufnehmen:

```js
console.log(import.meta.env.VITE_SOME_KEY) // "123"
console.log(import.meta.env.DB_PASSWORD) // undefined
```

Wenn Sie das Präfix der Env-Variablen anpassen möchten, sehen Sie sich die Option [envPrefix](/config/shared-options.html#envprefix) an.

:::tip Env-Parsing
Wie oben gezeigt, ist `VITE_SOME_KEY` eine Zahl, wird beim Parsen jedoch als String zurückgegeben. Dasselbe gilt für boolesche Env-Variablen. Achten Sie darauf, den Wert bei der Verwendung in Ihrem Code in den gewünschten Typ zu konvertieren.
:::

:::warning Secrets schützen

`VITE_*`-Variablen sollten _keine_ sensiblen Informationen wie API-Schlüssel enthalten. Die Werte dieser Variablen werden zur Build-Zeit in Ihren Quellcode gebündelt. Ziehen Sie für Produktions-Deployments einen Backend-Server oder Serverless-/Edge-Funktionen in Betracht, um Secrets angemessen zu schützen.

:::

### `.env`-Dateien

Vite verwendet [dotenv](https://github.com/motdotla/dotenv), um zusätzliche Umgebungsvariablen aus den folgenden Dateien in Ihrem [Environment-Verzeichnis](/config/shared-options.md#envdir) zu laden:

```
.env                # loaded in all cases
.env.local          # loaded in all cases, ignored by git
.env.[mode]         # only loaded in specified mode
.env.[mode].local   # only loaded in specified mode, ignored by git
```

:::tip Ladeprioritäten für Env-Dateien

Eine Env-Datei für einen bestimmten Modus (z. B. `.env.production`) hat höhere Priorität als eine generische (z. B. `.env`).

Vite lädt zusätzlich zur modusspezifischen Datei `.env.[mode]` stets `.env` und `.env.local`. In modusspezifischen Dateien deklarierte Variablen haben Vorrang vor jenen in generischen Dateien, doch Variablen, die nur in `.env` oder `.env.local` definiert sind, bleiben in der Umgebung verfügbar.

Darüber hinaus haben Umgebungsvariablen, die bereits beim Ausführen von Vite existieren, die höchste Priorität und werden nicht von `.env`-Dateien überschrieben. Zum Beispiel beim Ausführen von `VITE_SOME_KEY=123 vite build`.

`.env`-Dateien werden zu Beginn von Vite geladen. Starten Sie den Server nach Änderungen neu.

:::

:::warning Hinweis für Bun-Nutzende

Bei Verwendung von [Bun](https://bun.sh) sollten Sie beachten, dass Bun `.env`-Dateien automatisch lädt, bevor Ihr Skript läuft. Dieses eingebaute Verhalten lädt Umgebungsvariablen direkt in `process.env` und kann Vites Funktion beeinträchtigen, da diese bestehende `process.env`-Werte respektiert. Workarounds finden Sie unter [oven-sh/bun#5515](https://github.com/oven-sh/bun/issues/5515).

:::

Außerdem verwendet Vite ab Werk [dotenv-expand](https://github.com/motdotla/dotenv-expand), um in Env-Dateien geschriebene Variablen zu expandieren. Mehr zur Syntax erfahren Sie in [deren Dokumentation](https://github.com/motdotla/dotenv-expand#what-rules-does-the-expansion-engine-follow).

Beachten Sie: Wenn Sie `$` innerhalb eines Umgebungswerts verwenden möchten, müssen Sie es mit `\` escapen.

```[.env]
KEY=123
NEW_KEY1=test$foo   # test
NEW_KEY2=test\$foo  # test$foo
NEW_KEY3=test$KEY   # test123
```

::: details Variablen in umgekehrter Reihenfolge expandieren

Vite unterstützt das Expandieren von Variablen in umgekehrter Reihenfolge.
Die folgende `.env` wird beispielsweise als `VITE_FOO=foobar`, `VITE_BAR=bar` ausgewertet.

```[.env]
VITE_FOO=foo${VITE_BAR}
VITE_BAR=bar
```

In Shell-Skripten und anderen Werkzeugen wie `docker compose` funktioniert das nicht.
Dennoch unterstützt Vite dieses Verhalten, da `dotenv-expand` es seit Langem unterstützt und andere Werkzeuge im JavaScript-Ökosystem ältere Versionen verwenden, die dieses Verhalten kennen.

Um Interoperabilitätsprobleme zu vermeiden, sollten Sie sich möglichst nicht auf dieses Verhalten verlassen. Vite könnte künftig Warnungen dazu ausgeben.

:::

:::warning Lokale `.env`-Dateien ignorieren

`.env.*.local`-Dateien sind ausschließlich lokal und können sensible Variablen enthalten. Sie sollten `*.local` zu Ihrer `.gitignore` hinzufügen, damit sie nicht in git eingecheckt werden.

:::

## IntelliSense für TypeScript

Standardmäßig liefert Vite Typdefinitionen für `import.meta.env` in [`vite/client.d.ts`](https://github.com/vitejs/vite/blob/main/packages/vite/client.d.ts). Während Sie weitere eigene Env-Variablen in `.env.[mode]`-Dateien definieren können, möchten Sie vielleicht TypeScript-IntelliSense für selbst definierte Env-Variablen mit dem Präfix `VITE_` erhalten.

Dazu können Sie eine `vite-env.d.ts` im Verzeichnis `src` anlegen und `ImportMetaEnv` wie folgt erweitern:

```typescript [vite-env.d.ts]
interface ViteTypeOptions {
  // By adding this line, you can make the type of ImportMetaEnv strict
  // to disallow unknown keys.
  // strictImportMetaEnv: unknown
}

interface ImportMetaEnv {
  readonly VITE_APP_TITLE: string
  // more env variables...
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
```

Falls Ihr Code auf Typen aus Browser-Umgebungen wie [DOM](https://github.com/microsoft/TypeScript/blob/main/src/lib/dom.generated.d.ts) und [WebWorker](https://github.com/microsoft/TypeScript/blob/main/src/lib/webworker.generated.d.ts) angewiesen ist, können Sie das Feld [lib](https://www.typescriptlang.org/tsconfig#lib) in der `tsconfig.json` anpassen.

```json [tsconfig.json]
{
  "lib": ["WebWorker"]
}
```

:::warning Importe brechen die Typerweiterung

Falls die `ImportMetaEnv`-Erweiterung nicht funktioniert, stellen Sie sicher, dass Sie keine `import`-Anweisungen in `vite-env.d.ts` haben. Weitere Informationen finden Sie in der [TypeScript-Dokumentation](https://www.typescriptlang.org/docs/handbook/2/modules.html#how-javascript-modules-are-defined).

:::

## Ersetzen von Konstanten in HTML

Vite unterstützt außerdem das Ersetzen von Konstanten in HTML-Dateien. Alle Eigenschaften in `import.meta.env` lassen sich in HTML-Dateien mit einer speziellen `%CONST_NAME%`-Syntax verwenden:

```html
<h1>Vite is running in %MODE%</h1>
<p>Using data from %VITE_API_URL%</p>
```

Existiert die Env-Variable nicht in `import.meta.env`, etwa `%NON_EXISTENT%`, wird sie ignoriert und nicht ersetzt – anders als `import.meta.env.NON_EXISTENT` in JS, wo sie durch `undefined` ersetzt wird.

Da Vite von vielen Frameworks verwendet wird, hält es sich bei komplexen Ersetzungen wie Bedingungen absichtlich zurück. Vite lässt sich über [ein bestehendes Userland-Plugin](https://github.com/vitejs/awesome-vite#transformers) oder ein eigenes Plugin erweitern, das den [Hook `transformIndexHtml`](./api-plugin#transformindexhtml) implementiert.

## Modi

Standardmäßig läuft der Dev-Server (Befehl `dev`) im Modus `development` und der Befehl `build` im Modus `production`.

Das bedeutet, dass beim Ausführen von `vite build` die Env-Variablen aus `.env.production` geladen werden, sofern eine solche Datei existiert:

```[.env.production]
VITE_APP_TITLE=My App
```

In Ihrer App können Sie den Titel über `import.meta.env.VITE_APP_TITLE` rendern.

In manchen Fällen möchten Sie `vite build` vielleicht mit einem anderen Modus ausführen, um einen anderen Titel zu rendern. Sie können den für einen Befehl verwendeten Standardmodus überschreiben, indem Sie das Options-Flag `--mode` übergeben. Wenn Sie Ihre App beispielsweise für einen Staging-Modus bauen möchten:

```bash
vite build --mode staging
```

Und eine Datei `.env.staging` anlegen:

```[.env.staging]
VITE_APP_TITLE=My App (staging)
```

Da `vite build` standardmäßig einen Produktions-Build ausführt, können Sie das auch ändern und über einen anderen Modus samt `.env`-Dateikonfiguration einen Entwicklungs-Build erzeugen:

```[.env.testing]
NODE_ENV=development
```

### NODE_ENV und Modi

Wichtig ist, dass `NODE_ENV` (`process.env.NODE_ENV`) und Modi zwei verschiedene Konzepte sind. So wirken sich verschiedene Befehle auf `NODE_ENV` und den Modus aus:

| Befehl                                               | NODE_ENV        | Modus           |
| ---------------------------------------------------- | --------------- | --------------- |
| `vite build`                                         | `"production"`  | `"production"`  |
| `vite build --mode development`                      | `"production"`  | `"development"` |
| `NODE_ENV=development vite build`                    | `"development"` | `"production"`  |
| `NODE_ENV=development vite build --mode development` | `"development"` | `"development"` |

Die unterschiedlichen Werte von `NODE_ENV` und Modus spiegeln sich auch in den zugehörigen `import.meta.env`-Eigenschaften wider:

| Befehl                 | `import.meta.env.PROD` | `import.meta.env.DEV` |
| ---------------------- | ---------------------- | --------------------- |
| `NODE_ENV=production`  | `true`                 | `false`               |
| `NODE_ENV=development` | `false`                | `true`                |
| `NODE_ENV=other`       | `false`                | `true`                |

| Befehl               | `import.meta.env.MODE` |
| -------------------- | ---------------------- |
| `--mode production`  | `"production"`         |
| `--mode development` | `"development"`        |
| `--mode staging`     | `"staging"`            |

:::tip `NODE_ENV` in `.env`-Dateien

`NODE_ENV=...` lässt sich im Befehl setzen und ebenso in Ihrer `.env`-Datei. Ist `NODE_ENV` in einer `.env.[mode]`-Datei angegeben, kann der Modus dessen Wert steuern. Dennoch bleiben `NODE_ENV` und Modi zwei verschiedene Konzepte.

Der wesentliche Vorteil von `NODE_ENV=...` im Befehl besteht darin, dass Vite den Wert früh erkennen kann. Außerdem erlaubt es Ihnen, `process.env.NODE_ENV` in Ihrer Vite-Konfiguration zu lesen, da Vite die Env-Dateien erst laden kann, sobald die Konfiguration ausgewertet ist.
:::
