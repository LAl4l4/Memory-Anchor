# ==============================================================================
# 终极一键化：Git 提交 + 编译 + 提版 + Push + npm 发布
# ==============================================================================

BRANCH := $(shell git rev-parse --abbrev-ref HEAD)
VERSION ?= patch

MSG ?= chore: save work before release

.PHONY: patch minor major release chart-full chart-inc

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
	@echo "🚀 启动终极全自动发布流程..."
	
	@echo "➕ [2/6] 正在暂存所有本地改动，包含最新的编译产物 (git add .)..."
	git add .
	
	@echo "📝 [3/6] 正在提交代码 (git commit)..."
	# 把你的源码改动和刚刚编译出来的新文件一并打包提交
	git commit -m "$(MSG)" || echo "⚠️ 没有检测到代码变化，跳过 commit 步骤"
	
	@echo "🏷️ [4/6] 正在更新 npm 版本号 ($(VERSION))并自动生成 Tag..."
	# 此时工作区处于绝对干净的状态，npm version 100% 顺畅通过
	npm version $(VERSION)
	
	@echo "📤 [5/6] 正在推送代码及所有 Tags 到远程分支 ($(BRANCH))..."
	git push origin $(BRANCH) --tags
	
	@echo "🌐 [6/6] 正在发布到 npm ..."
	npm publish
	
	@echo "✨ [DONE] 所有的工作都做完了！这次绝对一路绿灯！"

# ------------------------------------------------------------------------------
# 调试命令：手动触发 chart 构建
# ------------------------------------------------------------------------------

# 全量重建 chart
chart-full:
	@npm run build
	@node -e "require('./dist/core/build-chart.js').buildChartFull()"

# 增量更新 chart，通过 FILES 变量传入文件列表
# Usage: make chart-inc FILES="src/index.ts src/utils/logger.ts"
FILES ?=
chart-inc:
	@npm run build
	@node -e "\
		var files = '$(FILES)'.split(' ').filter(function(f){return f.length>0}); \
		if (!files.length) { console.error('Usage: make chart-inc FILES=\"file1.ts file2.ts\"'); process.exit(1); } \
		require('./dist/core/build-chart.js').updateChartIncrementally(files)"