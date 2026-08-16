# Komponententests

Komponententests sind eine Teststrategie, die sich darauf konzentriert, einzelne UI-Komponenten isoliert zu testen. Anders als End-to-End-Tests, die vollständige Nutzerabläufe prüfen, verifizieren Komponententests, dass jede Komponente für sich korrekt funktioniert — dadurch laufen sie schneller und lassen sich leichter debuggen.

Vitest bietet umfassende Unterstützung für Komponententests über zahlreiche Frameworks hinweg, darunter Vue, React, Svelte, Lit, Preact, Qwik, Solid, Marko und weitere. Dieser Leitfaden behandelt die konkreten Muster, Werkzeuge und Best Practices, um Komponenten mit Vitest wirkungsvoll zu testen.

## Warum Komponententests?

Komponententests liegen zwischen Unit-Tests und End-to-End-Tests und bieten mehrere Vorteile:

- **Schnelleres Feedback** – einzelne Komponenten testen, ohne ganze Anwendungen zu laden
- **Isoliertes Testen** – Fokus auf das Verhalten der Komponente ohne externe Abhängigkeiten
- **Besseres Debugging** – Probleme in bestimmten Komponenten lassen sich leichter eingrenzen
- **Umfassende Abdeckung** – Grenzfälle und Fehlerzustände lassen sich leichter testen

## Browser-Modus für Komponententests

Komponententests nutzen in Vitest den **Browser-Modus**, um Tests in echten Browserumgebungen mit Playwright, WebdriverIO oder im Preview-Modus auszuführen. Das ergibt die realitätsnächste Testumgebung, da Ihre Komponenten in echten Browsern mit tatsächlichen DOM-Implementierungen, CSS-Rendering und Browser-APIs laufen.

### Warum der Browser-Modus?

Der Browser-Modus ist der empfohlene Ansatz für Komponententests, weil er die realitätsnächste Testumgebung bietet. Anders als Bibliotheken zur DOM-Simulation deckt der Browser-Modus reale Probleme auf, die Ihre Nutzer betreffen können.

::: tip
Der Browser-Modus deckt Probleme auf, die Bibliotheken zur DOM-Simulation womöglich übersehen, darunter:
- Probleme mit CSS-Layout und Styling
- Tatsächliches Verhalten von Browser-APIs
- Korrekte Ereignisbehandlung und -propagierung
- Ordentliches Fokusmanagement und Barrierefreiheitsfunktionen

:::

### Zweck dieses Leitfadens

Dieser Leitfaden konzentriert sich gezielt auf **Muster und Best Practices für Komponententests** mit den Möglichkeiten von Vitest. Viele Beispiele verwenden zwar den Browser-Modus (weil er der empfohlene Ansatz ist), der Fokus liegt hier aber auf komponentenspezifischen Teststrategien statt auf Details der Browserkonfiguration.

Für die detaillierte Browsereinrichtung, Konfigurationsoptionen und fortgeschrittene Browserfunktionen siehe die [Dokumentation zum Browser-Modus](/guide/browser/).

## Was einen guten Komponententest ausmacht

Gute Komponententests konzentrieren sich auf **Verhalten und Nutzererfahrung** statt auf Implementierungsdetails:

- **Den Vertrag testen** – wie Komponenten Eingaben (Props) erhalten und Ausgaben erzeugen (Events, Renderings)
- **Nutzerinteraktionen testen** – Klicks, Formularabsendungen, Tastaturnavigation
- **Grenzfälle testen** – Fehlerzustände, Ladezustände, leere Zustände
- **Interna nicht testen** – Zustandsvariablen, private Methoden, CSS-Klassen

### Hierarchie beim Komponententesten

```
1. Critical User Paths → Always test these
2. Error Handling      → Test failure scenarios
3. Edge Cases          → Empty data, extreme values
4. Accessibility       → Screen readers, keyboard nav
5. Performance         → Large datasets, animations
```

## Strategien für Komponententests

### Isolationsstrategie

Testen Sie Komponenten isoliert, indem Sie Abhängigkeiten mocken:

```tsx
// For API requests, we recommend MSW (Mock Service Worker)
// See: https://vitest.dev/guide/mocking/requests
//
// vi.mock(import('../api/userService'), () => ({
//   fetchUser: vi.fn().mockResolvedValue({ name: 'John' })
// }))

// Mock child components to focus on parent logic
vi.mock(import('../components/UserCard'), () => ({
  default: vi.fn(({ user }) => `<div>User: ${user.name}</div>`)
}))

test('UserProfile handles loading and data states', async () => {
  const { getByText } = render(<UserProfile userId="123" />)

  // Test loading state
  await expect.element(getByText('Loading...')).toBeInTheDocument()

  // Test for data to load (expect.element auto-retries)
  await expect.element(getByText('User: John')).toBeInTheDocument()
})
```

