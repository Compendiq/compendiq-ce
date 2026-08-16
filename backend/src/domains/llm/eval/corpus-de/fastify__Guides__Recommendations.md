<h1 align="center">Fastify</h1>

## Empfehlungen

Dieses Dokument enthält eine Reihe von Empfehlungen für die Verwendung von Fastify.

- [Verwende einen Reverse Proxy](#use-a-reverse-proxy)
  - [HAProxy](#haproxy)
  - [Nginx](#nginx)
- [Häufige Ursachen für Performance-Einbußen](#common-causes-of-performance-degradation)
- [Kubernetes](#kubernetes)
- [Kapazitätsplanung für die Produktion](#capacity)
- [Mehrere Instanzen betreiben](#multiple)

## Verwende einen Reverse Proxy
<a id="reverseproxy"></a>

Node.js gehört zu den frühen Vertretern von Frameworks, die einen leicht nutzbaren Webserver in der Standardbibliothek mitbringen. Zuvor benötigte man bei Sprachen wie PHP oder Python entweder einen Webserver mit spezieller Unterstützung für die Sprache oder die Möglichkeit, eine Art [CGI-Gateway][cgi] einzurichten, das mit der Sprache funktioniert. Mit Node.js kann man eine Anwendung schreiben, die HTTP-Requests _direkt_ verarbeitet. Daraus entsteht die Versuchung, Anwendungen zu schreiben, die Requests für mehrere Domains verarbeiten, auf mehreren Ports lauschen (also HTTP _und_ HTTPS) und diese Anwendungen dann direkt im Internet exponieren, um Requests zu bedienen.

Das Fastify-Team hält das **entschieden** für ein Anti-Pattern und für äußerst schlechte Praxis:

1. Es fügt der Anwendung unnötige Komplexität hinzu, indem es ihren Fokus verwässert.
2. Es verhindert [horizontale Skalierbarkeit][scale-horiz].

Eine ausführlichere Erörterung, warum man sich für einen Reverse Proxy entscheiden sollte, findest du unter [Why should I use a Reverse Proxy if Node.js is Production Ready?][why-use].

Als konkretes Beispiel betrachte die Situation, in der:

1. Die App mehrere Instanzen benötigt, um die Last zu bewältigen.
1. Die App TLS-Terminierung benötigt.
1. Die App HTTP-Requests auf HTTPS umleiten muss.
1. Die App mehrere Domains bedienen muss.
1. Die App statische Ressourcen ausliefern muss, z. B. JPEG-Dateien.

Es gibt viele Reverse-Proxy-Lösungen, und deine Umgebung gibt die zu verwendende Lösung möglicherweise vor, z. B. AWS oder GCP. Angesichts des Obigen könnten wir [HAProxy][haproxy] oder [Nginx][nginx] verwenden, um diese Anforderungen zu erfüllen:

### HAProxy

```conf
# The global section defines base HAProxy (engine) instance configuration.
global
  log /dev/log syslog
  maxconn 4096
  chroot /var/lib/haproxy
  user haproxy
  group haproxy

  # Set some baseline TLS options.
  tune.ssl.default-dh-param 2048
  ssl-default-bind-options no-sslv3 no-tlsv10 no-tlsv11
  ssl-default-bind-ciphers ECDH+AESGCM:DH+AESGCM:ECDH+AES256:DH+AES256:ECDH+AES128:DH+AES:RSA+AESGCM:RSA+AES:!aNULL:!MD5:!DSS
  ssl-default-server-options no-sslv3 no-tlsv10 no-tlsv11
  ssl-default-server-ciphers ECDH+AESGCM:DH+AESGCM:ECDH+AES256:DH+AES256:ECDH+AES128:DH+AES:RSA+AESGCM:RSA+AES:!aNULL:!MD5:!DSS

# Each defaults section defines options that will apply to each subsequent
# subsection until another defaults section is encountered.
defaults
  log   global
  mode  http
  option        httplog
  option        dontlognull
  retries       3
  option redispatch
  # The following option makes haproxy close connections to backend servers
  # instead of keeping them open. This can alleviate unexpected connection
  # reset errors in the Node process.
  option http-server-close
  maxconn       2000
  timeout connect 5000
  timeout client 50000
  timeout server 50000

  # Enable content compression for specific content types.
  compression algo gzip
  compression type text/html text/plain text/css application/javascript

# A "frontend" section defines a public listener, i.e. an "http server"
# as far as clients are concerned.
frontend proxy
  # The IP address here would be the _public_ IP address of the server.
  # Here, we use a private address as an example.
  bind 10.0.0.10:80
  # This redirect rule will redirect all traffic that is not TLS traffic
  # to the same incoming request URL on the HTTPS port.
  redirect scheme https code 308 if !{ ssl_fc }
  # Technically this use_backend directive is useless since we are simply
  # redirecting all traffic to this frontend to the HTTPS frontend. It is
  # merely included here for completeness sake.
  use_backend default-server

# This frontend defines our primary, TLS only, listener. It is here where
# we will define the TLS certificates to expose and how to direct incoming
# requests.
frontend proxy-ssl
  # The `/etc/haproxy/certs` directory in this example contains a set of
  # certificate PEM files that are named for the domains the certificates are
  # issued for. When HAProxy starts, it will read this directory, load all of
  # the certificates it finds here, and use SNI matching to apply the correct
  # certificate to the connection.
  bind 10.0.0.10:443 ssl crt /etc/haproxy/certs

  # Here we define rule pairs to handle static resources. Any incoming request
  # that has a path starting with `/static`, e.g.
  # `https://one.fastify.example/static/foo.jpeg`, will be redirected to the
  # static resources server.
  acl is_static path -i -m beg /static
  use_backend static-backend if is_static

  # Here we define rule pairs to direct requests to appropriate Node.js
  # servers based on the requested domain. The `acl` line is used to match
  # the incoming hostname and define a boolean indicating if it is a match.
  # The `use_backend` line is used to direct the traffic if the boolean is
  # true.
  acl example1 hdr_sub(Host) one.fastify.example
  use_backend example1-backend if example1

  acl example2 hdr_sub(Host) two.fastify.example
  use_backend example2-backend if example2

  # Finally, we have a fallback redirect if none of the requested hosts
  # match the above rules.
  default_backend default-server

# A "backend" is used to tell HAProxy where to request information for the
# proxied request. These sections are where we will define where our Node.js
# apps live and any other servers for things like static assets.
backend default-server
  # In this example we are defaulting unmatched domain requests to a single
  # backend server for all requests. Notice that the backend server does not
  # have to be serving TLS requests. This is called "TLS termination": the TLS
  # connection is "terminated" at the reverse proxy.
  # It is possible to also proxy to backend servers that are themselves serving
  # requests over TLS, but that is outside the scope of this example.
  server server1 10.10.10.2:80

# This backend configuration will serve requests for `https://one.fastify.example`
# by proxying requests to three backend servers in a round-robin manner.
backend example1-backend
  server example1-1 10.10.11.2:80
  server example1-2 10.10.11.2:80
  server example2-2 10.10.11.3:80

# This one serves requests for `https://two.fastify.example`
backend example2-backend
  server example2-1 10.10.12.2:80
  server example2-2 10.10.12.2:80
  server example2-3 10.10.12.3:80

# This backend handles the static resources requests.
backend static-backend
  server static-server1 10.10.9.2:80
```

[cgi]: https://en.wikipedia.org/wiki/Common_Gateway_Interface
[scale-horiz]: https://en.wikipedia.org/wiki/Scalability#Horizontal
[why-use]: https://web.archive.org/web/20190821102906/https://medium.com/intrinsic/why-should-i-use-a-reverse-proxy-if-node-js-is-production-ready-5a079408b2ca
[haproxy]: https://www.haproxy.org/

### Nginx

```nginx
# This upstream block groups 3 servers into one named backend fastify_app
# with 2 primary servers distributed via round-robin
# and one backup which is used when the first 2 are not reachable
# This also assumes your fastify servers are listening on port 80.
# more info: https://nginx.org/en/docs/http/ngx_http_upstream_module.html
upstream fastify_app {
  server 10.10.11.1:80;
  server 10.10.11.2:80;
  server 10.10.11.3:80 backup;
}

# This server block asks NGINX to respond with a redirect when
# an incoming request from port 80 (typically plain HTTP), to
# the same request URL but with HTTPS as protocol.
# This block is optional, and usually used if you are handling
# SSL termination in NGINX, like in the example here.
server {
  # default server is a special parameter to ask NGINX
  # to set this server block to the default for this address/port
  # which in this case is any address and port 80
  listen 80 default_server;
  listen [::]:80 default_server;

  # With a server_name directive you can also ask NGINX to
  # use this server block only with matching server name(s)
  # listen 80;
  # listen [::]:80;
  # server_name example.tld;

  # This matches all paths from the request and responds with
  # the redirect mentioned above.
  location / {
    return 301 https://$host$request_uri;
  }
}

# This server block asks NGINX to respond to requests from
# port 443 with SSL enabled and accept HTTP/2 connections.
# This is where the request is then proxied to the fastify_app
# server group via port 3000.
server {
  # This listen directive asks NGINX to accept requests
  # coming to any address, port 443, with SSL.
  listen 443 ssl default_server;
  listen [::]:443 ssl default_server;

  # With a server_name directive you can also ask NGINX to
  # use this server block only with matching server name(s)
  # listen 443 ssl;
  # listen [::]:443 ssl;
  # server_name example.tld;

  # Enable HTTP/2 support
  http2 on;

  # Your SSL/TLS certificate (chain) and secret key in the PEM format
  ssl_certificate /path/to/fullchain.pem;
  ssl_certificate_key /path/to/private.pem;

  # A generic best practice baseline for based
  # on https://ssl-config.mozilla.org/
  ssl_session_timeout 1d;
  ssl_session_cache shared:FastifyApp:10m;
  ssl_session_tickets off;

  # This tells NGINX to only accept TLS 1.3, which should be fine
  # with most modern browsers including IE 11 with certain updates.
  # If you want to support older browsers you might need to add
  # additional fallback protocols.
  ssl_protocols TLSv1.3;
  ssl_prefer_server_ciphers off;

  # This adds a header that tells browsers to only ever use HTTPS
  # with this server.
  add_header Strict-Transport-Security "max-age=63072000" always;

  # The following directives are only necessary if you want to
  # enable OCSP Stapling.
  ssl_stapling on;
  ssl_stapling_verify on;
  ssl_trusted_certificate /path/to/chain.pem;

  # Custom nameserver to resolve upstream server names
  # resolver 127.0.0.1;

  # This section matches all paths and proxies it to the backend server
  # group specified above. Note the additional headers that forward
  # information about the original request. You might want to set
  # trustProxy to the address of your NGINX server so the X-Forwarded
  # fields are used by fastify.
  location / {
    # more info: https://nginx.org/en/docs/http/ngx_http_proxy_module.html
    proxy_http_version 1.1;
    proxy_cache_bypass $http_upgrade;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection 'upgrade';
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;

    # This is the directive that proxies requests to the specified server.
    # If you are using an upstream group, then you do not need to specify a port.
    # If you are directly proxying to a server e.g.
    # proxy_pass http://127.0.0.1:3000 then specify a port.
    proxy_pass http://fastify_app;
  }
}
```

[nginx]: https://nginx.org/

## Häufige Ursachen für Performance-Einbußen

Diese Muster können in der Produktion die Latenz erhöhen oder den Durchsatz verringern:

- Bevorzuge auf heißen Pfaden statische oder einfache parametrische Routes. RegExp-Routes sind teuer, und Routes mit vielen Parametern können die Performance des Routers ebenfalls beeinträchtigen. Siehe [Routes - Url building](../Reference/Routes.md#url-building).
- Setze Route-Constraints mit Bedacht ein. Versions-Constraints können die Router-Performance verschlechtern, und asynchrone eigene Constraints sollten als letztes Mittel betrachtet werden. Siehe [Routes - Constraints](../Reference/Routes.md#constraints).
- Bevorzuge nach Möglichkeit Fastify-Plugins/-Hooks gegenüber generischer Middleware. Die Middleware-Adapter von Fastify funktionieren, aber native Integrationen sind für performance-kritische Pfade typischerweise besser. Siehe [Middleware](../Reference/Middleware.md).
- Definiere Response-Schemas, um die JSON-Serialisierung zu beschleunigen. Siehe [Getting Started - Serialize your data](./Getting-Started.md#serialize-data).
- Lass Ajvs `allErrors` standardmäßig deaktiviert. Aktiviere es nur, wenn detailliertes Validierungs-Feedback nötig ist (zum Beispiel bei formularlastigen APIs), und vermeide es auf latenzkritischen Endpunkten. Ist `allErrors: true` aktiviert, kann die Validierung pro Request mehr Arbeit verrichten und Denial-of-Service-Angriffe bei nicht vertrauenswürdigen Eingaben erleichtern.
  Siehe auch:
  - [Validation and Serialization - Validator Compiler](../Reference/Validation-and-Serialization.md#schema-validator)
  - [Ajv Security Risks of Trusted Schemas](https://ajv.js.org/security.html#security-risks-of-trusted-schemas).

## Kubernetes
<a id="kubernetes"></a>

Die `readinessProbe` verwendet ([standardmäßig](https://kubernetes.io/docs/tasks/configure-pod-container/configure-liveness-readiness-startup-probes/#configure-probes)) die Pod-IP als Hostnamen. Fastify lauscht standardmäßig auf `127.0.0.1`. Die Probe kann die Anwendung in diesem Fall nicht erreichen. Damit es funktioniert, muss die Anwendung auf `0.0.0.0` lauschen oder in der Spezifikation `readinessProbe.httpGet` einen eigenen Hostnamen angeben, wie im folgenden Beispiel:

```yaml
readinessProbe:
    httpGet:
        path: /health
        port: 4000
    initialDelaySeconds: 30
    periodSeconds: 30
    timeoutSeconds: 3
    successThreshold: 1
    failureThreshold: 5
```

## Kapazitätsplanung für die Produktion
<a id="capacity"></a>

Um die Produktionsumgebung für deine Fastify-Anwendung richtig zu dimensionieren, wird dringend empfohlen, eigene Messungen gegen verschiedene Konfigurationen der Umgebung durchzuführen, die echte CPU-Kerne, virtuelle CPU-Kerne (vCPU) oder sogar Bruchteile von vCPU-Kernen verwenden können. Wir verwenden in dieser Empfehlung durchgehend den Begriff vCPU, um jeden CPU-Typ zu bezeichnen.

Werkzeuge wie [k6](https://github.com/grafana/k6) oder [autocannon](https://github.com/mcollina/autocannon) können für die erforderlichen Performance-Tests verwendet werden.

Davon abgesehen kannst du Folgendes als Faustregel betrachten:

* Für die geringstmögliche Latenz werden 2 vCPU pro App-Instanz empfohlen (z. B. pro k8s-Pod). Die zweite vCPU wird überwiegend vom Garbage Collector (GC) und vom libuv-Threadpool genutzt. Das minimiert die Latenz für deine Nutzer sowie den Speicherverbrauch, da der GC häufiger läuft. Außerdem muss der Haupt-Thread nicht anhalten, um den GC laufen zu lassen.

* Um auf Durchsatz zu optimieren (die größtmögliche Anzahl an Requests pro Sekunde je verfügbarer vCPU zu verarbeiten), ziehe eine geringere Anzahl vCPUs pro App-Instanz in Betracht. Es ist völlig in Ordnung, Node.js-Anwendungen mit 1 vCPU zu betreiben.

* Du kannst auch mit einer noch kleineren Menge vCPU experimentieren, was in bestimmten Anwendungsfällen einen noch besseren Durchsatz liefern kann. Es gibt Berichte über API-Gateway-Lösungen, die mit 100m–200m vCPU in Kubernetes gut funktionieren.

Sieh dir [Node's Event Loop From the Inside Out](https://www.youtube.com/watch?v=P9csgxBgaZ8) an, um die Funktionsweise von Node.js genauer zu verstehen und besser einschätzen zu können, was deine konkrete Anwendung benötigt.

## Mehrere Instanzen betreiben
<a id="multiple"></a>

Es gibt mehrere Anwendungsfälle, in denen der Betrieb mehrerer Fastify-Apps auf demselben Server in Betracht kommt. Ein häufiges Beispiel wäre, Metrik-Endpunkte auf einem separaten Port bereitzustellen, um öffentlichen Zugriff zu verhindern, wenn ein Reverse Proxy oder eine Ingress-Firewall keine Option ist.

Es ist völlig in Ordnung, mehrere Fastify-Instanzen innerhalb desselben Node.js-Prozesses hochzufahren und nebeneinander zu betreiben, selbst in Systemen unter hoher Last. Jede Fastify-Instanz erzeugt nur so viel Last, wie sie an Traffic empfängt, zuzüglich des für diese Fastify-Instanz genutzten Speichers.
