# vitest-browser-react

Das Community-Paket [`vitest-browser-react`](https://npmx.dev/package/vitest-browser-react) rendert [React](https://react.dev/)-Komponenten im [Browser-Modus](/guide/browser/).

```jsx
import { render } from 'vitest-browser-react'
import { expect, test } from 'vitest'
import Component from './Component.jsx'

test('counter button increments the count', async () => {
  const screen = await render(<Component count={1} />)

  await screen.getByRole('button', { name: 'Increment' }).click()

  await expect.element(screen.getByText('Count is 2')).toBeVisible()
})
```

::: warning
Diese Bibliothek ist von [`@testing-library/react`](https://github.com/testing-library/react-testing-library) inspiriert.

Wenn du `@testing-library/react` bisher in deinen Tests verwendet hast, kannst du es weiterhin nutzen; das Paket `vitest-browser-react` bietet jedoch bestimmte Vorteile, die dem Browser-Modus eigen sind und die `@testing-library/react` fehlen:

`vitest-browser-react` gibt APIs zurück, die gut mit den eingebauten [Locators](/api/browser/locators), [User Events](/api/browser/interactivity) und [Assertions](/api/browser/assertions) zusammenspielen: Vitest wiederholt zum Beispiel automatisch den Zugriff auf das Element, bis die Assertion erfolgreich ist, selbst wenn es zwischen den Assertions neu gerendert wurde.
:::

Das Paket stellt zwei Einstiegspunkte bereit: `vitest-browser-react` und `vitest-browser-react/pure`. Sie bieten eine nahezu identische API (`pure` stellt zusätzlich `configure` bereit), aber der Einstiegspunkt `pure` registriert keinen Handler, der die Komponente vor dem Start des nächsten Tests entfernt.

## render

```ts
export function render(
  ui: React.ReactNode,
  options?: ComponentRenderOptions,
): Promise<RenderResult>
```

Die Funktion `render` zeichnet eine Trace-Markierung `react.render` auf, die in der [Trace View](/guide/browser/trace-view) sichtbar ist.

:::warning
Beachte, dass `render` anders als in anderen Paketen asynchron ist. Das dient dazu, [`Suspense`](https://react.dev/reference/react/Suspense) korrekt zu unterstützen.

```tsx
import { render } from 'vitest-browser-react'
const screen = render(<Component />) // [!code --]
const screen = await render(<Component />) // [!code ++]
```
:::

### Optionen

#### container

Standardmäßig erstellt Vitest ein `div`, hängt es an `document.body` an und rendert deine Komponente dort. Wenn du deinen eigenen `HTMLElement`-Container übergibst, wird dieser nicht automatisch angehängt – du musst `document.body.appendChild(container)` vor `render` aufrufen.

Wenn du zum Beispiel ein `tbody`-Element unit-testest, kann dieses kein Kind eines `div` sein. In diesem Fall kannst du ein `table` als Render-Container angeben.

```jsx
const table = document.createElement('table')

const { container } = await render(<TableBody {...props} />, {
  // ⚠️ appending the element to `body` manually before rendering
  container: document.body.appendChild(table),
})
```

#### baseElement

Ist der `container` angegeben, ist dies standardmäßig dieser Container, andernfalls standardmäßig `document.body`. Es wird als Basiselement für die Queries verwendet sowie als das, was bei Verwendung von `debug()` ausgegeben wird.

#### wrapper

Übergib eine React-Komponente als Option `wrapper`, damit sie um das innere Element herum gerendert wird. Das ist besonders nützlich, um wiederverwendbare eigene Render-Funktionen für gängige Daten-Provider zu erstellen. Zum Beispiel:

```jsx
import React from 'react'
import { render } from 'vitest-browser-react'
import { ThemeProvider } from 'my-ui-lib'
import { TranslationProvider } from 'my-i18n-lib'

function AllTheProviders({ children }) {
  return (
    <ThemeProvider theme="light">
      <TranslationProvider>
        {children}
      </TranslationProvider>
    </ThemeProvider>
  )
}

export function customRender(ui, options) {
  return render(ui, { wrapper: AllTheProviders, ...options })
}
```

### Render-Ergebnis

Zusätzlich zum dokumentierten Rückgabewert gibt die Funktion `render` auch alle verfügbaren [Locators](/api/browser/locators) relativ zum [`baseElement`](#baseelement) zurück, einschließlich [eigener](/api/browser/locators#custom-locators).

```tsx
const screen = await render(<TableBody {...props} />)

await screen.getByRole('link', { name: 'Expand' }).click()
```

#### container

Der umgebende `div`-DOM-Knoten deines gerenderten React-Elements (gerendert mit `ReactDOM.render`). Das ist ein regulärer DOM-Knoten, du könntest also technisch `container.querySelector` usw. aufrufen, um die Kinder zu untersuchen.

:::danger
Wenn du dich dabei ertappst, `container` zum Abfragen gerenderter Elemente zu verwenden, solltest du das überdenken! Die [Locators](/api/browser/locators) sind darauf ausgelegt, robuster gegenüber Änderungen an der getesteten Komponente zu sein. Verwende `container` nicht, um Elemente abzufragen!
:::

#### baseElement

Der umgebende DOM-Knoten, in dem dein React-Element im `container` gerendert wird. Wenn du `baseElement` in den Optionen von render nicht angibst, ist es standardmäßig `document.body`.

Das ist nützlich, wenn die zu testende Komponente etwas außerhalb des `container`-`div` rendert, z. B. wenn du deine Portal-Komponente per Snapshot testen willst, die ihr HTML direkt im Body rendert.

:::tip
Die von `render` zurückgegebenen Queries schauen in `baseElement`, du kannst die Queries also verwenden, um deine Portal-Komponente ohne das `baseElement` zu testen.
:::

#### locator

Der [Locator](/api/browser/locators) deines `container`. Er ist nützlich, um Queries zu verwenden, die nur auf deine Komponente beschränkt sind, oder um ihn an andere Assertions weiterzureichen:

```jsx
import { render } from 'vitest-browser-react'

const { locator } = await render(<NumberDisplay number={1} />)

await locator.getByRole('button').click()
await expect.element(locator).toHaveTextContent('Hello World')
```

#### debug

```ts
function debug(
  el?: HTMLElement | HTMLElement[] | Locator | Locator[],
  maxLength?: number,
  options?: PrettyDOMOptions,
): void
```

Diese Methode ist eine Abkürzung für `console.log(prettyDOM(baseElement))`. Sie gibt den DOM-Inhalt des Containers oder der angegebenen Elemente auf der Konsole aus.

#### rerender

```ts
function rerender(ui: React.ReactNode): Promise<void>
```

Zeichnet außerdem eine Trace-Markierung `react.rerender` in der [Trace View](/guide/browser/trace-view) auf.

Es ist besser, die Komponente zu testen, die die Props aktualisiert, um sicherzustellen, dass die Props korrekt aktualisiert werden, und um zu vermeiden, dass sich deine Tests auf Implementierungsdetails stützen. Wenn du dennoch die Props einer gerenderten Komponente in deinem Test aktualisieren möchtest, kann diese Funktion dazu verwendet werden, die Props der gerenderten Komponente zu aktualisieren.

```jsx
import { render } from 'vitest-browser-react'

const { rerender } = await render(<NumberDisplay number={1} />)

// re-render the same component with different props
await rerender(<NumberDisplay number={2} />)
```

#### unmount

```ts
function unmount(): Promise<void>
```

Zeichnet außerdem eine Trace-Markierung `react.unmount` in der [Trace View](/guide/browser/trace-view) auf.

Dies bewirkt, dass die gerenderte Komponente unmountet wird. Das ist nützlich, um zu testen, was passiert, wenn deine Komponente von der Seite entfernt wird (etwa um zu prüfen, dass du keine Event-Handler zurücklässt, die Speicherlecks verursachen).

```jsx
import { render } from 'vitest-browser-react'

const { container, unmount } = await render(<Login />)
await unmount()
// your component has been unmounted and now: container.innerHTML === ''
```

#### asFragment

```ts
function asFragment(): DocumentFragment
```

Gibt ein `DocumentFragment` deiner gerenderten Komponente zurück. Das kann nützlich sein, wenn du Live-Bindings vermeiden und sehen möchtest, wie deine Komponente auf Events reagiert.

## cleanup

```ts
export function cleanup(): Promise<void>
```

Entfernt alle mit [`render`](#render) gerenderten Komponenten.

## renderHook

```ts
export function renderHook<Props, Result>(
  renderCallback: (initialProps?: Props) => Result,
  options: RenderHookOptions<Props>,
): Promise<RenderHookResult<Result, Props>>
```

Dies ist ein praktischer Wrapper um `render` mit einer eigenen Test-Komponente. Die API entstand aus einem verbreiteten Testmuster und ist vor allem für Bibliotheken interessant, die Hooks veröffentlichen. Du solltest `render` bevorzugen, da eine eigene Test-Komponente zu lesbareren und robusteren Tests führt, weil das, was du testen willst, nicht hinter einer Abstraktion versteckt ist.

```jsx
import { renderHook } from 'vitest-browser-react'

test('returns logged in user', async () => {
  const { result } = await renderHook(() => useLoggedInUser())
  expect(result.current).toEqual({ name: 'Alice' })
})
```

### Optionen

`renderHook` akzeptiert dieselben Optionen wie [`render`](#render), ergänzt um `initialProps`:

Damit werden die Props deklariert, die beim ersten Aufruf an den Render-Callback übergeben werden. Diese werden nicht übergeben, wenn du `rerender` ohne Props aufrufst.

```jsx
import { renderHook } from 'vitest-browser-react'

test('returns logged in user', async () => {
  const { result, rerender } = await renderHook((props = {}) => props, {
    initialProps: { name: 'Alice' },
  })
  expect(result.current).toEqual({ name: 'Alice' })
  await rerender()
  expect(result.current).toEqual({ name: undefined })
})
```

:::warning
Wenn du `renderHook` zusammen mit den Optionen `wrapper` und `initialProps` verwendest, werden die `initialProps` nicht an die `wrapper`-Komponente übergeben. Um der `wrapper`-Komponente Props bereitzustellen, ziehe eine Lösung wie diese in Betracht:

```jsx
function createWrapper(Wrapper, props) {
  return function CreatedWrapper({ children }) {
    return <Wrapper {...props}>{children}</Wrapper>
  }
}

// ...

await renderHook(() => {}, {
  wrapper: createWrapper(Wrapper, { value: 'foo' }),
})
```
:::

`renderHook` gibt einige nützliche Methoden und Eigenschaften zurück:

### Render-Hook-Ergebnis

#### result

Enthält den zuletzt committeten Rückgabewert des Render-Callbacks:

```jsx
import { useState } from 'react'
import { renderHook } from 'vitest-browser-react'
import { expect } from 'vitest'

const { result } = await renderHook(() => {
  const [name, setName] = useState('')
  React.useEffect(() => {
    setName('Alice')
  }, [])

  return name
})

expect(result.current).toBe('Alice')
```

Beachte, dass der Wert in `result.current` gehalten wird. Stell dir `result` als [Ref](https://react.dev/learn/referencing-values-with-refs) auf den zuletzt committeten Wert vor.

#### rerender {#renderhooks-rerender}

Rendert den zuvor gerenderten Render-Callback mit den neuen Props:

```jsx
import { renderHook } from 'vitest-browser-react'

const { rerender } = await renderHook(({ name = 'Alice' } = {}) => name)

// re-render the same hook with different props
await rerender({ name: 'Bob' })
```

#### unmount {#renderhooks-unmount}

Unmountet den Test-Hook.

```jsx
import { renderHook } from 'vitest-browser-react'

const { unmount } = await renderHook(({ name = 'Alice' } = {}) => name)

await unmount()
```

## Queries erweitern

Um Locator-Queries zu erweitern, siehe [`"Custom Locators"`](/api/browser/locators#custom-locators). Um zum Beispiel `render` einen neuen eigenen Locator zurückgeben zu lassen, definiere ihn über die API `locators.extend`:

```jsx {5-7,12}
import { locators } from 'vitest/browser'
import { render } from 'vitest-browser-react'

locators.extend({
  getByArticleTitle(title) {
    return `[data-title="${title}"]`
  },
})

const screen = await render(<Component />)
await expect.element(
  screen.getByArticleTitle('Hello World')
).toBeVisible()
```

## Konfiguration

Du kannst mit der Methode `configure` aus `vitest-browser-react/pure` festlegen, ob die Komponente im Strict Mode gerendert werden soll:

```js
import { configure } from 'vitest-browser-react/pure'

configure({
  // disabled by default
  reactStrictMode: true,
})
```

## Siehe auch

- [Dokumentation der React Testing Library](https://testing-library.com/docs/react-testing-library/intro)
