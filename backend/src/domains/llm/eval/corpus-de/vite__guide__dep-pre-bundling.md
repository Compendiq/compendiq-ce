# Vorab-Bündelung von Abhängigkeiten

Wenn du `vite` zum ersten Mal ausführst, bündelt Vite die Abhängigkeiten deines Projekts vorab, bevor deine Seite lokal geladen wird. Das geschieht standardmäßig automatisch und transparent.

## Das Warum

Vite führt hier das aus, was wir "Dependency Pre-Bundling" nennen. Dieser Vorgang erfüllt zwei Zwecke:

1. **Kompatibilität mit CommonJS und UMD:** Während der Entwicklung liefert Vite sämtlichen Code als natives ESM aus. Daher muss Vite Abhängigkeiten, die als CommonJS oder UMD ausgeliefert werden, zunächst nach ESM konvertieren.

   Beim Konvertieren von CommonJS-Abhängigkeiten führt Vite eine intelligente Import-Analyse durch, sodass benannte Imports von CommonJS-Modulen wie erwartet funktionieren, selbst wenn die Exporte dynamisch zugewiesen werden (z. B. bei React):

   ```js
   // works as expected
   import React, { useState } from 'react'
   ```

2. **Performance:** Vite fasst ESM-Abhängigkeiten mit vielen internen Modulen zu einem einzigen Modul zusammen, um die Ladezeit nachfolgender Seitenaufrufe zu verbessern.

   Manche Pakete liefern ihre ES-Modul-Builds als viele einzelne Dateien aus, die sich gegenseitig importieren. Zum Beispiel hat [`lodash-es` über 600 interne Module](https://unpkg.com/browse/lodash-es/)! Wenn wir `import { debounce } from 'lodash-es'` schreiben, feuert der Browser über 600 HTTP-Requests gleichzeitig ab! Auch wenn der Server damit problemlos umgehen kann, erzeugt die große Zahl an Requests auf der Browserseite eine Netzwerküberlastung, wodurch die Seite spürbar langsamer lädt.

   Indem wir `lodash-es` vorab zu einem einzigen Modul bündeln, brauchen wir stattdessen nur noch einen einzigen HTTP-Request!

::: tip HINWEIS
Das Pre-Bundling von Abhängigkeiten gilt nur im Entwicklungsmodus.
:::

## Automatische Erkennung von Abhängigkeiten

Wenn kein bestehender Cache gefunden wird, durchsucht Vite deinen Quellcode und erkennt automatisch Abhängigkeits-Imports (also "bare imports", die aus `node_modules` aufgelöst werden sollen) und verwendet diese gefundenen Imports als Einstiegspunkte für das Pre-Bundling. Das Pre-Bundling wird mit [Rolldown](https://rolldown.rs/) durchgeführt und ist daher typischerweise sehr schnell.

Wenn nach dem Start des Servers ein neuer Abhängigkeits-Import auftaucht, der noch nicht im Cache liegt, führt Vite den Bündelungsvorgang erneut aus und lädt die Seite bei Bedarf neu.

## Monorepos und verlinkte Abhängigkeiten

In einem Monorepo-Setup kann eine Abhängigkeit ein verlinktes Paket aus demselben Repository sein. Vite erkennt automatisch Abhängigkeiten, die nicht aus `node_modules` aufgelöst werden, und behandelt die verlinkte Abhängigkeit als Quellcode. Es versucht nicht, die verlinkte Abhängigkeit zu bündeln, sondern analysiert stattdessen deren Abhängigkeitsliste.

Das setzt allerdings voraus, dass die verlinkte Abhängigkeit als ESM exportiert wird. Falls nicht, kannst du die Abhängigkeit in deiner Konfiguration zu [`optimizeDeps.include`](/config/dep-optimization-options.md#optimizedeps-include) hinzufügen.

```js twoslash [vite.config.js]
import { defineConfig } from 'vite'
// ---cut---
export default defineConfig({
  optimizeDeps: {
    include: ['linked-dep'],
  },
})
```

Wenn du Änderungen an der verlinkten Abhängigkeit vornimmst, starte den Dev-Server mit der Kommandozeilenoption `--force` neu, damit die Änderungen wirksam werden.

## Das Verhalten anpassen

Die standardmäßigen Heuristiken zur Erkennung von Abhängigkeiten sind nicht immer wünschenswert. Wenn du Abhängigkeiten explizit in die Liste aufnehmen oder aus ihr ausschließen möchtest, verwende die [`optimizeDeps`-Konfigurationsoptionen](/config/dep-optimization-options.md).

Ein typischer Anwendungsfall für `optimizeDeps.include` oder `optimizeDeps.exclude` ist ein Import, der im Quellcode nicht direkt auffindbar ist. Vielleicht entsteht der Import zum Beispiel erst durch eine Plugin-Transformation. Das bedeutet, dass Vite den Import beim ersten Scan nicht entdecken kann — es findet ihn erst, nachdem die Datei vom Browser angefordert und transformiert wurde. Dadurch bündelt der Server unmittelbar nach dem Start erneut.

Sowohl `include` als auch `exclude` können hier helfen. Ist die Abhängigkeit groß (mit vielen internen Modulen) oder CommonJS, solltest du sie einschließen; ist die Abhängigkeit klein und bereits gültiges ESM, kannst du sie ausschließen und den Browser sie direkt laden lassen.

Du kannst außerdem Rolldown selbst über die [Option `optimizeDeps.rolldownOptions`](/config/dep-optimization-options.md#optimizedeps-rolldownoptions) weiter anpassen. Zum Beispiel, indem du ein Rolldown-Plugin hinzufügst, das spezielle Dateien in Abhängigkeiten verarbeitet, oder indem du das [Build-`target`](https://rolldown.rs/reference/InputOptions.transform#target) änderst.

## Caching

### Dateisystem-Cache

Vite legt die vorab gebündelten Abhängigkeiten in `node_modules/.vite` ab. Ob der Pre-Bundling-Schritt erneut ausgeführt werden muss, entscheidet Vite anhand einiger Quellen:

- Inhalt der Lockfile des Paketmanagers, z. B. `package-lock.json`, `yarn.lock`, `pnpm-lock.yaml`, `bun.lock`, `aube-lock.yaml` oder `nub.lock`.
- Änderungszeitpunkt des Patches-Ordners.
- Relevante Felder in deiner `vite.config.js`, sofern vorhanden.
- Wert von `NODE_ENV`.

Der Pre-Bundling-Schritt muss nur dann erneut ausgeführt werden, wenn sich einer der obigen Punkte geändert hat.

Wenn du Vite aus irgendeinem Grund zwingen möchtest, die Abhängigkeiten neu zu bündeln, kannst du entweder den Dev-Server mit der Kommandozeilenoption `--force` starten oder das Cache-Verzeichnis `node_modules/.vite` manuell löschen.

### Browser-Cache

Aufgelöste Abhängigkeits-Requests werden mit den HTTP-Headern `max-age=31536000,immutable` stark gecacht, um die Performance beim Neuladen der Seite während der Entwicklung zu verbessern. Einmal gecacht, erreichen diese Requests den Dev-Server nie wieder. Sie werden automatisch über die angehängte Versions-Query invalidiert, sobald eine andere Version installiert ist (wie in der Lockfile deines Paketmanagers abgebildet). Wenn du deine Abhängigkeiten durch lokale Änderungen debuggen möchtest, kannst du:

1. Den Cache vorübergehend über den Netzwerk-Tab der Browser-Devtools deaktivieren.
2. Den Vite-Dev-Server mit dem Flag `--force` neu starten, um die Abhängigkeiten neu zu bündeln.
3. Die Seite neu laden.
