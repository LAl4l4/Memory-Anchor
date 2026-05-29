# ==============================================================================
# 终极一键化：Git 提交 + 编译 + 提版 + Push + npm 发布
# ==============================================================================

BRANCH := $(shell git rev-parse --abbrev-ref HEAD)
VERSION ?= patch

# 🔥 默认的 Commit 信息，如果你不传 MSG 参数，就会用这行
MSG ?= chore: save work before release

.PHONY: patch minor major release

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
	
	@echo "🔍 [1/6] 正在执行打包编译 (npm run build)..."
	# 🔥 必须最先编译！让所有新生成的 dist 文件尘埃落定
	npm run build
	
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
	
	@echo "🌐 [6/6] 正在发布到 npm 镜像源..."
	npm publish
	
	@echo "✨ [DONE] 所有的工作都做完了！这次绝对一路绿灯！"