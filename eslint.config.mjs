// Reuses the harness's script configs, whose plugin imports resolve from .claude/hooks/node_modules.
// This repository has no node_modules, so .vscode/settings.json points eslint.nodePath there too.

import prettier from './.claude/hooks/node_modules/eslint-plugin-prettier/recommended.js';
import scripts from './.claude/hooks/eslint.scripts.config.mjs';
import skills from './.claude/hooks/eslint.skills.config.mjs';

export default [
  // Claude Code's own writes, gitignored, which ESLint does not read.
  { ignores: ['home/.claude/skills/synced/', 'home/.claude/skills/.trash/'] },
  ...scripts.map((config) => ({ ...config, basePath: 'scripts' })),
  ...skills.map((config) => ({ ...config, basePath: 'home/.claude/skills' })),
  // Reports formatting as lint errors, against the root .prettierrc.yml.
  prettier,
];
