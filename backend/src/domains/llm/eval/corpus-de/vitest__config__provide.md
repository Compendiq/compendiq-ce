# provide

- **Typ:** `Partial<ProvidedContext>`

Definiert Werte, auf die innerhalb deiner Tests über die Methode `inject` zugegriffen werden kann.

:::code-group
```ts [vitest.config.js]
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    provide: {
      API_KEY: '123',
    },
  },
})
```
```ts [api.test.js]
import { expect, inject, test } from 'vitest'

test('api key is defined', () => {
  expect(inject('API_KEY')).toBe('123')
})
```
:::

::: warning
Die Eigenschaften müssen Strings sein und die Werte müssen [serialisierbar](https://developer.mozilla.org/en-US/docs/Web/API/Web_Workers_API/Structured_clone_algorithm#supported_types) sein, da dieses Objekt zwischen verschiedenen Prozessen übertragen wird.
:::

::: tip
Wenn du TypeScript verwendest, musst du den Typ `ProvidedContext` erweitern, um typsicher darauf zuzugreifen:

```ts [vitest.shims.d.ts]
declare module 'vitest' {
  export interface ProvidedContext {
    API_KEY: string
  }
}

// mark this file as a module so augmentation works correctly
export {}
```
:::
