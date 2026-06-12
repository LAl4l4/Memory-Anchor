import { Parser, Language } from "web-tree-sitter";

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { scanAvailableParsers } from "./scan-parsers.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const cache = new Map<string, Language>();
let availableParsers: Set<string> | null = null;

void Parser;

/**
 * Return the set of language names that have a corresponding tree-sitter WASM parser.
 * Result is cached after the first call.
 */
export function getAvailableParsers(): Set<string> {
    if (availableParsers) return availableParsers;

    const wasmDir = path.join(__dirname, "..", "..", "tree-sitter-parser");
    availableParsers = scanAvailableParsers(wasmDir);
    return availableParsers;
}

export async function loadLanguage(lang: string) {
    if (cache.has(lang)) {
        return cache.get(lang)!;
    }

    const wasmPath = path.join(
        __dirname,
        "..",
        "..",
        "tree-sitter-parser",
        `tree-sitter-${lang}.wasm`
    );

    const buffer = fs.readFileSync(wasmPath);

    const language = await Language.load(
        new Uint8Array(buffer)
    );

    cache.set(lang, language);

    return language;
}