### Integrationsstrategie

Testen Sie das Zusammenspiel von Komponenten und den Datenfluss:

```tsx
test('ProductList filters and displays products correctly', async () => {
  const mockProducts = [
    { id: 1, name: 'Laptop', category: 'Electronics', price: 999 },
    { id: 2, name: 'Book', category: 'Education', price: 29 }
  ]

  const { getByLabelText, getByText } = render(
    <ProductList products={mockProducts} />
  )

  // Initially shows all products
  await expect.element(getByText('Laptop')).toBeInTheDocument()
  await expect.element(getByText('Book')).toBeInTheDocument()

  // Filter by category
  await userEvent.selectOptions(
    getByLabelText(/category/i),
    'Electronics'
  )

  // Only electronics should remain
  await expect.element(getByText('Laptop')).toBeInTheDocument()
  await expect.element(queryByText('Book')).not.toBeInTheDocument()
})
```

## Integration der Testing Library

Vitest stellt zwar offizielle Pakete für gängige Frameworks bereit ([`vitest-browser-vue`](https://npmx.dev/package/vitest-browser-vue), [`vitest-browser-react`](https://npmx.dev/package/vitest-browser-react), [`vitest-browser-svelte`](https://npmx.dev/package/vitest-browser-svelte)), Sie können aber für Frameworks, die noch nicht offiziell unterstützt werden, die [Testing Library](https://testing-library.com/) einbinden.

### Wann Sie die Testing Library verwenden sollten

- Ihr Framework hat noch kein offizielles Vitest-Browser-Paket
- Sie migrieren bestehende Tests, die die Testing Library verwenden
- Sie bevorzugen die API der Testing Library für bestimmte Testszenarien

### Integrationsmuster

Der Schlüssel ist `page.elementLocator()`, um die DOM-Ausgabe der Testing Library mit den Browser-Modus-APIs von Vitest zu verbinden:

```jsx
// For Solid.js components
import { render } from '@testing-library/solid'
import { page } from 'vitest/browser'

test('Solid component handles user interaction', async () => {
  // Use Testing Library to render the component
  const { baseElement, getByRole } = render(() =>
    <Counter initialValue={0} />
  )

  // Bridge to Vitest's browser mode for interactions and assertions
  const screen = page.elementLocator(baseElement)

  // Use Vitest's page queries for finding elements
  const incrementButton = screen.getByRole('button', { name: /increment/i })

  // Use Vitest's assertions and interactions
  await expect.element(screen.getByText('Count: 0')).toBeInTheDocument()

  // Trigger user interaction using Vitest's page API
  await incrementButton.click()

  await expect.element(screen.getByText('Count: 1')).toBeInTheDocument()
})
```

### Verfügbare Testing-Library-Pakete

Beliebte Testing-Library-Pakete, die gut mit Vitest zusammenarbeiten:

- [`@testing-library/solid`](https://github.com/solidjs/solid-testing-library) – für Solid.js
- [`@marko/testing-library`](https://testing-library.com/docs/marko-testing-library/intro) – für Marko
- [`@testing-library/svelte`](https://testing-library.com/docs/svelte-testing-library/intro) – Alternative zu [`vitest-browser-svelte`](https://npmx.dev/package/vitest-browser-svelte)
- [`@testing-library/vue`](https://testing-library.com/docs/vue-testing-library/intro) – Alternative zu [`vitest-browser-vue`](https://npmx.dev/package/vitest-browser-vue)

::: tip Migrationspfad
Wenn Ihr Framework später offizielle Vitest-Unterstützung erhält, können Sie schrittweise migrieren, indem Sie die `render`-Funktion der Testing Library ersetzen und den Großteil Ihrer Testlogik unverändert lassen.
:::

## Best Practices

### 1. Den Browser-Modus für CI/CD verwenden
Sorgen Sie dafür, dass Tests in echten Browserumgebungen laufen, um die realitätsnächsten Ergebnisse zu erhalten. Der Browser-Modus liefert korrektes CSS-Rendering, echte Browser-APIs und ordentliche Ereignisbehandlung.

### 2. Nutzerinteraktionen testen
Simulieren Sie echtes Nutzerverhalten mit Vitests [Interactivity-API](/api/browser/interactivity). Verwenden Sie `page.getByRole()` und `userEvent`-Methoden, wie in unseren [Fortgeschrittenen Testmustern](#advanced-testing-patterns) gezeigt:

```tsx
// Good: Test actual user interactions
await page.getByRole('button', { name: /submit/i }).click()
await page.getByLabelText(/email/i).fill('user@example.com')

// Avoid: Testing implementation details
// component.setState({ email: 'user@example.com' })
```

### 3. Barrierefreiheit testen
Stellen Sie sicher, dass Komponenten für alle Nutzer funktionieren, indem Sie Tastaturnavigation, Fokusmanagement und ARIA-Attribute testen. Praktische Muster finden Sie in unserem Beispiel [Barrierefreiheit testen](#testing-accessibility):

```tsx
// Test keyboard navigation
await userEvent.keyboard('{Tab}')
await expect.element(document.activeElement).toHaveFocus()

// Test ARIA attributes
await expect.element(modal).toHaveAttribute('aria-modal', 'true')
```

### 4. Externe Abhängigkeiten mocken
Konzentrieren Sie Tests auf die Komponentenlogik, indem Sie APIs und externe Dienste mocken. Das macht Tests schneller und zuverlässiger. Beispiele finden Sie in unserer [Isolationsstrategie](#isolation-strategy):

```tsx
// For API requests, we recommend using MSW (Mock Service Worker)
// See: https://vitest.dev/guide/mocking/requests
// This provides more realistic request/response mocking

// For module mocking, use the import() syntax
vi.mock(import('../components/UserCard'), () => ({
  default: vi.fn(() => <div>Mocked UserCard</div>)
}))
```

### 5. Aussagekräftige Testbeschreibungen verwenden
Schreiben Sie Testbeschreibungen, die das erwartete Verhalten erklären, nicht Implementierungsdetails:

```tsx
// Good: Describes user-facing behavior
test('shows error message when email format is invalid')
test('disables submit button while form is submitting')

// Avoid: Implementation-focused descriptions
test('calls validateEmail function')
test('sets isSubmitting state to true')
```

## Fortgeschrittene Testmuster

### Zustandsverwaltung von Komponenten testen

```tsx
// Testing stateful components and state transitions
test('ShoppingCart manages items correctly', async () => {
  const { getByText, getByTestId } = render(<ShoppingCart />)

  // Initially empty
  await expect.element(getByText('Your cart is empty')).toBeInTheDocument()

  // Add item
  await page.getByRole('button', { name: /add laptop/i }).click()

  // Verify state change
  await expect.element(getByText('1 item')).toBeInTheDocument()
  await expect.element(getByText('Laptop - $999')).toBeInTheDocument()

  // Test quantity updates
  await page.getByRole('button', { name: /increase quantity/i }).click()
  await expect.element(getByText('2 items')).toBeInTheDocument()
})
```

### Asynchrone Komponenten mit Datenabruf testen

```tsx
// Option 1: Recommended - Use MSW (Mock Service Worker) for API mocking
import { http, HttpResponse } from 'msw'
import { setupWorker } from 'msw/browser'

// Set up MSW worker with API handlers
const worker = setupWorker(
  http.get('/api/users/:id', ({ params }) => {
    // Describe the happy path
    return HttpResponse.json({ id: params.id, name: 'John Doe', email: 'john@example.com' })
  })
)

// Start the worker before all tests
beforeAll(() => worker.start())
afterEach(() => worker.resetHandlers())
afterAll(() => worker.stop())

test('UserProfile handles loading, success, and error states', async () => {
  // Test success state
  const { getByText } = render(<UserProfile userId="123" />)
  // expect.element auto-retries until elements are found
  await expect.element(getByText('John Doe')).toBeInTheDocument()
  await expect.element(getByText('john@example.com')).toBeInTheDocument()

  // Test error state by overriding the handler for this test
  worker.use(
    http.get('/api/users/:id', () => {
      return HttpResponse.json({ error: 'User not found' }, { status: 404 })
    })
  )

  const { getByText: getErrorText } = render(<UserProfile userId="999" />)
  await expect.element(getErrorText('Error: User not found')).toBeInTheDocument()
})
```

::: tip
Weitere Details finden Sie unter [MSW im Browser verwenden](https://mswjs.io/docs/integrations/browser).
:::

### Kommunikation zwischen Komponenten testen

```tsx
// Test parent-child component interaction
test('parent and child components communicate correctly', async () => {
  const mockOnSelectionChange = vi.fn()

  const { getByText } = render(
    <ProductCatalog onSelectionChange={mockOnSelectionChange}>
      <ProductFilter />
      <ProductGrid />
    </ProductCatalog>
  )

  // Interact with child component
  await page.getByRole('checkbox', { name: /electronics/i }).click()

  // Verify parent receives the communication
  expect(mockOnSelectionChange).toHaveBeenCalledWith({
    category: 'electronics',
    filters: ['electronics']
  })

  // Verify other child component updates (expect.element auto-retries)
  await expect.element(getByText('Showing Electronics products')).toBeInTheDocument()
})
```

### Komplexe Formulare mit Validierung testen

```tsx
test('ContactForm handles complex validation scenarios', async () => {
  const mockSubmit = vi.fn()
  const { getByLabelText, getByText } = render(
    <ContactForm onSubmit={mockSubmit} />
  )

  const nameInput = page.getByLabelText(/full name/i)
  const emailInput = page.getByLabelText(/email/i)
  const messageInput = page.getByLabelText(/message/i)
  const submitButton = page.getByRole('button', { name: /send message/i })

  // Test validation triggers
  await submitButton.click()

  await expect.element(getByText('Name is required')).toBeInTheDocument()
  await expect.element(getByText('Email is required')).toBeInTheDocument()
  await expect.element(getByText('Message is required')).toBeInTheDocument()

  // Test partial validation
  await nameInput.fill('John Doe')
  await submitButton.click()

  await expect.element(getByText('Name is required')).not.toBeInTheDocument()
  await expect.element(getByText('Email is required')).toBeInTheDocument()

  // Test email format validation
  await emailInput.fill('invalid-email')
  await submitButton.click()

  await expect.element(getByText('Please enter a valid email')).toBeInTheDocument()

  // Test successful submission
  await emailInput.fill('john@example.com')
  await messageInput.fill('Hello, this is a test message.')
  await submitButton.click()

  expect(mockSubmit).toHaveBeenCalledWith({
    name: 'John Doe',
    email: 'john@example.com',
    message: 'Hello, this is a test message.'
  })
})
```

### Error Boundaries testen

```tsx
// Test how components handle and recover from errors
function ThrowError({ shouldThrow }: { shouldThrow: boolean }) {
  if (shouldThrow) {
    throw new Error('Component error!')
  }
  return <div>Component working fine</div>
}

test('ErrorBoundary catches and displays errors gracefully', async () => {
  const { getByText, rerender } = render(
    <ErrorBoundary fallback={<div>Something went wrong</div>}>
      <ThrowError shouldThrow={false} />
    </ErrorBoundary>
  )

  // Initially working
  await expect.element(getByText('Component working fine')).toBeInTheDocument()

  // Trigger error
  rerender(
    <ErrorBoundary fallback={<div>Something went wrong</div>}>
      <ThrowError shouldThrow={true} />
    </ErrorBoundary>
  )

  // Error boundary should catch it
  await expect.element(getByText('Something went wrong')).toBeInTheDocument()
})
```

### Barrierefreiheit testen

```tsx
test('Modal component is accessible', async () => {
  const { getByRole, getByLabelText } = render(
    <Modal isOpen={true} title="Settings">
      <SettingsForm />
    </Modal>
  )

  // Test focus management - modal should receive focus when opened
  // This is crucial for screen reader users to know a modal opened
  const modal = getByRole('dialog')
  await expect.element(modal).toHaveFocus()

  // Test ARIA attributes - these provide semantic information to screen readers
  await expect.element(modal).toHaveAttribute('aria-labelledby') // Links to title element
  await expect.element(modal).toHaveAttribute('aria-modal', 'true') // Indicates modal behavior

  // Test keyboard navigation - Escape key should close modal
  // This is required by ARIA authoring practices
  await userEvent.keyboard('{Escape}')
  // expect.element auto-retries until modal is removed
  await expect.element(modal).not.toBeInTheDocument()

  // Test focus trap - tab navigation should cycle within modal
  // This prevents users from tabbing to content behind the modal
  const firstInput = getByLabelText(/username/i)
  const lastButton = getByRole('button', { name: /save/i })

  // Use click to focus on the first input, then test tab navigation
  await firstInput.click()
  await userEvent.keyboard('{Shift>}{Tab}{/Shift}') // Shift+Tab goes backwards
  await expect.element(lastButton).toHaveFocus() // Should wrap to last element
})
```

## Komponententests debuggen

### 1. Die Entwicklerwerkzeuge des Browsers nutzen

Der Browser-Modus führt Tests in echten Browsern aus und gibt Ihnen damit Zugriff auf die vollen Entwicklerwerkzeuge. Wenn Tests fehlschlagen, können Sie:

- **Die Entwicklerwerkzeuge öffnen** während der Testausführung (F12 oder Rechtsklick → Untersuchen)
- **Breakpoints setzen** in Ihrem Testcode oder Komponentencode
- **Das DOM inspizieren**, um die tatsächlich gerenderte Ausgabe zu sehen
- **Konsolenfehler prüfen** auf JavaScript-Fehler oder -Warnungen
- **Netzwerk-Requests überwachen**, um API-Aufrufe zu debuggen

Für das Debuggen im Headful-Modus fügen Sie Ihrer Browserkonfiguration vorübergehend `headless: false` hinzu.

### 2. Debug-Ausgaben ergänzen

Nutzen Sie gezielte Ausgaben, um Testfehler zu verstehen:

```tsx
test('debug form validation', async () => {
  render(<ContactForm />)

  const submitButton = page.getByRole('button', { name: /submit/i })
  await submitButton.click()

  // Debug: Check if element exists with different query
  const errorElement = page.getByText('Email is required')
  console.log('Error element found:', errorElement.length)

  await expect.element(errorElement).toBeInTheDocument()
})
```

### 3. Die gerenderte Ausgabe inspizieren

Wenn Komponenten nicht wie erwartet rendern, gehen Sie systematisch vor:

**Die Browser-UI von Vitest nutzen:**
- Führen Sie Tests mit aktiviertem Browser-Modus aus
- Öffnen Sie die im Terminal angezeigte Browser-URL, um die laufenden Tests zu sehen
- Die visuelle Prüfung hilft, CSS-Probleme, Layoutfehler oder fehlende Elemente zu erkennen

**Elementabfragen testen:**
```tsx
// Debug why elements can't be found
const button = page.getByRole('button', { name: /submit/i })
console.log('Button count:', button.length) // Should be 1

// Try alternative queries if the first one fails
if (button.length === 0) {
  console.log('All buttons:', page.getByRole('button').length)
  console.log('By test ID:', page.getByTestId('submit-btn').length)
}
```

### 4. Selektoren überprüfen

Probleme mit Selektoren sind eine häufige Ursache für Testfehler. Debuggen Sie sie systematisch:

**Zugängliche Namen prüfen:**
```tsx
// If getByRole fails, check what roles/names are available
const buttons = page.getByRole('button').all()
for (const button of buttons) {
  // Use element() to get the DOM element and access native properties
  const element = button.element()
  const accessibleName = element.getAttribute('aria-label') || element.textContent
  console.log(`Button: "${accessibleName}"`)
}
```

**Verschiedene Abfragestrategien ausprobieren:**
```tsx
// Multiple ways to find the same element using .or for auto-retrying
const submitButton = page.getByRole('button', { name: /submit/i }) // By accessible name
  .or(page.getByTestId('submit-button')) // By test ID
  .or(page.getByText('Submit')) // By exact text
// Note: Vitest doesn't have page.locator(), use specific getBy* methods instead
```

**Häufige Muster beim Debuggen von Selektoren:**
```tsx
test('debug element queries', async () => {
  render(<LoginForm />)

  // Check if element is visible and enabled
  const emailInput = page.getByLabelText(/email/i)
  await expect.element(emailInput).toBeVisible() // Will show if element is visible and print DOM if not
})
```

### 5. Async-Probleme debuggen

Bei Komponententests treten häufig Timing-Probleme auf:

```tsx
test('debug async component behavior', async () => {
  render(<AsyncUserProfile userId="123" />)

  // expect.element will automatically retry and show helpful error messages
  await expect.element(page.getByText('John Doe')).toBeInTheDocument()
})
```

## Migration von anderen Testframeworks

### Von Jest + Testing Library

Die meisten Tests mit Jest + Testing Library funktionieren mit minimalen Änderungen:

```ts
// Before (Jest)
import { render, screen } from '@testing-library/react' // [!code --]

// After (Vitest)
import { render } from 'vitest-browser-react' // [!code ++]
```

### Wesentliche Unterschiede

- Verwenden Sie für DOM-Assertions `await expect.element()` statt `expect()`
- Verwenden Sie für Nutzerinteraktionen `vitest/browser` statt `@testing-library/user-event`
- Der Browser-Modus liefert eine echte Browserumgebung für realitätsnahes Testen

## Weiterführendes

- [Dokumentation zum Browser-Modus](/guide/browser/)
- [Assertion-API](/api/browser/assertions)
- [Interactivity-API](/api/browser/interactivity)
- [Beispiel-Repository](https://github.com/vitest-tests/browser-examples)
