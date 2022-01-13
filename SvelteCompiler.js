import { createHash } from 'crypto';

import sourcemap from 'source-map';

import { processCode } from './scss-processor';

const SCSS_STYLE_REGEX = /<style[^>]+lang=['"]scss['"]/;
const GLOBAL_STYLE_EXTRACTION = '/** extracted into global style */';
const GLOBAL_STYLE_EXTRACTION_REGEX = /<style[^>]+global[^>]*>\/\*\* extracted into global style \*\/<\/style>/g;

const { createMakeHot } = require('svelte-hmr');

// PREPROCESS_VERSION can be used in development
// to invalidate caches
// In a published package, the cache is reset
// whenever the app updates to a new version.
const PREPROCESS_VERSION = 9;

const PACKAGE_NAME = 'r00t3g:melte';

SvelteCompiler = class SvelteCompiler extends CachingCompiler {
    constructor(options = {}) {
        super({
            compilerName: 'svelte',
            defaultCacheSize: 1024 * 1024 * 10
        });

        this.options = options;
        this.babelCompiler = new BabelCompiler;

        // Don't attempt to require `svelte/compiler` during `meteor publish`.
        if (!options.isPublishing) {
            try {
                this.svelte = require('svelte/compiler');
            } catch (error) {
                throw new Error(
                    'Cannot find the `svelte` package in your application. ' +
                    'Please install it with `meteor npm install svelte`.'
                );
            }

            try {
                require('node-sass');
            } catch (error) {
                throw new Error(
                    'Cannot find the `node-sass` package in your application. ' +
                    'Please install it with `meteor npm install node-sass`.'
                );
            }

            try {
                this.ts = require('svelte-preprocess/dist/transformers/typescript').transformer;
            } catch (error) {
                throw new Error(
                    'Cannot find the `svelte-preprocess` package in your application. ' +
                    'Please install it with `meteor npm install svelte-preprocess`.'
                );
            }

            this.makeHot = createMakeHot({
                meta: 'module',
                walk: this.svelte.walk,
                absoluteImports: false,
                hotApi: `meteor/${PACKAGE_NAME}/hmr-runtime.js`,
                preserveLocalState: false,
                adapter: `meteor/${PACKAGE_NAME}/proxy-adapter.js`,
            });
        }
    }

    hmrAvailable(file) {
        return typeof file.hmrAvailable === 'function' && file.hmrAvailable();
    }

    getCacheKey(file) {
        if (SCSS_STYLE_REGEX.test(file.getContentsAsString())) {
            // We intentionally omit caching now for components with SCSS styles,
            // otherwise it will demand a really complicated way of tracking
            // imported files as dependencies.
            return Date.now() + Math.random();
        }

        return [
            this.options,
            file.getPathInPackage(),
            file.getSourceHash(),
            file.getArch(),
            file.getPackageName(),
            this.hmrAvailable(file),
            process.env.NODE_ENV === 'production',
            {
                svelteVersion: this.svelte.VERSION,
                preprocessVersion: PREPROCESS_VERSION
            },
        ];
    }

    setDiskCacheDirectory(cacheDirectory) {
        this._diskCache = cacheDirectory;
    }

    _setBabelCacheDirectory(suffix) {
        // Babel doesn't use the svelte or preprocessor versions in its cache keys
        // so we instead use the versions in the cache path
        const babelSuffix = `-babel-${(this.svelte || {}).VERSION}-${PREPROCESS_VERSION}-${process.env.NODE_ENV
        === 'production'}-${suffix || ''}`;
        this.babelCompiler.setDiskCacheDirectory(this._diskCache + babelSuffix);
    }

    // The compile result returned from `compileOneFile` can be an array or an
    // object. If the processed HTML file is not a Svelte component, the result is
    // an array of HTML sections (head and/or body). Otherwise, it's an object
    // with JavaScript from a compiled Svelte component.
    compileResultSize(result) {
        let size = 0;

        if (Array.isArray(result)) {
            result.forEach(section => size += section.data.length);
        } else {
            size = result.data.length + result.sourceMap.toString().length;
        }

        return size;
    }

    compileOneFileLater(file, getResult) {
        file.addJavaScript({
            path: file.getPathInPackage()
        }, async () => {
            return await getResult();
        });
    }

    async compileOneFile(file) {
        let code = file.getContentsAsString();
        let map;
        const basename = file.getBasename();
        const path = file.getPathInPackage();
        const arch = file.getArch();

        const svelteOptions = {
            dev: this.options.dev ?? process.env.NODE_ENV !== 'production',
            filename: path,
            name: basename
                .slice(0, basename.indexOf('.')) // Remove extension
                .replace(/[^a-z0-9_$]/ig, '_') // Ensure valid identifier
        };

        // If the component was imported by server code, compile it for SSR.
        if (arch.startsWith('os.')) {
            svelteOptions.generate = 'ssr';
        } else {
            const { hydratable, css } = this.options;

            svelteOptions.hydratable = hydratable === true;
            svelteOptions.css = css === true;
        }

        if (this.options.cssHashPrefix) {
            svelteOptions.cssHash = ({ hash, css }) => `${this.options.cssHashPrefix}${hash(css)}`;
        }

        let error;

        try {
            ({ code, map } = (await this.svelte.preprocess(code, {
                script: ({ content, attributes }) => {
                    return attributes.lang === 'ts'
                        ? this.ts({ content, filename: path })
                        : { code: content };
                },
                style: async ({ content, attributes }) => {
                    if (attributes.lang === 'scss') {
                        const shallEmit = ('global' in attributes) || !svelteOptions.css;
                        const result = await processCode(file, path, { content, attributes });

                        result?.dependencies?.forEach((dependencyPath) => {
                            file.readAndWatchFile(dependencyPath);
                        });

                        if (!shallEmit) {
                            return result;
                        }

                        file.addStylesheet({
                            path: file.getBasename() + '.scss',
                            data: result.code,
                            sourceMap: result.map,
                            lazy: false,
                        });

                        return { code: GLOBAL_STYLE_EXTRACTION };
                    }

                    return { code: content };
                }
            })));
        } catch (e) {
            e.message += `\n${e.stack}`;
            file.error(e);
            return;
        }

        if (error) {
            error.message += `\n${error.stack}`;
            file.error(error);
            return;
        }

        let compiledResult;
        try {
            code = code.replace(GLOBAL_STYLE_EXTRACTION_REGEX, '');

            compiledResult = this.svelte.compile(code, svelteOptions);

            if (map) {
                compiledResult.js.map = this.combineSourceMaps(map, compiledResult.js.map);
            }

        } catch (e) {
            e.message += `\n${e.stack}`;
            file.error(e);
            return;
        }

        if (this.hmrAvailable(file)) {
            compiledResult.js.code = this.makeHot(
                path,
                compiledResult.js.code,
                {},
                compiledResult,
                code,
                svelteOptions
            );

            // makeHot is hard coded to use `import.meta` in some places
            // even when using the `meta` option.
            compiledResult.js.code = compiledResult.js.code.replace(
                'import.meta && import.meta.hot',
                'module && module.hot'
            );
        }

        try {
            return this.transpileWithBabel(
                compiledResult.js,
                path,
                file
            );
        } catch (e) {
            // Throw unknown errors.
            if (!e.start && e.message !== 'Babel compilation error!') {
                throw e;
            }

            let message;

            if (e.frame) {
                // Prepend a vertical bar to each line to prevent Meteor from trimming
                // whitespace and moving the code frame indicator to the wrong position.
                const frame = e.frame.split('\n').map(line => {
                    return `| ${line}`;
                }).join('\n');

                message = `${e.message}\n\n${frame}`;
            } else if (e.stack) {
                e.message += `\n${e.stack}`;
            } else {
                message = e.message;
            }

            file.error({
                message,
                line: e.start ? e.start.line : 0,
                column: e.start ? e.start.column : 0,
            });
        }
    }

    addCompileResult(file, result) {
        if (Array.isArray(result)) {
            result.forEach(section => file.addHtml(section));
        } else {
            file.addJavaScript(result);
        }
    }

    transpileWithBabel(source, path, file) {
        const optionsHash = createHash('md4')
            .update(JSON.stringify(this.options))
            .digest('hex')
            .substring(0, 6);

        // We need a different folder when HMR is enabled
        // to prevent babel from using those cache entries
        // in production builds
        this._setBabelCacheDirectory(`-${optionsHash}-${this.hmrAvailable(file) ? 'hmr-1.4.9' : '1.4.9'}`);

        let data = '', sourceMap = null;

        try {
            const result = this.babelCompiler.processOneFileForTarget(file, source.code);
            ({ data, sourceMap } = result || {});
        } catch (e) {
            e.message += `\n${e.stack}`;
            file.error(e);
        }

        if (!data || !sourceMap) {
            throw new Error('Babel compilation error!');
        }

        return {
            sourcePath: path,
            path,
            data,
            sourceMap: sourceMap ? this.combineSourceMaps(sourceMap, source.map) : source.map,
        };
    }

    // Generates a new source map that maps a file transpiled by Babel back to the
    // original HTML via a source map generated by the Svelte compiler.
    combineSourceMaps(targetMap, originalMap) {
        const result = new sourcemap.SourceMapGenerator;

        const targetConsumer = new sourcemap.SourceMapConsumer(targetMap);
        const originalConsumer = new sourcemap.SourceMapConsumer(originalMap);

        targetConsumer.eachMapping(mapping => {
            // Ignore mappings that don't have a source.
            if (!mapping.source) {
                return;
            }

            const position = originalConsumer.originalPositionFor({
                line: mapping.originalLine,
                column: mapping.originalColumn
            });

            // Ignore mappings that don't map to the original HTML.
            if (!position.source) {
                return;
            }

            result.addMapping({
                source: position.source,
                original: {
                    line: position.line,
                    column: position.column
                },
                generated: {
                    line: mapping.generatedLine,
                    column: mapping.generatedColumn
                }
            });
        });

        if (originalMap.sourcesContent && originalMap.sourcesContent.length) {
            // Copy source content from the source map generated by the Svelte compiler.
            // We can just take the first entry because only one file is involved in the
            // Svelte compilation and Babel transpilation.
            result.setSourceContent(originalMap.sources[0], originalMap.sourcesContent[0]);
        }

        return result.toJSON();
    }
};
