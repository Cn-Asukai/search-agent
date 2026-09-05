<!--
Sync Impact Report
- Version change: (unratified template) → 1.0.0
- Modified principles:
  - PRINCIPLE_1_NAME (template) → I. 代码质量优先
  - PRINCIPLE_2_NAME (template) → II. 测试标准不可妥协
  - PRINCIPLE_3_NAME (template) → III. 用户体验一致性
  - PRINCIPLE_4_NAME (template) → IV. 性能有界且可观测
  - PRINCIPLE_5_NAME (template) → V. 原则驱动技术选型与实现
- Added sections:
  - 技术选型与实现决策
  - 质量门禁与开发流程
- Removed sections: none (template placeholders replaced in place)
- Follow-up TODOs: none
-->

# search-agent Constitution

## Core Principles

### I. 代码质量优先

本仓库是面向客户端的 HTTP 检索服务，不是脚本堆砌。每一处改动 MUST 保持类型安全、模块边界清晰、失败路径显式。

- 领域契约 MUST 以 `src/domain/search.ts` 的 Effect Schema 为唯一真相；请求、任务、结果、SSE 事件不得在路由或服务层另起一套形状。
- 配置 MUST 经 `AppConfig` 注入；禁止在业务代码中直接读 `process.env`（启动期加载 `.env` 除外）。
- 服务 MUST 以 Effect `Context.Service` + `Layer` 装配。禁止在模块顶层 `new` 出带状态的单例，也禁止把 HTTP、任务表、opencode RPC 写进同一个函数。
- 两条事件总线 MUST 分离：`EventBridge.events` 只服务 SearchRunner；`TaskManager.events` 只服务 HTTP。跨总线直连视为缺陷。
- 公共标识符、API、路径、命令、配置键 MUST 使用英文。源码注释跟随当前文件已有语言，不得整文件翻译。
- 新增依赖 MUST 有明确职责缺口；能用现有 Effect / Schema / OpenCode SDK 表达的，不得再引入平行运行时或第二套 HTTP 框架。
- 复杂度 MUST 可辩护：更深的抽象、额外进程、额外总线只有在现有边界无法表达时才允许引入。

理由：search-agent 把「任务表、执行器、事件桥、内嵌 opencode」拆开，是为了让检索编排可测、可替换。破坏边界会立刻让超时、进度和终态互相污染。

### II. 测试标准不可妥协

没有失败测试作锚点的行为变更，不得合入。测试是契约，不是事后补丁。

- 行为变更 MUST 先写（或扩展）会失败的测试，再改实现；禁止先改代码再补测试来“对齐现状”。
- 纯逻辑（解析、SSE 装配、会话终态判定、事件翻译）MUST 有不启动 LLM、MCP、真实 opencode 的单元测试。
- 契约变更 MUST 有测试锁住：`SearchResult` / `searchResultJsonSchema` 的必填字段、禁止 `anyOf`/`minLength`、SSE 事件序（`task` → `progress*` → `result|error` 后结束）均属此列。
- 涉及并发、超时、断线重连、快照与直播之间的竞态时，MUST 用可注入时钟/PubSub 的测试覆盖，而不是靠手工 curl 碰运气。
- 测试 MUST 可在无外网、无 API key 的环境下用 `npm test` 跑绿。依赖真实模型或真实搜索的验证 SHALL 标为手工/集成，不得充当默认门禁。
- `npm run typecheck` MUST 与 `npm test` 一并视为门禁。类型错误不得用 `any`、无根据的断言或把问题推到测试文件来掩盖。
- 修复生产缺陷 MUST 先补一个复现该缺陷的测试，再改代码。

理由：本服务的正确性大量体现在异步边界（SSE 空隙、session idle、结构化输出解析）。没有测试的“看起来能跑”会在下一次超时或重连时静默丢终态。

### III. 用户体验一致性

客户端只看见任务与结构化结论，不看见 opencode。对外行为 MUST 稳定、可预期、可解释。

