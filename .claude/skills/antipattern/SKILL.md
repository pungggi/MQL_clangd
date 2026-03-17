# MQL5 Anti-Pattern Detection Skill

Analyze the MQL5 codebase for general and platform-specific anti-patterns.

## Detection Rules

### General Anti-Patterns
1. **Magic numbers**: Replace with named constants or enumerations.
2. **Deep nesting**: Refactor complex conditional structures to early returns/guard clauses.
3. **Dead code**: Identify and remove unused variables, unreachable branches, or redundant functions.
4. **Code duplication**: Extract repetitive logic into shared include files (`.mqh`) or reusable functions.
5. **Naming issues**: Enforce consistent conventions (e.g., camelCase vs. PascalCase) and avoid shadowing global/platform symbols.

### MQL5-Specific Anti-Patterns
6. **Trading Error Handling**: Improper handling of `OrderSend`, `OrderModify`, or `OrderDelete`. Check return values and ensure `GetLastError()` is consulted for failures.
7. **Inefficient OnTick Logic**: Repeated recalculation of values instead of utilizing indicator handles or rates of change.
8. **Resource Management**: Failure to release indicator handles (`IndicatorRelease`) or file handles (`FileClose`) during deinitialization or after use.
9. **Input Validation**: Missing boundary checks for `input` variables that could lead to logic errors (e.g., negative lot size or stop loss).
10. **Blocking Operations**: Use of `Sleep()` or performing heavy I/O operations inside time-critical functions like `OnTick` or `OnTimer`.

## Severity Taxonomy

*   **Critical**: Breaks core functionality, security, or trading safety (e.g., unhandled `OrderSend` failures, resource leaks).
*   **Major**: Significant correctness, performance, or quality issues that could lead to bugs under specific conditions (e.g., blocking `OnTick`, missing input validation).
*   **Minor**: Style, maintainability, or minor optimizations (e.g., magic numbers, deep nesting, naming).

## Report Format

For each finding, provide a structured report using the following format:

### [Severity Level]
- [ ] **File**: `path/to/file.mq5`
- [ ] **Line**: `[Line Number]`
- [ ] **Issue**: [Description of the anti-pattern]
- [ ] **Suggestion**: [Concise fix or refactoring advice]

## Usage

**Verify each finding against the current code before reporting.**
**Ask for user confirmation before applying any automated fixes.**
