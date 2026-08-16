# Requests mocken

Da Vitest in Node läuft, ist das Mocken von Netzwerk-Requests knifflig; Web-APIs stehen nicht zur Verfügung, wir brauchen also etwas, das das Netzwerkverhalten für uns nachbildet. Wir empfehlen dafür [Mock Service Worker](https://mswjs.io/). Damit können Sie `http`-, `WebSocket`- und `GraphQL`-Netzwerk-Requests mocken, und zwar Framework-unabhängig.

Mock Service Worker (MSW) funktioniert, indem er die Requests abfängt, die Ihre Tests absetzen – Sie können ihn also einsetzen, ohne Ihren Anwendungscode zu ändern. Im Browser nutzt er dafür die [Service Worker API](https://developer.mozilla.org/en-US/docs/Web/API/Service_Worker_API). In Node.js und damit auch für Vitest verwendet er die Bibliothek [`@mswjs/interceptors`](https://github.com/mswjs/interceptors). Um mehr über MSW zu erfahren, lesen Sie deren [Einführung](https://mswjs.io/docs/)

## Konfiguration

Sie können ihn wie folgt in Ihrer [Setup-Datei](/config/setupfiles) verwenden

::: code-group

```js [HTTP Setup]
import { afterAll, afterEach, beforeAll } from 'vitest'
import { setupServer } from 'msw/node'
import { http, HttpResponse } from 'msw'

const posts = [
  {
    userId: 1,
    id: 1,
    title: 'first post title',
    body: 'first post body',
  },
  // ...
]

export const restHandlers = [
  http.get('https://rest-endpoint.example/path/to/posts', () => {
    return HttpResponse.json(posts)
  }),
]

const server = setupServer(...restHandlers)

// Start server before all tests
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }))

// Close server after all tests
afterAll(() => server.close())

// Reset handlers after each test for test isolation
afterEach(() => server.resetHandlers())
```

```js [GraphQL Setup]
import { afterAll, afterEach, beforeAll } from 'vitest'
import { setupServer } from 'msw/node'
import { graphql, HttpResponse } from 'msw'

const posts = [
  {
    userId: 1,
    id: 1,
    title: 'first post title',
    body: 'first post body',
  },
  // ...
]

const graphqlHandlers = [
  graphql.query('ListPosts', () => {
    return HttpResponse.json({
      data: { posts },
    })
  }),
]

const server = setupServer(...graphqlHandlers)

// Start server before all tests
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }))

// Close server after all tests
afterAll(() => server.close())

// Reset handlers after each test for test isolation
afterEach(() => server.resetHandlers())
```

```js [WebSocket Setup]
import { afterAll, afterEach, beforeAll } from 'vitest'
import { setupServer } from 'msw/node'
import { ws } from 'msw'

const chat = ws.link('wss://chat.example.com')

const wsHandlers = [
  chat.addEventListener('connection', ({ client }) => {
    client.addEventListener('message', (event) => {
      console.log('Received message from client:', event.data)
      // Echo the received message back to the client
      client.send(`Server received: ${event.data}`)
    })
  }),
]

const server = setupServer(...wsHandlers)

// Start server before all tests
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }))

// Close server after all tests
afterAll(() => server.close())

// Reset handlers after each test for test isolation
afterEach(() => server.resetHandlers())
```
:::

> Die Konfiguration des Servers mit `onUnhandledRequest: 'error'` stellt sicher, dass ein Fehler geworfen wird, sobald ein Request auftritt, für den es keinen passenden Request-Handler gibt.

## Mehr
MSW kann noch weit mehr. Sie können auf Cookies und Query-Parameter zugreifen, Mock-Fehlerantworten definieren und vieles mehr! Um zu sehen, was Sie mit MSW alles machen können, lesen Sie [deren Dokumentation](https://mswjs.io/docs).
