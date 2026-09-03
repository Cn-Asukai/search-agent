# syntax=docker/dockerfile:1

# search-agent(基于 opencode SDK 的汉化检索服务)容器
# 内嵌模式:服务自动 spawn `opencode serve`,因此镜像内同时包含:
#   - Node.js 运行时代码(src/)
#   - opencode CLI(npm 包 opencode-ai,postinstall 拉取平台二进制)
#   - 容器化后的 opencode 配置(docker/opencode/opencode.jsonc + config.json)

# ── 构建阶段 ────────────────────────────────────────────────
# Node 24 官方镜像(bookworm/glibc;opencode 的 linux-x64 二进制为 glibc 静态链接)
FROM node:24-bookworm-slim AS build

WORKDIR /app

# 先装依赖,利用层缓存
COPY package.json package-lock.json ./
RUN npm ci

# 编译用 devDependencies(tsx/tsc)已随 npm ci 安装,直接复制源码即可运行
COPY tsconfig.json ./
COPY src ./src

# ── 运行时阶段 ──────────────────────────────────────────────
FROM node:24-bookworm-slim

# 全局安装 opencode CLI:同版本 postinstall 会按平台自动安装二进制
# 构建期完成,避免每次容器启动都跑下载
ARG OPENCODE_VERSION=1.18.25
RUN npm install -g opencode-ai@${OPENCODE_VERSION} \
    && opencode --version

WORKDIR /app
ENV NODE_ENV=production

# 应用代码 + 编译产物(tsx 直接跑 TS 源码)
# package.json 必需:其 "type": "module" 决定 .ts 按 ESM 解析(sdk 的 exports 只有 import 条件)
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/src ./src
COPY --from=build /app/tsconfig.json ./tsconfig.json

# 业务静态资源:opencode.jsonc(模型/MCP/agent 定义)与 prompts/
COPY opencode.jsonc ./opencode.jsonc
COPY prompts ./prompts

# opencode 用户级配置:全局模型 provider(如 taotoken 自定义 provider)放在
# $HOME/.config/opencode/config.json(见 docker/opencode/config.json + README)
COPY docker/opencode/config.json /home/node/.config/opencode/config.json

# opencode(Bun 打包)会写 $HOME/.local/{state,share}(会话/缓存/日志),
# 整个 /home/node 归 node 用户,保证 HOME 下各目录可写
RUN mkdir -p /home/node/.local/share/opencode \
    && chown -R node:node /home/node

# 端口 8787 为 HTTP 服务;内嵌 opencode serve 用随机空闲端口(默认),无需暴露
EXPOSE 8787

USER node

CMD ["npx", "tsx", "src/index.ts"]
