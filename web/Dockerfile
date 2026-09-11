# 前端开发镜像：只装依赖，由 compose 把 ./web 挂到 /app 后跑 Vite。
# 构建: docker compose -f docker-compose.yml -f docker-compose.dev.yml build web

FROM node:24-bookworm-slim

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

EXPOSE 5173

CMD ["npm", "run", "dev", "--", "--host", "0.0.0.0", "--port", "5173", "--strictPort"]
