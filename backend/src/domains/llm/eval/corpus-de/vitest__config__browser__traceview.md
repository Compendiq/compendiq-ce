# browser.traceView <Badge type="warning" text="Experimentell" /> <Version>5.0.0</Version>

- **Typ:** `boolean | { enabled?: boolean; recordCanvas?: boolean; inlineImages?: boolean }`
- **CLI:** `--browser.traceView`
- **Standard:** `false`

Aktiviert das Sammeln von Trace-View-Daten für Browser-Tests. Vitest erfasst DOM-Snapshots für Browser-Interaktionen und kann sie in der Browser-UI, der Vitest-UI oder im HTML-Reporter anzeigen, sofern diese Oberflächen aktiviert sind – externe Werkzeuge sind nicht erforderlich.

```ts
export default defineConfig({
  test: {
    browser: {
      traceView: true,
    },
  },
})
```

Verwende die Objektform, um zusätzliche Optionen für die Snapshot-Genauigkeit zu aktivieren:

```ts
export default defineConfig({
  test: {
    browser: {
      traceView: {
        enabled: true,
        inlineImages: true,
        recordCanvas: true,
      },
    },
  },
})
```

| Option | Standard | Beschreibung |
| --- | --- | --- |
| `enabled` | `false` | Aktiviert das Sammeln von Vitest-Trace-View-Artefakten. |
| `inlineImages` | `false` | Bettet die Pixel geladener `<img>`-Elemente in die Snapshots ein, damit das Replay portabler wird – nützlich im HTML-Reporter. |
| `recordCanvas` | `false` | Erfasst Canvas-Pixel in den Snapshots. |

## browser.traceView.enabled {#traceview-enabled}

- **Typ:** `boolean`
- **Standard:** `false`
- **CLI:** `--browser.traceView.enabled`

Aktiviert das Sammeln von Vitest-Trace-View-Artefakten.

## browser.traceView.inlineImages {#traceview-inlineimages}

- **Typ:** `boolean`
- **Standard:** `false`
- **CLI:** `--browser.traceView.inlineImages`

Bettet die Pixel geladener `<img>`-Elemente in die Snapshots ein, damit das Replay portabler wird – nützlich im HTML-Reporter.

## browser.traceView.recordCanvas {#traceview-recordcanvas}

- **Typ:** `boolean`
- **Standard:** `false`
- **CLI:** `--browser.traceView.recordCanvas`

Erfasst Canvas-Pixel in den Snapshots. Das aktiviert eine schwächere Replay-Iframe-Sandbox, weil rrweb Skripte benötigt, um Canvas-Daten neu zu zeichnen.

Die vollständige Dokumentation findest du unter [Trace View](/guide/browser/trace-view).
