# vitest-browser-svelte

Das Community-Paket [`vitest-browser-svelte`](https://npmx.dev/package/vitest-browser-svelte) rendert [Svelte](https://svelte.dev/)-Komponenten im [Browser-Modus](/guide/browser/).

```ts
import { render } from 'vitest-browser-svelte'
import { expect, test } from 'vitest'
import Component from './Component.svelte'

test('counter button increments the count', async () => {
  const screen = await render(Component, {
    initialCount: 1,
  })

  await screen.getByRole('button', { name: 'Increment' }).click()

  await expect.element(screen.getByText('Count is 2')).toBeVisible()
})
```

::: warning
Diese Bibliothek ist von [`@testing-library/svelte`](https://github.com/testing-library/svelte-testing-library) inspiriert.

Wenn du `@testing-library/svelte` bisher in deinen Tests verwendet hast, kannst du dabei bleiben. Das Paket `vitest-browser-svelte` bietet allerdings bestimmte Vorteile, die nur im Browser-Modus existieren und `@testing-library/svelte` fehlen:

`vitest-browser-svelte` gibt APIs zurück, die gut mit den eingebauten [Locators](/api/browser/locators), [User Events](/api/browser/interactivity) und [Assertions](/api/browser/assertions) zusammenspielen: Vitest wiederholt zum Beispiel automatisch den Zugriff auf das Element, bis die Assertion erfolgreich ist — selbst wenn es zwischen den Assertions neu gerendert wurde.
:::

Das Paket bietet zwei Einstiegspunkte: `vitest-browser-svelte` und `vitest-browser-svelte/pure`. Sie stellen dieselbe API bereit, aber der Einstiegspunkt `pure` registriert keinen Handler, der die Komponente vor dem Start des nächsten Tests entfernt.

## render

```ts
export function render<C extends Component>(
  Component: ComponentImport<C>,
  options?: ComponentOptions<C>,
  renderOptions?: SetupOptions
): Promise<RenderResult<C>>
```

Die Funktion `render` zeichnet eine Trace-Markierung `svelte.render` auf, die in der [Trace View](/guide/browser/trace-view) sichtbar ist.

### Optionen

Die Funktion `render` akzeptiert entweder Optionen, die du an [`mount`](https://svelte.dev/docs/svelte/imperative-component-api#mount) weiterreichen kannst, oder direkt Props:

```ts
const screen = await render(Component, {
  props: { // [!code --]
    initialCount: 1, // [!code --]
  }, // [!code --]
  initialCount: 1, // [!code ++]
})
```

#### props

Die Props der Komponente.

#### target

Standardmäßig erzeugt Vitest ein `div`, hängt es an `document.body` an und rendert deine Komponente dort. Wenn du deinen eigenen `HTMLElement`-Container bereitstellst, wird dieser nicht automatisch angehängt — du musst vor `render` selbst `document.body.appendChild(container)` aufrufen.

Wenn du zum Beispiel ein `tbody`-Element als Unit testest, kann es kein Kind eines `div` sein. In diesem Fall kannst du eine `table` als Render-Container angeben.

```ts
const table = document.createElement('table')

const screen = await render(TableBody, {
  props,
  // ⚠️ appending the element to `body` manually before rendering
  target: document.body.appendChild(table),
})
```

#### baseElement

Dies kann in einem dritten Argument übergeben werden. Du wirst diese Option nur selten, wenn überhaupt, brauchen.

Wenn `target` angegeben ist, entspricht dies standardmäßig diesem Wert, ansonsten `document.body`. Es dient als Basiselement für die Queries und ist außerdem das, was bei Verwendung von `debug()` ausgegeben wird.

### Render-Ergebnis

Zusätzlich zum dokumentierten Rückgabewert liefert die Funktion `render` auch alle verfügbaren [Locators](/api/browser/locators) relativ zum [`baseElement`](#baseelement), einschließlich [eigener Locators](/api/browser/locators#custom-locators).

```ts
const screen = await render(TableBody, props)

await screen.getByRole('link', { name: 'Expand' }).click()
```

#### container

Der umschließende DOM-Knoten, in dem deine Svelte-Komponente gerendert wird. Das ist ein gewöhnlicher DOM-Knoten, du könntest also technisch gesehen `container.querySelector` usw. aufrufen, um die Kinder zu untersuchen.

:::danger
Wenn du merkst, dass du `container` verwendest, um nach gerenderten Elementen zu suchen, solltest du das überdenken! Die [Locators](/api/browser/locators) sind darauf ausgelegt, robuster gegenüber Änderungen an der getesteten Komponente zu sein. Vermeide es, `container` zum Suchen von Elementen zu verwenden!
:::

#### component

Die gemountete Instanz der Svelte-Komponente. Darüber kannst du bei Bedarf auf Methoden und Eigenschaften der Komponente zugreifen.

```ts
const { component } = await render(Counter, {
  initialCount: 0,
})

// Access component exports if needed
```

#### locator

Der [Locator](/api/browser/locators) deines `container`. Er ist nützlich, um Queries nur auf deine Komponente einzugrenzen oder ihn an andere Assertions weiterzureichen:

```ts
import { render } from 'vitest-browser-svelte'

const { locator } = await render(NumberDisplay, {
  number: 2,
})

await locator.getByRole('button').click()
await expect.element(locator).toHaveTextContent('Hello World')
```

#### debug

```ts
function debug(
  el?: HTMLElement | HTMLElement[] | Locator | Locator[],
): void
```

Diese Methode ist eine Abkürzung für `console.log(prettyDOM(baseElement))`. Sie gibt den DOM-Inhalt des Containers oder der angegebenen Elemente auf der Konsole aus.

#### rerender

```ts
function rerender(props: Partial<ComponentProps<T>>): Promise<void>
```

Aktualisiert die Props der Komponente und wartet, bis Svelte die Änderungen angewendet hat. Damit testest du, wie deine Komponente auf Prop-Änderungen reagiert. Zeichnet außerdem eine Trace-Markierung `svelte.rerender` in der [Trace View](/guide/browser/trace-view) auf.

```ts
import { render } from 'vitest-browser-svelte'

const { rerender } = await render(NumberDisplay, {
  number: 1,
})

// re-render the same component with different props
await rerender({ number: 2 })
```

#### unmount

```ts
function unmount(): Promise<void>
```

Hängt die Svelte-Komponente aus und zerstört sie. Zeichnet außerdem eine Trace-Markierung `svelte.unmount` in der [Trace View](/guide/browser/trace-view) auf. Das ist nützlich, um zu testen, was passiert, wenn deine Komponente von der Seite entfernt wird (etwa um zu prüfen, dass keine Event-Handler zurückbleiben und Speicherlecks verursachen).

```ts
import { render } from 'vitest-browser-svelte'

const { container, unmount } = await render(Component)
await unmount()
// your component has been unmounted and now: container.innerHTML === ''
```

## cleanup

```ts
export function cleanup(): void
```

Entfernt alle mit [`render`](#render) gerenderten Komponenten.

## Queries erweitern

Um Locator-Queries zu erweitern, siehe [`"Custom Locators"`](/api/browser/locators#custom-locators). Wenn `render` zum Beispiel einen neuen eigenen Locator zurückgeben soll, definiere ihn über die API `locators.extend`:

```ts {5-7,12}
import { locators } from 'vitest/browser'
import { render } from 'vitest-browser-svelte'

locators.extend({
  getByArticleTitle(title) {
    return `[data-title="${title}"]`
  },
})

const screen = await render(Component)
await expect.element(
  screen.getByArticleTitle('Hello World')
).toBeVisible()
```

## Snippets

Für einfache Snippets kannst du eine Wrapper-Komponente und "Dummy"-Children verwenden, um sie zu testen. Das Setzen von `data-testid`-Attributen kann beim Testen von Slots auf diese Weise hilfreich sein.

::: code-group
```ts [basic.test.js]
import { render } from 'vitest-browser-svelte'
import { expect, test } from 'vitest'

import SubjectTest from './basic-snippet.test.svelte'

test('basic snippet', async () => {
  const screen = await render(SubjectTest)

  const heading = screen.getByRole('heading')
  const child = heading.getByTestId('child')

  await expect.element(child).toBeInTheDocument()
})
```
```svelte [basic-snippet.svelte]
<script>
  let { children } = $props()
</script>

<h1>
  {@render children?.()}
</h1>
```
```svelte [basic-snippet.test.svelte]
<script>
  import Subject from './basic-snippet.svelte'
</script>

<Subject>
  <span data-testid="child"></span>
</Subject>
```
:::

Für komplexere Snippets, bei denen du zum Beispiel Argumente prüfen möchtest, kannst du Svelte's API [`createRawSnippet`](https://svelte.dev/docs/svelte/svelte#createRawSnippet) verwenden.

::: code-group
```js [complex-snippet.test.js]
import { render } from 'vitest-browser-svelte'
import { createRawSnippet } from 'svelte'
import { expect, test } from 'vitest'

import Subject from './complex-snippet.svelte'

test('renders greeting in message snippet', async () => {
  const screen = await render(Subject, {
    name: 'Alice',
    message: createRawSnippet(greeting => ({
      render: () => `<span data-testid="message">${greeting()}</span>`,
    })),
  })

  const message = screen.getByTestId('message')

  await expect.element(message).toHaveTextContent('Hello, Alice!')
})
```
```svelte [complex-snippet.svelte]
<script>
  let { name, message } = $props()

  const greeting = $derived(`Hello, ${name}!`)
</script>

<p>
  {@render message?.(greeting)}
</p>
```
:::

## Siehe auch

- [Dokumentation der Svelte Testing Library](https://testing-library.com/docs/svelte-testing-library/intro)
- [Beispiele der Svelte Testing Library](https://github.com/testing-library/svelte-testing-library/tree/main/examples)
