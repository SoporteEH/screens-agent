import js from '@eslint/js';
import globals from 'globals';
import eslintPluginPrettierRecommended from 'eslint-plugin-prettier/recommended';

export default [
    {
        ignores: ['node_modules/', 'dist/', 'out/'],
    },
    js.configs.recommended,
    {
        files: ['**/*.js'],
        languageOptions: {
            ecmaVersion: 'latest',
            sourceType: 'commonjs',
            globals: globals.node,
        },
        rules: {
            'no-unused-vars': [
                'warn',
                { argsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
            ],
            'prefer-const': 'warn',
            'no-var': 'error',
            eqeqeq: ['error', 'always'],
        },
    },
    {
        // Renderer scripts loaded by the HTML pages; the shared ones also export for node:test.
        files: ['js/**/*.js'],
        languageOptions: {
            sourceType: 'script',
            globals: { ...globals.browser, module: 'readonly' },
        },
    },
    {
        // Preloads run in the renderer with Electron's require.
        files: ['*preload.js'],
        languageOptions: {
            globals: { ...globals.node, ...globals.browser },
        },
    },
    eslintPluginPrettierRecommended,
    // After the Prettier preset, which turns `curly` off.
    {
        rules: { curly: ['error', 'multi-line'] },
    },
];
