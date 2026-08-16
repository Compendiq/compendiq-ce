<h1 align="center">Fastify</h1>

## Fehler
<a id="errors"></a>

**Inhaltsverzeichnis**
- [Fehler](#errors)
  - [Fehlerbehandlung in Node.js](#error-handling-in-nodejs)
    - [Nicht abgefangene Fehler](#uncaught-errors)
    - [Fehler in Promises abfangen](#catching-errors-in-promises)
  - [Fehler in Fastify](#errors-in-fastify)
    - [Fehler in Eingabedaten](#errors-in-input-data)
    - [Nicht abgefangene Fehler in Fastify abfangen](#catching-uncaught-errors-in-fastify)
    - [Was der Standard-Fehlerhandler sendet](#what-the-default-error-handler-sends)
  - [Fehler in Fastify-Lifecycle-Hooks und ein eigener Fehlerhandler](#errors-in-fastify-lifecycle-hooks-and-a-custom-error-handler)
  - [Fastify-Fehlercodes](#fastify-error-codes)
    - [FST_ERR_NOT_FOUND](#fst_err_not_found)
    - [FST_ERR_OPTIONS_NOT_OBJ](#fst_err_options_not_obj)
    - [FST_ERR_QSP_NOT_FN](#fst_err_qsp_not_fn)
    - [FST_ERR_SCHEMA_CONTROLLER_BUCKET_OPT_NOT_FN](#fst_err_schema_controller_bucket_opt_not_fn)
    - [FST_ERR_SCHEMA_ERROR_FORMATTER_NOT_FN](#fst_err_schema_error_formatter_not_fn)
    - [FST_ERR_AJV_CUSTOM_OPTIONS_OPT_NOT_OBJ](#fst_err_ajv_custom_options_opt_not_obj)
    - [FST_ERR_AJV_CUSTOM_OPTIONS_OPT_NOT_ARR](#fst_err_ajv_custom_options_opt_not_arr)
    - [FST_ERR_CTP_ALREADY_PRESENT](#fst_err_ctp_already_present)
    - [FST_ERR_CTP_INVALID_TYPE](#fst_err_ctp_invalid_type)
    - [FST_ERR_CTP_EMPTY_TYPE](#fst_err_ctp_empty_type)
    - [FST_ERR_CTP_INVALID_HANDLER](#fst_err_ctp_invalid_handler)
    - [FST_ERR_CTP_INVALID_PARSE_TYPE](#fst_err_ctp_invalid_parse_type)
    - [FST_ERR_CTP_BODY_TOO_LARGE](#fst_err_ctp_body_too_large)
    - [FST_ERR_CTP_INVALID_MEDIA_TYPE](#fst_err_ctp_invalid_media_type)
    - [FST_ERR_CTP_INVALID_CONTENT_LENGTH](#fst_err_ctp_invalid_content_length)
    - [FST_ERR_CTP_EMPTY_JSON_BODY](#fst_err_ctp_empty_json_body)
    - [FST_ERR_CTP_INVALID_JSON_BODY](#fst_err_ctp_invalid_json_body)
    - [FST_ERR_CTP_INSTANCE_ALREADY_STARTED](#fst_err_ctp_instance_already_started)
    - [FST_ERR_INSTANCE_ALREADY_LISTENING](#fst_err_instance_already_listening)
    - [FST_ERR_DEC_ALREADY_PRESENT](#fst_err_dec_already_present)
    - [FST_ERR_DEC_DEPENDENCY_INVALID_TYPE](#fst_err_dec_dependency_invalid_type)
    - [FST_ERR_DEC_MISSING_DEPENDENCY](#fst_err_dec_missing_dependency)
    - [FST_ERR_DEC_AFTER_START](#fst_err_dec_after_start)
    - [FST_ERR_DEC_REFERENCE_TYPE](#fst_err_dec_reference_type)
    - [FST_ERR_DEC_UNDECLARED](#fst_err_dec_undeclared)
    - [FST_ERR_HOOK_INVALID_TYPE](#fst_err_hook_invalid_type)
    - [FST_ERR_HOOK_INVALID_HANDLER](#fst_err_hook_invalid_handler)
    - [FST_ERR_HOOK_INVALID_ASYNC_HANDLER](#fst_err_hook_invalid_async_handler)
    - [FST_ERR_HOOK_NOT_SUPPORTED](#fst_err_hook_not_supported)
    - [FST_ERR_MISSING_MIDDLEWARE](#fst_err_missing_middleware)
    - [FST_ERR_HOOK_TIMEOUT](#fst_err_hook_timeout)
    - [FST_ERR_LOG_INVALID_DESTINATION](#fst_err_log_invalid_destination)
    - [FST_ERR_LOG_INVALID_LOGGER](#fst_err_log_invalid_logger)
    - [FST_ERR_LOG_INVALID_LOGGER_INSTANCE](#fst_err_log_invalid_logger_instance)
    - [FST_ERR_LOG_INVALID_LOGGER_CONFIG](#fst_err_log_invalid_logger_config)
    - [FST_ERR_LOG_LOGGER_AND_LOGGER_INSTANCE_PROVIDED](#fst_err_log_logger_and_logger_instance_provided)
    - [FST_ERR_LOG_INVALID_LOG_CONTROLLER](#fst_err_log_invalid_log_controller)
    - [FST_ERR_REP_INVALID_PAYLOAD_TYPE](#fst_err_rep_invalid_payload_type)
    - [FST_ERR_REP_RESPONSE_BODY_CONSUMED](#fst_err_rep_response_body_consumed)
    - [FST_ERR_REP_READABLE_STREAM_LOCKED](#fst_err_rep_readable_stream_locked)
    - [FST_ERR_REP_ALREADY_SENT](#fst_err_rep_already_sent)
    - [FST_ERR_REP_SENT_VALUE](#fst_err_rep_sent_value)
    - [FST_ERR_SEND_INSIDE_ONERR](#fst_err_send_inside_onerr)
    - [FST_ERR_SEND_UNDEFINED_ERR](#fst_err_send_undefined_err)
    - [FST_ERR_BAD_STATUS_CODE](#fst_err_bad_status_code)
    - [FST_ERR_BAD_TRAILER_NAME](#fst_err_bad_trailer_name)
    - [FST_ERR_BAD_TRAILER_VALUE](#fst_err_bad_trailer_value)
    - [FST_ERR_FAILED_ERROR_SERIALIZATION](#fst_err_failed_error_serialization)
    - [FST_ERR_MISSING_SERIALIZATION_FN](#fst_err_missing_serialization_fn)
    - [FST_ERR_MISSING_CONTENTTYPE_SERIALIZATION_FN](#fst_err_missing_contenttype_serialization_fn)
    - [FST_ERR_REQ_INVALID_VALIDATION_INVOCATION](#fst_err_req_invalid_validation_invocation)
    - [FST_ERR_SCH_MISSING_ID](#fst_err_sch_missing_id)
    - [FST_ERR_SCH_ALREADY_PRESENT](#fst_err_sch_already_present)
    - [FST_ERR_SCH_CONTENT_MISSING_SCHEMA](#fst_err_sch_content_missing_schema)
    - [FST_ERR_SCH_DUPLICATE](#fst_err_sch_duplicate)
    - [FST_ERR_SCH_VALIDATION_BUILD](#fst_err_sch_validation_build)
    - [FST_ERR_SCH_SERIALIZATION_BUILD](#fst_err_sch_serialization_build)
    - [FST_ERR_SCH_RESPONSE_SCHEMA_NOT_NESTED_2XX](#fst_err_sch_response_schema_not_nested_2xx)
    - [FST_ERR_INIT_OPTS_INVALID](#fst_err_init_opts_invalid)
    - [FST_ERR_FORCE_CLOSE_CONNECTIONS_IDLE_NOT_AVAILABLE](#fst_err_force_close_connections_idle_not_available)
    - [FST_ERR_DUPLICATED_ROUTE](#fst_err_duplicated_route)
    - [FST_ERR_BAD_URL](#fst_err_bad_url)
    - [FST_ERR_MAX_PARAM_LENGTH](#fst_err_max_param_length)
    - [FST_ERR_ASYNC_CONSTRAINT](#fst_err_async_constraint)
    - [FST_ERR_INVALID_URL](#fst_err_invalid_url)
    - [FST_ERR_ROUTE_OPTIONS_NOT_OBJ](#fst_err_route_options_not_obj)
    - [FST_ERR_ROUTE_DUPLICATED_HANDLER](#fst_err_route_duplicated_handler)
    - [FST_ERR_ROUTE_HANDLER_NOT_FN](#fst_err_route_handler_not_fn)
    - [FST_ERR_ROUTE_MISSING_HANDLER](#fst_err_route_missing_handler)
    - [FST_ERR_ROUTE_METHOD_INVALID](#fst_err_route_method_invalid)
    - [FST_ERR_ROUTE_METHOD_NOT_SUPPORTED](#fst_err_route_method_not_supported)
    - [FST_ERR_ROUTE_LOG_LEVEL_INVALID](#fst_err_route_log_level_invalid)
    - [FST_ERR_ROUTE_BODY_VALIDATION_SCHEMA_NOT_SUPPORTED](#fst_err_route_body_validation_schema_not_supported)
    - [FST_ERR_ROUTE_BODY_LIMIT_OPTION_NOT_INT](#fst_err_route_body_limit_option_not_int)
    - [FST_ERR_HANDLER_TIMEOUT](#fst_err_handler_timeout)

    - [FST_ERR_ROUTE_HANDLER_TIMEOUT_OPTION_NOT_INT](#fst_err_route_handler_timeout_option_not_int)
    - [FST_ERR_ROUTE_REWRITE_NOT_STR](#fst_err_route_rewrite_not_str)
    - [FST_ERR_ROUTE_MISSING_CONTENT_TYPE](#fst_err_route_missing_content_type)
    - [FST_ERR_ROUTE_MISSING_CONTENT](#fst_err_route_missing_content)
    - [FST_ERR_REOPENED_CLOSE_SERVER](#fst_err_reopened_close_server)
    - [FST_ERR_REOPENED_SERVER](#fst_err_reopened_server)
    - [FST_ERR_PLUGIN_VERSION_MISMATCH](#fst_err_plugin_version_mismatch)
    - [FST_ERR_PLUGIN_CALLBACK_NOT_FN](#fst_err_plugin_callback_not_fn)
    - [FST_ERR_PLUGIN_NOT_VALID](#fst_err_plugin_not_valid)
    - [FST_ERR_ROOT_PLG_BOOTED](#fst_err_root_plg_booted)
    - [FST_ERR_PARENT_PLUGIN_BOOTED](#fst_err_parent_plugin_booted)
    - [FST_ERR_PLUGIN_TIMEOUT](#fst_err_plugin_timeout)
    - [FST_ERR_PLUGIN_NOT_PRESENT_IN_INSTANCE](#fst_err_plugin_not_present_in_instance)
    - [FST_ERR_PLUGIN_INVALID_ASYNC_HANDLER](#fst_err_plugin_invalid_async_handler)
    - [FST_ERR_PLUGIN_DEPENDENCY_NOT_REGISTERED](#fst_err_plugin_dependency_not_registered)
    - [FST_ERR_VALIDATION](#fst_err_validation)
    - [FST_ERR_LISTEN_OPTIONS_INVALID](#fst_err_listen_options_invalid)
    - [FST_ERR_ERROR_HANDLER_NOT_FN](#fst_err_error_handler_not_fn)
    - [FST_ERR_ERROR_HANDLER_ALREADY_SET](#fst_err_error_handler_already_set)

### Fehlerbehandlung in Node.js
<a id="error-handling"></a>

#### Nicht abgefangene Fehler
In Node.js können nicht abgefangene Fehler Speicherlecks, Lecks bei
Dateideskriptoren und andere gravierende Produktionsprobleme verursachen.
[Domains](https://nodejs.org/en/blog/community/domain-postmortem) waren ein
gescheiterter Versuch, das zu beheben.

Da es nicht möglich ist, alle nicht abgefangenen Fehler sinnvoll zu verarbeiten,
besteht der beste Umgang mit ihnen darin,
[abzustürzen](https://nodejs.org/api/process.html#warning-using-uncaughtexception-correctly).

#### Fehler in Promises abfangen
Wenn Sie Promises verwenden, hängen Sie einen `.catch()`-Handler synchron an.

### Fehler in Fastify
Fastify verfolgt einen Alles-oder-nichts-Ansatz und will schlank und optimal
sein. Die Verantwortung dafür, dass Fehler ordentlich behandelt werden, liegt
beim Entwickler.

#### Fehler in Eingabedaten
Die meisten Fehler entstehen durch unerwartete Eingabedaten; daher empfiehlt es
sich, [Eingabedaten gegen ein JSON Schema zu validieren](./Validation-and-Serialization.md).

#### Nicht abgefangene Fehler in Fastify abfangen
Fastify versucht, so viele nicht abgefangene Fehler wie möglich abzufangen, ohne
die Performance zu beeinträchtigen. Dazu gehören:

1. synchrone Routen, z. B. `app.get('/', () => { throw new Error('kaboom') })`
2. `async`-Routen, z. B. `app.get('/', async () => { throw new Error('kaboom')
   })`

In beiden Fällen wird der Fehler sicher abgefangen und an Fastifys
Standard-Fehlerhandler weitergeleitet, was zu einer Antwort
`500 Internal Server Error` führt.

#### Was der Standard-Fehlerhandler sendet
Der Standard-Fehlerhandler serialisiert den Fehler in einen JSON-Body mit den
Eigenschaften `statusCode`, `error` und `message` sowie `code`, sofern der Fehler
einen solchen mitbringt:

```js
app.get('/', async () => { throw new Error('kaboom') })
```

```json
{
  "statusCode": 500,
  "error": "Internal Server Error",
  "message": "kaboom"
}
```

Die Eigenschaft `error` ist der generische HTTP-Statustext, **`message` ist
jedoch wortwörtlich `error.message`**. Das gilt für jeden Statuscode,
einschließlich `500`. Fastifys eingebauter Fehlerserialisierer gibt nur diese
vier Eigenschaften aus, sodass der Stacktrace nicht Teil des Standard-Payloads
ist — ein Response-Schema auf Routenebene ersetzt diesen Serialisierer jedoch,
und eines, das eine Eigenschaft `stack` deklariert, serialisiert sie mit.

> Sicherheit:
> Da `message` und `code` unverändert weitergereicht werden, gelangen Fehler,
> die von tiefer liegenden Bibliotheken in Ihrer Anwendung geworfen werden, zum
> Client. Ein Fehler eines Datenbanktreibers kann so etwa Schemadetails und
> Query-Text preisgeben:
>
> ```json
> {
>   "statusCode": 500,
>   "code": "ER_BAD_FIELD_ERROR",
>   "error": "Internal Server Error",
>   "message": "Unknown column 'username' in 'field list'"
> }
> ```
>
> Fastify unterscheidet hier nicht zwischen Entwicklung und Produktion. Wenn
> unerwartete Fehler den Client nicht erreichen dürfen, behandeln Sie das
> ausdrücklich selbst.

Registrieren Sie einen [`setErrorHandler`](./Server.md#seterrorhandler), um die
Meldung für Fehler zu ersetzen, die Sie nicht absichtlich ausgelöst haben,
während die absichtlich ausgelösten durchgereicht werden:

```js
app.setErrorHandler(function (error, request, reply) {
  // Errors with a statusCode below 500 were raised deliberately by this
  // application, as were validation errors. A status code below 500 is not on
  // its own a guarantee that the message is safe to expose — narrow this
  // condition if any of yours are not.
  if (error.validation || (error.statusCode && error.statusCode < 500)) {
    return reply.send(error)
  }

  // Anything else is unexpected: log it, but do not describe it to the client.
  this.log.error({ err: error }, 'unhandled error')
  reply.status(500).send({
    statusCode: 500,
    error: 'Internal Server Error',
    message: 'Internal Server Error'
  })
})
```

Der obige Handler wird an der Root-Instanz registriert und gilt daher für jede
Route. Fehlerhandler sind gekapselt; wie sie über Plugin-Kontexte hinweg
aufgelöst werden, lesen Sie
[im nächsten Abschnitt](#errors-in-fastify-lifecycle-hooks-and-a-custom-error-handler).

Beachten Sie, dass ein Response-Schema auf Routenebene weiterhin auf alles
angewendet wird, was der Fehlerhandler sendet, und den Payload entsprechend
umformt — einschließlich Eigenschaften, die der eingebaute Fehlerserialisierer
weggelassen hätte, etwa `stack`. Siehe
[Serialization](./Validation-and-Serialization.md#serialization).

### Fehler in Fastify-Lifecycle-Hooks und ein eigener Fehlerhandler

Aus der [Hooks-Dokumentation](./Hooks.md#manage-errors-from-a-hook):
> Wenn während der Ausführung Ihres Hooks ein Fehler auftritt, übergeben Sie ihn
> einfach an `done()`, und Fastify schließt den Request automatisch und sendet
> den passenden Fehlercode an den Nutzer.

Ist über [`setErrorHandler`](./Server.md#seterrorhandler) ein eigener
Fehlerhandler definiert, erhält dieser den Fehler, der an den `done()`-Callback
oder über andere unterstützte Mechanismen der automatischen Fehlerbehandlung
übergeben wurde. Wird `setErrorHandler` mehrfach verwendet, wird der Fehler an
den vorrangigsten Handler innerhalb des
[Kapselungskontexts](./Encapsulation.md) des Fehlers geleitet. Fehlerhandler
sind vollständig gekapselt; ein `setErrorHandler`-Aufruf innerhalb eines Plugins
beschränkt den Fehlerhandler daher auf den Kontext dieses Plugins.

Der Root-Fehlerhandler ist Fastifys generischer Fehlerhandler. Dieser
Fehlerhandler verwendet die Header und den Statuscode aus dem `Error`-Objekt,
sofern vorhanden. Header und Statuscode werden nicht automatisch gesetzt, wenn
ein eigener Fehlerhandler bereitgestellt wird.

Bei Verwendung eines eigenen Fehlerhandlers ist Folgendes zu beachten:

- `reply.send(data)` verhält sich wie in [gewöhnlichen Routenhandlern](./Reply.md#senddata)
  - Objekte werden serialisiert, wodurch der Lifecycle-Hook `preSerialization`
    ausgelöst wird, sofern definiert
  - Strings, Buffer und Streams werden mit den passenden Headern an den Client
    gesendet (ohne Serialisierung)

- Wird in einem eigenen Fehlerhandler ein neuer Fehler geworfen, wird der
  übergeordnete `errorHandler` aufgerufen.
  - Der Hook `onError` wird einmal für den ersten geworfenen Fehler ausgelöst
  - Ein Fehler wird aus einem Lifecycle-Hook nicht zweimal ausgelöst. Fastify
    überwacht die Fehleraufrufe intern, um Endlosschleifen bei Fehlern zu
    vermeiden, die in den Reply-Phasen des Lifecycles geworfen werden (also nach
    dem Routenhandler)

Wenn Sie Fastifys eigene Fehlerbehandlung über
[`setErrorHandler`](./Server.md#seterrorhandler) nutzen, achten Sie darauf, wie
Fehler zwischen eigenen und Standard-Fehlerhandlern propagiert werden.

Wirft der Fehlerhandler eines Plugins einen Fehler erneut, der keine Instanz von
[Error](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Error)
ist, propagiert dieser nicht zum Fehlerhandler des übergeordneten Kontexts.
Stattdessen wird er vom Standard-Fehlerhandler abgefangen. Das sehen Sie an der
Route `/bad` im folgenden Beispiel.

Um eine konsistente Fehlerbehandlung sicherzustellen, werfen Sie Instanzen von
`Error`. Ersetzen Sie beispielsweise in der Route `/bad` `throw 'foo'` durch
`throw new Error('foo')`, damit Fehler wie beabsichtigt durch die eigene
Fehlerbehandlungskette propagieren. Diese Praxis hilft, mögliche Fallstricke bei
der eigenen Fehlerbehandlung in Fastify zu vermeiden.

Zum Beispiel:
```js
const Fastify = require('fastify')

// Instantiate the framework
const fastify = Fastify({
  logger: true
})

// Register parent error handler
fastify.setErrorHandler((error, request, reply) => {
  reply.status(500).send({ ok: false })
})

fastify.register((app, options, next) => {
  // Register child error handler
  app.setErrorHandler((error, request, reply) => {
    throw error
  })

  app.get('/bad', async () => {
    // Throws a non-Error type, 'foo'
    throw 'foo'
  })

  app.get('/good', async () => {
    // Throws an Error instance, 'bar'
    throw new Error('bar')
  })

  next()
})

// Run the server
fastify.listen({ port: 3000 }, function (err, address) {
  if (err) {
    fastify.log.error(err)
    process.exit(1)
  }
  // Server is listening at ${address}
})
```

### Fastify-Fehlercodes
<a id="fastify-error-codes"></a>

Für Zuordnungen können Sie auf `errorCodes` zugreifen:
```js
// ESM
import { errorCodes } from 'fastify'

// CommonJS
const errorCodes = require('fastify').errorCodes
```

Zum Beispiel:
```js
const Fastify = require('fastify')

// Instantiate the framework
const fastify = Fastify({
  logger: true
})

// Declare a route
fastify.get('/', function (request, reply) {
  reply.code('bad status code').send({ hello: 'world' })
})

fastify.setErrorHandler(function (error, request, reply) {
  if (error instanceof Fastify.errorCodes.FST_ERR_BAD_STATUS_CODE) {
    // Log error
    this.log.error(error)
    // Send error response
    reply.status(500).send({ ok: false })
  } else {
    // Fastify will use parent error handler to handle this
    reply.send(error)
  }
})

// Run the server!
fastify.listen({ port: 3000 }, function (err, address) {
  if (err) {
    fastify.log.error(err)
    process.exit(1)
  }
  // Server is now listening on ${address}
})
```

Unten finden Sie eine Tabelle mit allen von Fastify verwendeten Fehlercodes.

| Code | Beschreibung | Lösung | Diskussion |
|------|-------------|--------------|------------|
| <a id="fst_err_not_found">FST_ERR_NOT_FOUND</a> | 404 Not Found | - | [#1168](https://github.com/fastify/fastify/pull/1168) |
| <a id="fst_err_options_not_obj">FST_ERR_OPTIONS_NOT_OBJ</a> | Fastify-Optionen falsch angegeben. | Die Fastify-Optionen sollten ein Objekt sein. | [#4554](https://github.com/fastify/fastify/pull/4554) |
| <a id="fst_err_qsp_not_fn">FST_ERR_QSP_NOT_FN</a> | QueryStringParser falsch angegeben. | Die Option QueryStringParser sollte eine Funktion sein. | [#4554](https://github.com/fastify/fastify/pull/4554) |
| <a id="fst_err_schema_controller_bucket_opt_not_fn">FST_ERR_SCHEMA_CONTROLLER_BUCKET_OPT_NOT_FN</a> | SchemaController.bucket falsch angegeben. | Die Option SchemaController.bucket sollte eine Funktion sein. | [#4554](https://github.com/fastify/fastify/pull/4554) |
| <a id="fst_err_schema_error_formatter_not_fn">FST_ERR_SCHEMA_ERROR_FORMATTER_NOT_FN</a> | Option SchemaErrorFormatter falsch angegeben. | Die Option SchemaErrorFormatter sollte eine nicht-asynchrone Funktion sein. | [#4554](https://github.com/fastify/fastify/pull/4554) |
| <a id="fst_err_ajv_custom_options_opt_not_obj">FST_ERR_AJV_CUSTOM_OPTIONS_OPT_NOT_OBJ</a> | ajv.customOptions falsch angegeben. | Die Option ajv.customOptions sollte ein Objekt sein. | [#4554](https://github.com/fastify/fastify/pull/4554) |
| <a id="fst_err_ajv_custom_options_opt_not_arr">FST_ERR_AJV_CUSTOM_OPTIONS_OPT_NOT_ARR</a> | Option ajv.plugins falsch angegeben. | Die Option ajv.plugins sollte ein Array sein. | [#4554](https://github.com/fastify/fastify/pull/4554) |
| <a id="fst_err_ctp_already_present">FST_ERR_CTP_ALREADY_PRESENT</a> | Der Parser für diesen Content-Type wurde bereits registriert. | Verwenden Sie einen anderen Content-Type oder löschen Sie den bereits registrierten Parser. | [#1168](https://github.com/fastify/fastify/pull/1168) |
| <a id="fst_err_ctp_invalid_type">FST_ERR_CTP_INVALID_TYPE</a> | `Content-Type` falsch angegeben | Der `Content-Type` sollte ein String sein. | [#1168](https://github.com/fastify/fastify/pull/1168) |
| <a id="fst_err_ctp_empty_type">FST_ERR_CTP_EMPTY_TYPE</a> | `Content-Type` ist ein leerer String. | `Content-Type` darf kein leerer String sein. | [#1168](https://github.com/fastify/fastify/pull/1168) |
| <a id="fst_err_ctp_invalid_handler">FST_ERR_CTP_INVALID_HANDLER</a> | Ungültiger Handler für den Content-Type. | Verwenden Sie einen anderen Handler. | [#1168](https://github.com/fastify/fastify/pull/1168) |
| <a id="fst_err_ctp_invalid_parse_type">FST_ERR_CTP_INVALID_PARSE_TYPE</a> | Der angegebene Parse-Typ wird nicht unterstützt. | Zulässige Werte sind <code>string</code> oder <code>buffer</code>. | [#1168](https://github.com/fastify/fastify/pull/1168) |
| <a id="fst_err_ctp_body_too_large">FST_ERR_CTP_BODY_TOO_LARGE</a> | Der Request-Body ist größer als das angegebene Limit. | Erhöhen Sie das Limit in der Einstellung der Fastify-Serverinstanz: [bodyLimit](./Server.md#bodylimit) | [#1168](https://github.com/fastify/fastify/pull/1168) |
| <a id="fst_err_ctp_invalid_media_type">FST_ERR_CTP_INVALID_MEDIA_TYPE</a> | Der empfangene Medientyp wird nicht unterstützt (es gibt also keinen passenden `Content-Type`-Parser dafür). | Verwenden Sie einen anderen Content-Type. | [#1168](https://github.com/fastify/fastify/pull/1168) |
| <a id="fst_err_ctp_invalid_content_length">FST_ERR_CTP_INVALID_CONTENT_LENGTH</a> | Die Größe des Request-Bodys stimmte nicht mit <code>Content-Length</code> überein. | Prüfen Sie die Größe des Request-Bodys und den Header <code>Content-Length</code>. | [#1168](https://github.com/fastify/fastify/pull/1168) |
| <a id="fst_err_ctp_empty_json_body">FST_ERR_CTP_EMPTY_JSON_BODY</a> | Der Body ist kein gültiges JSON, obwohl der Content-Type auf <code>application/json</code> gesetzt ist. | Prüfen Sie, ob der Request-Body gültiges JSON ist. | [#5925](https://github.com/fastify/fastify/pull/5925) |
| <a id="fst_err_ctp_invalid_json_body">FST_ERR_CTP_INVALID_JSON_BODY</a> | Der Body darf nicht leer sein, wenn der Content-Type auf <code>application/json</code> gesetzt ist. | Prüfen Sie den Request-Body. | [#1253](https://github.com/fastify/fastify/pull/1253) |
| <a id="fst_err_ctp_instance_already_started">FST_ERR_CTP_INSTANCE_ALREADY_STARTED</a> | Fastify ist bereits gestartet. | - | [#4554](https://github.com/fastify/fastify/pull/4554) |
| <a id="fst_err_instance_already_listening">FST_ERR_INSTANCE_ALREADY_LISTENING</a> | Die Fastify-Instanz lauscht bereits. | - | [#4554](https://github.com/fastify/fastify/pull/4554) |
| <a id="fst_err_dec_already_present">FST_ERR_DEC_ALREADY_PRESENT</a> | Ein Decorator mit demselben Namen ist bereits registriert. | Verwenden Sie einen anderen Decorator-Namen. | [#1168](https://github.com/fastify/fastify/pull/1168) |
| <a id="fst_err_dec_dependency_invalid_type">FST_ERR_DEC_DEPENDENCY_INVALID_TYPE</a> | Die Abhängigkeiten eines Decorators müssen vom Typ `Array` sein. | Verwenden Sie ein Array für die Abhängigkeiten. | [#3090](https://github.com/fastify/fastify/pull/3090) |
| <a id="fst_err_dec_missing_dependency">FST_ERR_DEC_MISSING_DEPENDENCY</a> | Der Decorator kann wegen einer fehlenden Abhängigkeit nicht registriert werden. | Registrieren Sie die fehlende Abhängigkeit. | [#1168](https://github.com/fastify/fastify/pull/1168) |
| <a id="fst_err_dec_after_start">FST_ERR_DEC_AFTER_START</a> | Der Decorator kann nach dem Start nicht mehr hinzugefügt werden. | Fügen Sie den Decorator hinzu, bevor Sie den Server starten. | [#2128](https://github.com/fastify/fastify/pull/2128) |
| <a id="fst_err_dec_reference_type">FST_ERR_DEC_REFERENCE_TYPE</a> | Der Decorator darf kein Referenztyp sein. | Definieren Sie den Decorator mit einer Getter-/Setter-Schnittstelle oder als leeren Decorator mit einem Hook. | [#5462](https://github.com/fastify/fastify/pull/5462) |
| <a id="fst_err_dec_undeclared">FST_ERR_DEC_UNDECLARED</a> | Es wurde versucht, auf einen Decorator zuzugreifen, der nicht deklariert wurde. | Deklarieren Sie den Decorator, bevor Sie ihn verwenden. | [#5768](https://github.com/fastify/fastify/pull/5768)
| <a id="fst_err_hook_invalid_type">FST_ERR_HOOK_INVALID_TYPE</a> | Der Hook-Name muss ein String sein. | Verwenden Sie einen String für den Hook-Namen. | [#1168](https://github.com/fastify/fastify/pull/1168) |
| <a id="fst_err_hook_invalid_handler">FST_ERR_HOOK_INVALID_HANDLER</a> | Der Hook-Callback muss eine Funktion sein. | Verwenden Sie eine Funktion für den Hook-Callback. | [#1168](https://github.com/fastify/fastify/pull/1168) |
| <a id="fst_err_hook_invalid_async_handler">FST_ERR_HOOK_INVALID_ASYNC_HANDLER</a> | Die Async-Funktion hat zu viele Argumente. Async-Hooks sollten das Argument `done` nicht verwenden. | Entfernen Sie das Argument `done` aus dem Async-Hook. | [#4367](https://github.com/fastify/fastify/pull/4367) |
| <a id="fst_err_hook_not_supported">FST_ERR_HOOK_NOT_SUPPORTED</a> | Der Hook wird nicht unterstützt. | Verwenden Sie einen unterstützten Hook. | [#4554](https://github.com/fastify/fastify/pull/4554) |
| <a id="fst_err_missing_middleware">FST_ERR_MISSING_MIDDLEWARE</a> | Sie müssen ein Plugin zur Behandlung von Middlewares registrieren; weitere Informationen unter [`Middleware`](./Middleware.md). | Registrieren Sie ein Plugin zur Behandlung von Middlewares. | [#2014](https://github.com/fastify/fastify/pull/2014) |
| <a id="fst_err_hook_timeout">FST_ERR_HOOK_TIMEOUT</a> | Ein Callback für einen Hook lief in einen Timeout. | Erhöhen Sie den Timeout für den Hook. | [#3106](https://github.com/fastify/fastify/pull/3106) |
| <a id="fst_err_log_invalid_destination">FST_ERR_LOG_INVALID_DESTINATION</a> | Der Logger akzeptiert das angegebene Ziel nicht. | Verwenden Sie als Ziel einen `'stream'` oder eine `'file'`. | [#1168](https://github.com/fastify/fastify/pull/1168) |
| <a id="fst_err_log_invalid_logger">FST_ERR_LOG_INVALID_LOGGER</a> | Der Logger sollte all diese Methoden besitzen: `'info'`, `'error'`, `'debug'`, `'fatal'`, `'warn'`, `'trace'`, `'child'`. | Verwenden Sie einen Logger mit allen erforderlichen Methoden. | [#4520](https://github.com/fastify/fastify/pull/4520) |
| <a id="fst_err_log_invalid_logger_instance">FST_ERR_LOG_INVALID_LOGGER_INSTANCE</a> | `loggerInstance` akzeptiert nur eine Logger-Instanz, kein Konfigurationsobjekt. | Um ein Konfigurationsobjekt zu übergeben, verwenden Sie stattdessen `'logger'`. | [#5020](https://github.com/fastify/fastify/pull/5020) |
| <a id="fst_err_log_invalid_logger_config">FST_ERR_LOG_INVALID_LOGGER_CONFIG</a> | Die Option logger akzeptiert nur ein Konfigurationsobjekt, keine Logger-Instanz. | Um eine Instanz zu übergeben, verwenden Sie stattdessen `'loggerInstance'`.  | [#5020](https://github.com/fastify/fastify/pull/5020) |
| <a id="fst_err_log_logger_and_logger_instance_provided">FST_ERR_LOG_LOGGER_AND_LOGGER_INSTANCE_PROVIDED</a> | Sie können nicht sowohl `'logger'` als auch `'loggerInstance'` angeben. | Bitte geben Sie nur eine der beiden Optionen an.  | [#5020](https://github.com/fastify/fastify/pull/5020) |
| <a id="fst_err_log_invalid_log_controller">FST_ERR_LOG_INVALID_LOG_CONTROLLER</a> | Die Option `logController` muss eine Instanz von `LogController` sein. | Leiten Sie von der Klasse `LogController` ab und übergeben Sie eine Instanz. | - |
| <a id="fst_err_rep_invalid_payload_type">FST_ERR_REP_INVALID_PAYLOAD_TYPE</a> | Der Reply-Payload kann entweder ein `string` oder ein `Buffer` sein. | Verwenden Sie einen `string` oder einen `Buffer` für den Payload. | [#1168](https://github.com/fastify/fastify/pull/1168) |
| <a id="fst_err_rep_response_body_consumed">FST_ERR_REP_RESPONSE_BODY_CONSUMED</a> | `Response` wird als Reply-Payload verwendet, der Body wird aber gerade konsumiert. | Stellen Sie sicher, dass Sie `Response.body` nicht konsumieren | [#5286](https://github.com/fastify/fastify/pull/5286) |
| <a id="fst_err_rep_readable_stream_locked">FST_ERR_REP_READABLE_STREAM_LOCKED</a> | `ReadableStream` wird als Reply-Payload verwendet, ist aber durch einen anderen Reader gesperrt. | Stellen Sie sicher, dass Sie `Readable.getReader` nicht vor dem Senden aufrufen, oder geben Sie die Sperre vor dem Senden mit `reader.releaseLock()` frei. | [#5920](https://github.com/fastify/fastify/pull/5920) |
| <a id="fst_err_rep_already_sent">FST_ERR_REP_ALREADY_SENT</a> | Eine Antwort wurde bereits gesendet. | - | [#1336](https://github.com/fastify/fastify/pull/1336) |
| <a id="fst_err_rep_sent_value">FST_ERR_REP_SENT_VALUE</a> | Der einzig mögliche Wert für `reply.sent` ist `true`. | - | [#1336](https://github.com/fastify/fastify/pull/1336) |
| <a id="fst_err_send_inside_onerr">FST_ERR_SEND_INSIDE_ONERR</a> | Sie können `send` nicht innerhalb des `onError`-Hooks verwenden. | - | [#1348](https://github.com/fastify/fastify/pull/1348) |
| <a id="fst_err_send_undefined_err">FST_ERR_SEND_UNDEFINED_ERR</a> | Ein undefinierter Fehler ist aufgetreten. | - | [#2074](https://github.com/fastify/fastify/pull/2074) |
| <a id="fst_err_bad_status_code">FST_ERR_BAD_STATUS_CODE</a> | Der Statuscode ist ungültig. | Verwenden Sie einen gültigen Statuscode. | [#2082](https://github.com/fastify/fastify/pull/2082) |
| <a id="fst_err_bad_trailer_name">FST_ERR_BAD_TRAILER_NAME</a> | `reply.trailer` wurde mit einem ungültigen Headernamen aufgerufen. | Verwenden Sie einen gültigen Headernamen. | [#3794](https://github.com/fastify/fastify/pull/3794) |
| <a id="fst_err_bad_trailer_value">FST_ERR_BAD_TRAILER_VALUE</a> | `reply.trailer` wurde mit einem ungültigen Typ aufgerufen. Erwartet wurde eine Funktion. | Verwenden Sie eine Funktion. | [#3794](https://github.com/fastify/fastify/pull/3794) |
| <a id="fst_err_failed_error_serialization">FST_ERR_FAILED_ERROR_SERIALIZATION</a> | Ein Fehler konnte nicht serialisiert werden. | - | [#4601](https://github.com/fastify/fastify/pull/4601) |
| <a id="fst_err_missing_serialization_fn">FST_ERR_MISSING_SERIALIZATION_FN</a> | Fehlende Serialisierungsfunktion. | Fügen Sie eine Serialisierungsfunktion hinzu. | [#3970](https://github.com/fastify/fastify/pull/3970) |
| <a id="fst_err_missing_contenttype_serialization_fn">FST_ERR_MISSING_CONTENTTYPE_SERIALIZATION_FN</a> | Fehlende `Content-Type`-Serialisierungsfunktion. | Fügen Sie eine Serialisierungsfunktion hinzu. | [#4264](https://github.com/fastify/fastify/pull/4264) |
| <a id="fst_err_req_invalid_validation_invocation">FST_ERR_REQ_INVALID_VALIDATION_INVOCATION</a> | Ungültiger Validierungsaufruf. Weder eine Validierungsfunktion für den HTTP-Teil noch ein Schema wurde angegeben. | Fügen Sie eine Validierungsfunktion hinzu. | [#3970](https://github.com/fastify/fastify/pull/3970) |
| <a id="fst_err_sch_missing_id">FST_ERR_SCH_MISSING_ID</a> | Das angegebene Schema hat keine `$id`-Eigenschaft. | Fügen Sie eine `$id`-Eigenschaft hinzu. | [#1168](https://github.com/fastify/fastify/pull/1168) |
| <a id="fst_err_sch_already_present">FST_ERR_SCH_ALREADY_PRESENT</a> | Ein Schema mit derselben `$id` existiert bereits. | Verwenden Sie eine andere `$id`. | [#1168](https://github.com/fastify/fastify/pull/1168) |
| <a id="fst_err_sch_content_missing_schema">FST_ERR_SCH_CONTENT_MISSING_SCHEMA</a> | Für den entsprechenden Content-Type fehlt ein Schema. | Fügen Sie ein Schema hinzu. | [#4264](https://github.com/fastify/fastify/pull/4264) |
| <a id="fst_err_sch_duplicate">FST_ERR_SCH_DUPLICATE</a> | Ein Schema mit demselben Attribut ist bereits vorhanden! | Verwenden Sie ein anderes Attribut. | [#1954](https://github.com/fastify/fastify/pull/1954) |
| <a id="fst_err_sch_validation_build">FST_ERR_SCH_VALIDATION_BUILD</a> | Das für die Validierung einer Route angegebene JSON Schema ist ungültig. | Korrigieren Sie das JSON Schema. | [#2023](https://github.com/fastify/fastify/pull/2023) |
| <a id="fst_err_sch_serialization_build">FST_ERR_SCH_SERIALIZATION_BUILD</a> | Das für die Serialisierung einer Routen-Response angegebene JSON Schema ist ungültig. | Korrigieren Sie das JSON Schema. | [#2023](https://github.com/fastify/fastify/pull/2023) |
| <a id="fst_err_sch_response_schema_not_nested_2xx">FST_ERR_SCH_RESPONSE_SCHEMA_NOT_NESTED_2XX</a> | Response-Schemas sollten unter einem gültigen Statuscode (2XX) verschachtelt sein. | Verwenden Sie einen gültigen Statuscode. | [#4554](https://github.com/fastify/fastify/pull/4554) |
| <a id="fst_err_init_opts_invalid">FST_ERR_INIT_OPTS_INVALID</a> | Ungültige Initialisierungsoptionen. | Verwenden Sie gültige Initialisierungsoptionen. | [#1471](https://github.com/fastify/fastify/pull/1471) |
| <a id="fst_err_force_close_connections_idle_not_available">FST_ERR_FORCE_CLOSE_CONNECTIONS_IDLE_NOT_AVAILABLE</a> | forceCloseConnections kann nicht auf `idle` gesetzt werden, da Ihr HTTP-Server die Methode `closeIdleConnections` nicht unterstützt. | Verwenden Sie einen anderen Wert für `forceCloseConnections`. | [#3925](https://github.com/fastify/fastify/pull/3925) |
| <a id="fst_err_duplicated_route">FST_ERR_DUPLICATED_ROUTE</a> | Für diese URL ist für die HTTP-Methode bereits ein Controller registriert. | Verwenden Sie eine andere URL oder registrieren Sie den Controller für eine andere HTTP-Methode. | [#2954](https://github.com/fastify/fastify/pull/2954) |
| <a id="fst_err_bad_url">FST_ERR_BAD_URL</a> | Der Router hat eine ungültige URL erhalten. | Verwenden Sie eine gültige URL. | [#2106](https://github.com/fastify/fastify/pull/2106) |
| <a id="fst_err_max_param_length">FST_ERR_MAX_PARAM_LENGTH</a> | Der Router hat eine URL erhalten, die die maximale Parameterlänge überschreitet. | Passen Sie die Parameterlänge an oder erhöhen Sie die maximale Parameterlänge nach Bedarf. | [#2106](https://github.com/fastify/fastify/pull/6716) |
| <a id="fst_err_async_constraint">FST_ERR_ASYNC_CONSTRAINT</a> | Der Router hat bei der Verwendung asynchroner Constraints einen Fehler erhalten. | - | [#4323](https://github.com/fastify/fastify/pull/4323) |
| <a id="fst_err_invalid_url">FST_ERR_INVALID_URL</a> | Die URL muss ein String sein. | Verwenden Sie einen String für die URL. | [#3653](https://github.com/fastify/fastify/pull/3653) |
| <a id="fst_err_route_options_not_obj">FST_ERR_ROUTE_OPTIONS_NOT_OBJ</a> | Die Optionen für die Route müssen ein Objekt sein. | Verwenden Sie ein Objekt für die Routenoptionen. | [#4554](https://github.com/fastify/fastify/pull/4554) |
| <a id="fst_err_route_duplicated_handler">FST_ERR_ROUTE_DUPLICATED_HANDLER</a> | Ein doppelter Handler für die Route ist nicht zulässig. | Verwenden Sie einen anderen Handler. | [#4554](https://github.com/fastify/fastify/pull/4554) |
| <a id="fst_err_route_handler_not_fn">FST_ERR_ROUTE_HANDLER_NOT_FN</a> | Der Handler der Route muss eine Funktion sein. | Verwenden Sie eine Funktion für den Handler. | [#4554](https://github.com/fastify/fastify/pull/4554) |
| <a id="fst_err_route_missing_handler">FST_ERR_ROUTE_MISSING_HANDLER</a> | Fehlende Handler-Funktion für die Route. | Fügen Sie eine Handler-Funktion hinzu. | [#4554](https://github.com/fastify/fastify/pull/4554) |
| <a id="fst_err_route_method_invalid">FST_ERR_ROUTE_METHOD_INVALID</a> | Die Methode ist kein gültiger Wert. | Verwenden Sie einen gültigen Wert für die Methode. | [#4750](https://github.com/fastify/fastify/pull/4750) |
| <a id="fst_err_route_method_not_supported">FST_ERR_ROUTE_METHOD_NOT_SUPPORTED</a> | Die Methode wird für die Route nicht unterstützt. | Verwenden Sie eine unterstützte Methode. | [#4554](https://github.com/fastify/fastify/pull/4554) |
| <a id="fst_err_route_log_level_invalid">FST_ERR_ROUTE_LOG_LEVEL_INVALID</a> | `logLevel` muss einem konfigurierten Logger-Level entsprechen. | Verwenden Sie für die Route eines der konfigurierten Logger-Level. | [#6523](https://github.com/fastify/fastify/pull/6523) |
| <a id="fst_err_route_body_validation_schema_not_supported">FST_ERR_ROUTE_BODY_VALIDATION_SCHEMA_NOT_SUPPORTED</a> | Ein Body-Validierungsschema wird für diese Route nicht unterstützt. | Verwenden Sie eine andere Methode für die Route. | [#4554](https://github.com/fastify/fastify/pull/4554) |
| <a id="fst_err_route_body_limit_option_not_int">FST_ERR_ROUTE_BODY_LIMIT_OPTION_NOT_INT</a> | Die Option `bodyLimit` muss eine Ganzzahl sein. | Verwenden Sie eine Ganzzahl für die Option `bodyLimit`. | [#4554](https://github.com/fastify/fastify/pull/4554) |
| <a id="fst_err_handler_timeout">FST_ERR_HANDLER_TIMEOUT</a> | Der Request lief in einen Timeout. | Erhöhen Sie die Option `handlerTimeout` oder optimieren Sie den Handler. | - |
| <a id="fst_err_route_handler_timeout_option_not_int">FST_ERR_ROUTE_HANDLER_TIMEOUT_OPTION_NOT_INT</a> | Die Option `handlerTimeout` muss eine positive Ganzzahl sein. | Verwenden Sie eine positive Ganzzahl für die Option `handlerTimeout`. | - |
| <a id="fst_err_route_rewrite_not_str">FST_ERR_ROUTE_REWRITE_NOT_STR</a> | `rewriteUrl` muss vom Typ `string` sein. | Verwenden Sie einen String für `rewriteUrl`. | [#4554](https://github.com/fastify/fastify/pull/4554) |
| <a id="fst_err_route_missing_content_type">FST_ERR_ROUTE_MISSING_CONTENT_TYPE</a> | Für den Request ist der Header `Content-Type` erforderlich. | Senden Sie den Request mit dem Header `Content-Type`. | [#6832](https://github.com/fastify/fastify/pull/6832) |
| <a id="fst_err_route_missing_content">FST_ERR_ROUTE_MISSING_CONTENT</a> | Für den Request ist ein Body erforderlich. | Senden Sie den Request mit einem Payload. | [#6832](https://github.com/fastify/fastify/pull/6832) |
| <a id="fst_err_reopened_close_server">FST_ERR_REOPENED_CLOSE_SERVER</a> | Fastify wurde bereits geschlossen und kann nicht erneut geöffnet werden. | - | [#2415](https://github.com/fastify/fastify/pull/2415) |
| <a id="fst_err_reopened_server">FST_ERR_REOPENED_SERVER</a> | Fastify lauscht bereits. | - | [#2415](https://github.com/fastify/fastify/pull/2415) |
| <a id="fst_err_plugin_version_mismatch">FST_ERR_PLUGIN_VERSION_MISMATCH</a> | Das installierte Fastify-Plugin passt nicht zur erwarteten Version. | Verwenden Sie eine kompatible Version des Plugins. | [#2549](https://github.com/fastify/fastify/pull/2549) |
| <a id="fst_err_plugin_callback_not_fn">FST_ERR_PLUGIN_CALLBACK_NOT_FN</a> | Der Callback für einen Hook ist keine Funktion. | Verwenden Sie eine Funktion für den Callback. | [#3106](https://github.com/fastify/fastify/pull/3106) |
| <a id="fst_err_plugin_not_valid">FST_ERR_PLUGIN_NOT_VALID</a> | Das Plugin muss eine Funktion oder ein Promise sein. | Verwenden Sie eine Funktion oder ein Promise für das Plugin. | [#3106](https://github.com/fastify/fastify/pull/3106) |
| <a id="fst_err_root_plg_booted">FST_ERR_ROOT_PLG_BOOTED</a> | Das Root-Plugin wurde bereits gebootet. | - | [#3106](https://github.com/fastify/fastify/pull/3106) |
| <a id="fst_err_parent_plugin_booted">FST_ERR_PARENT_PLUGIN_BOOTED</a> | Das Plugin kann nicht geladen werden, weil das übergeordnete Plugin bereits gebootet wurde (direkt aus `avvio` übernommen) | - | [#3106](https://github.com/fastify/fastify/pull/3106) |
| <a id="fst_err_plugin_timeout">FST_ERR_PLUGIN_TIMEOUT</a> | Das Plugin ist nicht rechtzeitig gestartet. | Erhöhen Sie den Timeout für das Plugin. | [#3106](https://github.com/fastify/fastify/pull/3106) |
| <a id="fst_err_plugin_not_present_in_instance">FST_ERR_PLUGIN_NOT_PRESENT_IN_INSTANCE</a> | Der Decorator ist in der Instanz nicht vorhanden. | - | [#4554](https://github.com/fastify/fastify/pull/4554) |
| <a id="fst_err_plugin_invalid_async_handler">FST_ERR_PLUGIN_INVALID_ASYNC_HANDLER</a> | Das zu registrierende Plugin vermischt Async- und Callback-Stil. | - | [#5141](https://github.com/fastify/fastify/pull/5141) |
| <a id="fst_err_plugin_dependency_not_registered">FST_ERR_PLUGIN_DEPENDENCY_NOT_REGISTERED</a> | Die Abhängigkeit eines Plugins ist nicht registriert. | Registrieren Sie die fehlende Abhängigkeit, bevor Sie dieses Plugin registrieren. | [#6774](https://github.com/fastify/fastify/pull/6774) |
| <a id="fst_err_validation">FST_ERR_VALIDATION</a> | Der Request hat die Payload-Validierung nicht bestanden. | Prüfen Sie den Request-Payload. | [#4824](https://github.com/fastify/fastify/pull/4824) |
| <a id="fst_err_listen_options_invalid">FST_ERR_LISTEN_OPTIONS_INVALID</a> | Ungültige Listen-Optionen. | Prüfen Sie die Listen-Optionen. | [#4886](https://github.com/fastify/fastify/pull/4886) |
| <a id="fst_err_error_handler_not_fn">FST_ERR_ERROR_HANDLER_NOT_FN</a> | Der Fehlerhandler muss eine Funktion sein | Übergeben Sie `setErrorHandler` eine Funktion. | [#5317](https://github.com/fastify/fastify/pull/5317) | <a id="fst_err_error_handler_already_set">FST_ERR_ERROR_HANDLER_ALREADY_SET</a> | In diesem Scope ist bereits ein Fehlerhandler gesetzt. Setzen Sie `allowErrorHandlerOverride: true`, um das Überschreiben zu erlauben. | Standardmäßig kann `setErrorHandler` pro Kapselungskontext nur einmal aufgerufen werden. | [#6097](https://github.com/fastify/fastify/pull/6098) |