- 对外 HTTP 面 MUST 保持现有资源语义：`POST /api/search` 创建并启动任务；`GET /api/search/:id` 读任务；`GET /api/search` 列最近任务；`GET /health` 报告本服务与 opencode 健康。新增端点不得复制上述语义。
- `stream=false` MUST 阻塞至 `done`/`error`，超时则返回 `202` 并保留可轮询任务；`stream=true` MUST 推送 `task` → `progress*` → `result|error`，终态后结束，不得在终态后继续心跳。
- 同步 JSON 与 SSE 终态 MUST 暴露同一份 `Task` 形状。禁止两种模式各写一套结果字段。
- 进度文案 MUST 使用简洁中文，描述用户能理解的阶段（如正在联网搜索），不得把内部工具名、SDK 错误栈或 opencode 原始事件直接甩给客户端。
- 检索结论 MUST 遵守提示词中的反编造规则：每条存在性判断要有可核查 URL；不确定字段留空或标未知；不得为了填满 Schema 虚构出版社、汉化组或链接。
- 错误 MUST 可分类：客户端输入错误、鉴权失败、任务不存在、检索超时、上游不健康。禁止一律 `500` 加内部异常字符串。
- 破坏性 API 变更（字段改名/删除、事件序变化、默认同步改流式）MUST 走 MAJOR 版本，并在 README 与领域 Schema 同步更新。

理由：调用方会用同步阻塞或 SSE 进度来驱动 UI。形状漂移、终态后仍 ping、或结论无来源，都会直接变成产品缺陷。

### IV. 性能有界且可观测

检索是慢路径，HTTP 是快路径。系统 MUST 在有限资源下退化，而不是把进程拖死。

- `POST /api/search` MUST 在入队后立即 `launch`；执行 MUST 在后台 fiber 中进行。禁止在路由里同步跑完整个 agent 会话。
- 并发 MUST 受 `MAX_CONCURRENCY` 信号量约束（默认 3）。槽的 `take`/`release` MUST 在 SearchRunner 中显式配对，不得用会把超时包死的 `withPermits` 包裹整段检索。
- 单任务 MUST 受 `TASK_TIMEOUT_MS` 限制（默认 10 分钟）；同步等待 MUST 受 `SYNC_MAX_WAIT_MS` 限制（默认 30 分钟），超时返回 `202` 而非无限挂起。
- 内存任务表 MUST 有上限（当前 500 条任务、每条进度 200）。超出 MUST 淘汰最旧记录，不得无界增长。
- EventBridge 全局 SSE MUST 只订一次；断线后按固定间隔重连（当前 5 秒），禁止 tight loop 重连把 CPU 打满。
- 本进程 MUST 保持编排角色：不在本仓库实现网页爬虫或模型推理。搜索走 websearch MCP，推理走配置的 LLM 网关。
- `/health` MUST 暴露 opencode 健康、运行中任务数与并发上限，供编排与排障使用。
- 新增特性若会增加每任务延迟、事件量或常驻内存，MUST 在方案中写明预算（超时、并发、载荷上限），否则不得实现。

理由：一次检索可达数分钟且占用模型与搜索配额。无界并发、无界任务表或同步阻塞，会让健康检查与其他客户端一起饿死。

### V. 原则驱动技术选型与实现

技术选型不是口味问题。候选方案 MUST 同时通过原则 I–IV，否则不得采用。

- 选型 MUST 先用原则打分：能否保持模块边界与类型契约（I）、能否在无外网下测试（II）、能否维持对外形状与中文进度（III）、能否受并发/超时/内存上限约束（IV）。
- 实现决策 MUST 落在现有缝上：领域类型进 `domain/`，配置进 `AppConfig`，任务真相进 `TaskManager`，编排进 `SearchRunner`，opencode 进出 `OpenCode`/`OpenCodeOps`，原始事件进 `EventBridge`，HTTP 适配进 `src/index.ts`。
- 当原则冲突时，优先级固定为：正确性与反编造（II + III 的证据规则）> 对外契约稳定（III）> 有界性能（IV）> 抽象优雅（I 中的简化）。不得为了“更漂亮的架构”牺牲终态可达或证据真实性。
- 替换主框架、协议或存储 MUST 提供对照：现有测试哪些会红、客户端要改什么、超时与并发如何保持。无对照的重写视为违宪。

理由：Effect、Schema、内嵌 opencode 都是为上述原则服务的手段。手段可替换，原则不可架空。

## 技术选型与实现决策

下列规则把原则 I–V 落到本仓库的具体选择。偏离时 MUST 在设计说明中逐条回应。

**语言与运行时**

- MUST 使用 TypeScript 与 Node.js `>= 20.12`（依赖原生 `process.loadEnvFile`）。
- MUST 保持 `"type": "module"`。新增 JS 工具链不得把项目拉回 CJS 主路径。

**效果系统与 HTTP**

