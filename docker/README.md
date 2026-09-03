# 容器化说明

本目录包含把 search-agent 与 websearch-mcpserver 跑成 docker compose 所需的全部文件。

## 文件结构

```
docker/
├── .env.example          # 环境变量模板(复制为 .env 后填入模型 key,不入库)
├── Dockerfile            # search-agent 容器(Dockerfile 在上层 docker/agent/)
├── agent/Dockerfile      # agent 服务容器
├── websearch/
│   ├── Dockerfile        # websearch-mcpserver 容器
│   └── config.yaml       # websearch 容器专用配置(根目录 websearch.config.yaml 的副本)
├── opencode/
│   ├── opencode.jsonc    # agent 业务配置(模型/MCP/agent 定义),替代根目录 opencode.jsonc
│   └── config.json       # opencode 全局模型 provider(镜像内不执行 auth login)
└── README.md             # 本文件
```

## 与根目录配置的关系

容器化后,原本在运行时依赖根目录两份配置文件,现在分别由容器内的两份替代,**请保持同步**:

| 根目录配置 | 容器内配置 | 差异 |
|---|---|---|
| `websearch.config.yaml`(websearch) | `docker/websearch/config.yaml` | 仅 `host`(容器内需 `0.0.0.0`)与 `cache.storage_path`(Windows→Linux 路径)不同 |
| `opencode.jsonc`(agent 业务) | `docker/opencode/opencode.jsonc` | 仅 `mcp.websearch.url` 从 `127.0.0.1:8338` 改为 `websearch:8338`(compose 服务名) |
| `~/.config/opencode/config.json`(本机全局) | `docker/opencode/config.json` | 内容直接复制;API key 用 `{env:...}` 占位,由 compose 注入 |

`prompts/` 目录与 `src/` 代码直接 COPY 进镜像,无需副本。

## 配置变更指引

- **改 websearch 功能开关**(搜索模式/引擎/限流等):同步改根目录 `config.yaml` **和** `docker/websearch/config.yaml`,然后 `docker compose build websearch`。
- **改 MCP 接入地址**:改 `docker/opencode/opencode.jsonc` 的 `mcp.websearch.url`。
- **换模型 provider**:改 `docker/opencode/config.json` 的 `provider` + `docker/.env` 的 `OPENCODE_MODEL`,重建 agent 容器(`docker compose up -d --build agent`)。
- **加 provider 密钥**:改 `docker/.env`,`docker compose up -d --force-recreate agent`。

## 日常命令

```bash
cp docker/.env.example docker/.env      # 首次:填模型 key
docker compose up -d --build            # 构建 + 启动
docker compose logs -f agent websearch  # 看日志
curl http://localhost:8787/health       # 验证
docker compose down                     # 停止(数据卷保留)
docker compose down -v                  # 停止并清空数据
```
