import js from '@eslint/js';
import { defineConfig } from 'eslint/config';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-plugin-prettier/recommended';

export default defineConfig(
  { ignores: ['dist/**', 'temp/**', 'node_modules/**'] },
  {
    files: ['**/*.ts'],
    extends: [js.configs.recommended, tseslint.configs.recommended, prettier],
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/consistent-type-imports': 'error',
      'padding-line-between-statements': [
        'error',
        { blankLine: 'always', prev: 'export', next: 'export' },
      ],
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      'prettier/prettier': [
        'error',
        {
          tabWidth: 2,
          singleQuote: true,
          semi: true,
          trailingComma: 'all',
          printWidth: 100,
          endOfLine: 'lf',
        },
      ],
    },
  },
);
