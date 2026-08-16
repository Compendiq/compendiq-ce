# vitest-browser-vue

Das Community-Paket [`vitest-browser-vue`](https://npmx.dev/package/vitest-browser-vue) rendert [Vue](https://vuejs.org/)-Komponenten im [Browser-Modus](/guide/browser/).

```ts
import { render } from 'vitest-browser-vue'
import { expect, test } from 'vitest'
import Component from './Component.vue'

test('counter button increments the count', async () => {
  const screen = await render(Component, {
    props: {
      initialCount: 1,
    }
  })

  await screen.getByRole('button', { name: 'Increment' }).click()

  await expect.element(screen.getByText('Count is 2')).toBeVisible()
})
```

::: warning
Diese Bibliothek ist von [`@testing-library/vue`](https://github.com/testing-library/vue-testing-library) inspiriert.

Wenn du `@testing-library/vue` bisher in deinen Tests verwendet hast, kannst du dabei bleiben. Das Paket `vitest-browser-vue` bietet allerdings bestimmte Vorteile, die nur im Browser-Modus existieren und `@testing-library/vue` fehlen:

`vitest-browser-vue` gibt APIs zurück, die gut mit den eingebauten [Locators](/api/browser/locators), [User Events](/api/browser/interactivity) und [Assertions](/api/browser/assertions) zusammenspielen: Vitest wiederholt zum Beispiel automatisch den Zugriff auf das Element, bis die Assertion erfolgreich ist — selbst wenn es zwischen den Assertions neu gerendert wurde.
:::

Das Paket bietet zwei Einstiegspunkte: `vitest-browser-vue` und `vitest-browser-vue/pure`. Sie stellen dieselbe API bereit, aber der Einstiegspunkt `pure` registriert keinen Handler, der die Komponente vor dem Start des nächsten Tests entfernt.

## render

```ts
export function render(
  component: Component,
  options?: ComponentRenderOptions,
): Promise<RenderResult>
```

Die Funktion `render` zeichnet eine Trace-Markierung `vue.render` auf, die in der [Trace View](/guide/browser/trace-view) sichtbar ist.

### Optionen

Die Funktion `render` unterstützt alle [`mount`-Optionen](https://test-utils.vuejs.org/api/#mount) aus `@vue/test-utils` (außer `attachTo` — verwende stattdessen `container`). Zusätzlich gibt es `container` und `baseElement`.

#### container

Standardmäßig erzeugt Vitest ein `div`, hängt es an `document.body` an und rendert deine Komponente dort. Wenn du deinen eigenen `HTMLElement`-Container bereitstellst, wird dieser nicht automatisch angehängt — du musst vor `render` selbst `document.body.appendChild(container)` aufrufen.

Wenn du zum Beispiel ein `tbody`-Element als Unit testest, kann es kein Kind eines `div` sein. In diesem Fall kannst du eine `table` als Render-Container angeben.

```js
const table = document.createElement('table')

const { container } = await render(TableBody, {
  props,
  // ⚠️ appending the element to `body` manually before rendering
  container: document.body.appendChild(table),
})
```

#### baseElement

Wenn `container` angegeben ist, entspricht dies standardmäßig diesem Wert, ansonsten `document.body`. Es dient als Basiselement für die Queries und ist außerdem das, was bei Verwendung von `debug()` ausgegeben wird.

### Render-Ergebnis

Zusätzlich zum dokumentierten Rückgabewert liefert die Funktion `render` auch alle verfügbaren [Locators](/api/browser/locators) relativ zum [`baseElement`](#baseelement), einschließlich [eigener Locators](/api/browser/locators#custom-locators).

```ts
const screen = await render(TableBody, { props })

await screen.getByRole('link', { name: 'Expand' }).click()
```

#### container

Der umschließende DOM-Knoten, in dem deine Vue-Komponente gerendert wird. Das ist ein gewöhnlicher DOM-Knoten, du könntest also technisch gesehen `container.querySelector` usw. aufrufen, um die Kinder zu untersuchen.

:::danger
Wenn du merkst, dass du `container` verwendest, um nach gerenderten Elementen zu suchen, solltest du das überdenken! Die [Locators](/api/browser/locators) sind darauf ausgelegt, robuster gegenüber Änderungen an der getesteten Komponente zu sein. Vermeide es, `container` zum Suchen von Elementen zu verwenden!
:::

#### baseElement

Der umschließende DOM-Knoten, in dem deine Vue-Komponente innerhalb des `container` gerendert wird. Wenn du `baseElement` in den Optionen von `render` nicht angibst, wird standardmäßig `document.body` verwendet.

Das ist nützlich, wenn die zu testende Komponente etwas außerhalb des `container`-`div` rendert, z. B. wenn du einen Snapshot-Test für deine Portal-Komponente schreiben möchtest, die ihr HTML direkt in den Body rendert.

:::tip
Die von `render` zurückgegebenen Queries schauen in `baseElement`, du kannst also Queries verwenden, um deine Portal-Komponente auch ohne `baseElement` zu testen.
:::

#### locator

Der [Locator](/api/browser/locators) deines `container`. Er ist nützlich, um Queries nur auf deine Komponente einzugrenzen oder ihn an andere Assertions weiterzureichen:

```js
import { render } from 'vitest-browser-vue'

const { locator } = await render(NumberDisplay, {
  props: { number: 2 }
})

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
function rerender(props: Partial<Props>): Promise<void>
```

Zeichnet außerdem eine Trace-Markierung `vue.rerender` in der [Trace View](/guide/browser/trace-view) auf.

Es ist besser, die Komponente zu testen, die die Props aktualisiert, um sicherzustellen, dass die Props korrekt aktualisiert werden, statt sich in Tests auf Implementierungsdetails zu verlassen. Wenn du die Props einer gerenderten Komponente in deinem Test dennoch aktualisieren möchtest, kannst du diese Funktion dafür verwenden.

```js
import { render } from 'vitest-browser-vue'

const { rerender } = await render(NumberDisplay, { props: { number: 1 } })

// re-render the same component with different props
await rerender({ number: 2 })
```

#### unmount

```ts
function unmount(): Promise<void>
```

Dadurch wird die gerenderte Komponente ausgehängt. Zeichnet außerdem eine Trace-Markierung `vue.unmount` in der [Trace View](/guide/browser/trace-view) auf. Das ist nützlich, um zu testen, was passiert, wenn deine Komponente von der Seite entfernt wird (etwa um zu prüfen, dass keine Event-Handler zurückbleiben und Speicherlecks verursachen).

#### emitted

```ts
function emitted<T = unknown>(): Record<string, T[]>
function emitted<T = unknown[]>(eventName: string): undefined | T[]
```

Gibt die von der Komponente ausgelösten Events zurück.

::: warning
Ausgelöste Werte sind ein Implementierungsdetail, das dem Benutzer nicht direkt zugänglich ist. Besser ist es daher, mit [Locators](/api/browser/locators) zu testen, wie deine ausgelösten Werte den angezeigten Inhalt verändern.
:::

## cleanup

```ts
export function cleanup(): void
```

Entfernt alle mit [`render`](#render) gerenderten Komponenten.

## Queries erweitern

Um Locator-Queries zu erweitern, siehe [`"Custom Locators"`](/api/browser/locators#custom-locators). Wenn `render` zum Beispiel einen neuen eigenen Locator zurückgeben soll, definiere ihn über die API `locators.extend`:

```js {5-7,12}
import { locators } from 'vitest/browser'
import { render } from 'vitest-browser-vue'

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

## Konfiguration

Du kannst die Optionen von [Vue Test Utils](https://test-utils.vuejs.org/api/#config) konfigurieren, indem du Eigenschaften am `config`-Export setzt (verfügbar sowohl in `vitest-browser-vue` als auch in `vitest-browser-vue/pure`):

```js
import { config } from 'vitest-browser-vue/pure'

config.global.stubs.CustomComponent = {
  template: '<div></div>',
}
```

## Siehe auch

- [Dokumentation der Vue Testing Library](https://testing-library.com/docs/vue-testing-library/intro)
