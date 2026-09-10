# Automatisches Aufräumen mit `using`

Spies und Mocks müssen nach dem Test, der sie installiert hat, wiederhergestellt werden, sonst leckt Zustand zwischen den Tests. Die üblichen Ansätze sind ein `afterEach(() => vi.restoreAllMocks())` auf Suite-Ebene oder ein [`onTestFinished(() => spy.mockRestore())`](/api/hooks#ontestfinished) direkt im jeweiligen Test.

Wenn deine Laufzeitumgebung [Explicit Resource Management](https://github.com/tc39/proposal-explicit-resource-management) unterstützt (Node.js 24+ oder über TypeScript 5.2+ in modernen Bundlern), gibt es eine kompaktere Möglichkeit: Deklariere den Spy mit `using` statt mit `const` – die Wiederherstellung erfolgt dann automatisch, sobald der Block verlassen wird.

Das funktioniert für [`vi.spyOn`](/api/vi#vi-spyon), [`vi.fn`](/api/vi#vi-fn) und [`vi.doMock`](/api/vi#vi-domock). <Version>3.2.0</Version>

## Muster

```ts
import { expect, it, vi } from 'vitest'

function debug(message: string) {
  console.log(message)
}

it('calls console.log', () => {
  using spy = vi.spyOn(console, 'log').mockImplementation(() => {})
  debug('message')
  expect(spy).toHaveBeenCalled()
})

// console.log is restored here without an afterEach
```

Dasselbe Muster funktioniert mit `vi.doMock`, das ein Disposable zurückgibt, welches beim Verlassen des Scopes ein Unmock einreiht:

```ts
import { expect, it, vi } from 'vitest'

it('uses the mocked module, then the real one', async () => {
  {
    using _mock = vi.doMock('./users', () => ({
      loadUser: () => ({ id: '1', name: 'Alice' }),
    }))
    const { loadUser } = await import('./users')
    expect(loadUser('alice').name).toBe('Alice')
  }

  // ./users is unmocked from here on
})
```

## Auf beliebige Blöcke begrenzt

`using` ist blockbezogen, du kannst einen Spy also nur für einen Teil eines Tests installieren. Genau diesen Fall decken weder `afterEach` noch `onTestFinished` ab, da beide erst nach dem Ende des Tests laufen:

```ts
import { expect, it, vi } from 'vitest'

it('only mocks fetch for the auth call', async () => {
  // real fetch here
  await preloadConfig()

  {
    using fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('{"ok":true}'))

    await login('alice', 'secret')
    expect(fetchSpy).toHaveBeenCalledOnce()
  }

  // real fetch is back
  await reportSuccess()
})
```

Das ist außerdem eine Möglichkeit, die globale Konfiguration [`restoreMocks: true`](/config/restoremocks) nicht aktivieren zu müssen, wenn tatsächlich nur eine Handvoll Aufrufe wiederhergestellt werden muss.

## Kompatibilität

`using` setzt Unterstützung für den TC39-Vorschlag Explicit Resource Management voraus:

- TypeScript ≥ 5.2 (mit `target: 'es2022'` oder höher und standardmäßig eingebundener `disposable`-Lib).
- Node.js ≥ 24 (oder Node 22+ mit Flags im Stil von `--harmony`) für native Laufzeitunterstützung.

Falls deine Umgebung das noch nicht unterstützt, ist [`onTestFinished`](/api/hooks#ontestfinished) das nächstliegende Äquivalent für das Aufräumen eines gesamten Tests: Es registriert das Aufräumen direkt inline und läuft nach dem Ende des Tests, unabhängig davon, ob er bestanden oder fehlgeschlagen ist:

```ts
import { expect, it, onTestFinished, vi } from 'vitest'

it('calls console.log', () => {
  const spy = vi.spyOn(console, 'log').mockImplementation(() => {})
  onTestFinished(() => spy.mockRestore())

  debug('message')
  expect(spy).toHaveBeenCalled()
})
```

`onTestFinished` kann einen Spy nicht mitten im Test abbauen, wie `using` es kann; das blockbezogene Muster oben bleibt daher spezifisch für ERM.

## Siehe auch

- [`vi.spyOn`](/api/vi#vi-spyon)
- [`vi.fn`](/api/vi#vi-fn)
- [`vi.doMock`](/api/vi#vi-domock)
- [`onTestFinished`](/api/hooks#ontestfinished)
- [`restoreMocks`](/config/restoremocks)
- [TC39-Vorschlag Explicit Resource Management](https://github.com/tc39/proposal-explicit-resource-management)
