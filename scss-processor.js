import { resolve, dirname } from 'path';

const appdir = resolve(process.cwd());

const includePaths = [
    appdir,
    resolve(appdir, 'node_modules'),
];

export async function processCode(file, filename, { content }) {
    const transformer = require('svelte-preprocess/dist/transformers/scss').transformer;

    try {
        return await transformer({
            content,
            filename,
            options: {
                includePaths,
                sourceMap: true,
                importer: [
                    function (url, prev, done) {
                        done({
                            file: resolve(
                                url.indexOf('.') === 0
                                    ? dirname(filename)
                                    : appdir,
                                url.replace(/^\//, '')
                            )
                        });
                    }
                ]
            }
        });
    } catch (e) {
        e.message += `\n${e.stack}`;
        file.error(e);
        return { code: '' };
    }
}
