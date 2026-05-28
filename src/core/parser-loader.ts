import Parser from "web-tree-sitter";
import fs from "fs";

const cache = new Map<string, any>();

export async function loadLanguage(lang: string) {
  if (cache.has(lang)) return cache.get(lang);

  const wasmPath = `./tree-sitter-parser/${lang}.wasm`;
  const buffer = fs.readFileSync(wasmPath);

  const language = await Parser.Language.load(buffer);
  cache.set(lang, language);

  return language;
}