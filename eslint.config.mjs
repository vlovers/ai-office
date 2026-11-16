import babelParser from '@babel/eslint-parser';
import reactHooks from 'eslint-plugin-react-hooks';

// Syntax-aware lint complementing the TypeScript 7 typecheck (which owns types and
// unused locals/parameters via noUnusedLocals/noUnusedParameters).
// typescript-eslint is not used: it requires TypeScript <6.1, and typed rules such as
// no-floating-promises are therefore unavailable. local/no-floating-async-call is a
// deliberately narrow, untyped substitute for the patterns used in this repository.

const parser = (tsx) => ({
  parser: babelParser,
  parserOptions: {
    requireConfigFile: false,
    babelOptions: {
      plugins: tsx
        ? ['@babel/plugin-syntax-jsx', '@babel/plugin-syntax-typescript']
        : ['@babel/plugin-syntax-typescript'],
    },
  },
});

/** Reports promise-returning calls whose rejection would be unhandled. */
const noFloatingAsyncCall = {
  meta: {
    type: 'problem',
    docs: { description: 'Require same-file async calls and .then/.finally chains to be handled' },
    messages: {
      floating:
        "Promise from async '{{name}}' is neither awaited, returned, nor explicitly voided.",
      chain: 'Promise chain ends in .{{name}}() without a rejection handler.',
    },
    schema: [],
  },
  create(context) {
    const asyncNames = new Set();
    const statements = [];
    const isAsyncFunction = (node) =>
      node &&
      (node.type === 'ArrowFunctionExpression' || node.type === 'FunctionExpression') &&
      node.async;
    const nameOf = (key) => (key?.type === 'Identifier' ? key.name : undefined);
    return {
      FunctionDeclaration(node) {
        if (node.async && node.id) asyncNames.add(node.id.name);
      },
      MethodDefinition(node) {
        if (node.value.async && nameOf(node.key)) asyncNames.add(nameOf(node.key));
      },
      'PropertyDefinition, ClassProperty'(node) {
        if (isAsyncFunction(node.value) && nameOf(node.key)) asyncNames.add(nameOf(node.key));
      },
      VariableDeclarator(node) {
        if (isAsyncFunction(node.init) && nameOf(node.id)) asyncNames.add(nameOf(node.id));
      },
      ExpressionStatement(node) {
        if (node.expression.type === 'CallExpression') statements.push(node.expression);
      },
      'Program:exit'() {
        for (const call of statements) {
          const callee = call.callee;
          if (callee.type === 'MemberExpression' && !callee.computed) {
            const method = nameOf(callee.property);
            if ((method === 'then' && call.arguments.length < 2) || method === 'finally') {
              context.report({ node: call, messageId: 'chain', data: { name: method } });
              continue;
            }
          }
          const name =
            callee.type === 'Identifier'
              ? callee.name
              : callee.type === 'MemberExpression' &&
                  callee.object.type === 'ThisExpression' &&
                  !callee.computed
                ? nameOf(callee.property)
                : undefined;
          if (name && asyncNames.has(name))
            context.report({ node: call, messageId: 'floating', data: { name } });
        }
      },
    };
  },
};

const securityRules = {
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
};
// Async and correctness hazards. Errors fail CI; warnings are tracked debt (see README).
const correctnessRules = {
  'local/no-floating-async-call': 'error',
  'no-async-promise-executor': 'error',
  'no-promise-executor-return': 'error',
  'no-unsafe-finally': 'error',
  'no-unsafe-optional-chaining': 'error',
  'no-unsafe-negation': 'error',
  'no-self-compare': 'error',
  'no-self-assign': 'error',
  'no-unreachable-loop': 'error',
  'no-constant-binary-expression': 'error',
  'no-fallthrough': 'error',
  'no-import-assign': 'error',
  'no-cond-assign': 'error',
  'no-compare-neg-zero': 'error',
  'no-sparse-arrays': 'error',
  'no-shadow-restricted-names': 'error',
  'no-new-native-nonconstructor': 'error',
  'no-with': 'error',
  'no-shadow': ['warn', { builtinGlobals: false, hoist: 'functions' }],
  'prefer-promise-reject-errors': 'warn',
};

export default [
  { ignores: ['dist/**', 'node_modules/**', '.ai-office/**', 'coverage/**'] },
  {
    files: ['src/**/*.ts', 'scripts/**/*.ts', 'tests/**/*.ts', '*.config.ts'],
    languageOptions: parser(false),
    plugins: { local: { rules: { 'no-floating-async-call': noFloatingAsyncCall } } },
    rules: { ...securityRules, ...correctnessRules },
  },
  {
    files: ['src/**/*.tsx'],
    languageOptions: parser(true),
    plugins: {
      local: { rules: { 'no-floating-async-call': noFloatingAsyncCall } },
      'react-hooks': reactHooks,
    },
    rules: {
      ...securityRules,
      ...correctnessRules,
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
    },
  },
  {
    // Plain ESM scripts and fixtures (no TypeScript syntax).
    files: ['scripts/**/*.mjs', 'tests/**/*.mjs', 'eslint.config.mjs'],
    plugins: { local: { rules: { 'no-floating-async-call': noFloatingAsyncCall } } },
    rules: { ...securityRules, ...correctnessRules },
  },
];
