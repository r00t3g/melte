Package.describe({
    name: 'r00t3g:melte',
    version: '1.4.10',
    summary: 'Svelte compiler with tracker integration, HMR and preprocessing support',
    git: 'https://github.com/r00t3g/melte.git',
    documentation: 'README.md'
});

const hmrVersion = '0.12.3';

Package.registerBuildPlugin({
    name: 'melte-compiler',
    use: [
        'babel-compiler@7.3.4',
        'caching-compiler@1.2.1',
        'ecmascript@0.12.7',
    ],
    sources: [
        'SvelteCompiler.js',
        'plugin.js'
    ],
    npmDependencies: {
        'source-map': '0.5.6',
        'svelte-hmr': hmrVersion,
    }
});

Npm.depends({
    'svelte-hmr': hmrVersion
});

Package.onUse(function (api) {
    api.versionsFrom('1.8.1');
    api.use('isobuild:compiler-plugin@1.0.0');
    api.use('modules', 'client');

    // Dependencies for compiled Svelte components (taken from `ecmascript`).
    api.imply([
        'ecmascript-runtime',
        'babel-runtime',
        'promise'
    ]);
});
