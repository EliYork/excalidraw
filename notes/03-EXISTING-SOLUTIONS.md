# 阶段三：已有自托管方案研究（2026-08-12 互联网调查）

## 1. alswl/excalidraw-collaboration（最接近我们目标的方案）

来源：README（GitHub raw，2026-08 抓取）

**解决的问题**：完整自托管 Excalidraw —— 实时协作 + scene 存储 + 图片存储 + Docker Compose 示例。

**架构**（与我们的目标架构几乎一致）：
- 前端：`alswl/excalidraw` fork（自托管聚焦，**支持运行时环境变量**）
- storage：`alswl/excalidraw-storage-backend`（HTTP API：scenes + files）
- room：`alswl/excalidraw-room-go`（Go 重写的 Socket.IO room server，官方协议兼容，带 /health /ready）
- 部署：`basic/docker-compose.yaml`（三服务直连）+ `advanced-nginx/compose.yml`（nginx 单域名：`/` → 前端，`/storage/` → storage，`/socket.io/` → room 带 WebSocket upgrade headers）

**Firebase 替代方式**：
- `VITE_APP_FIREBASE_CONFIG={}`（空配置，禁用 Firebase）
- fork 新增 env：`VITE_APP_HTTP_STORAGE_BACKEND_URL` + `VITE_APP_STORAGE_BACKEND=http`（见 alswl/excalidraw PR #5）
- `VITE_APP_BACKEND_V2_GET/POST_URL` 指向 storage backend 的 `/api/v2/scenes/`（分享链接后端也复用）

**Docker 镜像**：`alswl/excalidraw:v0.18.1-fork-b2`（前端，**运行时 env 生效**）、`alswl/excalidraw-storage-backend:v2023.11.11`、`alswl/excalidraw-room-go:v0.1.0`。

**维护状态**：README 活跃（Railway demo、Traefik 示例、issue #22 AWS 部署讨论）；但前端 fork **基于 v0.18.1（约 2023 年初）**，严重落后官方 master（我们 fork HEAD 已是 #11872）。storage backend 实际是 kiliandeca 的 Keyv 实现（redis/mongo/postgres/mysql 适配，默认内存非持久化）；advanced 示例还引入了 **MongoDB**。

**不适合复制的部分**：
- fork 版本落后（永久绑定旧 fork = 无法跟进 upstream，正是用户禁忌）
- MongoDB 依赖（用户明确不想要重型服务）
- Go room server 非官方（可选，但官方 excalidraw-room 更贴合上游、便于维护）

**可借鉴的设计**：
- runtime env 注入前端（"Dynamic frontend environment configuration" 已实现并验证）
- nginx 单域名 + WebSocket upgrade 反代拓扑
- storage backend 的 API 形状（`/api/v2/scenes/`、`/api/v2/files/...`）
- room server 增加 `/health` `/ready`（官方 excalidraw-room 没有 healthcheck，需补）

## 2. alswl/excalidraw-room-go

Go 单二进制重写官方 room 协议。配置：PORT/CORS_ORIGIN/PUBLIC_DIR/MAX_HTTP_BUFFER_SIZE（默认 5MB）。带 /health /ready。轻量可借鉴（尤其 healthcheck 与 MAX_HTTP_BUFFER_SIZE 思路），但非必须采用。

## 3. alswl/excalidraw-storage-backend（= kiliandeca 实现）

- Keyv K/V 存储（redis/mongo/postgres/mysql），**默认内存非持久化**，`STORAGE_URI` 配置
- env：PORT(8080)、GLOBAL_PREFIX(/api/v2)、STORAGE_URI、LOG_LEVEL、BODY_LIMIT(50mb)
- 无 filesystem 存储、无 SQLite、无 scene 合并/并发控制说明 → 不满足"数据完整性/并发安全/轻量"要求，**不直接采用**，仅借鉴 API 形状

## 4. 其他方向（调查结论）

- 官方文档（dev-docs/docs/introduction/development.mdx:100）明确：**官方 self-host 不支持协作**；上游 master 无任何非 Firebase storage 支持（firebase.ts 是唯一远端持久化后端）
- 官方下载 URL `https://firebasestorage.googleapis.com/v0/b/{bucket}/o/{prefix}%2F{id}?alt=media`（firebase.ts:285-288）——路径形状可 1:1 复刻为自托管 HTTP 路径，但域名与上传 SDK（uploadBytes）必须改前端
- 未找到（本轮未验证）：SQLite+filesystem 的现成轻量实现、上游 2024-2026 未合入的 storage adapter PR（子代理无网络工具，主代理仅抓取了上述仓库 README）

## 结论

**方案已获社区验证**：runtime env + HTTP storage + nginx ws 反代可以完整工作。我们采用"官方 master + 最小侵入 storage adapter + 自研轻量 storage（SQLite + filesystem）+ 官方 room"路线，不绑定 alswl fork。
