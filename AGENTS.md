# 需求确认

- 需求不够明确时，先结合现有代码和对话梳理已知信息，再与用户交互式确认会影响范围、行为或验收标准的问题。等待用户确认相应需求后再实施依赖这些决定的改动，已明确且可独立完成的工作可以继续。

# Git 提交

- 完成一项独立改动并通过相关验证后，主动创建本地 Git 提交。一个任务包含多项可独立验证的改动时，可以分开提交。
- 提交前检查工作区、暂存区和待提交差异。只加入当前任务的改动，保留用户已有的无关改动及其暂存状态。若无法安全隔离，在回复中说明情况。
- 提交信息应简明描述实际改动。遵循用户当轮关于提交时机和范围的指示。推送需另获用户授权。

# 目录结构约定

- 根目录：Go 服务端源码（`package main`，按职责分文件）、`*_test.go`、`Dockerfile`、`compose.yaml`、`README.md`。服务端源码和测试是 source of truth。不放前端源码和运行时数据。
- `web/src/`：前端 TypeScript 源码，`web/src/admin/` 为管理后台。`web/test/`：前端 `node --test` 测试，命名为 `*.test.mjs`。`web/index.html` 与 `web/admin/index.html` 是 Vite 入口。
- `web/dist/`：Vite 构建产物，由 Go 服务和 Docker 镜像读取。属于 output，已被 git 忽略，不手工编辑，需要时重新构建。
- `docs/`：设计与计划文档，目前为空。功能落地后以代码和 README 为准，计划稿不长期保留。
- `data/`：本地运行时数据（中继设置、计量账本）。`.deployment/`：部署用证书与密码文件。`.env`、`compose.override.yaml`：部署配置。以上均不提交，也不写入文档示例的真实值。
- `bin/`、`/filetransfer`：本地构建的可执行文件，不提交，可随时删除重建。

# 验证命令

- `go vet ./... && go test -race ./...`
- `npm --prefix web run typecheck && npm --prefix web test && npm --prefix web run build`
