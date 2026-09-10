# Schema-getriebene Assertions

Wenn dein Projekt Daten bereits mit [Zod](https://zod.dev), [Valibot](https://valibot.dev) oder [ArkType](https://arktype.io) validiert, beschreiben diese Schemas bereits, wie ein gültiger Wert aussieht. Sie in Tests wiederzuverwenden ist direkter, als Strukturprüfungen über `toEqual` und `toMatchObject` hinweg zu duplizieren.

[`expect.schemaMatching`](/api/expect#expect-schemamatching) <Version>4.0.0</Version> ist ein asymmetrischer Matcher, der ein beliebiges [Standard-Schema-v1](https://standardschema.dev)-Objekt entgegennimmt und erfolgreich ist, wenn der Wert diesem entspricht.

## Muster

```ts
import { expect, test } from 'vitest'
import { z } from 'zod'

test('email validation', () => {
  const user = { email: 'john@example.com' }

  expect(user).toEqual({
    email: expect.schemaMatching(z.string().email()),
  })
})
```

`expect.schemaMatching` ist ein asymmetrischer Matcher und lässt sich daher in jeder Gleichheitsprüfung genauso kombinieren wie `expect.any` oder `expect.stringMatching`:

- `toEqual` / `toStrictEqual`
- `toMatchObject`
- `toContainEqual`
- `toThrow`
- `toHaveBeenCalledWith`
- `toHaveReturnedWith`
- `toHaveBeenResolvedWith`

## Funktioniert mit jeder Standard-Schema-Bibliothek

```ts
import { expect, test } from 'vitest'
import { z } from 'zod'
import * as v from 'valibot'
import { type } from 'arktype'

const user = { email: 'john@example.com' }

// Zod
expect(user).toEqual({
  email: expect.schemaMatching(z.string().email()),
})

// Valibot
expect(user).toEqual({
  email: expect.schemaMatching(v.pipe(v.string(), v.email())),
})

// ArkType
expect(user).toEqual({
  email: expect.schemaMatching(type('string.email')),
})
```

## Aufrufargumente überprüfen

Ein häufiger Anwendungsfall ist die Prüfung, dass ein Mock mit Daten aufgerufen wurde, die einem Schema entsprechen, ohne jedes Feld einzeln auszuschreiben:

```ts
import { expect, test, vi } from 'vitest'
import { z } from 'zod'

const UserSchema = z.object({
  id: z.string().uuid(),
  email: z.string().email(),
  createdAt: z.date(),
})

test('persists a valid user', () => {
  const repo = { save: vi.fn() }
  registerUser(repo, { email: 'a@b.com' })

  expect(repo.save).toHaveBeenCalledWith(expect.schemaMatching(UserSchema))
})
```

Greife zu `schemaMatching`, wenn du für den Wert bereits ein Schema hast und sonst jede Eigenschaft von Hand ausschreiben müsstest. Besonders nützlich ist es bei Assertions über generierte Felder wie UUIDs oder Zeitstempel, bei denen du das Format prüfen kannst, ohne den exakten Wert vorherzusagen.

## Siehe auch

- [`expect.schemaMatching`](/api/expect#expect-schemamatching)
- [Standard Schema](https://standardschema.dev)
- [Asymmetrische Matcher](/api/expect)
