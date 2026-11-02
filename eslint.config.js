import tseslint from 'typescript-eslint';
export default [{
  files: ['src/**/*.ts', 'test/**/*.ts'],
  languageOptions: { parser: tseslint.parser },
  rules: { 'no-debugger': 'error', 'no-unreachable': 'error', 'no-dupe-keys': 'error' },
}];
