# syntax=docker/dockerfile:1

# search-agent(基于 opencode SDK 的汉化检索服务)容器
# 仅构建本应用;websearch MCP 由 compose 从远程镜像拉取,不在此构建。
#
# 构建: docker build -t ghcr.io/cn-asukai/search-agent:latest .
# 多架构: docker buildx build --platform linux/amd64,linux/arm64 -t ghcr.io/cn-asukai/search-agent:latest --push .
# 推送: docker push ghcr.io/cn-asukai/search-agent:latest
#
# 服务启动时自动 spawn `opencode serve`,因此镜像内同时包含:
#   - Node.js 运行时代码(src/)
#   - opencode CLI(npm 包 opencode-ai,postinstall 拉取平台二进制)
#   - 项目 opencode.jsonc(模型/MCP/agent)

# ── 构建阶段 ────────────────────────────────────────────────
# Node 24 官方镜像(bookworm/glibc)。linux/amd64 与 linux/arm64 均有官方 tag;
# opencode-ai postinstall 按 TARGETPLATFORM 拉取对应 glibc 二进制。
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

# compose 内网服务名是 websearch,容器内不能走 127.0.0.1
RUN sed -i 's|http://127.0.0.1:8338/mcp|http://websearch:8338/mcp|' opencode.jsonc

# opencode(Bun 打包)会写 $HOME/.local/{state,share}(会话/缓存/日志),
# 整个 /home/node 归 node 用户,保证 HOME 下各目录可写
RUN mkdir -p /home/node/.local/share/opencode \
    && chown -R node:node /home/node

# 端口 8787 为 HTTP 服务;内嵌 opencode serve 用随机空闲端口(默认),无需暴露
EXPOSE 8787

USER node

CMD ["npx", "tsx", "src/index.ts"]
