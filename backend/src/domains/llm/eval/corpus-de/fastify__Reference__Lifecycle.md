<h1 align="center">Fastify</h1>

## Lebenszyklus
<a id="lifecycle"></a>

Dieses Diagramm zeigt den internen Lebenszyklus von Fastify.

Der rechte Zweig jedes Abschnitts zeigt die nächste Phase des Lebenszyklus. Der linke Zweig zeigt den entsprechenden Fehlercode, der erzeugt wird, wenn die übergeordnete Phase einen Fehler wirft. Alle Fehler werden von Fastify automatisch behandelt.

```
Incoming Request
  │
  └─▶ Routing
        │
        └─▶ Instance Logger
             │
   4**/5** ◀─┴─▶ onRequest Hook
                  │
        4**/5** ◀─┴─▶ preParsing Hook
                        │
              4**/5** ◀─┴─▶ Parsing
                             │
                   4**/5** ◀─┴─▶ preValidation Hook
                                  │
                            400 ◀─┴─▶ Validation
                                        │
                              4**/5** ◀─┴─▶ preHandler Hook
                                              │
                                    4**/5** ◀─┴─▶ User Handler
                                                    │
                                                    └─▶ Reply
                                                          │
                                                4**/5** ◀─┴─▶ preSerialization Hook
                                                                │
                                                                └─▶ onSend Hook
                                                                      │
                                                            4**/5** ◀─┴─▶ Outgoing Response
                                                                            │
                                                                            └─▶ onResponse Hook
```

Wenn [`handlerTimeout`](./Server.md#factory-handler-timeout) konfiguriert ist, startet nach dem Routing ein Timer. Wird die Response nicht innerhalb der erlaubten Zeit gesendet, wird `request.signal` abgebrochen und ein Fehler `503 Service Unavailable` gesendet. Der Timer wird abgebrochen, wenn die Response abgeschlossen ist oder wenn `reply.hijack()` aufgerufen wird.

Vor oder während des `User Handler` kann `reply.hijack()` aufgerufen werden, um:
- Fastify daran zu hindern, nachfolgende Hooks und den User-Handler auszuführen
- Fastify daran zu hindern, die Response automatisch zu senden

Wird `reply.raw` verwendet, um eine Response zu senden, werden `onResponse`-Hooks trotzdem ausgeführt.

## Reply-Lebenszyklus
<a id="reply-lifecycle"></a>

Wenn der Nutzer den Request behandelt, kann das Ergebnis sein:

- In einem async-Handler: er gibt ein Payload zurück oder wirft einen `Error`
- In einem synchronen Handler: er sendet ein Payload oder eine `Error`-Instanz

Wenn die Reply gehijackt wurde, werden alle nachfolgenden Schritte übersprungen. Andernfalls fließen die Daten wie folgt:

```
                        ★ schema validation Error
                                    │
                                    └─▶ schemaErrorFormatter
                                               │
                          reply sent ◀── JSON ─┴─ Error instance
                                                      │
                                                      │         ★ throw an Error
                     ★ send or return                 │                 │
                            │                         │                 │
                            │                         ▼                 │
       reply sent ◀── JSON ─┴─ Error instance ──▶ onError Hook ◀───────┘
                                                      │
                                 reply sent ◀── JSON ─┴─ Error instance ──▶ setErrorHandler
                                                                                │
                                                                                └─▶ reply sent
```

`reply sent` bedeutet, dass das JSON-Payload durch eines der Folgenden serialisiert wird:
- Den [Reply-Serializer](./Server.md#setreplyserializer), sofern gesetzt
- Den [Serializer-Compiler](./Server.md#setserializercompiler), sofern für den HTTP-Statuscode ein JSON-Schema gesetzt ist
- Die Standardfunktion `JSON.stringify`

## Shutdown-Lebenszyklus
<a id="shutdown-lifecycle"></a>

Wenn [`fastify.close()`](./Server.md#close) aufgerufen wird, durchläuft der Server eine Graceful-Shutdown-Sequenz mit [`preClose`](./Hooks.md#pre-close)-Hooks, dem Leeren der Verbindungen und [`onClose`](./Hooks.md#on-close)-Hooks. Die vollständige schrittweise Beschreibung des Lebenszyklus findest du in der Dokumentation der Methode [`close`](./Server.md#close).
