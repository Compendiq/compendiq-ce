<h1 align="center">Serverless</h1>

Betreibe serverlose Anwendungen und REST-APIs mit deiner bestehenden Fastify-Anwendung. Möglicherweise musst du Codeänderungen vornehmen, damit es auf der von dir gewählten Serverless-Plattform funktioniert. Dieses Dokument enthält einen kleinen Leitfaden zu den beliebtesten Serverless-Anbietern und dazu, wie du Fastify mit ihnen verwendest.

#### Solltest du Fastify auf einer Serverless-Plattform einsetzen?

Das liegt bei dir! Bedenke, dass Functions as a Service immer kleine und fokussierte Funktionen verwenden sollten, du kannst damit aber auch eine komplette Webanwendung betreiben. Wichtig ist zu bedenken: Je größer die Anwendung, desto langsamer der initiale Start. Der beste Weg, Fastify-Anwendungen in Serverless-Umgebungen zu betreiben, sind Plattformen wie Google Cloud Run, AWS Fargate, Azure Container Instances und Vercel, wo der Server mehrere Requests gleichzeitig verarbeiten und die Funktionen von Fastify voll ausschöpfen kann.

Eine der besten Eigenschaften beim Einsatz von Fastify in serverlosen Anwendungen ist die einfache Entwicklung. In deiner lokalen Umgebung führst du die Fastify-Anwendung immer direkt aus, ohne zusätzliche Werkzeuge, während derselbe Code auf der von dir gewählten Serverless-Plattform mit einem zusätzlichen Code-Schnipsel ausgeführt wird.

### Inhalt

