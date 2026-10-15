import eslintPluginPrettier from 'eslint-plugin-prettier';
import eslintConfigPrettier from 'eslint-config-prettier';

export default [
    {
        ignores: ['node_modules/', 'dist/', 'dist_electron/', 'out/'],
    },
    {
        files: ['**/*.js'],
        languageOptions: {
            ecmaVersion: 2021,
            sourceType: 'module',
            globals: {
                console: 'readonly',
                process: 'readonly',
                __dirname: 'readonly',
                __filename: 'readonly',
                module: 'readonly',
                require: 'readonly',
                exports: 'readonly',
                Buffer: 'readonly',
                setTimeout: 'readonly',
                setInterval: 'readonly',
                clearTimeout: 'readonly',
                clearInterval: 'readonly',
                global: 'readonly',
                fetch: 'readonly',
                URL: 'readonly',
            },
        },
        plugins: {
            prettier: eslintPluginPrettier,
        },
        rules: {
            'prettier/prettier': 'warn',
            'no-console': 'off',
            'no-unused-vars': [
                'warn',
                { argsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
            ],
            'no-undef': 'error',
            'prefer-const': 'warn',
            'no-var': 'warn',
            eqeqeq: ['warn', 'always'],
            curly: ['warn', 'all'],
        },
    },
    {
        // Renderer scripts loaded by the HTML pages, not by Node.
        files: ['js/**/*.js'],
        languageOptions: {
            sourceType: 'script',
            globals: {
                window: 'readonly',
                document: 'readonly',
                globalThis: 'readonly',
                Intl: 'readonly',
                Image: 'readonly',
                performance: 'readonly',
                requestAnimationFrame: 'readonly',
            },
        },
    },
    eslintConfigPrettier,
];
