import babelParser from '@babel/eslint-parser';

// Syntax-only lint complements the repository's TypeScript 7 typecheck.
// Babel parses TS without imposing a conflicting TypeScript peer dependency.
export default [
  {
    files: [
      'src/server/delivery-*.ts',
      'scripts/delivery-admin.ts',
      'tests/delivery-*.ts',
      'tests/fixtures/delivery-security.ts',
    ],
    languageOptions: {
      parser: babelParser,
      parserOptions: {
        requireConfigFile: false,
        babelOptions: { plugins: ['@babel/plugin-syntax-typescript'] },
      },
    },
    rules: {
      'no-eval': 'error',
      'no-implied-eval': 'error',
      'no-new-func': 'error',
      'no-script-url': 'error',
      'no-debugger': 'error',
      'no-unreachable': 'error',
      'no-constant-condition': ['error', { checkLoops: false }],
      'no-dupe-args': 'error',
      'no-dupe-keys': 'error',
      'no-duplicate-case': 'error',
      'valid-typeof': 'error',
      eqeqeq: ['error', 'always'],
    },
  },
];
