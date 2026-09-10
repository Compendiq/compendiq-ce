# Globals mocken

Globale Variablen, die unter `jsdom` oder `node` nicht vorhanden sind, kannst du mit dem Helper [`vi.stubGlobal`](/api/vi#vi-stubglobal) mocken. Er legt den Wert der globalen Variable im Objekt `globalThis` ab.

Standardmäßig setzt Vitest diese Globals nicht zurück. Du kannst jedoch in deiner Konfiguration die Option [`unstubGlobals`](/config/unstubglobals) aktivieren, um die ursprünglichen Werte nach jedem Test wiederherzustellen, oder [`vi.unstubAllGlobals()`](/api/vi#vi-unstuballglobals) manuell aufrufen.

```ts
import { vi } from 'vitest'

const IntersectionObserverMock = vi.fn(class {
  disconnect = vi.fn()
  observe = vi.fn()
  takeRecords = vi.fn()
  unobserve = vi.fn()
})

vi.stubGlobal('IntersectionObserver', IntersectionObserverMock)

// now you can access it as `IntersectionObserver` or `window.IntersectionObserver`
```
