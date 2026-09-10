<!--
  LESEN SIE DIES, WENN SIE EINE NEUE DEPLOYMENT-PLATTFORM HINZUFÜGEN MÖCHTEN.

  Reichen Sie gerne einen PR ein, der einen neuen Abschnitt mit einem Link auf den
  Deployment-Leitfaden Ihrer Plattform hinzufügt, sofern er diese Kriterien erfüllt:

  1. Nutzende sollen ihre Website kostenlos deployen können.
  2. Angebote im kostenlosen Tarif sollen die Website unbegrenzt hosten und nicht zeitlich befristet sein.
     Eine begrenzte Menge an Rechenressourcen oder eine begrenzte Zahl an Websites im Gegenzug ist in Ordnung.
  3. Die verlinkten Leitfäden dürfen keine schädlichen Inhalte enthalten.
  4. Die Plattform muss seit mindestens 1 Jahr in Betrieb sein. Bitte belegen Sie das
     in Ihrer PR-Beschreibung.

  Neue Abschnitte sollten am Ende der Datei ergänzt werden. Orientieren Sie sich für die Formatierung
  des neuen Abschnitts bitte an den bestehenden Abschnitten am Ende dieser Datei.

  Das Vite-Team kann die Kriterien ändern und die aktuelle Liste von Zeit zu Zeit überprüfen.
  Wird ein Abschnitt entfernt, benachrichtigen wir vorher die ursprünglichen PR-Autoren.
-->

# Eine statische Website deployen

Die folgenden Leitfäden basieren auf einigen gemeinsamen Annahmen:

