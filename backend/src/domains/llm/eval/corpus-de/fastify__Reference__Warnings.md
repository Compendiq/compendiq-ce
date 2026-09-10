<h1 align="center">Fastify</h1>

**Inhaltsverzeichnis**
- [Warnungen](#warnings)
  - [Warnungen in Fastify](#warnings-in-fastify)
  - [Fastify-Warnungscodes](#fastify-warning-codes)
    - [FSTWRN001](#FSTWRN001)
    - [FSTWRN003](#FSTWRN003)
    - [FSTWRN004](#FSTWRN004)
  - [Fastify-Deprecation-Codes](#fastify-deprecation-codes)
    - [FSTDEP022](#FSTDEP022)
    - [FSTDEP023](#FSTDEP023)
    - [FSTDEP024](#FSTDEP024)
    - [FSTDEP025](#FSTDEP025)

## Warnungen

### Warnungen in Fastify

Fastify verwendet die [warning-event](https://nodejs.org/api/process.html#event-warning)-API
von Node.js, um Nutzer über veraltete Features und Programmierfehler zu
informieren. Die Warnungen von Fastify sind an den Präfixen `FSTWRN` und
`FSTDEP` erkennbar. Wenn eine solche Warnung auftritt, ist es dringend zu
empfehlen, die Ursache mit den Flags
[`--trace-warnings`](https://nodejs.org/api/cli.html#trace-warnings)
und [`--trace-deprecation`](https://nodejs.org/api/cli.html#trace-deprecation)
zu ermitteln. Diese erzeugen Stacktraces, die auf die Stelle im Code der
Anwendung verweisen, an der das Problem auftritt. Issues zu Warnungen, die ohne
diese Informationen eröffnet werden, werden geschlossen.

Warnungen lassen sich auch abschalten, was jedoch nicht empfohlen wird. Falls
nötig, verwenden Sie eine der folgenden Methoden:

- Setzen Sie die Umgebungsvariable `NODE_NO_WARNINGS` auf `1`
- Übergeben Sie dem Node-Prozess das Flag `--no-warnings`
- Setzen Sie `no-warnings` in der Umgebungsvariablen `NODE_OPTIONS`
- Übergeben Sie `--disable-warning=FSTWRN004`, um eine bestimmte Warnung abzuschalten

Weitere Informationen zum Abschalten von Warnungen finden Sie in der [Node-Dokumentation](https://nodejs.org/api/cli.html).

Das Abschalten von Warnungen wird nicht empfohlen und kann zu unerwartetem Verhalten führen.

### Fastify-Warnungscodes

| Code | Beschreibung | Lösung | Diskussion |
| ---- | ------------ | ------ | ---------- |
| <a id="FSTWRN001">FSTWRN001</a> | Das angegebene Schema für eine Route fehlt. Das kann darauf hindeuten, dass das Schema nicht sauber spezifiziert ist. | Prüfen Sie das Schema der Route. | [#4647](https://github.com/fastify/fastify/pull/4647) |
| <a id="FSTWRN003">FSTWRN003</a> | Das Plugin `%s` vermischt async- und Callback-Stil, was zu unbehandelten Rejections führen kann. | Vermischen Sie async- und Callback-Stil nicht. | [#6011](https://github.com/fastify/fastify/pull/6011) |
| <a id="FSTWRN004">FSTWRN004</a> | Ein `errorHandler` wird im selben Scope überschrieben, was zu subtilen Bugs führen kann. | Vermeiden Sie es, `setErrorHandler` mehr als einmal im selben Scope aufzurufen. Weitere Informationen finden Sie in der [Server-Dokumentation](https://fastify.dev/docs/latest/Reference/Server/#allowerrorhandleroverride). | [#6104](https://github.com/fastify/fastify/pull/6104) |
### Fastify-Deprecation-Codes

Deprecation-Codes werden von den folgenden CLI-Optionen von Node.js unterstützt:

- [--no-deprecation](https://nodejs.org/api/cli.html#no-deprecation)
- [--throw-deprecation](https://nodejs.org/api/cli.html#throw-deprecation)
- [--trace-deprecation](https://nodejs.org/api/cli.html#trace-deprecation)


| Code | Beschreibung | Lösung | Diskussion |
| ---- | ------------ | ------ | ---------- |
| <a id="FSTDEP022">FSTDEP022</a> | Sie versuchen, auf die veralteten Router-Optionen auf den obersten Optionseigenschaften zuzugreifen. | Verwenden Sie `options.routerOptions`. | [#5985](https://github.com/fastify/fastify/pull/5985)
| <a id="FSTDEP023">FSTDEP023</a> | Die Top-Level-Option `disableRequestLogging` ist veraltet. | Übergeben Sie stattdessen eine `LogController`-Instanz über die Option `logController` mit `disableRequestLogging` in deren Konstruktor. |
| <a id="FSTDEP024">FSTDEP024</a> | Die Top-Level-Option `requestIdLogLabel` ist veraltet. | Übergeben Sie stattdessen eine `LogController`-Instanz über die Option `logController` mit `requestIdLogLabel` in deren Konstruktor. |
| <a id="FSTDEP025">FSTDEP025</a> | Der Aufruf von `addHttpMethod` für eine bereits existierende HTTP-Methode ohne `{ overrideExisting: true }` ist veraltet. | Übergeben Sie `{ overrideExisting: true }`, um das Überschreiben explizit zu machen. | [#6879](https://github.com/fastify/fastify/pull/6879) |
