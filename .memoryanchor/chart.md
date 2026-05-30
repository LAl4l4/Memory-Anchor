# PROJECT CHART

## 1. Directory Skeleton
- /LICENSE: Source code module.
- /Makefile: Source code module.
- /README.md: Local documentation asset.
- /package.json: Project manifest, dependency definitions, and entry scripts.
- /src/cli.ts: Source code module.
- /src/commands/index.ts: Main entry gate and routing aggregator for this directory.
- /src/commands/init.ts: Source code module.
- /src/commands/status.ts: Source code module.
- /src/core/build-chart.ts: Source code module.
- /src/core/config.ts: Source code module.
- /src/core/context.ts: Source code module.
- /src/core/parser-loader.ts: Source code module.
- /src/hooks/past-session.ts: Source code module.
- /src/hooks/pre-session.ts: Source code module.
- /src/hooks/types.ts: Source code module.
- /src/index.ts: Main entry gate and routing aggregator for this directory.
- /src/types.ts: Source code module.
- /src/utils/ext-to-lang.ts: Source code module.
- /src/utils/logger.ts: Source code module.
- /src/utils/wasmbuilder.ts: Source code module.
- /tests/build-chart.test.js: Automated test suites and verification scripts.
- /tests/test-src/Sample.java: Automated test suites and verification scripts.
- /tests/test-src/sample.c: Automated test suites and verification scripts.
- /tests/test-src/sample.py: Automated test suites and verification scripts.
- /tree-sitter-parser/tree-sitter-c.wasm: Source code module.
- /tree-sitter-parser/tree-sitter-cpp.wasm: Source code module.
- /tree-sitter-parser/tree-sitter-css.wasm: Source code module.
- /tree-sitter-parser/tree-sitter-go.wasm: Source code module.
- /tree-sitter-parser/tree-sitter-html.wasm: Source code module.
- /tree-sitter-parser/tree-sitter-java.wasm: Source code module.
- /tree-sitter-parser/tree-sitter-javascript.wasm: Source code module.
- /tree-sitter-parser/tree-sitter-json.wasm: Source code module.
- /tree-sitter-parser/tree-sitter-python.wasm: Source code module.
- /tree-sitter-parser/tree-sitter-ruby.wasm: Source code module.
- /tree-sitter-parser/tree-sitter-rust.wasm: Source code module.
- /tree-sitter-parser/tree-sitter-scala.wasm: Source code module.
- /tree-sitter-parser/tree-sitter-swift.wasm: Source code module.
- /tree-sitter-parser/tree-sitter-tsx.wasm: Source code module.
- /tree-sitter-parser/tree-sitter-typescript.wasm: Source code module.
- /tsconfig.build.json: Source code module.
- /tsconfig.json: TypeScript compiler options and workspace path mappings.

## 2. Key Architecture Nodes
### /tests/test-src/Sample.java
- class Sample
- function add()

### /tests/test-src/sample.c
- function add()
- function main()
### /tests/test-src/sample.py
- function greet()
- class Greeter
- function __init__()
