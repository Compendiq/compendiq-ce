<h1 align="center">Fastify</h1>

## Long Term Support
<a id="lts"></a>

Der Long Term Support (LTS) von Fastify richtet sich nach dem in diesem Dokument
festgelegten Zeitplan:

1. Major-Releases, also das „X“ der [semantischen Versionierung][semver] in
   X.Y.Z-Releaseversionen, werden ab ihrem Veröffentlichungsdatum mindestens
   sechs Monate lang unterstützt. Das Veröffentlichungsdatum einer bestimmten
   Version finden Sie unter
   [https://github.com/fastify/fastify/releases](https://github.com/fastify/fastify/releases).
2. Major-Releases erhalten ab der Veröffentlichung des nächsten Major-Releases
   weitere sechs Monate lang Sicherheitsupdates. Nach diesem Zeitraum werden die
   Fastify-Maintainer Sicherheitskorrekturen weiterhin prüfen und veröffentlichen,
   solange sie von der Community bereitgestellt werden und keine anderen
   Randbedingungen verletzen, z. B. die minimal unterstützte Node.js-Version.
3. Major-Releases werden gegen alle Node.js-Release-Linien getestet und
   verifiziert, die innerhalb des LTS-Zeitraums der jeweiligen Fastify-Release-Linie
   von der [Node.js-LTS-Policy](https://github.com/nodejs/Release) unterstützt
   werden. Das bedeutet, dass jeweils nur das neueste Node.js-Release einer Linie
   unterstützt wird.
4. Zusätzlich zur Node.js-Laufzeitumgebung werden Major-Releases von Fastify auch
   gegen alternative, zu Node.js kompatible Laufzeitumgebungen getestet und
   verifiziert. Die Maintainer-Teams dieser alternativen Laufzeitumgebungen sind
   dafür verantwortlich, sicherzustellen und zu gewährleisten, dass diese Tests
   ordnungsgemäß funktionieren.
   1. [N|Solid](https://docs.nodesource.com/docs/product_suite/) testet und
      verifiziert jedes Fastify-Major-Release gegen die aktuellen N|Solid-LTS-Versionen.
      NodeSource stellt die Kompatibilität von Fastify mit N|Solid sicher und richtet
      sich dabei nach dem Supportumfang der N|Solid-LTS-Versionen zum Zeitpunkt des
      Fastify-Releases. Damit können N|Solid-Nutzer Fastify bedenkenlos einsetzen.

Ein „Monat“ ist definiert als 30 aufeinanderfolgende Tage.

> ## Sicherheitsreleases und Semver
>
> Da für Major-Releases Long Term Support angeboten wird, kommt es gelegentlich
> vor, dass Breaking Changes als _Minor_-Version veröffentlicht werden müssen.
> Solche Änderungen werden _immer_ in den [Release
> Notes](https://github.com/fastify/fastify/releases) dokumentiert.
>
> Um zu vermeiden, dass Sie brechende Sicherheitsupdates automatisch erhalten,
> können Sie den Tilde-Bereichsqualifizierer (`~`) verwenden. Um beispielsweise
> Patches für das 3.15-Release zu bekommen und nicht automatisch auf das
> 3.16-Release zu aktualisieren, geben Sie die Abhängigkeit als
> `"fastify": "~3.15.x"` an. Damit bleibt Ihre Anwendung verwundbar. Setzen Sie
> diesen Ansatz mit Bedacht ein.

### Sicherheitssupport über LTS hinaus

Der Fastify-Partner HeroDevs bietet über das OpenJS Ecosystem Sustainability
Program kommerziellen Sicherheitssupport für Fastify-Versionen an, die das
Ende ihrer Lebensdauer erreicht haben. Weitere Informationen finden Sie beim
angebotenen Dienst [Never Ending Support][hd-link].

### Zeitplan
<a id="lts-schedule"></a>

| Version | Releasedatum | Ende des LTS-Zeitraums | Node.js            | Nsolid(Node)   |
| :------ | :----------- | :--------------------- | :----------------- | :------------- |
| 1.0.0   | 2018-03-06   | 2019-09-01             | 6, 8, 9, 10, 11    |                |
| 2.0.0   | 2019-02-25   | 2021-01-31             | 6, 8, 10, 12, 14   |                |
| 3.0.0   | 2020-07-07   | 2023-06-30             | 10, 12, 14, 16, 18 | v5(18)         |
| 4.0.0   | 2022-06-08   | 2025-06-30             | 14, 16, 18, 20, 22 | v5(18), v5(20) |
| 5.0.0   | 2024-09-17   | offen                  | 20, 22             | v5(20)         |

### In der CI getestete Betriebssysteme
<a id="supported-os"></a>

Fastify nutzt GitHub Actions für CI-Tests. Details dazu, welches die aktuellste
virtuelle Umgebung in Bezug auf die unten stehenden YAML-Workflow-Labels ist,
finden Sie in [GitHubs Dokumentation zu
Workflow-Runnern](https://docs.github.com/en/actions/reference/runners/github-hosted-runners#supported-runners-and-hardware-resources):

| OS      | YAML-Workflow-Label | Paketmanager    | Node.js     | Nsolid(Node)  |
| ------- | ------------------- | --------------- | ----------- | ------------- |
| Linux   | `ubuntu-latest`     | npm             | 20          | v5(20)        |
| Linux   | `ubuntu-latest`     | yarn,pnpm       | 20          | v5(20)        |
| Windows | `windows-latest`    | npm             | 20          | v5(20)        |
| MacOS   | `macos-latest`      | npm             | 20          | v5(20)        |

Bei Verwendung von [yarn](https://yarnpkg.com/) kann das Flag `--ignore-engines` erforderlich sein.

[semver]: https://semver.org/

[hd-link]: https://www.herodevs.com/support/fastify-nes?utm_source=fastify&utm_medium=link&utm_campaign=eol_support_fastify
