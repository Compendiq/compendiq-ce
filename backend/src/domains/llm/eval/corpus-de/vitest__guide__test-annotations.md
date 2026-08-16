# Test-Annotationen

Vitest unterstützt es, deine Tests über die API [`context.annotate`](/guide/test-context#annotate) mit eigenen Nachrichten und Dateien zu annotieren. Diese Annotationen werden an den Testfall gehängt und im Hook [`onTestAnnotate`](/api/advanced/reporters#ontestannotate) an die Reporter weitergereicht.

```ts
test('hello world', async ({ annotate }) => {
  await annotate('this is my test')

  if (condition) {
    await annotate('this should\'ve errored', 'error')
  }

  const file = createTestSpecificFile()
  await annotate('creates a file', { body: file })

  await annotate('creates a file with text', {
    contentType: 'text/markdown',
    body: 'Hello **markdown**',
    bodyEncoding: 'utf-8',
  })
})
```

::: warning
Die Funktion `annotate` gibt ein Promise zurück, muss also mit `await` behandelt werden, wenn du dich darauf verlässt. Vitest wartet allerdings auch automatisch auf jede nicht awaitete Annotation, bevor der Test endet.
:::

Je nach Reporter siehst du diese Annotationen unterschiedlich.

## Eingebaute Reporter
### default

Der Reporter `default` gibt Annotationen nur aus, wenn der Test fehlgeschlagen ist:

```
  ⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯

  FAIL  example.test.js > an example of a test with annotation
Error: thrown error
  ❯ example.test.js:11:21
      9 |    await annotate('annotation 1')
      10|    await annotate('annotation 2', 'warning')
      11|    throw new Error('thrown error')
        |          ^
      12|  })

  ❯ example.test.js:9:15 notice
    ↳ annotation 1
  ❯ example.test.js:10:15 warning
    ↳ annotation 2

  ⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/1]⎯
```

### verbose

Der Reporter `verbose` ist der einzige Terminal-Reporter, der Annotationen auch dann ausgibt, wenn der Test nicht fehlschlägt.

```
✓ example.test.js > an example of a test with annotation

  ❯ example.test.js:9:15 notice
    ↳ annotation 1
  ❯ example.test.js:10:15 warning
    ↳ annotation 2

```

### html

Der HTML-Reporter zeigt Annotationen genauso an wie die UI. Du siehst die Annotation in der Zeile, in der sie aufgerufen wurde. Wurde die Annotation nicht in einer Testdatei aufgerufen, ist sie derzeit in der UI nicht sichtbar. Wir planen, eine separate Test-Zusammenfassungsansicht zu unterstützen, in der sie sichtbar sein wird.

<img alt="Vitest UI" img-light src="/annotations-html-light.png">
<img alt="Vitest UI" img-dark src="/annotations-html-dark.png">

### junit

Der Reporter `junit` listet Annotationen innerhalb des `properties`-Tags des Testcase auf. Der JUnit-Reporter ignoriert alle Anhänge und gibt nur den Typ und die Nachricht aus.

```xml
<testcase classname="basic/example.test.js" name="an example of a test with annotation" time="0.14315">
    <properties>
        <property name="notice" value="the message of the annotation">
        </property>
    </properties>
</testcase>
```

### github-actions

Der Reporter `github-actions` gibt die Annotation standardmäßig als [Notice-Nachricht](https://docs.github.com/en/actions/writing-workflows/choosing-what-your-workflow-does/workflow-commands-for-github-actions#setting-a-notice-message) aus. Den `type` kannst du konfigurieren, indem du als zweites Argument `notice`, `warning` oder `error` übergibst. Ist der Typ keiner davon, zeigt Vitest die Nachricht als Notice an.

<img alt="GitHub Actions" img-light src="/annotations-gha-light.png">
<img alt="GitHub Actions" img-dark src="/annotations-gha-dark.png">

### tap

Die Reporter `tap` und `tap-flat` geben Annotationen als Diagnosemeldungen in einer neuen Zeile aus, die mit einem `#`-Zeichen beginnt. Sie ignorieren alle Anhänge und geben nur Typ und Nachricht aus:

```
ok 1 - an example of a test with annotation # time=143.15ms
    # notice: the message of the annotation
```
