# typecheck <Experimental /> {#typecheck}

Optionen zur Konfiguration der Testumgebung für die [Typprüfung](/guide/testing-types).

## typecheck.enabled {#typecheck-enabled}

- **Typ:** `boolean`
- **Standard:** `false`
- **CLI:** `--typecheck`, `--typecheck.enabled`

Aktiviert die Typprüfung parallel zu deinen regulären Tests.

## typecheck.only {#typecheck-only}

- **Typ:** `boolean`
- **Standard:** `false`
- **CLI:** `--typecheck.only`

Führt nur Typprüfungstests aus, wenn die Typprüfung aktiviert ist. Bei Verwendung über die CLI aktiviert diese Option die Typprüfung automatisch.

## typecheck.checker

- **Typ:** `'tsc' | 'vue-tsc' | string`
- **Standard:** `tsc`

Legt fest, welche Werkzeuge für die Typprüfung verwendet werden. Vitest startet je nach Typ einen Prozess mit bestimmten Parametern, um das Parsen zu erleichtern. Der Checker sollte dasselbe Ausgabeformat wie `tsc` implementieren.

Für den Typechecker muss ein Paket installiert sein:

- `tsc` benötigt das Paket `typescript`
- `vue-tsc` benötigt das Paket `vue-tsc`

Du kannst auch einen Pfad zu einer eigenen Binary oder einen Befehlsnamen übergeben, der dieselbe Ausgabe wie `tsc --noEmit --pretty false` erzeugt.

## typecheck.include

- **Typ:** `string[]`
- **Standard:** `['**/*.{test,spec}-d.?(c|m)[jt]s?(x)']`

Glob-Muster für Dateien, die als Testdateien behandelt werden sollen.

## typecheck.exclude

- **Typ:** `string[]`
- **Standard:** `['**/node_modules/**', '**/dist/**', '**/cypress/**', '**/.{idea,git,cache,output,temp}/**']`

Glob-Muster für Dateien, die nicht als Testdateien behandelt werden sollen.

## typecheck.allowJs

- **Typ:** `boolean`
- **Standard:** `false`

Prüft JS-Dateien, die einen `@ts-check`-Kommentar enthalten. Ist die Option bereits in der tsconfig aktiviert, wird sie dadurch nicht überschrieben.

## typecheck.ignoreSourceErrors

- **Typ:** `boolean`
- **Standard:** `false`

Schlägt nicht fehl, wenn Vitest Fehler außerhalb der Testdateien findet. Nicht-Test-Fehler werden dir dadurch überhaupt nicht angezeigt.

Standardmäßig lässt Vitest die Test-Suite fehlschlagen, wenn es einen Fehler im Quellcode findet.

## typecheck.tsconfig

- **Typ:** `string`
- **Standard:** _versucht, die nächstgelegene tsconfig.json zu finden_

Pfad zu einer eigenen tsconfig, relativ zum Projekt-Root.

## typecheck.spawnTimeout

- **Typ:** `number`
- **Standard:** `10_000`

Mindestzeit in Millisekunden, die das Starten des Typecheckers dauert.
