# Vitest UI

Angetrieben von Vite hat Vitest beim Ausführen der Tests auch einen Dev-Server unter der Haube. Dadurch kann Vitest eine schöne UI bereitstellen, um Ihre Tests anzusehen und mit ihnen zu interagieren. Die Vitest UI ist optional, Sie müssen sie also installieren mit:

```bash
npm i -D @vitest/ui
```

Anschließend können Sie die Tests mit UI starten, indem Sie das Flag `--ui` übergeben:

```bash
vitest --ui
```

Danach erreichen Sie die Vitest UI unter <a href="http://localhost:51204/__vitest__/">`http://localhost:51204/__vitest__/`</a>

::: tip
Der Zugriff auf die Vitest UI ist geschützt. Falls die direkte URL einen Fehler anzeigt, öffnen Sie die URL mit einem Token, das Vitest im Terminal ausgibt, zum Beispiel `http://localhost:51204/__vitest__/?token=...`.
:::

::: warning
Die UI ist interaktiv und benötigt einen laufenden Vite-Server, führen Sie Vitest also im `watch`-Modus aus (der Standard). Alternativ können Sie einen statischen HTML-Report erzeugen, der identisch zur Vitest UI aussieht, indem Sie `html` in der Option `reporters` der Konfiguration angeben.
:::

<img alt="Vitest UI" img-light src="/ui-1-light.png">
<img alt="Vitest UI" img-dark src="/ui-1-dark.png">

Die UI kann auch als Reporter verwendet werden. Nutzen Sie den Reporter `'html'` in Ihrer Vitest-Konfiguration, um HTML-Ausgaben zu erzeugen und die Ergebnisse Ihrer Tests anzusehen:

```ts [vitest.config.ts]
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    reporters: ['html'],
  },
})
```

