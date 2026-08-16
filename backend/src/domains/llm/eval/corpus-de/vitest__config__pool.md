# pool

- **Typ:** `'threads' | 'forks' | 'vmThreads' | 'vmForks'`
- **Standard:** `'forks'`
- **CLI:** `--pool=threads`

Der Pool, in dem die Tests ausgeführt werden.

## threads

Aktiviert Multithreading. Bei der Verwendung von Threads kannst du keine prozessbezogenen APIs wie `process.chdir()` nutzen. Einige in nativen Sprachen geschriebene Bibliotheken wie `Prisma`, `bcrypt` und `canvas` haben Probleme, wenn sie in mehreren Threads laufen, und laufen in Segfaults. In diesen Fällen empfiehlt es sich, stattdessen den `forks`-Pool zu verwenden.

## forks

Ähnlich wie der `threads`-Pool, verwendet jedoch `child_process` statt `worker_threads`. Die Kommunikation zwischen Tests und Hauptprozess ist nicht so schnell wie beim `threads`-Pool. Prozessbezogene APIs wie `process.chdir()` sind im `forks`-Pool verfügbar.

## vmThreads

Führt Tests über einen [VM-Kontext](https://nodejs.org/api/vm.html) (in einer Sandbox-Umgebung) in einem `threads`-Pool aus.

Dadurch laufen Tests schneller, aber das VM-Modul ist bei der Ausführung von [ESM-Code](https://github.com/nodejs/node/issues/37648) instabil. Deine Tests werden [Speicher lecken](https://github.com/nodejs/node/issues/33439) – dem wird begegnet, indem Worker neu gestartet werden, sobald sie [`vmMemoryLimit`](/config/vmmemorylimit) überschreiten.

::: warning Das Recycling von Workern ist in `vmThreads` teuer
Einen Worker-Thread neu zu starten, ist nicht kostenlos: Node.js führt eine vollständige Garbage Collection über alles aus, was der Worker angesammelt hat, bevor der Thread beendet werden kann, und diese Arbeit läuft auf einem kleinen Pool von Hintergrund-Threads, den sich alle Worker im Prozess teilen. Wenn eine große Test-Suite wiederholt an [`vmMemoryLimit`](/config/vmmemorylimit) stößt, häufen sich diese Teardowns und bremsen zusätzlich die Worker aus, die noch Tests ausführen.

Der `vmForks`-Pool recycelt Worker, indem er den Child-Prozess beenden lässt, und das Betriebssystem gibt den Speicher frei. Ist deine Test-Suite groß genug, dass Worker recycelt werden, ist `vmForks` in der Regel spürbar schneller als `vmThreads`, obwohl seine Kommunikation mit dem Hauptprozess langsamer ist.
:::

Ab Node.js 24.9 wird `require()` eines ES-Moduls innerhalb von VM-Pools unterstützt, analog zu [Nodes eigenem `require(esm)`](https://nodejs.org/api/modules.html#loading-ecmascript-modules-using-require). Der Aufruf von `require()` auf einem ES-Modul, dessen Graph ein Top-Level-`await` enthält, wirft `ERR_REQUIRE_ASYNC_MODULE` – verwende für solche Dateien `await import()`.

::: warning
Code in einer Sandbox auszuführen hat einige Vorteile (schnellere Tests), bringt aber auch eine Reihe von Nachteilen mit sich.

- Die Globals innerhalb nativer Module wie (`fs`, `path` usw.) unterscheiden sich von den Globals in deiner Testumgebung. Dadurch verweist jeder von diesen nativen Modulen geworfene Fehler auf einen anderen Error-Konstruktor als den, der in deinem Code verwendet wird:

```ts
try {
  fs.writeFileSync('/does-not-exist')
}
catch (err) {
  console.log(err instanceof Error) // false
}
```

- Der Import von ES-Modulen cacht diese unbegrenzt, was zu Memory Leaks führt, wenn du viele Kontexte (Testdateien) hast. Es gibt in Node.js keine API, die diesen Cache leert.
- Der Zugriff auf Globals [dauert länger](https://github.com/nodejs/node/issues/31658) in einer Sandbox-Umgebung.

Bitte sei dir dieser Probleme bewusst, wenn du diese Option verwendest. Das Vitest-Team kann keines dieser Probleme auf unserer Seite beheben.
:::

## vmForks

Ähnlich wie der `vmThreads`-Pool, verwendet jedoch `child_process` statt `worker_threads`. Die Kommunikation zwischen Tests und Hauptprozess ist nicht so schnell wie beim `vmThreads`-Pool. Prozessbezogene APIs wie `process.chdir()` sind im `vmForks`-Pool verfügbar. Beachte bitte, dass dieser Pool dieselben Fallstricke hat, die bei `vmThreads` aufgeführt sind.

Anders als bei `vmThreads` erfordert das Recyceln eines Workers, der [`vmMemoryLimit`](/config/vmmemorylimit) überschritten hat, lediglich das Beenden des Child-Prozesses und ist damit deutlich günstiger. Bei großen Test-Suites, die regelmäßig Worker recyceln, ist `vmForks` gegenüber `vmThreads` vorzuziehen.
