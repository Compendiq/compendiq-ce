# bail

- **Typ:** `number`
- **Standard:** `0`
- **CLI:** `--bail=<value>`

Bricht die Testausführung ab, sobald die angegebene Anzahl von Tests fehlgeschlagen ist.

Standardmäßig führt Vitest alle Testfälle aus, selbst wenn einige davon fehlschlagen. Für CI-Builds ist das unter Umständen nicht erwünscht, wenn man ausschließlich an zu 100 % erfolgreichen Builds interessiert ist und die Testausführung beim Auftreten von Fehlschlägen so früh wie möglich stoppen möchte. Mit der Option `bail` lassen sich CI-Läufe beschleunigen, indem verhindert wird, dass nach aufgetretenen Fehlschlägen weitere Tests ausgeführt werden.