- MUST 使用 Effect 表达依赖、并发、超时、Stream 与 Layer 装配。
- HTTP MUST 走 `@effect/platform-node` + `HttpRouter`。不得并行引入 Express/Fastify/Koa 作为主服务。
- 失败 MUST 进入 Effect 错误通道；禁止在服务层用未捕获 Promise rejection 表达业务失败。

**契约与校验**

- 对外 JSON 与结构化输出 MUST 用 Effect Schema。不得为同一形状再引入 zod/io-ts。
- 交给 opencode 的 JSON Schema MUST 保持封闭子集（`type`/`properties`/`required`/`enum`/`items`/`description`），禁止 `anyOf`、`minLength` 等会导致 session 消息解码 400 的关键字。

**Agent 与搜索**

- 模型调用 MUST 经内嵌 `opencode serve` + `@opencode-ai/sdk`。本服务不得直连厂商 Chat Completions 作为检索主路径。
- 模型供应 MUST 可替换：自定义网关用 `LLM_BASE_URL` / `LLM_API_KEY` / `LLM_MODEL`；不得把实现绑死某一厂商 SDK。
- 联网搜索 MUST 经配置的 websearch MCP。本仓库不得内置搜索引擎客户端。

**状态与通信**

- 任务状态 MUST 只存在 `TaskManager`（进程内）。当前阶段不得引入 Redis/DB 作为任务真相，除非原则 IV 的上限已不够且有迁移方案。
- 对客户端推送 MUST 使用现有 SSE 编码器；不得把 EventBridge 的 `OpencodeEvent` 原样转发。

**可观测与安全**

- 密钥 MUST 经 `Redacted` / 环境变量进入进程，不得写入日志、进度文案或健康检查响应。
- `API_AUTH_KEY` 一旦配置，受保护接口 MUST 校验 Bearer；未配置时不得假装已鉴权。

**文档**

- 模块职责与事件方向 MUST 与 `docs/architecture.md` 保持一致。改边界时 MUST 先改架构说明与本宪法所指向的测试，再改代码。

## 质量门禁与开发流程

合入前 MUST 满足：

1. `npm run typecheck` 通过。
2. `npm test` 通过（当前覆盖 `sessionWait`、`parseResult`、`eventBridge`、`sseStream`；新增纯逻辑 MUST 加入该脚本）。
3. 行为变更附带失败过的测试；仅重构也不得降低现有断言强度。
4. 公开 API、SSE 事件或 `SearchResult` 字段变化时，README 与 `src/domain/search.ts` 同步更新。
5. PR 说明、设计说明、提交说明使用中文；conventional 前缀可保留英文。

评审 MUST 检查：

- 是否破坏双总线分离或 Layer 边界。
- 是否把 LLM/MCP 才能跑的逻辑塞进默认测试门禁，或反过来把可单测逻辑完全不测。
- 是否改变对外事件序、进度语言或错误形状。
- 是否绕过并发槽、超时或任务表上限。
- 是否引入与原则 V 冲突的新框架/新进程。

PR 打开或更新后 MUST 跟随 GitHub Actions（OpenCodeReview）。Publish to GHCR 仅 tag 触发，PR 上不得空等该工作流。明确的正确性与安全意见 MUST 修复；标注为建议/可选的可以解释后保留。不自动 merge；不用 `git push --force`（变基用 `--force-with-lease`）。

## Governance

本宪法高于风格偏好、个人习惯与“先跑起来再说”的临时实现。规范、计划、任务与 PR 若与本文件冲突，以本文件为准，除非按下列程序修正。

**修正程序**

1. 提出修正：说明冲突的原则、动机、对客户端与测试门禁的影响。
2. 版本号：MAJOR 表示删除或重新定义原则、改变优先级或放宽不可妥协条款；MINOR 表示新增原则/章节或实质性扩展指引；PATCH 表示措辞澄清、勘误、非语义润色。
3. 更新 `.specify/memory/constitution.md`，刷新文首 Sync Impact Report、`Version` 与 `Last Amended`。
4. 若修正改变门禁或对外契约，MUST 在同一变更中更新测试、README 与 `docs/architecture.md`。

**合规**

- 每个功能的 spec / plan / tasks MUST 显式对照原则 I–V。无法满足某条时 MUST 记录例外、时限与取消条件。
- 运行时开发指导见 `AGENTS.md` 与 `docs/architecture.md`；二者不得削弱本宪法。
- 复杂性增量（新总线、新存储、新 HTTP 框架、直连模型）MUST 在方案中引用本宪法的否决条件。

**Version**: 1.0.0 | **Ratified**: 2026-09-05 | **Last Amended**: 2026-09-05
