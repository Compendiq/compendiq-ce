# detectAsyncLeaks

- **Typ:** `boolean`
- **CLI:** `--detectAsyncLeaks`, `--detect-async-leaks`
- **Standard:** `false`

::: warning
Das Aktivieren dieser Option verlangsamt deine Tests erheblich. Verwende sie nur beim Debuggen oder beim Entwickeln von Tests.
:::

Erkennt asynchrone Ressourcen, die aus der Testdatei herauslecken.
Verwendet [`node:async_hooks`](https://nodejs.org/api/async_hooks.html), um die Erzeugung asynchroner Ressourcen nachzuverfolgen. Wird eine Ressource nicht aufgeräumt, wird sie nach dem Ende der Tests protokolliert.

Wenn dein Code beispielsweise `setTimeout`-Aufrufe enthält, deren Callback erst nach dem Ende der Tests ausgeführt wird, siehst du folgenden Fehler:

```sh
⎯⎯⎯⎯⎯⎯⎯⎯ Async Leaks 1 ⎯⎯⎯⎯⎯⎯⎯⎯

Timeout leaking in test/checkout-screen.test.tsx
 26|
 27|   useEffect(() => {
 28|     setTimeout(() => setWindowWidth(window.innerWidth), 150)
   |     ^
 29|   })
 30|
```

Um das zu beheben, musst du sicherstellen, dass dein Code den Timeout ordentlich aufräumt:

```js
useEffect(() => {
  setTimeout(setWindowWidth, 150, window.innerWidth) // [!code --]
  const timeout = setTimeout(setWindowWidth, 150, window.innerWidth) // [!code ++]

  return function cleanup() { // [!code ++]
    clearTimeout(timeout) // [!code ++]
  } // [!code ++]
})
```
