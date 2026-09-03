# syntax=docker/dockerfile:1

# websearch-mcpserver(联网搜索 MCP 服务)容器
# 单 Go 二进制,由官方 GitHub Releases 分发
# 版本与仓库根目录 config.yaml 保持同步(当前 v3.2.0)
# 换版本时只需改 ARG WEBSEARCH_VERSION,并同步替换根目录 config.yaml

FROM debian:bookworm-slim AS downloader

ARG TARGETARCH
ARG WEBSEARCH_VERSION=v3.2.0

# 从 GitHub Releases 拉取对应架构的静态二进制(无 CGO)
ADD https://github.com/daidaiJ/websearch-mcpserver/releases/download/${WEBSEARCH_VERSION}/websearch-mcpserver-linux-${TARGETARCH} /websearch-mcpserver
RUN chmod +x /websearch-mcpserver

# ── 运行时镜像 ──────────────────────────────────────────────
# 上游官方镜像用 alpine;这里用 glibc debian 跑发布版二进制更稳妥
# (发布版为静态链接,两者皆可,debian 自带 CA 证书更完整)
FROM debian:bookworm-slim

# HTTPS 上游(Bing/百度/学术引擎)需要 CA 证书;curl 用于容器健康检查
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*

COPY --from=downloader /websearch-mcpserver /usr/local/bin/websearch-mcpserver

# 配置目录:docker/config.yaml 是根目录 config.yaml 的容器化副本,
# 关键差异:host: 0.0.0.0(容器内需跨网络监听)、cache.storage_path 指向容器内路径
COPY config.yaml /app/config.yaml

# 默认监听 8338(与根目录 config.yaml 的 port 一致)
EXPOSE 8338

# 启动 HTTP MCP 服务;start 子命令会读取工作目录下的 config.yaml
WORKDIR /app
CMD ["websearch-mcpserver", "start"]
