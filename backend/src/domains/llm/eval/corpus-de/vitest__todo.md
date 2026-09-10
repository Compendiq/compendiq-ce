# UnoCSS entfernen – Migration abgeschlossen

UnoCSS verursachte OOM-Fehler in der CI. Es wurde vollständig entfernt und durch `@iconify/vue` + einfaches CSS ersetzt.

## Zusammenfassung

- UnoCSS-Plugin aus `vite.config.ts` entfernt
- `uno.css`-Import aus `theme/index.ts` entfernt
- `@iconify/vue` für Icons hinzugefügt
- Alle UnoCSS-Utilities in scoped CSS überführt

## Erledigt

- [x] `vite.config.ts` – UnoCSS-Plugin entfernt
- [x] `theme/index.ts` – `import 'uno.css'` entfernt
- [x] `CRoot.vue` – @iconify/vue + CSS
- [x] `ListItem.vue` – @iconify/vue + CSS (Spinner-, Häkchen- und Schließen-Icons)
- [x] `CourseLink.vue` – @iconify/vue + CSS
- [x] `FeaturesList.vue` – einfaches CSS
- [x] `Advanced.vue` – einfaches CSS
- [x] `Experimental.vue` – einfaches CSS

## Testseiten

- `/guide/features` – FeaturesList, ListItem, CourseLink
- `/config/projects` – CRoot
- `/api/advanced/vitest` – Experimental

## Nicht verwendet (übersprungen)

- `HomePage.vue` – wird im neuen Theme nicht verwendet
