# Preview-Optionen

Sofern nicht anders angegeben, gelten die Optionen in diesem Abschnitt nur für Preview.

## preview.host

- **Typ:** `string | boolean`
- **Standard:** [`server.host`](./server-options#server-host)

Legt fest, auf welchen IP-Adressen der Server lauschen soll.
Setzen Sie den Wert auf `0.0.0.0` oder `true`, um auf allen Adressen zu lauschen, einschließlich LAN- und öffentlicher Adressen.

Dies lässt sich über die CLI mit `--host 0.0.0.0` oder `--host` setzen.

::: tip HINWEIS

Es gibt Fälle, in denen andere Server anstelle von Vite antworten.
Weitere Einzelheiten finden Sie unter [`server.host`](./server-options#server-host).

:::

## preview.allowedHosts

- **Typ:** `string[] | true`
- **Standard:** [`server.allowedHosts`](./server-options#server-allowedhosts)

Die Hostnamen, auf die Vite antworten darf.

Weitere Einzelheiten finden Sie unter [`server.allowedHosts`](./server-options#server-allowedhosts).

## preview.port

- **Typ:** `number`
- **Standard:** `4173`

Legt den Server-Port fest. Beachten Sie: Ist der Port bereits belegt, probiert Vite automatisch den nächsten freien Port, sodass dies möglicherweise nicht der Port ist, auf dem der Server letztlich lauscht.

**Beispiel:**

```js
export default defineConfig({
  server: {
    port: 3030,
  },
  preview: {
    port: 8080,
  },
})
```

## preview.strictPort

- **Typ:** `boolean`
- **Standard:** [`server.strictPort`](./server-options#server-strictport)

Auf `true` setzen, um abzubrechen, wenn der Port bereits belegt ist, statt automatisch den nächsten freien Port zu probieren.

## preview.https

- **Typ:** `https.ServerOptions`
- **Standard:** [`server.https`](./server-options#server-https)

Aktiviert TLS + HTTP/2.

Weitere Einzelheiten finden Sie unter [`server.https`](./server-options#server-https).

## preview.open

- **Typ:** `boolean | string`
- **Standard:** [`server.open`](./server-options#server-open)

Öffnet die App beim Serverstart automatisch im Browser. Ist der Wert eine Zeichenkette, wird sie als Pfadname der URL verwendet. Wenn Sie den Server in einem bestimmten Browser Ihrer Wahl öffnen möchten, können Sie die Umgebungsvariable `process.env.BROWSER` setzen (z. B. `firefox`). Sie können auch `process.env.BROWSER_ARGS` setzen, um zusätzliche Argumente zu übergeben (z. B. `--incognito`).

`BROWSER` und `BROWSER_ARGS` sind ebenfalls spezielle Umgebungsvariablen, die Sie zur Konfiguration in der `.env`-Datei setzen können. Weitere Einzelheiten finden Sie beim [Paket `open`](https://github.com/sindresorhus/open#app).

## preview.proxy

- **Typ:** `Record<string, string | ProxyOptions>`
- **Standard:** [`server.proxy`](./server-options#server-proxy)

Konfiguriert eigene Proxy-Regeln für den Preview-Server. Erwartet ein Objekt aus `{ key: options }`-Paaren. Beginnt der Schlüssel mit `^`, wird er als `RegExp` interpretiert. Über die Option `configure` kann auf die Proxy-Instanz zugegriffen werden.

Verwendet [`http-proxy-3`](https://github.com/sagemathinc/http-proxy-3). Die vollständigen Optionen finden Sie [hier](https://github.com/sagemathinc/http-proxy-3#options).

## preview.cors

- **Typ:** `boolean | CorsOptions`
- **Standard:** [`server.cors`](./server-options#server-cors)

Konfiguriert CORS für den Preview-Server.

Weitere Einzelheiten finden Sie unter [`server.cors`](./server-options#server-cors).

## preview.headers

- **Typ:** `OutgoingHttpHeaders`

Legt die Response-Header des Servers fest.
