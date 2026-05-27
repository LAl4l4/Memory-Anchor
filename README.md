# CopilotWolf

CopilotWolf 是一个类似 openwolf 的 Copilot CLI 项目框架，仅包含基础结构与占位代码，方便后续扩展。

## 目录结构

- `src/cli.ts`：CLI 入口
- `src/commands/`：命令定义与注册
- `src/core/`：应用核心与配置
- `src/utils/`：通用工具
- `.github/extensions/`：Copilot CLI 扩展入口（已有）

## 开始使用

```bash
npm install
npm run build
npm start
```

运行 `copilotwolf init` 会在当前工作目录创建 `./.memoryanchor/`，包含：
- `chart.md`（项目地图：目录树与函数摘要）
- `ballast.md`（压舱铁律：习惯、教训与高频错题）
- `manifest.md`（Cross-Session Todo/Done 看板）

同时会创建 `./.github/hooks/memory-anchor.json` 作为 Memory Anchor hook 入口。
