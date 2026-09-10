<h1 align="center">Fastify</h1>

# Erkennen, wann Clients abbbrechen

## Einleitung

Fastify bietet Request-Events, die an bestimmten Punkten im Lebenszyklus einer Anfrage ausgelöst werden. Es gibt jedoch keinen eingebauten Mechanismus, um unbeabsichtigte Trennungsszenarien des Clients zu erkennen, wie z. B. wenn die Internetverbindung des Clients unterbrochen wird. Diese Anleitung behandelt Methoden zur Erkennung, ob und wann ein Client eine Anfrage absichtlich abbricht.

Beachten Sie, dass Fastifys `clientErrorHandler` nicht dafür ausgelegt ist, zu erkennen, wann ein Client eine Anfrage abbricht. Dies funktioniert genauso wie beim Standard-Node HTTP Modul, das den `clientError` Event auslöst, wenn eine ungültige Anfrage oder übermäßig große Header-Daten vorliegt. Wenn ein Client eine Anfrage abbricht, gibt es keinen Fehler auf der Socket und `clientErrorHandler` wird nicht ausgelöst.

## Lösung

### Überblick

Die vorgeschlagene Lösung ist eine mögliche Methode zur Erkennung, wann ein Client absichtlich eine Anfrage abbricht, z. B. wenn ein Browser geschlossen wird oder die HTTP-Anfrage von Ihrer Clientanwendung abgebrochen wird. Wenn Ihr Anwendungscode einen Fehler enthält, der zum Absturz des Servers führt, benötigen Sie möglicherweise zusätzliche Logik, um eine falsche Abbruchserkennung zu vermeiden.

Ziel ist es hier, zu erkennen, wann ein Client eine Verbindung absichtlich abbricht, damit Ihre Anwendungsschicht entsprechend fortfahren kann. Dies kann für Protokollierungszwecke oder um Geschäftslogik anzuhalten nützlich sein.

### Praxisbeispiel

Nehmen wir an, wir haben den folgenden Basisserver eingerichtet:
```js
import Fastify from 'fastify';

const sleep = async (time) => {
  return await new Promise(resolve => setTimeout(resolve, time || 1000));
}

const app = Fastify({
  logger: {
    transport: {
      target: 'pino-pretty',
      options: {
        translateTime: 'HH:MM:ss Z',
        ignore: 'pid,hostname',
      },
    },
  },
})

app.addHook('onRequest', async (request, reply) => {
  request.raw.on('close', () => {
    if (request.raw.aborted) {
      app.log.info('request closed')
    }
  })
})

app.get('/', async (request, reply) => {
  await sleep(3000)
  reply.code(200).send({ ok: true })
})

const start = async () => {
  try {
    await app.listen({ port: 3000 })
  } catch (err) {
    app.log.error(err)
    process.exit(1)
  }
}

start()
```
Unser Code richtet einen Fastify-Server ein, der folgende Funktionalität beinhaltet:

- Annahme von Requests unter `http://localhost:3000` mit einer verzögerten Antwort nach 3 Sekunden von `{ ok: true }`.
- Ein onRequest Hook, der ausgelöst wird, wenn jeder Request empfangen wird.
- Logik, die im Hook ausgeführt wird, wenn der Request geschlossen wird.
- Protokollierung, die erfolgt, wenn die Eigenschaft `aborted` des geschlossenen Requests true ist.

Obwohl die Eigenschaft `aborted` veraltet ist, ist `destroyed` kein geeigneter Ersatz, da die [Node.js Dokumentation vorschlägt](https://nodejs.org/api/http.html#requestaborted). Ein Request kann aus verschiedenen Gründen `destroyed` sein, z. B. wenn der Server die Verbindung schließt. Die Eigenschaft `aborted` ist nach wie vor die zuverlässigste Methode, um festzustellen, wann ein Client einen Request absichtlich abbricht.

Sie können diese Logik auch außerhalb eines Hooks, direkt in einer bestimmten Route durchführen.
```js
app.get('/', async (request, reply) => {
  request.raw.on('close', () => {
    if (request.raw.aborted) {
      app.log.info('request closed')
    }
  })
  await sleep(3000)
  reply.code(200).send({ ok: true })
})
```
An jedem Punkt Ihrer Geschäftslogik können Sie prüfen, ob die Anfrage abgebrochen wurde, und alternative Aktionen durchführen.
```js
app.get('/', async (request, reply) => {
  await sleep(3000)
  if (request.raw.aborted) {
    // do something here
  }
  await sleep(3000)
  reply.code(200).send({ ok: true })
})
```
Ein Vorteil, dies in Ihrem Anwendungscode hinzuzufügen, besteht darin, dass Sie Fastify-Details protokollieren können, wie z. B. die `reqId`, die in niedrigerstufigem Code möglicherweise nicht verfügbar ist, der nur Zugriff auf die rohen Anforderungsinformationen hat.

### Testen

Um diese Funktionalität zu testen, können Sie eine App wie Postman verwenden und Ihre Anfrage innerhalb von 3 Sekunden abbrechen. Alternativ können Sie Node verwenden, um eine HTTP-Anfrage mit Logik zu senden, die die Anfrage vor Ablauf von 3 Sekunden abbricht. Beispiel:
```js
const controller = new AbortController();
const signal = controller.signal;

(async () => {
   try {
      const response = await fetch('http://localhost:3000', { signal });
      const body = await response.text();
      console.log(body);
   } catch (error) {
      console.error(error);
   }
})();

setTimeout(() => {
   controller.abort()
}, 1000);
```
Mit beiden Ansätzen sollten Sie sehen, dass der Fastify-Log erscheint, sobald die Anfrage abgebrochen wird.

## Fazit

Die Details der Implementierung variieren von Problem zu Problem, aber das Hauptziel dieses Leitfadens war es, einen sehr spezifischen Anwendungsfall für ein Problem zu zeigen, das innerhalb des Fastify-Ökosystems gelöst werden konnte.

Sie können auf das `close`-Ereignis der Anfrage hören und feststellen, ob die Anfrage abgebrochen oder erfolgreich geliefert wurde. Sie können diese Lösung in einem `onRequest`-Hook oder direkt in einer einzelnen Route implementieren.

Dieser Ansatz wird bei Internetunterbrechungen nicht ausgelöst, und eine solche Erkennung würde zusätzliche Geschäftslogik erfordern. Wenn Sie fehlerhafte Backend-Anwendungslogik haben, die zu einem Serverabsturz führt, könnte dies eine falsche Erkennung auslösen. Der `clientErrorHandler` ist weder standardmäßig noch mit benutzerdefinierter Logik dafür vorgesehen, dieses Szenario zu behandeln und wird nicht ausgelöst, wenn der Client eine Anfrage abbricht.