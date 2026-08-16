<h1 align="center">Fastify</h1>

## Wie Sie Ihren eigenen Type Provider schreiben

Was Sie bei der Implementierung eines eigenen [Type Providers](../Reference/Type-Providers.md) beachten sollten:

### Typ-Kontravarianz

Während sich erschöpfende Prüfungen zur Typeinschränkung normalerweise auf
`never` stützen, um einen unerreichbaren Zustand darzustellen, sollte die
Einschränkung in Type-Provider-Interfaces nur bis `unknown` erfolgen.

Der Grund dafür ist, dass bestimmte Methoden von `FastifyInstance` kontravariant
bezüglich `TypeProvider` sind, was dazu führen kann, dass TypeScript
Zuweisbarkeitsprobleme meldet, sofern das eigene Type-Provider-Interface nicht
durch `FastifyTypeProviderDefault` substituierbar ist.

Beispielsweise ist `FastifyTypeProviderDefault` dem Folgenden nicht zuweisbar:
```ts
export interface NotSubstitutableTypeProvider extends FastifyTypeProvider {
   // bad, nothing is assignable to `never` (except for itself)
  validator: this['schema'] extends /** custom check here**/ ? /** narrowed type here **/ : never;
  serializer: this['schema'] extends /** custom check here**/ ? /** narrowed type here **/ : never;
}
```

Es sei denn, es wird geändert zu:
```ts
export interface SubstitutableTypeProvider extends FastifyTypeProvider {
  // good, anything can be assigned to `unknown`
  validator: this['schema'] extends /** custom check here**/ ? /** narrowed type here **/ : unknown;
  serializer: this['schema'] extends /** custom check here**/ ? /** narrowed type here **/ : unknown;
}
```
