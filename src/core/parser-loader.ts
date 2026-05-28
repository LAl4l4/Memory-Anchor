import { Parser, Language } from "web-tree-sitter";

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const cache = new Map<string, Language>();

void Parser;

export async function loadLanguage(lang: string) {
    if (cache.has(lang)) {
        return cache.get(lang)!;
    }

    const wasmPath = path.join(
        __dirname,
        "..",
        "..",
        "tree-sitter-parser",
        `${lang}.wasm`
    );

    const buffer = fs.readFileSync(wasmPath);

    const language = await Language.load(
        new Uint8Array(buffer)
    );

    cache.set(lang, language);

    return language;
}