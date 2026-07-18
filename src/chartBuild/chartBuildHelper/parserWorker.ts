import * as fs from 'fs';
import { parentPort } from 'worker_threads';
import { Parser } from "web-tree-sitter";
import { loadLanguage } from '../parser-loader.js';
import { extractSymbols, FileNode } from './symbolExtractor.js';

// Per-worker state: init once, reuse parser across tasks
await Parser.init();

const parser = new Parser();
const langCache = new Map<string, any>();

// Signal to pool that this worker is ready
parentPort!.postMessage({ type: 'ready' });

parentPort!.on('message', async (msg: { absolutePath: string; relativePath: string; lang: string }) => {
    const { absolutePath, relativePath, lang } = msg;

    try {
        // Worker 自己读文件，不通过主线程传大字符串
        const source = fs.readFileSync(absolutePath, "utf-8");

        // Load language (per-worker cache since workers have isolated memory)
        let language = langCache.get(lang);
        if (!language) {
            language = await loadLanguage(lang);
            langCache.set(lang, language);
        }

        parser.setLanguage(language);
        const tree = parser.parse(source);

        // source 和 tree 在此处之后不再被引用，GC 会回收

        if (!tree || !tree.rootNode) {
            process.stderr.write(`\x1b[31m[Memory Anchor] ⚠️ Failed to parse ${relativePath}\x1b[0m\n`);
            parentPort!.postMessage({
                fileNode: {
                    relativePath,
                    language: lang,
                    symbols: []
                } satisfies FileNode
            });
            return;
        }

        const fileNode: FileNode = {
            relativePath,
            language: lang,
            symbols: []
        };

        extractSymbols(tree.rootNode, fileNode);

        parentPort!.postMessage({ fileNode });
    } catch (err) {
        parentPort!.postMessage({
            fileNode: {
                relativePath,
                language: lang,
                symbols: [{ type: "error", name: String(err) }]
            }
        });
    }
});
