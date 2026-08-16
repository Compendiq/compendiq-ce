# TestCollection

`TestCollection` repräsentiert eine Sammlung von [Suites](/api/advanced/test-suite) und [Tests](/api/advanced/test-case) auf oberster Ebene innerhalb einer Suite oder eines Moduls. Sie stellt außerdem nützliche Methoden bereit, um über sich selbst zu iterieren.

::: info
Die meisten Methoden geben statt eines Arrays einen Iterator zurück, was die Performance verbessert, wenn du nicht jedes Element der Sammlung benötigst. Wenn du lieber mit einem Array arbeitest, kannst du den Iterator spreaden: `[...children.allSuites()]`.

Beachte außerdem, dass die Sammlung selbst ein Iterator ist:

```ts
for (const child of module.children) {
  console.log(child.type, child.name)
}
```
:::

## size

Die Anzahl der Tests und Suites in der Sammlung.

::: warning
Diese Zahl umfasst nur Tests und Suites auf oberster Ebene, nicht die verschachtelten Suites und Tests.
:::

## at

```ts
function at(index: number): TestCase | TestSuite | undefined
```

Gibt den Test oder die Suite an einem bestimmten Index zurück. Diese Methode akzeptiert auch negative Indizes.

## array

```ts
function array(): (TestCase | TestSuite)[]
```

Dieselbe Sammlung, aber als Array. Das ist nützlich, wenn du `Array`-Methoden wie `map` und `filter` verwenden möchtest, die von der `TaskCollection`-Implementierung nicht unterstützt werden.

## allSuites

```ts
function allSuites(): Generator<TestSuite, undefined, void>
```

Filtert alle Suites, die Teil dieser Sammlung und ihrer Kinder sind.

```ts
for (const suite of module.children.allSuites()) {
  if (suite.errors().length) {
    console.log('failed to collect', suite.errors())
  }
}
```

## allTests

```ts
function allTests(state?: TestState): Generator<TestCase, undefined, void>
```

Filtert alle Tests, die Teil dieser Sammlung und ihrer Kinder sind.

```ts
for (const test of module.children.allTests()) {
  if (test.result().state === 'pending') {
    console.log('test', test.fullName, 'did not finish')
  }
}
```

Du kannst einen `state`-Wert übergeben, um Tests nach ihrem Zustand zu filtern.

## tests

```ts
function tests(state?: TestState): Generator<TestCase, undefined, void>
```

Filtert nur die Tests, die Teil dieser Sammlung sind. Du kannst einen `state`-Wert übergeben, um Tests nach ihrem Zustand zu filtern.

## suites

```ts
function suites(): Generator<TestSuite, undefined, void>
```

Filtert nur die Suites, die Teil dieser Sammlung sind.
