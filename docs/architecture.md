# 架构与依赖

本文描述 search-agent 的目录职责、运行时拓扑、源码模块依赖和 Effect Layer 装配关系。

## 目录结构

```
search-agent/
├── Dockerfile                 # 仅构建 agent 镜像(不含 MCP)
├── docker-compose.yml         # 只拉取远程镜像并部署
├── opencode.jsonc             # 项目级:自定义网关 / MCP / agent
├── opencode.provider.json     # 容器用户级 provider(镜像不跑 auth login)
├── prompts/hanhua-search.md   # 检索 agent 系统提示词
├── websearch.config.yaml      # 本机 websearch-mcpserver 配置(非 Docker)
├── src/
│   ├── index.ts               # 入口:Layer 装配、HTTP 路由、SSE、事件桥
│   ├── env.ts                 # AppConfig:环境变量
│   ├── domain/
│   │   └── search.ts          # 领域 Schema(请求/结果/任务/进度)
│   └── services/
│       ├── opencode.ts        # 内嵌 opencode serve + SDK 操作
│       ├── eventBridge.ts     # opencode SSE → PubSub + 进度翻译
│       ├── taskManager.ts     # 内存任务表 + 事件广播 + 并发信号量
│       └── searchRunner.ts    # 检索编排:提交、等待、解析、写回
└── docs/
    └── architecture.md        # 本文件
```

职责分层:

| 层 | 路径 | 职责 |
|---|---|---|
| 入口 / HTTP | `src/index.ts` | 组装 Layer、暴露 REST/SSE、拉起事件桥 |
| 配置 | `src/env.ts` | 读 `.env` / 进程环境,产出 `AppConfig` |
| 领域 | `src/domain/` | 纯 Schema,不依赖服务 |
| 服务 | `src/services/` | 任务、检索、opencode、事件桥 |
| 运行时配置 | `opencode.jsonc`、`prompts/` | 内嵌 opencode 加载的业务配置 |
| 部署 | `Dockerfile`、`docker-compose.yml` | 构建 agent;compose 只拉镜像 |

## 运行时组件依赖

客户端只打本服务的 HTTP;本服务内嵌 spawn `opencode serve`;opencode 再连自定义 LLM 网关和 websearch MCP。

```mermaid
flowchart LR
  Client["客户端"]
  Agent["search-agent<br/>HTTP :8787"]
  OC["内嵌 opencode serve"]
  LLM["自定义 LLM 网关<br/>LLM_BASE_URL"]
  MCP["websearch-mcpserver<br/>:8338"]

  Client -->|"REST / SSE"| Agent
  Agent -->|"SDK spawn + 调用"| OC
  OC -->|"OpenAI 兼容 API"| LLM
  OC -->|"MCP HTTP"| MCP
```

Docker 部署时两个容器经 compose 内网互联,agent 依赖 websearch 健康后再启动:

```mermaid
flowchart TB
  subgraph compose["docker compose"]
    AgentC["agent<br/>ghcr.io/cn-asukai/search-agent"]
    MCPC["websearch<br/>ghcr.io/daidaij/websearch-mcpserver"]
    VolA[("opencode-data")]
    VolW[("websearch-cache")]
    AgentC -->|"depends_on healthy<br/>http://websearch:8338/mcp"| MCPC
    AgentC --- VolA
    MCPC --- VolW
  end
  User["宿主机 :8787"] --> AgentC
```

## 源码模块依赖

箭头表示 **import** 方向(依赖方 → 被依赖方)。`domain` 与 `env` 不互相引用;服务层可依赖二者,不可反向依赖入口。

```mermaid
flowchart TB
  index["src/index.ts"]
  env["src/env.ts"]
  domain["src/domain/search.ts"]
  oc["src/services/opencode.ts"]
  eb["src/services/eventBridge.ts"]
  tm["src/services/taskManager.ts"]
  sr["src/services/searchRunner.ts"]

  index --> env
  index --> oc
  index --> eb
  index --> tm
  index --> sr
  index --> domain

  sr --> env
  sr --> oc
  sr --> eb
  sr --> tm
  sr --> domain

  oc --> env
  oc --> domain

  tm --> env
  tm --> domain

  eb -.->|"仅类型"| sdkType["@opencode-ai/sdk"]
  oc --> sdk["@opencode-ai/sdk"]
  sr -.->|"仅类型"| sdkType
  env --> effect["effect"]
  domain --> effect
```

外部库:

| 模块 | 直接依赖 |
|---|---|
| `index.ts` | `effect`、`@effect/platform-node` |
| `env.ts` | `effect` |
| `domain/search.ts` | `effect` |
| `opencode.ts` | `effect`、`@opencode-ai/sdk` |
| `eventBridge.ts` | `effect`、`@opencode-ai/sdk`(类型) |
| `taskManager.ts` | `effect` |
| `searchRunner.ts` | `effect`、`@opencode-ai/sdk`(类型) |

## Effect Layer 依赖

运行时由 `Layer.provide` 消化需求。`SearchRunner` 依赖最宽,路由层再消费全部服务。

```mermaid
flowchart BT
  AppConfig["AppConfigLive"]
  OpenCode["OpenCodeLive"]
  OpenCodeOps["OpenCodeOpsLive"]
  TaskManager["TaskManagerLive"]
  EventBridge["EventBridgeLive"]
  SearchRunner["SearchRunnerLive"]
  Routes["HttpRouter 路由"]

  OpenCode --> AppConfig
  OpenCodeOps --> OpenCode
  OpenCodeOps --> AppConfig
  TaskManager --> AppConfig
  SearchRunner --> OpenCode
  SearchRunner --> OpenCodeOps
  SearchRunner --> TaskManager
  SearchRunner --> EventBridge
  SearchRunner --> AppConfig

  Routes --> AppConfig
  Routes --> OpenCode
  Routes --> OpenCodeOps
  Routes --> TaskManager
  Routes --> SearchRunner
```

装配位置在 `src/index.ts` 的 `ServicesLayer`:先 `provide` 掉各 Live 的入参,再 `mergeAll` 成无入参的服务层,HTTP 与事件桥共用同一 context。

## 检索请求流

```mermaid
sequenceDiagram
  participant C as 客户端
  participant H as index.ts 路由
  participant T as TaskManager
  participant R as SearchRunner
  participant O as OpenCodeOps
  participant S as 内嵌 opencode
  participant B as EventBridge

  C->>H: POST /api/search
  H->>T: create(query, type)
  H->>R: launch(taskId)
  alt stream=true
    H-->>C: SSE: task / progress / result
  else 同步
    H-->>C: 阻塞至终态或 202
  end
  R->>O: createSession + submitSearch
  O->>S: promptAsync
  S-->>B: SSE 事件
  B-->>R: session 进度 / idle
  R->>T: appendProgress / update(done|error)
  T-->>H: PubSub TaskEvent
```

`eventLoop` 在进程启动时 fork,全局订阅一次 opencode SSE,按 `sessionID` 分发给正在跑的任务。
