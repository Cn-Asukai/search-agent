# 汉化检索前端

Vite + React + shadcn/ui。通过 Vite 代理接入仓库根目录的 search-agent HTTP/SSE API。

```bash
# 先在仓库根目录启动后端：npm run dev  (监听 :8787)
npm install
npm run dev        # http://127.0.0.1:5173
npm run test       # shipped client HTTP + SSE 测试
npm run build
npm run preview    # http://127.0.0.1:4173
```

`VITE_API_BASE` 可指向独立 API origin；默认空字符串，请求走同源 `/api`（由 Vite proxy 转到 `127.0.0.1:8787`）。
