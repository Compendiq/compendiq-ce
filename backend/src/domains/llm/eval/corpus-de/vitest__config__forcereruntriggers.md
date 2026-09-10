# forceRerunTriggers <CRoot />

- **Typ:** `string[]`
- **Standard:** `['**/package.json', '**/vitest.config.*', '**/vite.config.*']`

Glob-Muster von Dateipfaden, die einen erneuten Lauf der gesamten Suite auslösen. In Kombination mit dem Argument `--changed` wird die gesamte Test-Suite ausgeführt, wenn der Auslöser im Git-Diff gefunden wird.

Nützlich, wenn Sie den Aufruf von CLI-Befehlen testen, da Vite in diesem Fall keinen Modulgraphen aufbauen kann:

```ts
test('execute a script', async () => {
  // Vitest cannot rerun this test, if content of `dist/index.js` changes
  await execa('node', ['dist/index.js'])
})
```

::: tip
Stellen Sie sicher, dass Ihre Dateien nicht durch [`server.watch.ignored`](https://vitejs.dev/config/server-options.html#server-watch) ausgeschlossen werden.
:::
