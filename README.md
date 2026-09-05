# search-agent — 汉化版本检索服务

服务端搜索 agent:用户提交作品名(轻小说 / 漫画),由 [opencode](https://opencode.ai) 驱动的 LLM agent 联网检索该作品**是否存在中文版本**(官方中文出版 / 正版平台引进 / 民间汉化),返回带来源链接的结构化结论。

```
客户端 ──HTTP/SSE──▶ 本服务(Effect HttpRouter)──SDK──▶ 内嵌 opencode serve ──MCP──▶ websearch-mcpserver
                                                                └──▶ LLM(自定义网关)
```

架构与模块依赖见 [`docs/architecture.md`](docs/architecture.md)。

## 前置安装

1. **Node.js >= 20.12**(用了原生 `process.loadEnvFile`)
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
   - 若你在它的 `websearch.config.yaml` 里配置了 `auth_token`:设置环境变量 `WEBSEARCH_TOKEN`,并取消 `opencode.jsonc` 中 `mcp.websearch.headers` 的注释。

## 启动

```bash
npm install
cp .env.example .env   # 按需修改(全部有默认值,可不改)
npm run dev            # 开发模式(热重载);生产用 npm start
```

## 前端（Vite + React + shadcn）

浏览器界面在 [`web/`](web/)。开发时 Vite 把 `/api` 与 `/health` 代理到本服务 `http://127.0.0.1:8787`。

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

启动成功会输出服务地址与内嵌 opencode 地址。`websearch-mcpserver` 未启动也不影响本服务启动,只是检索任务的搜索工具不可用(可在 `/health` 里看 opencode 是否健康)。必须从项目根目录启动(`npm run dev` / `npm start`),opencode 才能加载 `opencode.jsonc` 与 `prompts/`。

## Docker 部署(推荐)

compose **只拉取远程镜像并部署**,不在本地构建。两个容器:**agent 服务**(HTTP `:8787`,镜像 `ghcr.io/cn-asukai/search-agent`,多架构 `linux/amd64` + `linux/arm64`)+ **websearch MCP 服务**(内网 `:8338`,镜像 `ghcr.io/daidaij/websearch-mcpserver`)。

```bash
# 1. 准备环境变量(必填:自定义网关)
cp .env.example .env
#    编辑 .env,填入 LLM_BASE_URL / LLM_API_KEY / LLM_MODEL

# 2. 拉取并启动
docker compose pull
docker compose up -d

# 3. 验证
curl http://localhost:8787/health
```

私有 GHCR 包需先登录:`echo $GITHUB_TOKEN | docker login ghcr.io -u <github-user> --password-stdin`。

要点:

- **模型凭据**:镜像内不执行 `opencode auth login`。在 `.env` 填 `LLM_BASE_URL`、`LLM_API_KEY`、`LLM_MODEL` 即可对接任意 OpenAI 兼容网关,不绑定厂商或具体模型。Anthropic 原生协议把 [`opencode.jsonc`](opencode.jsonc) 里的 `npm` 改成 `@ai-sdk/anthropic` 后重建 agent 镜像。
- **websearch**:compose 从 `ghcr.io/daidaij/websearch-mcpserver` 拉取,把仓库根目录 [`websearch.config.yaml`](websearch.config.yaml) 挂到容器 `/app/config.yaml`(已显式开启百度网页搜索 `baidu.web_enabled: true`);`APP_HOST=0.0.0.0` 让 agent 经 compose 内网(`websearch:8338`)访问。不依赖宿主机上跑的 websearch 进程。镜像暂钉 `platform: linux/amd64`(ARM 主机走 QEMU);上游发 arm64 后去掉。
- **数据持久化**:opencode 会话存 `opencode-data` 卷,websearch 搜索缓存存 `websearch-cache` 卷;`docker compose down` 不清数据,`down -v` 才清。
- **代理**:内嵌 opencode 首次运行需联网安装 AI SDK provider 包、模型 API 需出网。需要代理时,在 `docker-compose.yml` 的 `agent.environment` 取消 `HTTP(S)_PROXY` 注释(指向 `host.docker.internal:7897` 之类的宿主代理)。
- 停止:`docker compose down`;看日志:`docker compose logs -f agent websearch`。

本仓库根目录 [`Dockerfile`](Dockerfile) 只构建 agent 镜像(不含 MCP)。发布新版本时推送 tag,GitHub Actions(`.github/workflows/publish-ghcr.yml`)会构建 **linux/amd64 + linux/arm64** 清单并推送到 GHCR。Apple Silicon / ARM 主机上 agent 会拉原生 arm64;websearch 仍走 amd64 模拟,直到上游发布 arm64。

```bash
git tag v0.1.0
git push origin v0.1.0
```

semver tag(如 `v0.1.0`)会打 `0.1.0` / `0.1` / `v0.1.0`;非预发布再打 `latest`。也可本地构建:

```bash
docker build -t ghcr.io/cn-asukai/search-agent:latest .
docker push ghcr.io/cn-asukai/search-agent:latest
```

PR 打开、同步或重开时,[OpenCodeReview](https://open-codereview.ai/docs/cicd) 会自动审查 diff(`.github/workflows/ocr-review.yml`);也可在 PR 评论 `/open-code-review` 或 `@open-code-review` 手动重跑。需在仓库 **Settings → Secrets and variables → Actions** 配置:

| 名称 | 类型 | 说明 |
|---|---|---|
| `OCR_LLM_URL` | Secret | LLM API 端点(如 `https://api.openai.com/v1/chat/completions`) |
| `OCR_LLM_AUTH_TOKEN` | Secret | LLM 鉴权 token |
| `OCR_LLM_MODEL` | Variable | 模型名 |
| `OCR_LLM_USE_ANTHROPIC` | Variable | Anthropic 填 `true`,OpenAI 兼容填 `false` |

## 接口

### `POST /api/search`

请求体:

```jsonc
{
  "query": "転生したら剣でした",     // 必填:作品名/描述(可含作者等线索,≤500 字)
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
  "work": { "original_title": "転生したら剣でした", "chinese_title": "转生成为了只有乖乖女的我也可以斩杀的魔王", "type": "novel" },
  "official": { "exists": true, "publisher": "东立出版社", "regions": ["台湾"], "evidence": "…" },
  "fan": { "exists": true, "translations": [ { "group": "…", "status": "completed", "source_url": "https://…" } ] },
  "sources": [ { "url": "https://…", "kind": "database" } ],
  "summary": "……"
}
```

### `GET /api/search/:id`

查询任务状态与结果(任务保存在内存中,服务重启即清空;超过等待上限的同步请求也可用它轮询)。

### `GET /api/search`

最近任务列表(id/查询/状态/时间,不含进度与结果明细),便于排查与轮询。

### `GET /health`

本服务 + opencode server 健康状态。

## 配置一览

| 位置 | 作用 |
|---|---|
| `opencode.jsonc` | 自定义网关(`provider.custom`)、MCP 搜索服务(`mcp.websearch`)、agent 定义(`agent.hanhua-search`) |
| `websearch.config.yaml` | websearch-mcpserver 配置(compose 挂载为容器 `/app/config.yaml`;已显式 `baidu.web_enabled: true`) |
| `prompts/hanhua-search.md` | 检索 agent 的系统提示词(检索策略、判定标准、反编造要求) |
| `.env`(参考 `.env.example`) | 模型网关、端口、并发/超时、鉴权、WEBSEARCH_TOKEN |

常用环境变量:`LLM_BASE_URL`、`LLM_API_KEY`、`LLM_MODEL`(自定义网关)、`PORT`、`OPENCODE_MODEL`(覆盖内部模型 id,默认 `custom/default`)、`MAX_CONCURRENCY`(默认 3)、`TASK_TIMEOUT_MS`(默认 5 分钟)、`API_AUTH_KEY`(设置后接口需要 Bearer 鉴权)。

本服务启动时自动 spawn 内嵌 `opencode serve`。检索产生的 session 会保留在本机(`~/.local/share/opencode`),可用于调试回看;不需要时可定期用 opencode CLI 清理。

## 目录结构

```
├── Dockerfile                # 仅构建 agent 镜像(不含 websearch MCP)
├── docker-compose.yml        # 仅拉取远程镜像并部署
├── websearch.config.yaml     # websearch MCP 配置(挂到容器 /app/config.yaml)
├── opencode.jsonc            # opencode 配置:自定义网关 / MCP / agent
├── prompts/hanhua-search.md  # 检索 agent 系统提示词
├── src/
│   ├── index.ts              # 入口:Layer 装配、HttpRouter 路由、SSE、事件桥
│   ├── env.ts                # 配置(AppConfig)
│   ├── domain/search.ts      # 领域 Schema
│   └── services/             # opencode / 事件桥 / 任务表 / 检索编排
├── web/                      # Vite + React + shadcn 前端（代理到 :8787）
├── docs/architecture.md      # 架构与 mermaid 依赖图
└── .env.example
```
