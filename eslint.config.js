import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';

/**
 * Главное правило — границы слоёв (см. README):
 *   app → features → shared, и никогда обратно;
 *   фича импортирует другую фичу только через её index.ts.
 */
const featureNames = ['chat', 'tasks', 'calendar', 'contacts', 'files', 'mail', 'more', 'settings', 'admin', 'utm', 'guide'];

export default tseslint.config(
  { ignores: ['dist', 'node_modules'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['src/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  },
  {
    files: ['src/shared/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': ['error', { patterns: [
        { group: ['@/app', '@/app/*'], message: 'shared не зависит от app.' },
        { group: ['@/features', '@/features/*'], message: 'shared не зависит от фич.' },
      ] }],
    },
  },
  ...featureNames.map((name) => ({
    files: [`src/features/${name}/**/*.{ts,tsx}`],
    rules: {
      'no-restricted-imports': ['error', { patterns: [
        { group: ['@/app', '@/app/*'], message: 'Фичи не зависят от app.' },
        {
          group: featureNames.filter((n) => n !== name).map((n) => `@/features/${n}/*`),
          message: 'Другая фича — только через её публичный API: @/features/<name>.',
        },
      ] }],
    },
  })),
);
