import fs from "fs";
import path from "path";
import { execSync } from "child_process";
import { LANGS } from "../types.js";
//must work at the project root, otherwise the path will be messed up
const outDir = "./tree-sitter-parser";
const cacheDir = "./.tree-sitter-repos";

fs.mkdirSync(outDir, { recursive: true });
fs.mkdirSync(cacheDir, { recursive: true });

for (const lang of LANGS) {
  console.log(`\n========================================`);
  console.log(`正在处理语言: ${lang}`);
  console.log(`========================================`);

  // 1. 处理特殊仓库名或子目录的映射
  // 比如 typescript 和 tsx 通常都在 tree-sitter-typescript 这一个仓库里
  let repoName = `tree-sitter-${lang}`;
  let subDir = "";

  if (lang === "typescript" || lang === "tsx") {
    repoName = "tree-sitter-typescript";
    subDir = lang; // 对应仓库内的子目录
  }
  // 如果有其他非标准命名的语言，可以在这里继续写 if 分支进行映射

  const repoUrl = `https://github.com/tree-sitter/${repoName}.git`;
  const repoPath = path.resolve(cacheDir, repoName);
  const buildContextPath = path.resolve(repoPath, subDir);
  const targetWasmPath = path.resolve(outDir, `tree-sitter-${lang}.wasm`);

  try {
    // 2. Clone 或 Update 源码仓库
    if (!fs.existsSync(repoPath)) {
      console.log(`📥 正在 Clone 仓库: ${repoName}...`);
      execSync(`git clone --depth=1 ${repoUrl} ${repoPath}`, { stdio: "inherit" });
    } else {
      console.log(`🔄 仓库已存在，正在拉取最新代码...`);
      execSync(`git pull`, { cwd: repoPath, stdio: "inherit" });
    }

    // 3. 安装该语法仓库的依赖
    // 很多 tree-sitter 仓库在 build 之前需要运行 npm install 来生成必要的 parser.c
    const packageJsonPath = path.join(buildContextPath, "package.json");
    if (fs.existsSync(packageJsonPath)) {
      console.log(`📦 正在安装语法依赖...`);
      execSync(`npm install`, { cwd: buildContextPath, stdio: "inherit" });
    }

    // 4. 自动化构建 WASM
    console.log(`🏗️  正在本地编译 WASM...`);
    // 使用 -o (或 --output) 直接将生成的 wasm 目标文件输出到你的 src 目录
    execSync(`tree-sitter build --wasm -o ${targetWasmPath}`, {
      cwd: buildContextPath,
      stdio: "inherit",
    });

    console.log(`✅ 成功构建并保存: tree-sitter-${lang}.wasm`);
  } catch (err) {
    console.error(`❌ 语言 [${lang}] 构建失败:`, err);
  }
}