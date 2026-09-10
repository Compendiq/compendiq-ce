# Funktionen mocken

Das Mocken von Funktionen lässt sich in zwei verschiedene Kategorien unterteilen: Spying und Mocking.

Wenn Sie das Verhalten einer Methode auf einem Objekt beobachten müssen, können Sie mit [`vi.spyOn()`](/api/vi#vi-spyon) einen Spy erstellen, der die Aufrufe dieser Methode nachverfolgt.

Wenn Sie eine eigene Funktionsimplementierung als Argument übergeben oder eine neue gemockte Entität erzeugen müssen, können Sie mit [`vi.fn()`](/api/vi#vi-fn) eine Mock-Funktion erstellen.

Sowohl `vi.spyOn` als auch `vi.fn` besitzen dieselben Methoden.

::: tip
Wenn ein Mock je nach den empfangenen Argumenten unterschiedliche Werte zurückgeben soll, können Sie mit [`vi.when()`](/api/vi#vi-when) argumentspezifisches Verhalten definieren, ohne eigene `if/else`-Logik zu schreiben. Details finden Sie im Rezept [Bedingtes Mocken](/guide/recipes/conditional-mocking).
:::

## Beispiel

```js
import { afterEach, describe, expect, it, vi } from 'vitest'

const messages = {
  items: [
    { message: 'Simple test message', from: 'Testman' },
    // ...
  ],
  addItem(item) {
    messages.items.push(item)
    messages.callbacks.forEach(callback => callback(item))
  },
  onItem(callback) {
    messages.callbacks.push(callback)
  },
  getLatest, // can also be a `getter or setter if supported`
}

function getLatest(index = messages.items.length - 1) {
  return messages.items[index]
}

it('should get the latest message with a spy', () => {
  const spy = vi.spyOn(messages, 'getLatest')
  expect(spy.getMockName()).toEqual('getLatest')

  expect(messages.getLatest()).toEqual(
    messages.items.at(-1),
  )

  expect(spy).toHaveBeenCalledTimes(1)

  spy.mockImplementationOnce(() => 'access-restricted')
  expect(messages.getLatest()).toEqual('access-restricted')

  expect(spy).toHaveBeenCalledTimes(2)
})

it('passing down the mock', () => {
  const callback = vi.fn()
  messages.onItem(callback)

  messages.addItem({ message: 'Another test message', from: 'Testman' })
  expect(callback).toHaveBeenCalledWith({
    message: 'Another test message',
    from: 'Testman',
  })
})
```
