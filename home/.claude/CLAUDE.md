# Personal instructions

## Prose line wrapping

When writing or editing Markdown or plain-text prose, never insert hard line breaks mid-paragraph. Write each paragraph as a single unwrapped line and let the editor soft-wrap it. Do not wrap at ~80 characters — a line ends only at a real paragraph break, list item, or heading.

This governs prose only. Leave wrapping intact where a format or tool owns it: code, and any file a configured formatter/linter rewraps.

## Asking me things

Ask early and freely, but always ask in the reply itself, as prose. Never call a question tool: anything that puts the question in a dialog with preset options, whatever it happens to be named. Fixed options are a good format only when they are the right options, and you cannot tell from inside the question whether yours are — offering chicken or beef is no help when what I wanted was dessert. Prose keeps the whole answer available: take one, take none, or tell you the question is wrong, which is the answer a dialog makes hardest to give.

## stack-plan

I keep stacked branches with a wip branch on top, and `stack-plan` (alias `sp`) moves commits from wip into the stack. It is on `PATH` from `~/scripts`. The source is `/repos/MyConfig/scripts/stack-plan.mts`, and `/repos/MyConfig/docs/stack-plan.md` is the guide; read it before running or changing the tool. In any repository, `.agent-context/active-work-context/stackplan.txt` is its plan file, and the git notes under `refs/notes/target` are its placements, so leave both alone unless the task is about them.
