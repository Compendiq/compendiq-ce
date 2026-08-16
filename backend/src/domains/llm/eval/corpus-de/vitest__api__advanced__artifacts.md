# Test-Artefakte <Advanced /> <Version type="experimental">4.0.11</Version> <Experimental />

::: warning
Dies ist eine fortgeschrittene API. Als Nutzer möchten Sie höchstwahrscheinlich stattdessen [Test-Annotationen](/guide/test-annotations) verwenden, um Ihren Tests Notizen oder Kontext hinzuzufügen. Diese API wird primär intern und von Bibliotheksautoren genutzt.
:::

Test-Artefakte erlauben es, während der Testausführung strukturierte Daten, Dateien oder Metadaten anzuhängen oder aufzuzeichnen. Das ist ein Low-Level-Feature, das primär gedacht ist für:

- interne Verwendung ([`annotate`](/guide/test-annotations) setzt auf dem Artefaktsystem auf)
- Framework-Autoren, die eigene Testwerkzeuge auf Basis von Vitest bauen

Jedes Artefakt umfasst:

- einen Typdiskriminator, der ein eindeutiger Bezeichner für den Artefakttyp ist
- eigene Daten, die beliebige relevante Informationen enthalten können
- optionale Attachments, entweder Dateien oder Inline-Inhalte, die dem Artefakt zugeordnet sind
- eine Position im Quellcode, die angibt, wo das Artefakt erzeugt wurde

