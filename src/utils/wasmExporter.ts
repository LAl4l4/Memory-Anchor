import fs from "fs";

const LANGS = [
  "javascript",
  "typescript",
  "tsx",
  "python",
  "java",
  "c",
  "cpp",
  "go",
  "rust",
  "php",
  "ruby",
  "kotlin",
  "swift",
  "c_sharp",
  "scala",
  "dart",
  "lua",
  "html",
  "css",
  "json",
  "yaml",
  "sql"
];

const base = "https://unpkg.com/tree-sitter-wasms@latest/out";
//must work at the project root, otherwise the path will be messed up
const outDir = "./src/tree-sitter-parser";

fs.mkdirSync(outDir, { recursive: true });

for (const lang of LANGS) {
  const url = `${base}/tree-sitter-${lang}.wasm`;

  console.log("downloading:", lang);

  const res = await fetch(url);

  if (!res.ok) {
    console.log("❌ failed:", lang);
    continue;
  }

  const buf = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(`${outDir}/${lang}.wasm`, buf);

  console.log("✅ saved:", lang);
}