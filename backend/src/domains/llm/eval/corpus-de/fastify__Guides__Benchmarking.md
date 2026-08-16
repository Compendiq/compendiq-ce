<h1 align="center">Fastify</h1>

## Benchmarking
Benchmarking ist wichtig, wenn Sie messen möchten, wie sich eine Änderung auf die Leistung Ihrer Anwendung auswirken kann. Wir bieten eine einfache Möglichkeit, Ihre Anwendung aus Sicht eines Benutzers und Mitwirkenden zu benchmarken. Die Einrichtung ermöglicht es Ihnen, Benchmarks in verschiedenen Branches und mit unterschiedlichen Node.js-Versionen zu automatisieren.

Die Module, die wir verwenden werden:
- [Autocannon](https://github.com/mcollina/autocannon): Ein HTTP/1.1 Benchmarking-Tool, geschrieben in node.
- [Branch-comparer](https://github.com/StarpTech/branch-comparer): Checkt mehrere git Branches aus, führt Skripte aus und protokolliert die Ergebnisse.
- [Concurrently](https://github.com/open-cli-tools/concurrently): Führt Befehle gleichzeitig aus.
- [Npx](https://github.com/npm/npx): NPM Package Runner, der verwendet wird, um Skripte gegen verschiedene Node.js-Versionen auszuführen und lokale Binaries auszuführen. Mit npm@5.2.0 mitgeliefert.

## Einfach

### Test im aktuellen Branch ausführen
```sh
npm run benchmark
```
### Führe den Test gegen verschiedene Node.js-Versionen aus ✨
```sh
npx -p node@10 -- npm run benchmark
```
## Fortgeschritten

### Test in verschiedenen Branches ausführen
```sh
branchcmp --rounds 2 --script "npm run benchmark"
```
### Führe den Test in verschiedenen Branches gegen verschiedene Node.js-Versionen aus ✨
```sh
branchcmp --rounds 2 --script "npm run benchmark"
```
### Aktuellen Branch mit main vergleichen (Gitflow)
```sh
branchcmp --rounds 2 --gitflow --script "npm run benchmark"
```
oder
```sh
npm run bench
```
### Verschiedene Beispiele ausführen
```sh
branchcmp --rounds 2 -s "node ./node_modules/concurrently -k -s first \"node ./examples/asyncawait.js\" \"node ./node_modules/autocannon -c 100 -d 5 -p 10 localhost:3000/\""
```
<!-- markdownlint-enable -->