- [AWS](#aws)
- [Genezio](#genezio)
- [Google Cloud Functions](#google-cloud-functions)
- [Google Firebase Functions](#google-firebase-functions)
- [Google Cloud Run](#google-cloud-run)
- [Netlify Lambda](#netlify-lambda)
- [Vercel](#vercel)

## AWS

Für die Integration mit AWS hast du zwei Bibliotheken zur Auswahl:

- [@fastify/aws-lambda](https://github.com/fastify/aws-lambda-fastify), das nur API-Gateway-Unterstützung hinzufügt, aber stark auf Fastify optimiert ist.
- [@h4ad/serverless-adapter](https://github.com/H4ad/serverless-adapter), das etwas langsamer ist, da es für jedes AWS-Event einen HTTP-Request erzeugt, aber mehr AWS-Dienste unterstützt, etwa: AWS SQS, AWS SNS und andere.

Du kannst also entscheiden, welche Option für dich am besten passt, und beide Bibliotheken ausprobieren.

### @fastify/aws-lambda verwenden

Das bereitgestellte Beispiel erlaubt es dir, serverlose Webanwendungen/-dienste und RESTful-APIs mit Fastify auf AWS Lambda und Amazon API Gateway einfach zu bauen.

#### app.js

```js
const fastify = require('fastify');

function init() {
  const app = fastify();
  app.get('/', (request, reply) => reply.send({ hello: 'world' }));
  return app;
}

if (require.main === module) {
  // called directly i.e. "node app"
  init().listen({ port: 3000 }, (err) => {
    if (err) console.error(err);
    console.log('server listening on 3000');
  });
} else {
  // required as a module => executed on aws lambda
  module.exports = init;
}
```

Bei der Ausführung in deiner Lambda-Funktion müssen wir nicht auf einem bestimmten Port lauschen, daher exportieren wir in diesem Fall einfach die Wrapper-Funktion `init`. Die Datei [`lambda.js`](#lambdajs) verwendet diesen Export.

Wenn du deine Fastify-Anwendung wie gewohnt ausführst, also `node app.js` *(die Erkennung dafür könnte `require.main === module` sein)*, kannst du normal auf deinem Port lauschen, sodass du deine Fastify-Funktion weiterhin lokal ausführen kannst.

#### lambda.js

```js
const awsLambdaFastify = require('@fastify/aws-lambda')
const init = require('./app');

const proxy = awsLambdaFastify(init())
// or
// const proxy = awsLambdaFastify(init(), { binaryMimeTypes: ['application/octet-stream'] })

exports.handler = proxy;
// or
// exports.handler = (event, context, callback) => proxy(event, context, callback);
// or
// exports.handler = (event, context) => proxy(event, context);
// or
// exports.handler = async (event, context) => proxy(event, context);
```

Wir requiren einfach [@fastify/aws-lambda](https://github.com/fastify/aws-lambda-fastify) (achte darauf, die Abhängigkeit mit `npm i @fastify/aws-lambda` zu installieren) und unsere Datei [`app.js`](#appjs) und rufen die exportierte Funktion `awsLambdaFastify` mit `app` als einzigem Parameter auf. Die resultierende Funktion `proxy` hat die korrekte Signatur, um als Lambda-`handler`-Funktion verwendet zu werden. So werden alle eingehenden Events (API-Gateway-Requests) an die Funktion `proxy` von [@fastify/aws-lambda](https://github.com/fastify/aws-lambda-fastify) übergeben.

### Zu beachten

- API Gateway unterstützt noch keine Streams, du kannst also keine [Streams](../Reference/Reply.md#streams) verarbeiten.
- API Gateway hat ein Timeout von 29 Sekunden, es ist also wichtig, innerhalb dieser Zeit eine Antwort zu liefern.

#### Über API Gateway hinaus

Wenn du mit weiteren AWS-Diensten integrieren musst, sieh dir [@h4ad/serverless-adapter](https://serverless-adapter.viniciusl.com.br/docs/main/frameworks/fastify) für Fastify an, um herauszufinden, wie die Integration funktioniert.

## Genezio

[Genezio](https://genezio.com/) ist eine Plattform, die das Deployment serverloser Anwendungen in die Cloud vereinfachen soll.

[Genezio hat einen eigenen Leitfaden für das Deployment einer Fastify-Anwendung.](https://deployapps.dev/docs/frameworks/fastify/)

## Google Cloud Functions

### Erstellung der Fastify-Instanz
```js
const fastify = require("fastify")({
  logger: true // you can also define the level passing an object configuration to logger: {level: 'debug'}
});
```

### Eigenen `contentTypeParser` zur Fastify-Instanz hinzufügen

Wie [in Issue #946](https://github.com/fastify/fastify/issues/946#issuecomment-766319521) erläutert, parst die Plattform Google Cloud Functions den Body des Requests, bevor er die Fastify-Instanz erreicht, was den Request-Body bei den Methoden `POST` und `PATCH` stört. Daher musst du einen eigenen [`Content-Type Parser`](../Reference/ContentTypeParser.md) hinzufügen, um dieses Verhalten abzumildern.

```js
fastify.addContentTypeParser('application/json', {}, (req, body, done) => {
  done(null, body.body);
});
```

### Definiere deinen Endpunkt (Beispiele)

Ein einfacher `GET`-Endpunkt:
```js
fastify.get('/', async (request, reply) => {
  reply.send({message: 'Hello World!'})
})
```

Oder ein vollständigerer `POST`-Endpunkt mit Schema-Validierung:
```js
fastify.route({
  method: 'POST',
  url: '/hello',
  schema: {
    body: {
      type: 'object',
      properties: {
        name: { type: 'string'}
      },
      required: ['name']
    },
    response: {
      200: {
        type: 'object',
        properties: {
          message: {type: 'string'}
        }
      }
    },
  },
  handler: async (request, reply) => {
    const { name } = request.body;
    reply.code(200).send({
      message: `Hello ${name}!`
    })
  }
})
```

### Die Funktion implementieren und exportieren

Als letzten Schritt implementierst du die Funktion, die den Request verarbeitet, und übergibst ihn an Fastify, indem du ein `request`-Event an `fastify.server` sendest:

```js
const fastifyFunction = async (request, reply) => {
  await fastify.ready();
  fastify.server.emit('request', request, reply)
}

exports.fastifyFunction = fastifyFunction;
```

### Lokaler Test

Installiere das [Google Functions Framework für Node.js](https://github.com/GoogleCloudPlatform/functions-framework-nodejs).

Du kannst es global installieren:
```bash
npm i -g @google-cloud/functions-framework
```

Oder als Entwicklungsbibliothek:
```bash
npm i -D @google-cloud/functions-framework
```

Dann kannst du deine Funktion lokal mit dem Functions Framework ausführen:
```bash
npx @google-cloud/functions-framework --target=fastifyFunction
```

Oder füge diesen Befehl deinen `package.json`-Skripten hinzu:
```json
"scripts": {
  ...
  "dev": "npx @google-cloud/functions-framework --target=fastifyFunction"
  ...
}
```
und führe ihn mit `npm run dev` aus.

### Deployment
```bash
gcloud functions deploy fastifyFunction \
--runtime nodejs14 --trigger-http --region $GOOGLE_REGION --allow-unauthenticated
```

#### Logs lesen
```bash
gcloud functions logs read
```

#### Beispiel-Request an den Endpunkt `/hello`
```bash
curl -X POST https://$GOOGLE_REGION-$GOOGLE_PROJECT.cloudfunctions.net/me \
  -H "Content-Type: application/json" \
  -d '{ "name": "Fastify" }'
{"message":"Hello Fastify!"}
```

#### Logging pro Route

Google Cloud Functions stellt einen einzigen Einstiegspunkt für deine Fastify-Instanz bereit, daher kann das Dashboard den gesamten HTTP-Traffic unter dieser Funktion anzeigen. Statt eine Funktion pro Endpunkt auszurollen, behalte die einzelne Fastify-Instanz bei und gib nach jedem Request eine strukturierte Logzeile mit der getroffenen Route aus:

```js
fastify.addHook('onResponse', async (request, reply) => {
  request.log.info({
    route: request.routeOptions.url,
    method: request.method,
    statusCode: reply.statusCode,
    responseTime: reply.elapsedTime
  }, 'request completed')
})
```

`request.routeOptions.url` ist das Route-Muster, sodass `/users/123` und `/users/456` unter `/users/:id` gruppiert werden. Mit aktiviertem Fastify-Logger werden die Felder als strukturierte Logfelder ausgegeben, wie in der [Dokumentation zu strukturiertem Logging in Cloud Logging](https://cloud.google.com/logging/docs/structured-logging) und im [Logging-Leitfaden für Cloud Functions](https://cloud.google.com/functions/docs/monitoring/logging) beschrieben. Erstelle in Cloud Logging eine [log-basierte Metrik](https://cloud.google.com/logging/docs/logs-based-metrics) oder filtere auf `jsonPayload.route`, um Request-Zahlen, Latenz und Fehlerraten pro Route zu erhalten.

Derselbe Hook funktioniert auch beim Deployment über Firebase Functions mit `onRequest`.

### Referenzen
- [Google Cloud Functions - Node.js Quickstart
  ](https://cloud.google.com/run/docs/quickstarts/functions/deploy-functions-gcloud)
- [Cloud Logging - Structured Logging](https://cloud.google.com/logging/docs/structured-logging)
- [Cloud Logging - Log-based Metrics](https://cloud.google.com/logging/docs/logs-based-metrics)
- [Cloud Functions - Logging](https://cloud.google.com/functions/docs/monitoring/logging)

## Google Firebase Functions

Folge diesem Leitfaden, wenn du Fastify als HTTP-Framework für Firebase Functions verwenden möchtest, statt des mit `onRequest(async (req, res) => {}` gelieferten schlichten JavaScript-Routers.

### Der onRequest()-Handler

Wir verwenden die Funktion `onRequest`, um unsere Fastify-Anwendungsinstanz zu umschließen.

Daher beginnen wir damit, sie in den Code zu importieren:

```js
const { onRequest } = require("firebase-functions/v2/https")
```

### Erstellung der Fastify-Instanz

Erstelle die Fastify-Instanz und kapsle die zurückgegebene Anwendungsinstanz in einer Funktion, die Routes registriert und die Verarbeitung von Plugins, Hooks und weiteren Einstellungen durch den Server abwartet. Und zwar so:

```js
const fastify = require("fastify")({
  logger: true,
})

const fastifyApp = async (request, reply) => {
  await registerRoutes(fastify)
  await fastify.ready()
  fastify.server.emit("request", request, reply)
}
```

### Eigenen `contentTypeParser` zur Fastify-Instanz hinzufügen und Endpunkte definieren

Die HTTP-Schicht von Firebase Functions parst den Request bereits und stellt ein JSON-Payload über die Eigenschaft `payload.body` unten bereit. Sie bietet außerdem Zugriff auf den rohen, ungeparsten Body, was nützlich ist, um Request-Signaturen zur Validierung von HTTP-Webhooks zu berechnen.

Ergänze die Funktion `registerRoutes()` wie folgt:

```js
async function registerRoutes (fastify) {
  fastify.addContentTypeParser("application/json", {}, (req, payload, done) => {
    // useful to include the request's raw body on the `req` object that will
    // later be available in your other routes so you can calculate the HMAC
    // if needed
    req.rawBody = payload.rawBody

    // payload.body is already the parsed JSON so we just fire the done callback
    // with it
    done(null, payload.body)
  })

  // define your endpoints here...
  fastify.post("/some-route-here", async (request, reply) => {})

  fastify.get('/', async (request, reply) => {
    reply.send({message: 'Hello World!'})
  })
}
```

**Wird dieser `ContentTypeParser` nicht hinzugefügt, kann der Fastify-Prozess hängen bleiben und nach dem Empfang eines Requests mit dem Content-Type `application/json` keine weiteren Requests mehr verarbeiten.**

Bei Verwendung von TypeScript kann die Eigenschaft `payload.body` nicht gefunden werden, da der Typ von `payload` eine native `IncomingMessage` ist, die von Firebase verändert wird.

Um den Fehler zu unterdrücken, kannst du die folgende Signatur verwenden:

```ts
declare module 'http' {
	interface IncomingMessage {
		body?: unknown;
	}
}
```

### Die Funktion mit Firebase onRequest exportieren

Der letzte Schritt besteht darin, die Fastify-App-Instanz an Firebases eigene Funktion `onRequest()` zu exportieren, damit diese ihr die Request- und Reply-Objekte übergeben kann:

```js
exports.app = onRequest(fastifyApp)
```

### Lokaler Test

Installiere die Firebase-Tools-Funktionen, damit du die CLI verwenden kannst:

```bash
npm i -g firebase-tools
```

Dann kannst du deine Funktion lokal ausführen mit:

```bash
firebase emulators:start --only functions
```

### Deployment

Rolle deine Firebase Functions aus mit:

```bash
firebase deploy --only functions
```

#### Logs lesen

Verwende die Firebase-Tools-CLI:

```bash
firebase functions:log
```

### Referenzen
- [Fastify on Firebase Functions](https://github.com/lirantal/lemon-squeezy-firebase-webhook-fastify/blob/main/package.json)
- [An article about HTTP webhooks on Firebase Functions and Fastify: A Practical Case Study with Lemon Squeezy](https://lirantal.com/blog/http-webhooks-firebase-functions-fastify-practical-case-study-lemon-squeezy)

## Google Cloud Run

Anders als AWS Lambda oder Google Cloud Functions ist Google Cloud Run eine serverlose **Container**-Umgebung. Ihr Hauptzweck ist es, eine infrastrukturabstrahierte Umgebung zum Ausführen beliebiger Container bereitzustellen. Dadurch lässt sich Fastify mit wenigen bis gar keinen Codeänderungen gegenüber der gewohnten Schreibweise deiner Fastify-App auf Google Cloud Run ausrollen.

*Folge den Schritten unten, um auf Google Cloud Run auszurollen, wenn du bereits mit gcloud vertraut bist, oder folge einfach dem [Quickstart](https://docs.cloud.google.com/run/docs/quickstarts).*

### Fastify-Server anpassen

Damit Fastify Requests innerhalb des Containers korrekt entgegennimmt, achte darauf, den richtigen Port und die richtige Adresse zu setzen:

```js
function build() {
  const fastify = Fastify({ trustProxy: true })
  return fastify
}

async function start() {
  // Google Cloud Run will set this environment variable for you, so
  // you can also use it to detect if you are running in Cloud Run
  const IS_GOOGLE_CLOUD_RUN = process.env.K_SERVICE !== undefined

  // You must listen on the port Cloud Run provides
  const port = process.env.PORT || 3000

  // You must listen on all IPV4 addresses in Cloud Run
  const host = IS_GOOGLE_CLOUD_RUN ? "0.0.0.0" : undefined

  try {
    const server = build()
    const address = await server.listen({ port, host })
    console.log(`Listening on ${address}`)
  } catch (err) {
    console.error(err)
    process.exit(1)
  }
}

module.exports = build

if (require.main === module) {
  start()
}
```

### Ein Dockerfile hinzufügen

Du kannst jedes gültige `Dockerfile` verwenden, das eine Node-App verpackt und ausführt. Ein einfaches `Dockerfile` findest du in der offiziellen [gcloud-Dokumentation](https://github.com/knative/docs/blob/2d654d1fd6311750cc57187a86253c52f273d924/docs/serving/samples/hello-world/helloworld-nodejs/Dockerfile).

```Dockerfile
# Use the official Node.js LTS image.
# https://hub.docker.com/_/node
FROM node:lts

# Create and change to the app directory.
WORKDIR /usr/src/app

# Copy application dependency manifests to the container image.
# A wildcard is used to ensure both package.json AND package-lock.json are copied.
# Copying this separately prevents re-running npm install on every code change.
COPY package*.json ./

# Install production dependencies.
RUN npm i --production

# Copy local code to the container image.
COPY . .

# Run the web service on container startup.
CMD [ "npm", "start" ]
```

### Eine .dockerignore hinzufügen

Um Build-Artefakte aus deinem Container herauszuhalten (was ihn klein hält und die Build-Zeiten verbessert), füge eine `.dockerignore`-Datei wie die folgende hinzu:

```dockerignore
Dockerfile
README.md
node_modules
npm-debug.log
```

### Build einreichen

Als Nächstes reichst du deine App ein, damit sie zu einem Docker-Image gebaut wird, indem du den folgenden Befehl ausführst (ersetze `PROJECT-ID` und `APP-NAME` durch deine GCP-Projekt-ID und einen App-Namen):

```bash
gcloud builds submit --tag gcr.io/PROJECT-ID/APP-NAME
```

### Image ausrollen

Nachdem dein Image gebaut wurde, kannst du es mit dem folgenden Befehl ausrollen:

```bash
gcloud beta run deploy --image gcr.io/PROJECT-ID/APP-NAME --platform managed
```

Deine App ist dann über die von GCP bereitgestellte URL erreichbar.

## netlify-lambda

Führe zunächst bitte alle Vorbereitungsschritte zu **AWS Lambda** durch.

Erstelle einen Ordner namens `functions` und darin die Datei `server.js` (dein Endpunktpfad ist dann `server.js`).

### functions/server.js

```js
export { handler } from '../lambda.js'; // Change `lambda.js` path to your `lambda.js` path
```

### netlify.toml

```toml
[build]
  # This will be run the site build
  command = "npm run build:functions"
  # This is the directory is publishing to netlify's CDN
  # and this is directory of your front of your app
  # publish = "build"
  # functions build directory
  functions = "functions-build" # always appends `-build` folder to your `functions` folder for builds
```

### webpack.config.netlify.js

**Vergiss nicht, diese Webpack-Konfiguration hinzuzufügen, sonst können Probleme auftreten**

```js
const nodeExternals = require('webpack-node-externals');
const dotenv = require('dotenv-safe');
const webpack = require('webpack');

const env = process.env.NODE_ENV || 'production';
const dev = env === 'development';

if (dev) {
  dotenv.config({ allowEmptyValues: true });
}

module.exports = {
  mode: env,
  devtool: dev ? 'eval-source-map' : 'none',
  externals: [nodeExternals()],
  devServer: {
    proxy: {
      '/.netlify': {
        target: 'http://localhost:9000',
        pathRewrite: { '^/.netlify/functions': '' }
      }
    }
  },
  module: {
    rules: []
  },
  plugins: [
    new webpack.DefinePlugin({
      'process.env.APP_ROOT_PATH': JSON.stringify('/'),
      'process.env.NETLIFY_ENV': true,
      'process.env.CONTEXT': env
    })
  ]
};
```

### Skripte

Füge diesen Befehl deinen `package.json`-*scripts* hinzu

```json
"scripts": {
  ...
  "build:functions": "netlify-lambda build functions --config ./webpack.config.netlify.js"
  ...
}
```

Danach sollte alles einwandfrei funktionieren.

## Vercel

[Vercel](https://vercel.com) unterstützt das Deployment von Fastify-Anwendungen vollständig. Zusätzlich kannst du mit Vercels [Fluid compute](https://vercel.com/docs/fluid-compute) serverartige Nebenläufigkeit mit den Autoscaling-Eigenschaften klassischer serverloser Funktionen kombinieren.

Steige mit dem [Fastify-Template auf Vercel](
https://vercel.com/templates/backend/fastify-on-vercel) ein.

[Fluid compute](https://vercel.com/docs/fluid-compute) erfordert derzeit eine ausdrückliche Aktivierung. Mehr zum Aktivieren von Fluid compute erfährst du [hier](
https://vercel.com/docs/fluid-compute#enabling-fluid-compute).
