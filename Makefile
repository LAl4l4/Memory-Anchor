# ==============================================================================
# 终极一键化：Git 提交 + 编译 + 提版 + Push + npm 发布
# ==============================================================================

BRANCH := $(shell git rev-parse --abbrev-ref HEAD)
VERSION ?= patch

MSG ?= chore: save work before release

.PHONY: patch minor major release chart-full chart-inc chart-registry chart-partitions

patch:
	@$(MAKE) release VERSION=patch

minor:
	@$(MAKE) release VERSION=minor

major:
	@$(MAKE) release VERSION=major

# ------------------------------------------------------------------------------
# 核心自动化链条
# ------------------------------------------------------------------------------
release:
	@echo "正在执行一键化发布流程，当前分支: $(BRANCH), 版本: $(VERSION)"
	
	@echo "➕ [2/6] 正在暂存所有本地改动，包含最新的编译产物 (git add .)..."
	git add .
	
	@echo "📝 [3/6] 正在提交代码 (git commit)..."
	git commit -m "$(MSG)" || echo "⚠️ 没有检测到代码变化，跳过 commit 步骤"
	
	@echo "🏷️ [4/6] 正在更新 npm 版本号 ($(VERSION))并自动生成 Tag..."
	npm version $(VERSION)
	
	@echo "📤 [5/6] 正在推送代码及所有 Tags 到远程分支 ($(BRANCH))..."
	git push origin $(BRANCH) --tags
	
	@echo "🌐 [6/6] 正在推送到 npm ..."
	npm publish
	
	@echo "✨ [DONE] 发布流程完成！请检查 npm 仓库确认发布成功。"

# ------------------------------------------------------------------------------
# 调试命令：手动触发 chart 构建
# ------------------------------------------------------------------------------

# 全量重建 chart
chart-full:
	@npm run build
	@node -e "import('./dist/chartBuild/buildChart.js').then(({ buildChartFull }) => buildChartFull())"

# 增量更新 chart，通过 FILES 变量传入文件列表
# Usage: make chart-inc FILES="src/index.ts src/utils/logger.ts"
FILES ?=
chart-inc:
	@npm run build
	@node -e "Promise.all([import('./dist/chartBuild/incremental.js'), import('./dist/chartBuild/buildChart.js')]).then(async ([{ updateChartIncrementally }, { destroyPool }]) => { const files = '$(FILES)'.split(' ').filter(Boolean); if (!files.length) { console.error('Usage: make chart-inc FILES=\"file1.ts file2.ts\"'); process.exitCode = 1; return; } try { await updateChartIncrementally(files); } finally { await destroyPool(); } })"

# 调试目录分区注册表（尚未接入正式 CLI）
chart-registry:
	@npm run build
	@node -e "import('./dist/chartBuild/buildChart.js').then(async ({ buildDirectoryTreeRegistryForDebug }) => { await buildDirectoryTreeRegistryForDebug(); console.error('[Memory Anchor] Directory registry written to: .memoryanchor/dirTree.json'); })"

# 调试完整目录分区：生成 registry，并写入镜像目录 chart
chart-partitions:
	@npm run build
	@node -e "import('./dist/chartBuild/partition/partitionedChartBuilder.js').then(async ({ buildPartitionedChartsForDebug }) => { const result = await buildPartitionedChartsForDebug(); console.error('[Memory Anchor] Partition directories: ' + result.directories.join(', ')); console.error('[Memory Anchor] Partitioned charts written: ' + result.chartPaths.length); console.error('[Memory Anchor] Chart index written to: ' + result.indexPath); })"
