# includeTaskLocation

- **Typ:** `boolean`
- **Standard:** `false`

Legt fest, ob die Eigenschaft `location` enthalten sein soll, wenn die Vitest-API Tasks in [Reportern](/config/reporters) entgegennimmt. Wenn Sie viele Tests haben, kann dies zu einer kleinen Performance-Einbuße führen.

Die Eigenschaft `location` enthält die Werte `column` und `line`, die der Position von `test` oder `describe` in der Originaldatei entsprechen.

Diese Option wird automatisch aktiviert, wenn Sie sie nicht ausdrücklich deaktivieren und Vitest in einer der folgenden Konstellationen ausführen:
- [Vitest UI](/guide/ui)
- oder im [Browser-Modus](/guide/browser/) ohne [Headless](/guide/browser/#headless)-Modus
- oder mit dem [HTML-Reporter](/guide/reporters#html-reporter)

::: tip
Diese Option hat keine Auswirkung, wenn Sie keinen eigenen Code verwenden, der darauf angewiesen ist.
:::
