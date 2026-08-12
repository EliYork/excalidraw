# 自托管部署（Self-hosted Excalidraw）

完整的实时协作 + 图片共享 + Scene 持久化，全部自托管，不依赖 Firebase 或任何外部服务。

## 快速开始

前置：Docker + Docker Compose。

```sh
docker compose up -d --build
```

打开 <http://localhost:8080>，选择 **Live Collaboration** 创建房间，把房间链接分享给其他人。

首次构建需要几分钟（前端 yarn install + vite build）。

## 服务拓扑

```
浏览器
  │
  ├── /           → app（nginx 静态前端 + 运行时 config 注入）
  ├── /socket.io/ → room（官方 excalidraw-room，Socket.IO，WebSocket upgrade）
  └── /api/v2/    → storage（scene 密文 + 图片密文，SQLite + filesystem）
```

单域名部署：所有流量走 `app` 一个端口。WebSocket 与 storage 均为同源，无 CORS 配置负担。

## 配置（运行时环境变量，无需重新构建镜像）

默认全部为空 = 同源（`/socket.io`、`/api/v2`），单域名部署**零配置**。

| 变量 | 说明 | 示例 |
|---|---|---|
| `WS_SERVER_URL` | Socket.IO 服务器地址；空 = 同源 | `wss://collab.example.com` |
| `STORAGE_BASE_URL` | 存储 API 根（不含 `/api/v2`）；空 = 同源 | `https://storage.example.com` |
| `BACKEND_V2_GET_URL` / `BACKEND_V2_POST_URL` | 分享链接 scene 后端；空 = 同源 `/api/v2` | |
| `LIBRARY_URL` / `LIBRARY_BACKEND` | 素材库；空 = 隐藏入口 | |
| `PLUS_LP` / `PLUS_APP` | Excalidraw+ 链接；空 = 隐藏入口 | |
| `AI_BACKEND` | AI 功能后端；空 = 隐藏入口 | |
| `APP_PORT` | 宿主端口映射（compose 用） | `8080` |
| `CORS_ORIGIN` | room 服务的 CORS（默认 `*`，同源部署无需改） | |
| `MAX_BODY_BYTES` | storage 单请求上限（默认 10 MiB） | |

修改 `compose.yaml` 同级 `.env` 文件后 `docker compose up -d` 即生效（app 容器重启时重新生成 `/config.js`）。

> 机制：nginx 容器启动时由 `docker/nginx/10-runtime-config.sh` 用环境变量生成
> `config.js`（`window.__EXCALIDRAW_RUNTIME_CONFIG__`），前端
> `data/runtimeConfig.ts` 优先读它，其次才是 build-time 的 `VITE_APP_*`。

## 持久化与备份

- 数据在 `storage-data` volume：`storage.sqlite`（scene 元数据/密文）+ `files/`（图片密文）。
- 备份 = 停止写入后复制 volume（或 `docker compose exec storage` 内执行 `sqlite3` 备份 + 同步 `files/`）。
- 容器重启/升级不丢数据（volume 独立于容器生命周期）。
- 可选 GC：`docker compose exec storage node src/gc.js`（删除房间 scene 已不存在且 24h 未用的孤儿文件）。

## 安全说明

- 服务端只见密文：scene 与图片均在浏览器端用房间密钥（AES-128-GCM）加密后上传；房间密钥只在 URL hash 中流转。
- 房间链接即凭证（官方语义，无服务端鉴权）。如需要访问控制，请在反向代理层加 Basic Auth / SSO。
- 上传上限 10 MiB/请求（`MAX_BODY_BYTES`），nginx `client_max_body_size 12m`。
- ID 全部白名单校验（roomId 20 hex / fileId 40 hex / prefix 白名单），杜绝 path traversal。
- 生产环境请置于 HTTPS 之后（浏览器 Web Crypto API 需要安全上下文；`http://localhost` 除外）。

## 升级

1. `git pull`（或拉取新镜像 tag）→ 重新构建：`docker compose up -d --build`
2. 数据格式兼容策略：storage 的 SQLite schema 有版本演进时提供迁移；files/ 按内容寻址（fileId=SHA-1），旧文件天然兼容。
3. 前端跟随官方 upstream 的维护方案见 `notes/05-UPSTREAM-MAINTENANCE.md`。

## 本地开发（无 Docker）

```sh
# 终端 1：storage
cd docker/storage && node src/server.js        # :8080
# 终端 2：room（官方仓库或 docker/room）
cd ../room && yarn && yarn start:dev           # :3002
# 终端 3：前端
yarn && yarn start                             # :3001，.env.development 已指向 localhost:3002
```

开发模式下 `public/config.js` 为空对象 → 使用 build-time 默认值；如需连本地 storage，
在 `.env.development.local` 设置 `VITE_APP_STORAGE_BASE_URL=http://localhost:8080`。
