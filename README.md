# search-agent — 汉化版本检索服务

服务端搜索 agent:用户提交作品名(轻小说 / 漫画),由 [opencode](https://opencode.ai) 驱动的 LLM agent 联网检索该作品**是否存在中文版本**(官方中文出版 / 正版平台引进 / 民间汉化),返回带来源链接的结构化结论。

```
客户端 ──HTTP/SSE──▶ 本服务(Hono)──SDK──▶ opencode server ──MCP──▶ websearch-mcpserver(联网搜索)
                                        └──▶ LLM(模型与 API key 由你配置)
```

## 前置安装

1. **Node.js >= 20.12**(用了原生 `process.loadEnvFile`)
2. **opencode CLI**(内嵌模式必需,本服务会自动 spawn `opencode serve`):

   ```bash
   npm install -g opencode-ai
   opencode --version   # 确认可用
   ```

3. **模型与 API key**(必填):
   - 编辑 `opencode.jsonc`,取消 `"model": "..."` 的注释并填入你的模型(如 `zai/glm-4.7`、`anthropic/claude-sonnet-4-5`、`deepseek/deepseek-chat`);
   - 运行 `opencode auth login`,选择对应 provider 填入 API key。
   - 也可以不改配置文件,用环境变量 `OPENCODE_MODEL=provider/model-id` 强制指定。

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

启动成功会输出服务地址与 opencode 接入模式。`websearch-mcpserver` 未启动也不影响本服务启动,只是检索任务的搜索工具不可用(可在 `/health` 里看 opencode 是否健康)。

## Docker 部署(推荐)

用 docker compose 一次性启动两个容器:**agent 服务**(HTTP `:8787`)+ **websearch MCP 服务**(内网 `:8338`,联网搜索)。

```bash
# 1. 准备本地环境变量(必填:模型 API key)
cp docker/.env.example docker/.env
#    编辑 docker/.env,填入 TAOTOKEN_API_KEY(或换你自己的 provider)

# 2. 构建并启动
docker compose up -d --build

# 3. 验证
curl http://localhost:8787/health
```

要点:

- **模型凭据**:镜像内不执行 `opencode auth login`。把本机 `~/.config/opencode/config.json` 里的 provider(如 taotoken 自定义网关)抄到 [`docker/opencode/config.json`](docker/opencode/config.json),API key 用 `{env:XXX_API_KEY}` 占位,再由 compose 把 `docker/.env` 注入容器。默认已内置 `taotoken/deepseek-v4-pro`,换模型改 `docker/.env` 的 `OPENCODE_MODEL` 即可。
- **websearch 配置**:容器用它自己那份 [`docker/websearch/config.yaml`](docker/websearch/config.yaml)(根目录 `websearch.config.yaml` 的副本,仅监听地址与缓存路径不同)。两个容器在 compose 内网互联(`websearch:8338`),不依赖宿主机上跑的 websearch 进程。
- **数据持久化**:opencode 会话存 `opencode-data` 卷,websearch 搜索缓存存 `websearch-cache` 卷;`docker compose down` 不清数据,`down -v` 才清。
- **代理**:内嵌 opencode 首次运行需联网安装 AI SDK provider 包、模型 API 需出网。需要代理时,在 `docker-compose.yml` 的 `agent.environment` 取消 `HTTP(S)_PROXY` 注释(指向 `host.docker.internal:7897` 之类的宿主代理)。
- 停止:`docker compose down`;看日志:`docker compose logs -f agent websearch`。

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

**SSE 模式**(`stream: true`):依次推送 `task` → 多条 `progress`(工具调用进度)→ `result` / `error`:

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
| `opencode.jsonc` | 模型(`model`)、MCP 搜索服务(`mcp.websearch`)、agent 定义(`agent.hanhua-search`) |
| `prompts/hanhua-search.md` | 检索 agent 的系统提示词(检索策略、判定标准、反编造要求) |
| `.env`(参考 `.env.example`) | 端口、opencode 接入方式、并发/超时、鉴权、WEBSEARCH_TOKEN |

常用环境变量:`PORT`、`OPENCODE_BASE_URL`(外部 opencode serve 地址)、`OPENCODE_MODEL`、`MAX_CONCURRENCY`(默认 3)、`TASK_TIMEOUT_MS`(默认 5 分钟)、`API_AUTH_KEY`(设置后接口需要 Bearer 鉴权)。

## opencode 接入的两种模式

- **内嵌模式**(默认):本服务自动 spawn `opencode serve`。要求从项目根目录启动本服务(`npm run dev` / `npm start`),这样 opencode 才能加载 `opencode.jsonc` 与 `prompts/`。
- **外部模式**:在项目根目录运行 `opencode serve --port 7777`,再设置 `OPENCODE_BASE_URL=http://127.0.0.1:7777`。适合 opencode 独立部署/复用的场景。

检索产生的 opencode session 会保留在本机(`~/.local/share/opencode`),可用于调试回看;不需要时可定期用 opencode CLI 清理。

## 目录结构

```
├── opencode.jsonc            # opencode 配置:模型 / MCP / agent
├── prompts/hanhua-search.md  # 检索 agent 系统提示词
├── src/
│   ├── index.ts              # 入口:Effect 组装、HttpRouter 路由、SSE、优雅关闭
│   ├── env.ts                # 配置(AppConfig 服务)
│   ├── domain/search.ts      # 领域 Schema(effect Schema + JSON Schema 导出)
│   └── services/
│       ├── opencode.ts       # opencode server 生命周期 + SDK 封装
│       ├── eventBridge.ts    # opencode 事件订阅 → PubSub + 进度翻译
│       ├── taskManager.ts    # 内存任务表 + 事件广播 + 并发信号量
│       └── searchRunner.ts   # 任务执行:promptAsync、超时 abort、结构化解析
└── .env.example
```