Vitest verwaltet die Serialisierung von Attachments automatisch (Dateien werden nach [`attachmentsDir`](/config/attachmentsdir) kopiert) und ergänzt Metadaten zur Quellposition, sodass Sie sich auf die Daten konzentrieren können, die Sie aufzeichnen möchten. Alle Artefakte **müssen** von [`TestArtifactBase`](#testartifactbase) und alle Attachments von [`TestAttachment`](#testattachment) erben, damit sie intern korrekt verarbeitet werden.

## API

### `recordArtifact` <Experimental /> {#recordartifact}

::: warning
`recordArtifact` ist eine experimentelle API. Breaking Changes folgen möglicherweise nicht SemVer; pinnen Sie bitte die Version von Vitest, wenn Sie sie verwenden.

Die API-Oberfläche kann sich aufgrund von Feedback ändern. Wir ermutigen Sie, sie auszuprobieren und Ihre Erfahrungen mit dem Team zu teilen.
:::

```ts
function recordArtifact<Artifact extends TestArtifact>(task: Test, artifact: Artifact): Promise<Artifact>
```

Die Funktion `recordArtifact` zeichnet während der Testausführung ein Artefakt auf und gibt es zurück. Sie erwartet als ersten Parameter einen [Task](/api/advanced/runner#tasks) und als zweiten ein Objekt, das [`TestArtifact`](#testartifact) zuweisbar ist.

::: info
Artefakte müssen aufgezeichnet werden, bevor der Task gemeldet wird. Danach aufgezeichnete Artefakte werden nicht in den Task aufgenommen.
:::

Wenn ein Artefakt zu einem Test aufgezeichnet wird, löst dies das Runner-Event `onTestArtifactRecord` und das [Reporter-Event `onTestCaseArtifactRecord`](/api/advanced/reporters#ontestcaseartifactrecord) aus. Um aufgezeichnete Artefakte eines Testfalls abzurufen, verwenden Sie die Methode [`artifacts()`](/api/advanced/test-case#artifacts).

Hinweis: Annotationen erscheinen – [obwohl sie auf diesem Feature aufsetzen](#relationship-with-annotations) – aus Gründen der Rückwärtskompatibilität bis zur nächsten Major-Version nicht im Array `task.artifacts`.

### `TestArtifact`

Der Typ `TestArtifact` ist eine Union, die alle Artefakte enthält, die Vitest erzeugen kann, einschließlich eigener. Alle Artefakte erben von [`TestArtifactBase`](#testartifactbase)

### `TestArtifactBase` <Experimental /> {#testartifactbase}

```ts
export interface TestArtifactBase {
  /** File or data attachments associated with this artifact */
  attachments?: TestAttachment[]
  /** Source location where this artifact was created */
  location?: TestArtifactLocation
}
```

Das Interface `TestArtifactBase` ist die Basis für alle Test-Artefakte.

Erweitern Sie dieses Interface, wenn Sie eigene Test-Artefakte erstellen. Vitest verwaltet das Array `attachments` automatisch und ergänzt die Eigenschaft `location`, um anzugeben, wo in Ihrem Testcode das Artefakt erzeugt wurde.

::: danger
Wenn [`api.allowWrite`](/config/api#api-allowwrite) deaktiviert ist, leert Vitest vor dem Reporting bei jedem Artefakt das Array `attachments`.

Wenn Ihr eigenes Artefakt den Typ von `attachments` einschränkt (etwa auf ein Tupel), nehmen Sie `| []` in die Union auf, damit der Typ widerspiegelt, was zur Laufzeit tatsächlich passiert.
:::

### `TestAttachment`

```ts
export interface TestAttachment {
  /** MIME type of the attachment (e.g., 'image/png', 'text/plain') */
  contentType?: string
  /** Local file path or external HTTP(S) URL to the attachment. Relative paths are resolved from the project root. */
  path?: string
  /** Inline attachment content as a string or raw binary data */
  body?: string | Uint8Array
  /**
   * @experimental
   * How the string `body` is encoded.
   * - `'base64'` (default): body is already base64-encoded
   * - `'utf-8'`: body is a utf8 string
   */
  bodyEncoding?: 'base64' | 'utf-8'
}
```

Das Interface `TestAttachment` repräsentiert ein Datei- oder Daten-Attachment, das einem Test-Artefakt zugeordnet ist.

Attachments können entweder pfadbasiert sein (über `path`) oder Inline-Inhalte enthalten (über `body`). Der `contentType` hilft Konsumenten dabei, die Attachment-Daten richtig zu interpretieren.

Der `path` eines Attachments kann auf eine lokale Datei oder eine externe `http`/`https`-URL zeigen. Relative lokale Pfade werden ausgehend vom Projekt-Root aufgelöst. Lokale Dateien werden in das Attachment-Verzeichnis von Vitest kopiert, bevor Reporter sie erhalten. Externe URLs bleiben unverändert erhalten.

Wenn Sie einen String als `body` übergeben, geht Vitest davon aus, dass er bereits base64-kodiert ist, sofern Sie nicht `bodyEncoding: 'utf-8'` setzen. Übergeben Sie `body` als `Uint8Array`, kodiert Vitest ihn automatisch als base64. Die Option `bodyEncoding` gilt nur für Inline-`body`-Attachments, nicht für `path`-Attachments.

### `TestArtifactLocation`

```ts
export interface TestArtifactLocation {
  /** Line number in the source file (1-indexed) */
  line: number
  /** Column number in the line (1-indexed) */
  column: number
  /** Path to the source file */
  file: string
}
```

Das Interface `TestArtifactLocation` repräsentiert die Information zur Quellcodeposition eines Test-Artefakts. Es gibt an, wo im Quellcode das Artefakt entstanden ist.

### `TestArtifactRegistry`

Das Interface `TestArtifactRegistry` ist eine Registry für eigene Test-Artefakttypen.

Durch Erweitern dieses Interfaces mit der [Module-Augmentation von TypeScript](https://typescriptlang.org/docs/handbook/declaration-merging#module-augmentation) lassen sich eigene Artefakttypen registrieren, die Tests erzeugen können.

Jedes eigene Artefakt sollte [`TestArtifactBase`](#testartifactbase) erweitern und eine eindeutige Diskriminator-Eigenschaft `type` enthalten.

Hier einige Richtlinien bzw. Best Practices:

- Verwenden Sie möglichst ein `Symbol` als **Registry-Schlüssel**, um Eindeutigkeit zu garantieren
- Die Eigenschaft `type` sollte dem Muster `'package-name:artifact-name'` folgen, **`'internal:'` ist ein reserviertes Präfix**
- Nutzen Sie `attachments`, um Dateien oder Daten beizufügen; erweitern Sie [`TestAttachment`](#testattachment) für eigene Metadaten
- Wenn Sie den Typ von `attachments` einschränken (etwa auf ein Tupel), nehmen Sie `| []` in die Union auf, da Vitest das Array zur Laufzeit leeren kann (siehe [`TestArtifactBase`](#testartifactbase))
- Die Eigenschaft `location` wird automatisch ergänzt

## Eigene Artefakte

Um Artefakte typsicher zu verwenden und zu verwalten, müssen Sie ihren Typ erstellen und registrieren:

```ts
import type { TestArtifactBase, TestAttachment } from 'vitest'

interface A11yReportAttachment extends TestAttachment {
  contentType: 'text/html'
  path: string
}

interface AccessibilityArtifact extends TestArtifactBase {
  type: 'a11y:report'
  passed: boolean
  wcagLevel: 'A' | 'AA' | 'AAA'
  attachments: [A11yReportAttachment] | []
}

const a11yReportKey = Symbol('report')

declare module 'vitest' {
  interface TestArtifactRegistry {
    [a11yReportKey]: AccessibilityArtifact
  }
}
```

Solange die Typen ihren Basistypen zuweisbar sind und keine Fehler enthalten, sollte alles funktionieren und Sie sollten Artefakte über [`recordArtifact`](#recordartifact) aufzeichnen können:

```ts
async function toBeAccessible(
  this: MatcherState,
  actual: Element,
  wcagLevel: 'A' | 'AA' | 'AAA' = 'AA'
): AsyncExpectationResult {
  const report = await runAccessibilityAudit(actual, wcagLevel)

  await recordArtifact(this.task, {
    type: 'a11y:report',
    passed: report.violations.length === 0,
    wcagLevel,
    attachments: [{
      contentType: 'text/html',
      path: report.path,
    }],
  })

  return {
    pass: violations.length === 0,
    message: () => `Found ${report.violations.length} accessibility violation(s)`
  }
}
```

## Verhältnis zu Annotationen

Test-Annotationen setzen auf dem Artefaktsystem auf. Wenn Sie Annotationen in Tests verwenden, erzeugen sie im Hintergrund Artefakte vom Typ `internal:annotation`. Annotationen sind allerdings:

- einfacher zu verwenden
- für Endnutzer konzipiert, nicht für Entwickler

Verwenden Sie Annotationen, wenn Sie Ihren Tests lediglich Notizen hinzufügen möchten. Verwenden Sie Artefakte, wenn Sie eigene Daten benötigen.
