// Bug-class rules only: each one catches code that does something other than it says. Style is
// left alone. Findings that existed when this was added are recorded in eslint-suppressions.json,
// so only new ones fail `verify`. Fixing a recorded one: run `npx eslint --prune-suppressions`.
import globals from 'globals';

const bugs = {
  'array-callback-return': 'error',
  'for-direction': 'error',
  'getter-return': 'error',
  'no-async-promise-executor': 'error',
  'no-compare-neg-zero': 'error',
  'no-cond-assign': 'error',
  'no-const-assign': 'error',
  'no-constant-binary-expression': 'error',
  'no-dupe-args': 'error',
  'no-dupe-class-members': 'error',
  'no-dupe-else-if': 'error',
  'no-dupe-keys': 'error',
  'no-duplicate-case': 'error',
  'no-fallthrough': 'error',
  'no-func-assign': 'error',
  'no-import-assign': 'error',
  'no-loss-of-precision': 'error',
  'no-self-assign': 'error',
  'no-setter-return': 'error',
  'no-sparse-arrays': 'error',
  'no-undef': 'error',
  'no-unmodified-loop-condition': 'error',
  'no-unreachable': 'error',
  'no-unsafe-finally': 'error',
  'no-unsafe-negation': 'error',
  'no-unsafe-optional-chaining': 'error',
  'use-isnan': 'error',
  'valid-typeof': 'error',
};

export default [
  { ignores: ['dist*/**', 'node_modules/**', 'reports/**', 'test-results/**', 'fixtures/**', 'fixtures-perf/**', '**/vendor/**', '.claude/**', '.pipeline/**', 'crates/**/target/**', 'sidecar/**/target/**'] },
  { files: ['**/*.{js,mjs}'], languageOptions: { ecmaVersion: 'latest', sourceType: 'module', globals: { ...globals.node } }, linterOptions: { reportUnusedDisableDirectives: 'off' }, rules: bugs },
  // esbuild replaces these at build time (build/build.mjs).
  { files: ['app/**/*.js'], languageOptions: { globals: { ...globals.browser, ...globals.worker, __APP_VERSION__: 'readonly', __BUILD_DATE__: 'readonly', __DEV__: 'readonly', __DEFAULT_MODEL__: 'readonly' } } },
  // The analysis worker's runtime defines GW for the modules it loads.
  { files: ['app/src/workers/**/*.js'], languageOptions: { globals: { GW: 'readonly' } } },
  { files: ['crates/**/*.{js,mjs}'], languageOptions: { globals: { ...globals.worker } } },
  // Browser-side code: the sidecar's own UI, and the page.evaluate callbacks in browser tests.
  { files: ['sidecar/ui/**/*.{js,mjs}', 'tests/{e2e,tools,firefox,ios,android}/**/*.{js,mjs}'], languageOptions: { globals: { ...globals.browser } } },
];
