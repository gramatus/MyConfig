// Reuses the harness's script configs, whose plugin imports resolve from .claude/hooks/node_modules.
// This repository has no node_modules, so .vscode/settings.json points eslint.nodePath there too.

import scripts from "./.claude/hooks/eslint.scripts.config.mjs";
import skills from "./.claude/hooks/eslint.skills.config.mjs";

export default [
  ...scripts.map((config) => ({ ...config, basePath: "scripts" })),
  ...skills.map((config) => ({ ...config, basePath: "home/.claude/skills" })),
];
