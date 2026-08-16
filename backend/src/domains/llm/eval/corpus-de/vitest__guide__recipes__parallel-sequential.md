# Parallele und sequenzielle Testdateien

Die meisten Testdateien sind unabhängig voneinander und laufen parallel schneller. Die Ausnahme sind jene wenigen, die sich eine exklusive Ressource teilen, etwa einen festen Port, ein beschreibbares Temp-Verzeichnis oder eine Datenbank ohne Isolation pro Test. Solche Dateien werden instabil, wenn andere Tests nebenläufig dazu laufen.

Die Parallelität global zu deaktivieren würde jeden Test der Suite verlangsamen. Teilt man die Suite in zwei [`projects`](/guide/projects) auf – ein paralleles und ein sequenzielles –, zahlen nur die betroffenen Dateien den Preis.

## Muster

```ts [vitest.config.ts]
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'Parallel',
          exclude: ['**.sequential.test.ts'],
        },
      },
      {
        test: {
          name: 'Sequential',
          include: ['**.sequential.test.ts'],
          fileParallelism: false,
        },
      },
    ],
  },
})
```

[`fileParallelism: false`](/config/fileparallelism) auf Projektebene lässt den Rest deiner Suite weiterhin nebenläufig laufen, während die passenden Dateien einzeln nacheinander ausgeführt werden. Es ist eine Kurzform für [`maxWorkers: 1`](/config/maxworkers); die beiden Einstellungen sind gleichwertig.

## Sequenziell nach parallel ausführen

Standardmäßig laufen Projekte parallel zueinander, sodass die erste Datei des sequenziellen Projekts sich mit parallelen Dateien überlappen kann, die dieselbe Ressource noch halten. Verwende [`sequence.groupOrder`](/config/sequence#sequence-grouporder) <Version>3.2.0</Version>, um zu erzwingen, dass der parallele Durchlauf zuerst abgeschlossen wird:

```ts [vitest.config.ts]
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'Parallel',
          exclude: ['**.sequential.test.ts'],
          sequence: { groupOrder: 0 },
        },
      },
      {
        test: {
          name: 'Sequential',
          include: ['**.sequential.test.ts'],
          fileParallelism: false,
          sequence: { groupOrder: 1 },
        },
      },
    ],
  },
})
```

Der parallele Durchlauf endet, *dann* startet der sequenzielle. Die gesamte Laufzeit bleibt nahe an der parallelen Zeit plus der Summe der sequenziellen Testlaufzeiten.

## Dateiebene vs. Testebene

In Vitest gibt es zwei verschiedene Stellschrauben für „parallel“. Verwechsle sie nicht:

| Ebene | Stellschraube | Steuert |
| --- | --- | --- |
| Über Dateien hinweg | [`fileParallelism`](/config/fileparallelism) | Ob zwei Test*dateien* in parallelen Workern laufen |
| Innerhalb einer Datei | `describe.concurrent` / `test.concurrent` | Ob Tests *innerhalb einer Datei* nebenläufig laufen |

`fileParallelism: false` macht Tests innerhalb einer Datei nicht nebenläufig; Tests innerhalb einer Datei laufen standardmäßig sequenziell. Und `concurrent` an einem `describe` oder `test` beeinflusst nicht, wie Dateien eingeplant werden.

## Siehe auch

- [`fileParallelism`](/config/fileparallelism)
- [`maxWorkers`](/config/maxworkers)
- [`sequence.groupOrder`](/config/sequence#sequence-grouporder)
- [Parallelität](/guide/parallelism)
- [Test-Projekte](/guide/projects)
- [Isolationseinstellungen pro Datei](/guide/recipes/disable-isolation)
