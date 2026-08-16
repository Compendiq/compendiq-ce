# Klassen mocken

Sie können eine ganze Klasse mit einem einzigen [`vi.fn`](/api/vi#fn)-Aufruf mocken.

```ts
class Dog {
  name: string

  constructor(name: string) {
    this.name = name
  }

  static getType(): string {
    return 'animal'
  }

  greet = (): string => {
    return `Hi! My name is ${this.name}!`
  }

  speak(): string {
    return 'bark!'
  }

  isHungry() {}
  feed() {}
}
```

Wir können diese Klasse mit `vi.fn` (oder `vi.spyOn().mockImplementation()`) nachbauen:

```ts
const Dog = vi.fn(class {
  static getType = vi.fn(() => 'mocked animal')

  constructor(name) {
    this.name = name
  }

  greet = vi.fn(() => `Hi! My name is ${this.name}!`)
  speak = vi.fn(() => 'loud bark!')
  feed = vi.fn()
})
```

::: warning
Wenn die Konstruktorfunktion einen nicht-primitiven Wert zurückgibt, wird dieser Wert zum Ergebnis des new-Ausdrucks. In diesem Fall ist `[[Prototype]]` möglicherweise nicht korrekt gebunden:

```ts
const CorrectDogClass = vi.fn(function (name) {
  this.name = name
})

const IncorrectDogClass = vi.fn(name => ({
  name
}))

const Marti = new CorrectDogClass('Marti')
const Newt = new IncorrectDogClass('Newt')

Marti instanceof CorrectDogClass // ✅ true
Newt instanceof IncorrectDogClass // ❌ false!
```

Wenn Sie Klassen mocken, bevorzugen Sie die Klassensyntax gegenüber der Funktion.
:::

::: tip WANN VERWENDEN?
Allgemein gesprochen würden Sie eine Klasse auf diese Weise innerhalb der Modul-Factory nachbauen, wenn die Klasse aus einem anderen Modul re-exportiert wird:

```ts
import { Dog } from './dog.js'

vi.mock(import('./dog.js'), () => {
  const Dog = vi.fn(class {
    feed = vi.fn()
    // ... other mocks
  })
  return { Dog }
})
```

Diese Methode lässt sich auch verwenden, um eine Instanz einer Klasse an eine Funktion zu übergeben, die dasselbe Interface akzeptiert:

```ts [src/feed.ts]
function feed(dog: Dog) {
  // ...
}
```
```ts [tests/dog.test.ts]
import { expect, test, vi } from 'vitest'
import { feed } from '../src/feed.js'

const Dog = vi.fn(class {
  feed = vi.fn()
})

test('can feed dogs', () => {
  const dogMax = new Dog('Max')

  feed(dogMax)

  expect(dogMax.feed).toHaveBeenCalled()
  expect(dogMax.isHungry()).toBe(false)
})
```
:::

Wenn wir nun eine neue Instanz der Klasse `Dog` erzeugen, ist deren Methode `speak` (neben `feed` und `greet`) bereits gemockt:

```ts
const Cooper = new Dog('Cooper')
Cooper.speak() // loud bark!
Cooper.greet() // Hi! My name is Cooper!

// you can use built-in assertions to check the validity of the call
expect(Cooper.speak).toHaveBeenCalled()
expect(Cooper.greet).toHaveBeenCalled()

const Max = new Dog('Max')

// methods are not shared between instances if you assigned them directly
expect(Max.speak).not.toHaveBeenCalled()
expect(Max.greet).not.toHaveBeenCalled()
```

Wir können den Rückgabewert für eine bestimmte Instanz neu setzen:

```ts
const dog = new Dog('Cooper')

// "vi.mocked" is a type helper, since
// TypeScript doesn't know that Dog is a mocked class,
// it wraps any function in a Mock<T> type
// without validating if the function is a mock
vi.mocked(dog.speak).mockReturnValue('woof woof')

dog.speak() // woof woof
```

Um die Eigenschaft zu mocken, können wir die Methode `vi.spyOn(dog, 'name', 'get')` verwenden. Damit lassen sich Spy-Assertions auf der gemockten Eigenschaft nutzen:

```ts
const dog = new Dog('Cooper')

const nameSpy = vi.spyOn(dog, 'name', 'get').mockReturnValue('Max')

expect(dog.name).toBe('Max')
expect(nameSpy).toHaveBeenCalledTimes(1)
```

::: tip
Mit derselben Methode können Sie auch Getter und Setter ausspähen.
:::

::: danger
Die Verwendung von Klassen mit `vi.fn()` wurde in Vitest 4 eingeführt. Zuvor mussten Sie `function` und `prototype`-Vererbung direkt verwenden. Siehe [v3-Guide](https://v3.vitest.dev/guide/mocking.html#classes).
:::