- Sie verwenden den Standard-Ausgabeort des Builds (`dist`). Dieser Ort [lässt sich über `build.outDir` ändern](/config/build-options.md#build-outdir); die Anweisungen dieser Leitfäden können Sie in dem Fall entsprechend übertragen.
- Sie verwenden npm. Wenn Sie Yarn oder andere Paketmanager einsetzen, können Sie die Skripte mit den jeweils entsprechenden Befehlen ausführen.
- Vite ist als lokale Dev-Dependency in Ihrem Projekt installiert, und Sie haben die folgenden npm-Skripte eingerichtet:

```json [package.json]
{
  "scripts": {
    "build": "vite build",
    "preview": "vite preview"
  }
}
```

Wichtig zu wissen: `vite preview` ist dafür gedacht, den Build lokal in der Vorschau zu betrachten, und nicht als Produktionsserver.

::: tip HINWEIS
Diese Leitfäden beschreiben, wie Sie ein statisches Deployment Ihrer Vite-Website durchführen. Vite unterstützt außerdem Server-Side Rendering. SSR bezeichnet Frontend-Frameworks, die dieselbe Anwendung in Node.js ausführen, sie zu HTML vorrendern und schließlich auf dem Client hydratisieren können. Mehr zu dieser Funktion erfahren Sie im [SSR-Leitfaden](./ssr). Wenn Sie hingegen eine Integration mit klassischen serverseitigen Frameworks suchen, sehen Sie sich stattdessen den [Leitfaden zur Backend-Integration](./backend-integration) an.
:::

## Die App bauen

Sie können den Befehl `npm run build` ausführen, um die App zu bauen.

```bash
$ npm run build
```

Standardmäßig landet die Build-Ausgabe unter `dist`. Diesen `dist`-Ordner können Sie auf jeder von Ihnen bevorzugten Plattform deployen.

### Die App lokal testen

Sobald Sie die App gebaut haben, können Sie sie lokal testen, indem Sie den Befehl `npm run preview` ausführen.

```bash
$ npm run preview
```

Der Befehl `vite preview` startet einen lokalen statischen Webserver, der die Dateien aus `dist` unter `http://localhost:4173` ausliefert. Das ist eine einfache Möglichkeit zu prüfen, ob der Produktions-Build in Ihrer lokalen Umgebung in Ordnung aussieht.

Sie können den Port des Servers konfigurieren, indem Sie das Flag `--port` als Argument übergeben.

```json [package.json]
{
  "scripts": {
    "preview": "vite preview --port 8080"
  }
}
```

Nun startet der Befehl `preview` den Server unter `http://localhost:8080`.

## GitHub Pages

1. **Vite-Konfiguration anpassen**

   Setzen Sie in der `vite.config.js` das korrekte `base`.

   Wenn Sie nach `https://<USERNAME>.github.io/` oder über GitHub Pages auf eine eigene Domain (z. B. `www.example.com`) deployen, setzen Sie `base` auf `'/'`. Alternativ können Sie `base` aus der Konfiguration entfernen, da der Standardwert `'/'` ist.

   Wenn Sie nach `https://<USERNAME>.github.io/<REPO>/` deployen (Ihr Repository liegt z. B. unter `https://github.com/<USERNAME>/<REPO>`), setzen Sie `base` auf `'/<REPO>/'`.

2. **GitHub Pages aktivieren**

   Gehen Sie in Ihrem Repository zu **Settings → Pages**. Öffnen Sie unter **Build and deployment** das Auswahlmenü **Source** und wählen Sie **GitHub Actions**.

   GitHub deployt Ihre Website nun über einen GitHub-Actions-[Workflow](https://docs.github.com/en/actions/concepts/workflows-and-actions/workflows), was notwendig ist, weil Vite für das Deployment einen Build-Schritt benötigt.

3. **Einen Workflow anlegen**

   Legen Sie in Ihrem Repository eine neue Datei unter `.github/workflows/deploy.yml` an. Sie können auch im vorherigen Schritt auf **„create your own“** klicken, wodurch eine Starter-Workflow-Datei für Sie erzeugt wird.

   Hier ein Beispiel-Workflow, der Abhängigkeiten mit npm installiert, die Website baut und sie deployt, sobald Sie Änderungen in den `main`-Branch pushen:

   <<< ./static-deploy-github-pages.yaml#content [.github/workflows/deploy.yml]

## GitLab Pages und GitLab CI

1. Setzen Sie in der `vite.config.js` das korrekte `base`.

   Wenn Sie nach `https://<USERNAME or GROUP>.gitlab.io/` deployen, können Sie `base` weglassen, da der Standardwert `'/'` ist.

   Wenn Sie nach `https://<USERNAME or GROUP>.gitlab.io/<REPO>/` deployen – Ihr Repository liegt zum Beispiel unter `https://gitlab.com/<USERNAME>/<REPO>` –, setzen Sie `base` auf `'/<REPO>/'`.

2. Legen Sie im Wurzelverzeichnis Ihres Projekts eine Datei namens `.gitlab-ci.yml` mit dem folgenden Inhalt an. Sie baut und deployt Ihre Website, sobald Sie Ihre Inhalte ändern:

   ```yaml [.gitlab-ci.yml]
   image: node:lts
   pages:
     stage: deploy
     cache:
       key:
         files:
           - package-lock.json
         prefix: npm
       paths:
         - node_modules/
     script:
       - npm install
       - npm run build
       - cp -a dist/. public/
     artifacts:
       paths:
         - public
     rules:
       - if: $CI_COMMIT_BRANCH == $CI_DEFAULT_BRANCH
   ```

## Netlify

### Netlify CLI

1. Installieren Sie die [Netlify CLI](https://docs.netlify.com/api-and-cli-guides/cli-guides/get-started-with-cli/) über `npm install -g netlify-cli`.
2. Legen Sie mit `netlify init` eine neue Site an.
3. Deployen Sie mit `netlify deploy`.

Die Netlify CLI gibt Ihnen eine Vorschau-URL zur Prüfung. Wenn Sie bereit für die Produktion sind, verwenden Sie das `prod`-Flag: `netlify deploy --prod`.

### Netlify mit Git

1. Pushen Sie Ihren Code in ein Git-Repository (GitHub, GitLab, BitBucket, Azure DevOps).
2. [Importieren Sie das Projekt](https://app.netlify.com/start) in Netlify.
3. Wählen Sie den Branch und das Ausgabeverzeichnis und richten Sie gegebenenfalls Umgebungsvariablen ein.
4. Klicken Sie auf **Deploy**.
5. Ihre Vite-App ist deployt!

Nachdem Ihr Projekt importiert und deployt wurde, erzeugen alle weiteren Pushes in andere Branches als den Produktions-Branch sowie Pull Requests [Preview-Deployments](https://docs.netlify.com/deploy/deploy-types/deploy-previews/), und alle Änderungen am Produktions-Branch (üblicherweise „main“) führen zu einem [Produktions-Deployment](https://docs.netlify.com/deploy/deploy-overview/#definitions).

## Vercel

### Vercel CLI

1. Installieren Sie die [Vercel CLI](https://vercel.com/cli) über `npm i -g vercel` und führen Sie `vercel` aus, um zu deployen.
2. Vercel erkennt, dass Sie Vite verwenden, und aktiviert die passenden Einstellungen für Ihr Deployment.
3. Ihre Anwendung ist deployt! (z. B. [vite-vue-template.vercel.app](https://vite-vue-template.vercel.app/))

### Vercel mit Git

1. Pushen Sie Ihren Code in Ihr Git-Repository (GitHub, GitLab, Bitbucket).
2. [Importieren Sie Ihr Vite-Projekt](https://vercel.com/new) in Vercel.
3. Vercel erkennt, dass Sie Vite verwenden, und aktiviert die passenden Einstellungen für Ihr Deployment.
4. Ihre Anwendung ist deployt! (z. B. [vite-vue-template.vercel.app](https://vite-vue-template.vercel.app/))

Nachdem Ihr Projekt importiert und deployt wurde, erzeugen alle weiteren Pushes in Branches [Preview-Deployments](https://vercel.com/docs/deployments/environments#preview-environment-pre-production), und alle Änderungen am Produktions-Branch (üblicherweise „main“) führen zu einem [Produktions-Deployment](https://vercel.com/docs/deployments/environments#production-environment).

Mehr über Vercels [Git-Integration](https://vercel.com/docs/concepts/git) erfahren Sie hier.

## Cloudflare

### Cloudflare Workers

Das [Cloudflare-Vite-Plugin](https://developers.cloudflare.com/workers/vite-plugin/) bietet die Integration mit Cloudflare Workers und nutzt Vites Environment API, um Ihren serverseitigen Code während der Entwicklung in der Cloudflare-Workers-Runtime auszuführen.

Um Cloudflare Workers zu einem bestehenden Vite-Projekt hinzuzufügen, installieren Sie das Plugin und fügen es Ihrer Konfiguration hinzu:

```bash
$ npm install --save-dev @cloudflare/vite-plugin
```

```js [vite.config.js]
import { defineConfig } from 'vite'
import { cloudflare } from '@cloudflare/vite-plugin'

export default defineConfig({
  plugins: [cloudflare()],
})
```

```jsonc [wrangler.jsonc]
{
  "name": "my-vite-app",
}
```

Nach dem Ausführen von `npm run build` lässt sich Ihre Anwendung mit `npx wrangler deploy` deployen.

Sie können Ihrer Vite-Anwendung außerdem problemlos Backend-APIs hinzufügen, um sicher mit Cloudflare-Ressourcen zu kommunizieren. Diese laufen während der Entwicklung in der Workers-Runtime und werden zusammen mit Ihrem Frontend deployt. Eine vollständige Anleitung finden Sie im [Tutorial zum Cloudflare-Vite-Plugin](https://developers.cloudflare.com/workers/vite-plugin/tutorial/).

### Cloudflare Pages

#### Cloudflare Pages mit Git

Cloudflare Pages bietet Ihnen eine Möglichkeit, direkt nach Cloudflare zu deployen, ohne eine Wrangler-Datei verwalten zu müssen.

1. Pushen Sie Ihren Code in Ihr Git-Repository (GitHub, GitLab).
2. Melden Sie sich im Cloudflare-Dashboard an und wählen Sie Ihr Konto unter **Account Home** > **Workers & Pages**.
3. Wählen Sie **Create a new Project** und die Option **Pages**, dann Git.
4. Wählen Sie das zu deployende Git-Projekt und klicken Sie auf **Begin setup**.
5. Wählen Sie in den Build-Einstellungen das passende Framework-Preset entsprechend dem von Ihnen gewählten Vite-Framework. Andernfalls geben Sie Ihre Build-Befehle und das erwartete Ausgabeverzeichnis für Ihr Projekt an.
6. Dann speichern und deployen!
7. Ihre Anwendung ist deployt! (z. B. `https://<PROJECTNAME>.pages.dev/`)

Nachdem Ihr Projekt importiert und deployt wurde, erzeugen alle weiteren Pushes in Branches [Preview-Deployments](https://developers.cloudflare.com/pages/platform/preview-deployments/), sofern Sie das in Ihren [Branch-Build-Controls](https://developers.cloudflare.com/pages/platform/branch-build-controls/) nicht anders festlegen. Alle Änderungen am Produktions-Branch (üblicherweise „main“) führen zu einem Produktions-Deployment.

Sie können auf Pages außerdem eigene Domains hinzufügen und eigene Build-Einstellungen verwalten. Mehr zur [Git-Integration von Cloudflare Pages](https://developers.cloudflare.com/pages/configuration/git-integration/) erfahren Sie hier.

## Google Firebase

1. Installieren Sie [firebase-tools](https://www.npmjs.com/package/firebase-tools) über `npm i -g firebase-tools`.

2. Legen Sie im Wurzelverzeichnis Ihres Projekts die folgenden Dateien an:

   ::: code-group

   ```json [firebase.json]
   {
     "hosting": {
       "public": "dist",
       "ignore": [],
       "rewrites": [
         {
           "source": "**",
           "destination": "/index.html"
         }
       ]
     }
   }
   ```

   ```js [.firebaserc]
   {
     "projects": {
       "default": "<YOUR_FIREBASE_ID>"
     }
   }
   ```

   :::

3. Deployen Sie nach dem Ausführen von `npm run build` mit dem Befehl `firebase deploy`.

## Surge

1. Installieren Sie [surge](https://www.npmjs.com/package/surge) über `npm i -g surge`.
2. Führen Sie `npm run build` aus.
3. Deployen Sie nach surge, indem Sie `surge dist` eingeben.

Sie können auch auf eine [eigene Domain](https://surge.sh/help/adding-a-custom-domain) deployen, indem Sie `surge dist yourdomain.com` verwenden.

## Azure Static Web Apps

Mit dem Microsoft-Azure-Dienst [Static Web Apps](https://aka.ms/staticwebapps) können Sie Ihre Vite-App schnell deployen. Sie benötigen:

- Ein Azure-Konto und einen Subscription Key. Sie können [hier ein kostenloses Azure-Konto anlegen](https://azure.microsoft.com/free).
- Ihren App-Code, gepusht nach [GitHub](https://github.com).
- Die [SWA-Erweiterung](https://marketplace.visualstudio.com/items?itemName=ms-azuretools.vscode-azurestaticwebapps) in [Visual Studio Code](https://code.visualstudio.com).

Installieren Sie die Erweiterung in VS Code und wechseln Sie in das Wurzelverzeichnis Ihrer App. Öffnen Sie die Static-Web-Apps-Erweiterung, melden Sie sich bei Azure an und klicken Sie auf das „+“-Zeichen, um eine neue Static Web App anzulegen. Sie werden aufgefordert festzulegen, welcher Subscription Key verwendet werden soll.

Folgen Sie dem von der Erweiterung gestarteten Assistenten, um Ihrer App einen Namen zu geben, ein Framework-Preset zu wählen und das App-Wurzelverzeichnis (üblicherweise `/`) sowie den Ort der gebauten Dateien `/dist` festzulegen. Der Assistent läuft durch und legt in Ihrem Repository im Ordner `.github` eine GitHub Action an.

Die Action deployt Ihre App (den Fortschritt sehen Sie im Actions-Tab Ihres Repositories), und nach erfolgreichem Abschluss können Sie Ihre App unter der Adresse betrachten, die im Fortschrittsfenster der Erweiterung angegeben ist, indem Sie auf die Schaltfläche „Browse Website“ klicken, die nach dem Durchlauf der GitHub Action erscheint.

## Render

Sie können Ihre Vite-App als Static Site auf [Render](https://render.com/) deployen.

1. Legen Sie ein [Render-Konto](https://dashboard.render.com/register) an.

2. Klicken Sie im [Dashboard](https://dashboard.render.com/) auf die Schaltfläche **New** und wählen Sie **Static Site**.

3. Verbinden Sie Ihr GitHub-/GitLab-Konto oder verwenden Sie ein öffentliches Repository.

4. Geben Sie einen Projektnamen und einen Branch an.
   - **Build Command**: `npm install && npm run build`
   - **Publish Directory**: `dist`

5. Klicken Sie auf **Create Static Site**. Ihre App sollte unter `https://<PROJECTNAME>.onrender.com/` deployt sein.

Standardmäßig löst jeder neue Commit, der in den angegebenen Branch gepusht wird, automatisch ein neues Deployment aus. [Auto-Deploy](https://render.com/docs/deploys#configuring-auto-deploys) lässt sich in den Projekteinstellungen konfigurieren.

Sie können Ihrem Projekt außerdem eine [eigene Domain](https://render.com/docs/custom-domains) hinzufügen.

## Flightcontrol

Deployen Sie Ihre statische Website mit [Flightcontrol](https://www.flightcontrol.dev/?ref=docs-vite), indem Sie diesen [Anweisungen](https://www.flightcontrol.dev/docs/reference/examples/vite?ref=docs-vite) folgen.

## xmit Static Site Hosting

Deployen Sie Ihre statische Website mit [xmit](https://xmit.co), indem Sie diesem [Leitfaden](https://xmit.dev/guides/vite-quickstart/) folgen.

## Zephyr Cloud

[Zephyr Cloud](https://zephyr-cloud.io) ist eine Deployment-Plattform, die sich direkt in Ihren Build-Prozess integriert und globale Edge-Verteilung für Module Federation und andere Arten von Anwendungen bietet.

Zephyr verfolgt einen anderen Ansatz als andere Cloud-Anbieter. Es integriert sich direkt in den Vite-Build-Prozess, sodass Ihre Anwendung bei jedem Build und bei jedem Start des Dev-Servers automatisch mit Zephyr Cloud deployt wird.

Folgen Sie den Schritten im [Vite-Deployment-Leitfaden](https://docs.zephyr-cloud.io/bundlers/vite), um loszulegen.

## EdgeOne Pages

Deployen Sie Ihre statische Website mit [EdgeOne Pages](https://edgeone.ai/products/pages), indem Sie diesen [Anweisungen](https://pages.edgeone.ai/document/vite) folgen.
