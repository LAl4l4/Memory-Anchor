import * as fs from 'fs';

const WASM_PATTERN = /^tree-sitter-(.+)\.wasm$/;

/**
 * Scan a directory for tree-sitter WASM parser files and extract language names.
 * Filenames follow the convention: tree-sitter-{lang}.wasm → {lang}
 */
export function scanAvailableParsers(wasmDir: string): Set<string> {
    const parsers = new Set<string>();
    if (!fs.existsSync(wasmDir)) return parsers;

    const files = fs.readdirSync(wasmDir);
    for (const file of files) {
        const match = file.match(WASM_PATTERN);
        if (match) {
            parsers.add(match[1]);
        }
    }
    return parsers;
}