Ihren Coverage-Report können Sie in der Vitest UI einsehen: Details unter [Vitest UI Coverage](/guide/coverage#vitest-ui).

::: warning
Wenn Sie zusätzlich in Echtzeit im Terminal sehen möchten, wie Ihre Tests laufen, ergänzen Sie die Option `reporters` um `configDefaults.reporters`: `['html', ...configDefaults.reporters]`.
:::

::: tip
Um Ihren HTML-Report anzusehen, können Sie den Befehl [vite preview](https://vitejs.dev/guide/cli.html#vite-preview) verwenden:

```sh
npx vite preview --outDir .vitest
```

Den Ausgabeort können Sie über die Option `outputDir` des HTML-Reporters konfigurieren. Sie verweist auf das Wurzelverzeichnis des Report-Artefakts; der Einstiegspunkt des Reports wird nach `<outputDir>/index.html` geschrieben. Der Standardwert ist `.vitest`, das gemeinsame Artefaktverzeichnis von Vitest.
:::

Wenn Sie einen portablen Report benötigen, der sich als eine einzelne Datei öffnen oder weitergeben lässt, siehe [`singleFile`](/guide/reporters#html-reporter) in der Dokumentation des HTML-Reporters.

::: tip
Um den HTML-Report aus der CI heraus anzusehen, etwa in GitHub Actions, laden Sie das Ausgabeverzeichnis als Artefakt hoch:

```yaml
- uses: actions/upload-artifact@v7
  id: upload-report
  with:
    name: vitest-report
    path: .vitest/

- name: Viewer link in summary
  run: echo "[View HTML report](https://viewer.vitest.dev/?url=${{ steps.upload-report.outputs.artifact-url }})" >> $GITHUB_STEP_SUMMARY
```

Das fügt der Job-Zusammenfassung einen Link hinzu. Klicken Sie darauf, um den Report direkt im Browser im [Vitest Viewer](https://viewer.vitest.dev/) zu öffnen. Sie können das Artefakt auch manuell herunterladen, entpacken und dann wie oben lokal `vite preview` ausführen.

Wenn Sie `singleFile: true` verwenden, können Sie den Report als eine einzelne Datei hochladen, und er wird mit der Option `archive: false` direkt in den GitHub-Artefakten ansehbar:

```yaml
- uses: actions/upload-artifact@v7
  with:
    path: .vitest/index.html
    archive: false
```
:::

## Modulgraph

Der Tab „Module Graph“ zeigt den Modulgraphen der ausgewählten Testdatei.

::: info
Alle gezeigten Bilder verwenden das Repository [Zammad](https://github.com/zammad/zammad) als Beispiel.
:::

<img alt="The module graph view" img-light src="/ui/light-module-graph.png">
<img alt="The module graph view" img-dark src="/ui/dark-module-graph.png">

Bei mehr als 50 Modulen zeigt der Modulgraph nur die ersten beiden Ebenen des Graphen, um die visuelle Unruhe zu reduzieren. Sie können jederzeit auf das Symbol „Show Full Graph“ klicken, um den vollständigen Graphen anzusehen.

<center>
  <img alt="The 'Show Full Graph' button located close to the legend" img-light src="/ui/light-ui-show-graph.png">
  <img alt="The 'Show Full Graph' button located close to the legend" img-dark src="/ui/dark-ui-show-graph.png">
</center>

::: warning
Beachten Sie: Ist Ihr Graph zu groß, kann es eine Weile dauern, bis sich die Knotenpositionen stabilisiert haben.
:::

Den ursprünglichen Modulgraphen stellen Sie jederzeit durch Klick auf „Reset“ wieder her. Um den Modulgraphen zu erweitern, klicken Sie mit der rechten Maustaste oder halten Sie <kbd>Shift</kbd> gedrückt, während Sie auf den Knoten klicken, der Sie interessiert. Dadurch werden alle mit dem ausgewählten Knoten verbundenen Knoten angezeigt.

Standardmäßig zeigt Vitest die Module aus `node_modules` nicht an. Üblicherweise werden diese Module externalisiert. Sie können sie einblenden, indem Sie „Hide node_modules“ abwählen.

### Modulinformationen

Mit einem Linksklick auf den Modulknoten öffnen Sie die Ansicht „Module Info“.

<img alt="The module info view for an inlined module" img-light src="/ui/light-module-info.png">
<img alt="The module info view for an inlined module" img-dark src="/ui/dark-module-info.png">

Diese Ansicht ist in zwei Teile gegliedert. Der obere Teil zeigt die vollständige Modul-ID und einige Diagnosen zum Modul. Ist [`fsModuleCache`](/config/fsmodulecache) aktiviert, erscheint ein Badge „cached“ oder „not cached“. Rechts sehen Sie Zeitdiagnosen:

- Self Time: die Zeit, die der Import des Moduls gedauert hat, ohne statische Importe.
- Total Time: die Zeit, die der Import des Moduls gedauert hat, inklusive statischer Importe. Beachten Sie, dass hierin die `transform`-Zeit des aktuellen Moduls nicht enthalten ist.
- Transform: die Zeit, die die Transformation des Moduls gedauert hat.

Wenn Sie diese Ansicht durch Klick auf einen Import geöffnet haben, sehen Sie am Anfang außerdem einen „Back“-Button, der Sie zum vorherigen Modul zurückbringt.

Der untere Teil hängt vom Modultyp ab. Ist das Modul extern, sehen Sie nur den Quellcode dieser Datei. Sie können den Modulgraphen dann nicht weiter durchlaufen und sehen nicht, wie lange der Import statischer Importe gedauert hat.

<img alt="The module info view for an external module" img-light src="/ui/light-module-info-external.png">
<img alt="The module info view for an external module" img-dark src="/ui/dark-module-info-external.png">

Wurde das Modul inline eingebunden, sehen Sie drei weitere Fenster:

- Source: der unveränderte Quellcode des Moduls
- Transformed: der transformierte Code, den Vitest über Vites [Module Runner](https://vite.dev/guide/api-environment-runtimes#modulerunner) ausführt
- Source Map (v3): die Mappings der Source Map

Alle statischen Importe im Fenster „Source“ zeigen die Gesamtzeit, die das aktuelle Modul für deren Auswertung benötigt hat. Wurde der Import im Modulgraphen bereits ausgewertet, wird `0ms` angezeigt, da er zu diesem Zeitpunkt gecacht ist.

Hat das Laden des Moduls länger gedauert als der [`danger`-Schwellwert](/config/experimental#experimental-importdurations-thresholds) (Standard: 500 ms), wird die Zeit rot dargestellt. Hat es länger gedauert als der [`warn`-Schwellwert](/config/experimental#experimental-importdurations-thresholds) (Standard: 100 ms), wird die Zeit orange dargestellt.

Sie können auf eine Importquelle klicken, um in dieses Modul zu springen und den Graphen weiter zu durchlaufen (beachten Sie `./support/assertions/index.ts` unten).

<img alt="The module info view for an internal module" img-light src="/ui/light-module-info-traverse.png">
<img alt="The module info view for an internal module" img-dark src="/ui/dark-module-info-traverse.png">

::: warning
Beachten Sie, dass reine Typimporte zur Laufzeit nicht ausgeführt werden und keine Gesamtdauer anzeigen. Sie lassen sich auch nicht öffnen.
:::

Wenn ein anderes Plugin während der Transformation einen Modulimport einfügt, werden diese Importe am Anfang des Moduls in grauer Farbe angezeigt (zum Beispiel Module, die von `import.meta.glob` eingefügt werden). Auch sie zeigen die Gesamtzeit und lassen sich weiter durchlaufen.

<img alt="The module info view for an internal module" img-light src="/ui/light-module-info-shadow.png">
<img alt="The module info view for an internal module" img-dark src="/ui/dark-module-info-shadow.png">

::: tip
Wenn Sie eine eigene Integration auf Basis von Vitest entwickeln, können Sie [`vitest.experimental_getSourceModuleDiagnostic`](/api/advanced/vitest#getsourcemodulediagnostic) verwenden, um diese Informationen abzurufen.
:::

### Import-Aufschlüsselung

::: tip FEEDBACK
Bitte hinterlassen Sie Feedback zu diesem Feature in einer [GitHub-Diskussion](https://github.com/vitest-dev/vitest/discussions/9224).
:::

Der Tab „Module Graph“ bietet außerdem eine Import-Aufschlüsselung mit einer Liste der Module, deren Laden am längsten dauert (standardmäßig die Top 10), sortiert nach Total Time.

<img alt="Import breakdown with a list of top 10 modules that take the longest time to load" img-light src="/ui/light-import-breakdown.png">
<img alt="Import breakdown with a list of top 10 modules that take the longest time to load" img-dark src="/ui/dark-import-breakdown.png">

Sie können auf das Modul klicken, um die Modulinformationen zu sehen. Ist das Modul extern, wird es gelb dargestellt (dieselbe Farbe wie im Modulgraphen).

Die Aufschlüsselung zeigt eine Liste von Modulen mit Self Time, Total Time und einem Prozentwert relativ zur Zeit, die das Laden der gesamten Testdatei gedauert hat.

Das Symbol „Show Import Breakdown“ wird rot dargestellt, wenn mindestens eine Datei länger als der [`danger`-Schwellwert](/config/experimental#experimental-importdurations-thresholds) (Standard: 500 ms) zum Laden gebraucht hat, und orange, wenn mindestens eine Datei länger als der [`warn`-Schwellwert](/config/experimental#experimental-importdurations-thresholds) (Standard: 100 ms) gebraucht hat.

Mit [`experimental.importDurations.limit`](/config/experimental#experimental-importdurationslimit) steuern Sie die Anzahl der angezeigten Importe.
