## Bug Fixing 
When fixing bugs in MQL5 code, trace the actual execution path through git history before proposing fixes. Do not attempt multiple speculative fixes in sequence - instead, build understanding first, then propose one well-reasoned fix.

Before proposing any fix, trace the execution path through the relevant code. Check git log and git diff for recent changes to these files. Show me your understanding of what changed and why the bug occurs, then propose ONE fix with your confidence level.

## Project Context
This project uses MQL5 (MetaTrader 5) extensively. MQL5 files use .mqh/.mq5 extensions. Key patterns: objects can have helper objects, EAs (Expert Advisors) run on charts, reinit cycles must preserve state, and chart objects broadcast across symbols/timeframes. Always consider these MQL5-specific behaviors when debugging.

## Planning & Design
When asked for a plan or design, start with the minimal viable scope. Do not propose broad multi-component solutions unless explicitly asked. Prefer incremental approaches.

## Code Quality
After renaming variables or refactoring across multiple files, grep for naming collisions where a renamed variable might shadow a parameter or local variable in the same scope.