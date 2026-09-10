# vmMemoryLimit

- **Typ:** `string | number`
- **Standard:** `1 / maxWorkers`

Diese Option betrifft nur die Pools `vmForks` und `vmThreads`.

Legt das Speicherlimit für Worker fest, ab dem sie recycelt werden.

Standardmäßig wird der gesamte Systemspeicher gleichmäßig auf die Worker aufgeteilt. Wenn Sie [`maxWorkers`](/config/maxworkers) erhöhen, steht den Workern weniger Speicher zur Verfügung, sodass sie häufiger recycelt werden.

Dieser Wert hängt stark von Ihrer Umgebung ab, daher ist es besser, ihn manuell anzugeben, statt sich auf den Standardwert zu verlassen.

Das Recycling existiert, weil VM-Kontexte [Speicher lecken](https://github.com/nodejs/node/issues/33439): Der Speicherverbrauch eines Workers wächst mit jeder Testdatei, die er ausführt, sodass ein Worker nicht ewig leben kann. Das Limit ist ein Kompromiss:

- Ein niedriges Limit recycelt Worker häufig. Im Pool `vmThreads` ist das teuer, weil das Zerstören eines Worker-Threads eine vollständige Garbage Collection über den Speicher des Workers ausführt und mit laufenden Tests um die gemeinsam genutzten Hintergrund-Threads des Prozesses konkurriert. Der Pool `vmForks` recycelt Worker, indem er den Kindprozess beenden lässt, wodurch häufiges Recycling dort deutlich günstiger ist.
- Ein hohes Limit lässt Worker Speicher ansammeln. Wenn der kombinierte Speicherverbrauch aller Worker sich dem nähert, was die Maschine fassen kann, wird jeder Pool langsamer.

::: tip
Die Implementierung basiert auf Jests [`workerIdleMemoryLimit`](https://jestjs.io/docs/configuration#workeridlememorylimit-numberstring).

Das Limit kann auf verschiedene Arten angegeben werden; auf das Ergebnis wird jeweils `Math.floor` angewendet, um daraus einen Ganzzahlwert zu machen:

- `<= 1` – Der Wert wird als Prozentsatz des Systemspeichers interpretiert. 0.5 setzt das Speicherlimit des Workers also auf die Hälfte des gesamten Systemspeichers
- `\> 1` – Wird als fester Byte-Wert interpretiert. Wegen der vorherigen Regel müssten Sie für einen Wert von 1 Byte (ich weiß nicht, warum) 1.1 verwenden.
- Mit Einheiten
  - `50%` – Wie oben, ein Prozentsatz des gesamten Systemspeichers
  - `100KB`, `65MB` usw. – Mit Einheiten zur Angabe eines festen Speicherlimits.
    - `K` / `KB` – Kilobyte (x1000)
    - `KiB` – Kibibyte (x1024)
    - `M` / `MB` – Megabyte
    - `MiB` – Mebibyte
    - `G` / `GB` – Gigabyte
    - `GiB` – Gibibyte
:::

::: warning
Ein prozentual angegebenes Speicherlimit [funktioniert auf Linux-CircleCI-Workern nicht](https://github.com/jestjs/jest/issues/11956#issuecomment-1212925677), weil dort der Systemspeicher falsch gemeldet wird.
:::
