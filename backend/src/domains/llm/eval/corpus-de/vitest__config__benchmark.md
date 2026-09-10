# benchmark <Experimental /> {#benchmark}

- **Typ:** `{ include?, exclude?, ... }`

Optionen, die beim Ausführen von `vitest bench` verwendet werden.

## benchmark.enabled

- **Typ:** `boolean`
- **Standard:** `false`

Aktiviert das Benchmark-Projekt. Ist die Option gesetzt, legt Vitest neben deinem regulären Testprojekt ein eigenes Benchmark-Projekt an, führt darin die auf [`benchmark.include`](#benchmark-include) passenden Dateien aus und stellt diesen Dateien die [`bench`-Fixture](/guide/test-context#bench) bereit. Der Aufruf von `vitest bench` aktiviert dies automatisch.

## benchmark.include

- **Typ:** `string[]`
- **Standard:** `['**/*.{bench,benchmark}.?(c|m)[jt]s?(x)']`

Include-Globs für Benchmark-Testdateien

## benchmark.exclude

- **Typ:** `string[]`
- **Standard:** `['node_modules', 'dist', '.idea', '.git', '.cache']`

Exclude-Globs für Benchmark-Testdateien

## benchmark.includeSource

- **Typ:** `string[]`
- **Standard:** `[]`

Include-Globs für In-Source-Benchmark-Testdateien. Diese Option ähnelt [`includeSource`](/config/include-source).

Ist sie definiert, führt Vitest alle passenden Dateien aus, die `import.meta.vitest` enthalten.

## benchmark.retainSamples

- **Typ:** `boolean`
- **Standard:** `false`

Nimmt in jedes Benchmark-Ergebnis das `samples`-Array mit den Zeitmessungen pro Iteration auf. Standardmäßig deaktiviert, um den Speicherverbrauch zu senken; aktiviere es, wenn ein eigener Reporter oder ein API-Konsument die Rohdaten benötigt.

## benchmark.provider

- **Typ:** `string`
- **Standard:** `undefined` (verwendet den eingebauten Provider)

Der Benchmark-Provider, der die registrierten Benchmarks ausführt und ihre Ergebnisse zurückgibt. Setze dies auf einen Modulpfad, dessen Default-Export `BenchmarkProvider` implementiert. Relative Pfade werden ausgehend vom Projekt-Root aufgelöst.

Einrichtungshinweise und die Provider-API findest du im Leitfaden [Custom Benchmark Provider](/guide/advanced/benchmark-provider).

## benchmark.suppressExportGetterWarnings

- **Typ:** `boolean`
- **Standard:** `false`

Unterdrückt die Warnung, die ausgegeben wird, wenn ein Benchmark zu häufig auf Getter von Modul-Exporten zugreift. Vitest verfolgt Getter-Zugriffe während Benchmark-Läufen, weil Vites Module Runner jeden Export in einen Getter einpackt und übermäßige Zugriffe die Messung dominieren können (siehe [Module Runner Overhead](/guide/benchmarking#module-runner-overhead)). Aktiviere dies, wenn du den Overhead bewusst in Kauf nimmst oder wenn die Warnung bei Benchmarks stört, in denen die Getter-Kosten vernachlässigbar sind.
