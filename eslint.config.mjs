import typescriptEslint from '@typescript-eslint/eslint-plugin';
import typescriptParser from '@typescript-eslint/parser';
import prettier from 'eslint-plugin-prettier/recommended';
import simpleImportSort from 'eslint-plugin-simple-import-sort';
import unusedImports from 'eslint-plugin-unused-imports';

const plugins = {
  'simple-import-sort': simpleImportSort,
  'unused-imports': unusedImports,
};

const importRules = {
  'simple-import-sort/imports': 'error',
  'simple-import-sort/exports': 'error',
  'unused-imports/no-unused-imports': 'error',
};

const typescript = {
  languageOptions: {
    parser: typescriptParser,
    parserOptions: { sourceType: 'module', ecmaVersion: 'latest' },
  },
  plugins: { ...plugins, '@typescript-eslint': typescriptEslint },
  rules: {
    ...typescriptEslint.configs.recommended.rules,
    ...importRules,
    '@typescript-eslint/no-unused-vars': [
      'error',
      {
        args: 'all',
        argsIgnorePattern: '^_',
        caughtErrors: 'all',
        caughtErrorsIgnorePattern: '^_',
        destructuredArrayIgnorePattern: '^_',
        varsIgnorePattern: '^_',
        ignoreRestSiblings: true,
      },
    ],
  },
};

export default [
  // Claude Code's own writes, gitignored, which ESLint does not read.
  {
    ignores: [
      'home/.claude/skills/synced/',
      'home/.claude/skills/.trash/',
      '.claude/fallback/',
    ],
  },
  {
    files: ['scripts/*.mjs'],
    languageOptions: { sourceType: 'module', ecmaVersion: 'latest' },
    plugins,
    rules: importRules,
  },
  {
    files: ['scripts/*.mts', 'home/.claude/skills/*/scripts/**/*.mts'],
    ...typescript,
  },
  // Reports formatting as lint errors, against the root .prettierrc.yml.
  prettier,
];
