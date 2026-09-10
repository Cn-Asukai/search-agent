# search-agent — 汉化版本检索服务

服务端搜索 agent:用户提交作品名(轻小说 / 漫画),由 [opencode](https://opencode.ai) 驱动的 LLM agent 联网检索该作品**是否存在中文版本**(官方中文出版 / 正版平台引进 / 民间汉化),返回带来源链接的结构化结论。

```
客户端 ──HTTP/SSE──▶ 本服务(Effect HttpRouter)──SDK──▶ 内嵌 opencode serve ──MCP──▶ websearch-mcpserver
                                                                └──▶ LLM(自定义网关)
```

架构与模块依赖见 [`docs/architecture.md`](docs/architecture.md)。

## 前置安装

1. **Node.js >= 22.16**(SQLite 用 `node:sqlite`;也用了原生 `process.loadEnvFile`)
2. **opencode CLI**(本服务启动时自动 spawn `opencode serve`):

   ```bash
   npm install -g opencode-ai
   opencode --version   # 确认可用
   ```

3. **模型与 API key**(必填),二选一:
   - **自定义网关**(推荐,不绑定厂商):在 `.env` 填 `LLM_BASE_URL`(通常以 `/v1` 结尾)、`LLM_API_KEY`、`LLM_MODEL`(发给上游的模型名);
   - **官方 provider**:运行 `opencode auth login`,再用 `OPENCODE_MODEL=provider/model-id` 指定(如 `anthropic/claude-sonnet-4-5`)。

4. **websearch-mcpserver**(联网搜索,必填):
   - 从 [Releases](https://github.com/daidaiJ/websearch-mcpserver/releases) 下载 Windows 版;
   - 运行 `websearch-mcpserver.exe start`(默认监听 `127.0.0.1:8338`,零 API key 即可用百度 + Bing + DuckDuckGo);
   - 本仓库 [`websearch.config.yaml`](websearch.config.yaml) 仅给 Docker compose 内网用(`host: 0.0.0.0`),禁止当裸金属配置。
   - 启用 `WEBSEARCH_TOKEN` 时三处必须同时开:`.env` / compose 注入、`websearch.config.yaml` 的 `auth_token`、`opencode.jsonc` 的 `Authorization: Bearer`。空 token 仍可能不鉴权。

## 启动

```bash
npm install
cp .env.example .env   # 按需修改(全部有默认值,可不改)
npm run dev            # 开发模式(热重载);生产用 npm start
```

## 前端（Vite + React + shadcn）

浏览器界面在 [`web/`](web/)。开发时 Vite 把 `/api` 代理到本服务 `http://127.0.0.1:8787`。

```bash
# 终端 1：本服务
npm run dev

# 终端 2：前端
npm install --prefix web
npm run web:dev          # http://127.0.0.1:5173
```

生产构建与预览：

```bash
npm run web:build
npm run web:preview      # http://127.0.0.1:4173，同样代理到 :8787
```

前端测试（驱动 shipped HTTP/SSE client）：

```bash
npm run web:test
```

页面可提交 `query` + `type`（`novel` | `manga` | `unknown`），以 `stream: true` 调用 `POST /api/search`，渲染 `progress` 与终态 `result` / `error`；也可按任务 id 调用 `GET /api/search/:id`。

启动成功会输出服务地址与内嵌 opencode 地址。`websearch-mcpserver` 未启动也不影响本服务启动,只是检索任务的搜索工具不可用(可在 `/api/health` 里看 opencode 是否健康)。必须从项目根目录启动(`npm run dev` / `npm start`),opencode 才能加载 `opencode.jsonc` 与 `prompts/`。

## Docker 使用

### 本地 Docker 开发

开发覆盖文件让 `agent` 从当前工作树构建，本地镜像标签为 `search-agent:dev`；`websearch` 仍从 `ghcr.io/daidaij/websearch-mcpserver` 拉取。它不修改正式部署使用的基础清单。

```bash
# 1. 准备环境变量(必填:自定义网关)
cp .env.example .env
#    编辑 .env,填入 LLM_BASE_URL / LLM_API_KEY / LLM_MODEL

# 2. 合并开发覆盖文件，构建本地 agent 并等待两个服务健康
docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d --build --wait

# 3. 验证
curl http://localhost:8787/api/health
```

源码改动后重复第 2 步即可重新构建 `search-agent:dev`。首次构建可能拉取 `node:24-bookworm-slim`；这是 Dockerfile 的基础镜像前置条件，不是拉取 `ghcr.io/cn-asukai/search-agent`。`websearch` 仍会按其远程拉取策略获取镜像。

### 正式 Docker 部署(推荐)

基础 compose 清单只拉取远程镜像并部署：**agent 服务**(HTTP `:8787`，镜像 `ghcr.io/cn-asukai/search-agent`，多架构 `linux/amd64` + `linux/arm64`)+ **websearch MCP 服务**(内网 `:8338`，镜像 `ghcr.io/daidaij/websearch-mcpserver`)。不叠加 `docker-compose.dev.yml` 时，以下命令始终使用已发布的 GHCR agent 镜像。compose 默认把 agent 端口绑在 `127.0.0.1:${AGENT_PORT:-8787}`，只对本机可达；对外走 [`deploy/nginx/search-agent.conf`](deploy/nginx/search-agent.conf)。容器内仍 `HOST=0.0.0.0`。未配置 `API_AUTH_KEY` 时服务仍会监听（空值=不鉴权）。

```bash
# 1. 准备环境变量(必填:自定义网关)
cp .env.example .env
#    编辑 .env,填入 LLM_BASE_URL / LLM_API_KEY / LLM_MODEL

# 2. 拉取并启动远程发布镜像
docker compose pull && docker compose up -d

# 3. 验证已发布镜像的健康端点
curl http://localhost:8787/api/health
```

私有 GHCR 包需先登录:`echo $GITHUB_TOKEN | docker login ghcr.io -u <github-user> --password-stdin`。

要点:

- **模型凭据**:镜像内不执行 `opencode auth login`。在 `.env` 填 `LLM_BASE_URL`、`LLM_API_KEY`、`LLM_MODEL` 即可对接任意 OpenAI 兼容网关,不绑定厂商或具体模型。Anthropic 原生协议把 [`opencode.jsonc`](opencode.jsonc) 里的 `npm` 改成 `@ai-sdk/anthropic` 后重建 agent 镜像。
- **端口**:compose 默认映射 `127.0.0.1:${AGENT_PORT:-8787}:8787`，只对本机可达。对外走 [`deploy/nginx/search-agent.conf`](deploy/nginx/search-agent.conf)。容器内 `HOST=0.0.0.0` 不变；未配置 `API_AUTH_KEY` 时服务仍监听（空值=不鉴权）。
- **websearch**:compose 从 `ghcr.io/daidaij/websearch-mcpserver` 拉取,把仓库根目录 [`websearch.config.yaml`](websearch.config.yaml) 挂到容器 `/app/config.yaml`(已显式 `host: "0.0.0.0"` 与 `baidu.web_enabled: true`)。**这份 yaml 仅 compose 内网用,禁止当裸金属配置。** `WEBSEARCH_TOKEN` 由 compose 注入,与 yaml `auth_token`、`opencode.jsonc` 的 `Authorization` 三处必须同时开;空 token 仍可能不鉴权。agent 经 compose 内网服务名 `websearch:8338` 访问 MCP;监听地址写在 YAML 里,不要用 `APP_HOST`。不依赖宿主机上跑的 websearch 进程。镜像暂钉 `platform: linux/amd64`(ARM 主机走 QEMU);上游发 arm64 后去掉。
- **数据持久化**:全部落到仓库根目录 `data/`(已 gitignore):任务 SQLite 在 `data/search-agent.sqlite`(`SQLITE_PATH=/home/node/data/search-agent.sqlite`),opencode 会话在 `data/opencode/`,websearch 搜索缓存在 `data/websearch/`。`docker compose down` / `down -v` 都不会删宿主机 `data/`。容器以 `node`(uid 1000) 跑;若宿主机 `data/` 是 root 创建的,旧镜像会因 `EACCES` 起不来,当前镜像入口会在启动时 chown。
- **代理**:内嵌 opencode 首次运行需联网安装 AI SDK provider 包、模型 API 需出网。需要代理时,在 `docker-compose.yml` 的 `agent.environment` 取消 `HTTP(S)_PROXY` 注释(指向 `host.docker.internal:7897` 之类的宿主代理)。
- 停止:`docker compose down`;看日志:`docker compose logs -f agent websearch`。

本仓库根目录 [`Dockerfile`](Dockerfile) 只构建 agent 镜像(不含 MCP)。Apple Silicon / ARM 主机上 agent 会拉原生 arm64;websearch 仍走 amd64 模拟,直到上游发布 arm64。每次 git push 还会由 `.github/workflows/sync-cnb.yml` 同步到 CNB 仓 [longlian.online/search-agent](https://cnb.cool/longlian.online/search-agent)。发版见下方「发布」。

## 发布

之后发版只走 **`npm version`**,不要单独 `git tag`。在要发版的分支(一般是 `main`)、工作区干净时:

```bash
npm version patch -m "chore: release %s"   # 或 minor / major / 绝对版本如 0.2.5
git push origin HEAD --follow-tags
```

`npm version` 会改根目录 `package.json` 与 lock、提交,并打 `vX.Y.Z`。`--follow-tags` 把提交和 tag 一起推上去后,[`publish-docker.yml`](.github/workflows/publish-docker.yml) 构建 **linux/amd64 + linux/arm64** 并推到 GHCR 与 CNB。本包 `"private": true`,不要 `npm publish`。

`patch` / `minor` / `major` 相对的是 **当前 `package.json` 的 version**。若它落后于已有 git tag,第一次对齐用绝对版本(例如现为 `0.1.0`、tag 已到 `v0.2.4` 时用 `npm version 0.2.5`)。

`/api/health` 的 `version` 来自该 tag(镜像构建注入 `GIT_VERSION`);本地 `npm run dev` 用 `git describe --tags --always --dirty`。`revision` 是完整 commit SHA。仅 `vX.Y.Z` 发版会构建镜像;`v0.2.5` 会打 `0.2.5` / `0.2` / `v0.2.5`;仅非预发布 semver(不含 `-` 的 `vX.Y.Z`)才会移动 `latest`。

- GHCR:`ghcr.io/cn-asukai/search-agent`
- CNB:`docker.cnb.cool/longlian.online/search-agent`

本地 Compose 开发镜像内没有 `.git`,构建时自行传入:

```bash
GIT_VERSION=$(git describe --tags --always --dirty) GIT_REVISION=$(git rev-parse HEAD) \
  docker compose -f docker-compose.yml -f docker-compose.dev.yml up --build
```

PR 打开、同步或重开时,[OpenCodeReview](https://open-codereview.ai/docs/cicd) 会自动审查 diff(`.github/workflows/ocr-review.yml`);也可在 PR 评论 `/open-code-review` 或 `@open-code-review` 手动重跑。需在仓库 **Settings → Secrets and variables → Actions** 配置:

| 名称 | 类型 | 说明 |
|---|---|---|
| `OCR_LLM_URL` | Secret | LLM API 端点(如 `https://api.openai.com/v1/chat/completions`) |
| `OCR_LLM_AUTH_TOKEN` | Secret | LLM 鉴权 token |
| `OCR_LLM_MODEL` | Variable | 模型名 |
| `OCR_LLM_USE_ANTHROPIC` | Variable | Anthropic 填 `true`,OpenAI 兼容填 `false` |
| `GIT_PASSWORD` | Secret | CNB 访问令牌(用户名固定 `cnb`)。同步代码需仓库读写;推送镜像需制品库写权限 |

## 接口

### `POST /api/search`

请求体:

```jsonc
{
  "query": "転生したら剣でした",     // 必填:作品名/描述(可含作者等线索)
  "type": "novel",                  // 可选:novel | manga | unknown(默认 unknown,两类都查)
  "stream": false                   // 可选:true 时返回 SSE 进度流
}
```

**同步模式**(`stream: false`,默认):阻塞至检索完成(通常 30 秒~几分钟),返回完整任务:

```bash
curl -s -X POST http://localhost:8787/api/search \
  -H "Content-Type: application/json" \
  -d '{"query":"転生したら剣でした","type":"novel"}' | jq
```

**SSE 模式**(`stream: true`):依次推送 `task` → 多条 `progress`(工具调用进度)→ `result` / `error`,终态事件之后流结束(不再 ping):

```bash
curl -N -X POST http://localhost:8787/api/search \
  -H "Content-Type: application/json" \
  -d '{"query":"転生したら剣でした","type":"novel","stream":true}'
```

结果结构(`task.result`):

```jsonc
{
  "verdict": "both",          // official 仅官方中文 | fan 仅民间汉化 | both 均有 | none 均无 | uncertain 无法确定
  "confidence": "high",
  "work": { "original_title": "転生したら剣でした", "chinese_title": "转生成为魔剑", "type": "novel" },
  "official": { "exists": true, "publisher": "东立出版社", "regions": ["台湾"], "evidence": "…" },
  "fan": { "exists": true, "translations": [ { "group": "…", "status": "completed", "source_url": "https://…" } ] },
  "sources": [ { "url": "https://…", "kind": "database" } ],
  "summary": "……"
}
```

### `GET /api/search/:id`

查询任务状态与结果(任务保存在 SQLite,服务重启后仍可查;超过等待上限的同步请求也可用它轮询)。原始 opencode 调用链路在库表 `tasks.opencode_trace`,不通过本接口返回。

`Accept: text/event-stream` 或 `?stream=true` 时，对**已有任务**再挂一条 SSE（先推当前快照，再推后续 `progress` / `result` / `error`），刷新页面后续上同一任务，不会新建检索。

### `GET /api/search`

最近任务列表(id/查询/状态/时间,不含进度与结果明细),便于排查与轮询。

### `GET /api/health`

本服务 + opencode server 健康状态。`version` 是 `npm version` 打出的 git tag(镜像里的 `GIT_VERSION`,本地则 `git describe`);`revision` 是构建时的 commit SHA。

## 配置一览

| 位置 | 作用 |
|---|---|
| `opencode.jsonc` | 自定义网关(`provider.custom`)、MCP 搜索服务(`mcp.websearch`)、agent 定义(`agent.hanhua-search`) |
| `websearch.config.yaml` | websearch-mcpserver 配置(compose 挂载为容器 `/app/config.yaml`;仅 compose 内网,禁止裸金属;已显式 `host: 0.0.0.0` 与 `baidu.web_enabled: true`) |
| `prompts/hanhua-search.md` | 检索 agent 的系统提示词(检索策略、判定标准、反编造要求) |
| `.env`(参考 `.env.example`) | 模型网关、端口、并发/超时、鉴权、WEBSEARCH_TOKEN |

常用环境变量:`LLM_BASE_URL`、`LLM_API_KEY`、`LLM_MODEL`(自定义网关)、`PORT`、`OPENCODE_MODEL`(覆盖内部模型 id,默认 `custom/default`)、`MAX_CONCURRENCY`(默认 3)、`TASK_TIMEOUT_MS`(默认 10 分钟 / 600000)、`TASK_RETENTION`(默认 500 条任务)、`PROGRESS_RETENTION`(默认每条进度 200)、`TRACE_STEP_RETENTION`(默认 trace 500 步)、`SQLITE_PATH`(默认 `./data/search-agent.sqlite`)、`API_AUTH_KEY`(设置后接口需要 Bearer 鉴权)。

本服务启动时自动 spawn 内嵌 `opencode serve`。检索产生的 session 会保留在本机(`~/.local/share/opencode`),可用于调试回看;不需要时可定期用 opencode CLI 清理。

## 目录结构

```
├── Dockerfile                # 仅构建 agent 镜像(不含 websearch MCP)
├── docker-compose.yml        # 正式部署：仅拉取远程镜像
├── docker-compose.dev.yml    # 本地开发：覆盖 agent 为本地构建镜像
├── websearch.config.yaml     # websearch MCP 配置(挂到容器 /app/config.yaml)
├── opencode.jsonc            # opencode 配置:自定义网关 / MCP / agent
├── prompts/hanhua-search.md  # 检索 agent 系统提示词
├── src/
│   ├── index.ts              # 入口:Layer 装配、HttpRouter 路由、SSE、事件桥
│   ├── env.ts                # 配置(AppConfig)
│   ├── domain/search.ts      # 领域 Schema
│   └── services/             # sqlite / opencode / 事件桥 / 任务表 / 检索编排
├── web/                      # Vite + React + shadcn 前端（代理到 :8787）
├── docs/architecture.md      # 架构与 mermaid 依赖图
└── .env.example
```
