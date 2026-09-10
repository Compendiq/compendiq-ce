<h1 align="center">Fastify</h1>

## Kerndokumente
<a id="reference-core-docs"></a>

Das vollständige Inhaltsverzeichnis findest du [weiter unten](#reference-toc). Die folgende Liste
ist eine Teilmenge des vollständigen Inhaltsverzeichnisses und beschreibt die zentralen Fastify-APIs und
-Konzepte, geordnet nach ihrer voraussichtlichen Bedeutung für den Leser:

+ [Server](./Server.md): Dokumentiert die Kern-API von Fastify. Enthält die Dokumentation
  zur Factory-Funktion und zur daraus entstehenden Serverinstanz.
+ [Lifecycle](./Lifecycle.md): Erklärt den Request-Lebenszyklus von Fastify und
  zeigt, an welchen Stellen [Hooks](./Hooks.md) für die Einbindung zur Verfügung stehen.
+ [Routes](./Routes.md): Beschreibt, wie Routen bei Fastify registriert werden und wie
  Fastify den Routing-Trie aufbaut und auswertet.
+ [Request](./Request.md): Beschreibt das Request-Objekt von Fastify, das an
  jeden Request-Handler übergeben wird.
+ [Reply](./Reply.md): Beschreibt das Response-Objekt von Fastify, das jedem
  Request-Handler zur Verfügung steht.
+ [Validation and Serialization](./Validation-and-Serialization.md): Beschreibt
  die Unterstützung von Fastify für die Validierung eingehender Daten und wie Fastify Daten
  für Responses serialisiert.
+ [Plugins](./Plugins.md): Erklärt die Plugin-Architektur und die Plugin-API von Fastify.
+ [Encapsulation](./Encapsulation.md): Erklärt ein Kernkonzept, auf dem alle
  Fastify-Plugins aufbauen.
+ [Decorators](./Decorators.md): Erklärt die Decorator-APIs für Server, Request und Response.
+ [Hooks](./Hooks.md): Beschreibt die API, über die Plugins sich in den
  Request-Lebenszyklus einklinken können.


## Inhaltsverzeichnis der Referenzdokumentation
<a id="reference-toc"></a>

Dieses Inhaltsverzeichnis ist alphabetisch geordnet.

+ [Content Type Parser](./ContentTypeParser.md): Dokumentiert den Standard-Content-Type-Parser
  von Fastify und wie man Unterstützung für neue Content-Types hinzufügt.
+ [Decorators](./Decorators.md): Erklärt die Decorator-APIs für Server, Request und Response.
+ [Encapsulation](./Encapsulation.md): Erklärt ein Kernkonzept, auf dem alle
  Fastify-Plugins aufbauen.
+ [Errors](./Errors.md): Beschreibt, wie Fastify mit Fehlern umgeht, und listet die
  Standardmenge der von Fastify erzeugten Fehler auf.
+ [Hooks](./Hooks.md): Beschreibt die API, über die Plugins sich in den
  Request-Lebenszyklus einklinken können.
+ [HTTP/2](./HTTP2.md): Beschreibt die HTTP/2-Unterstützung von Fastify.
+ [Logging](./Logging.md): Beschreibt das mitgelieferte Logging von Fastify und wie man
  es anpasst.
+ [Long Term Support](./LTS.md): Erklärt die Long-Term-Support-Zusage von Fastify
  und die möglichen Ausnahmen vom [Semver](https://semver.org)-Vertrag.
+ [Middleware](./Middleware.md): Beschreibt die Unterstützung von Fastify für
  Middleware im Express.js-Stil.
+ [Plugins](./Plugins.md): Erklärt die Plugin-Architektur und die Plugin-API von Fastify.
+ [Reply](./Reply.md): Beschreibt das Response-Objekt von Fastify, das jedem
  Request-Handler zur Verfügung steht.
+ [Request](./Request.md): Beschreibt das Request-Objekt von Fastify, das an
  jeden Request-Handler übergeben wird.
+ [Routes](./Routes.md): Beschreibt, wie Routen bei Fastify registriert werden und wie
  Fastify den Routing-Trie aufbaut und auswertet.
+ [Server](./Server.md): Dokumentiert die Kern-API von Fastify. Enthält die Dokumentation
  zur Factory-Funktion und zu dem von ihr zurückgegebenen Objekt.
+ [TypeScript](./TypeScript.md): Dokumentiert die TypeScript-Unterstützung von Fastify und
  gibt Empfehlungen für die Entwicklung von TypeScript-Anwendungen.
+ [Validation and Serialization](./Validation-and-Serialization.md): Beschreibt
  die Unterstützung von Fastify für die Validierung eingehender Daten und wie Fastify Daten
  für Responses serialisiert.
+ [Warnings](./Warnings.md): Beschreibt die von Fastify ausgegebenen Warnungen und wie man
  sie behebt.
