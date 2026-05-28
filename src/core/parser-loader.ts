import Parser from "web-tree-sitter";
import fs from "fs";
import { fileURLToPath } from "url";
import path from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const cache = new Map<string, any>();

export async function loadLanguage(lang: string) {
    if (cache.has(lang)) return cache.get(lang);

    const wasmPath = path.join(
        __dirname,
        "../tree-sitter-parser",
        `${lang}.wasm`
    );
    const buffer = fs.readFileSync(wasmPath);

    const language = await Parser.Language.load(buffer);
    cache.set(lang, language);

    return language;
}