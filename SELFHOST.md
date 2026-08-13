# 自托管部署（Self-hosted Excalidraw）

完整的实时协作 + 图片共享 + Scene 持久化，全部自托管，不依赖 Firebase 或任何外部服务。

## 快速开始

前置：Docker + Docker Compose。两种部署模式（拓扑相同、持久化 volume 共享，可随时切换）：

- **本地构建**：`docker compose up -d --build`（下文本地示例）
- **GHCR 预构建镜像**：`docker compose -f compose.ghcr.yaml up -d`（生产推荐，见 [GHCR 镜像发布与生产部署](#ghcr-镜像发布与生产部署)）

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
| `MAX_FILE_UPLOAD_BYTES` | 图片上传上限（字节；默认 `20971520` = 20 MiB）。单一来源：前端检查 + storage body limit + nginx `client_max_body_size` 三者一致 | `10485760`（10 MiB） |

修改 `compose.yaml` 同级 `.env` 文件后 `docker compose up -d` 即生效（app 容器重启时重新生成 `/config.js`）。

> 机制：nginx 容器启动时由 `docker/nginx/10-runtime-config.sh` 用环境变量生成
> `config.js`（`window.__EXCALIDRAW_RUNTIME_CONFIG__`），前端
> `data/runtimeConfig.ts` 优先读它，其次才是 build-time 的 `VITE_APP_*`。

## 持久化与备份

- 数据在 `storage-data` volume（显式名 `excalidraw-storage-data`，本地构建与 GHCR 镜像两种模式共享同一 volume）：`storage.sqlite`（scene 元数据/密文）+ `files/`（图片密文）。
- 备份 = 停止写入后复制 volume（或 `docker compose exec storage` 内执行 `sqlite3` 备份 + 同步 `files/`）。
- 容器重启/升级不丢数据（volume 独立于容器生命周期）。
- 可选 GC：`docker compose exec storage node src/gc.js`（删除房间 scene 已不存在且 24h 未用的孤儿文件）。

## 安全说明

- 服务端只见密文：scene 与图片均在浏览器端用房间密钥（AES-128-GCM）加密后上传；房间密钥只在 URL hash 中流转。
- 房间链接即凭证（官方语义，无服务端鉴权）。如需要访问控制，请在反向代理层加 Basic Auth / SSO。
- 上传上限默认 20 MiB/请求（单一来源 `MAX_FILE_UPLOAD_BYTES`：前端检查 + storage `MAX_BODY_BYTES` + nginx `client_max_body_size` 三者一致，改环境变量即全局生效）。
- ID 全部白名单校验（roomId 20 hex / fileId 40 hex / prefix 白名单），杜绝 path traversal。
- 生产环境请置于 HTTPS 之后（浏览器 Web Crypto API 需要安全上下文；`http://localhost` 除外）。

## GHCR 镜像发布与生产部署

发布链路：`.github/workflows/ghcr-publish.yml`。推送 `master`、推送 `v*` tag 或手动触发 `workflow_dispatch` 时，构建并发布三个镜像到本仓库的 GHCR 命名空间：

```
ghcr.io/<owner>/<repo>/app
ghcr.io/<owner>/<repo>/room
ghcr.io/<owner>/<repo>/storage
```

无需配置任何 secret：`GITHUB_TOKEN` 自动持有 `packages: write`，且命名空间跟随仓库（fork 自动发布到自己的命名空间）。镜像为多平台（`linux/amd64`、`linux/arm64`），带完整 OCI metadata（source/revision/created/license 等），构建层缓存经 GitHub Actions cache 复用（BuildKit `type=gha`，按镜像隔离，不互相淘汰）。

### tag 策略

| tag | 何时推送 | 用途 |
|---|---|---|
| `sha-<12hex>` | 每次推送（不可变） | 精确定位某次构建；回滚/复现的锚点 |
| `latest` | 默认分支每次推送；`v*` tag 推送时同时更新 | compose 默认引用，跟随最新 |
| `vX.Y.Z` | 推送 `v*` tag 时（同时更新 `latest`） | 语义化版本发布点 |

### 生产部署（预构建镜像，无本地构建）

1. `cp .env.example .env`，设置 `GHCR_IMAGE_PREFIX=ghcr.io/<owner>/<repo>`（与你的仓库一致）
2. `docker compose -f compose.ghcr.yaml up -d`
3. 打开 <http://localhost:8080>（或 `APP_PORT`）

与 `compose.yaml`（本地构建模式）拓扑完全一致；`storage-data` volume 显式同名共享，两种模式可随时切换，数据不丢。

### 更新

- 跟随默认分支：`docker compose -f compose.ghcr.yaml pull && docker compose -f compose.ghcr.yaml up -d`（`latest` 已随每次推送更新）
- 跟随发布版本：`.env` 设 `IMAGE_TAG=vX.Y.Z` → `docker compose -f compose.ghcr.yaml up -d`
- 数据格式兼容策略见下节「升级」。

### 回滚

- `.env` 设 `IMAGE_TAG=sha-<12hex>`（或上一发布 `vX.Y.Z`）→ `docker compose -f compose.ghcr.yaml up -d`。镜像常驻 GHCR，无需重新构建。
- 回滚不影响数据：volume 独立于镜像生命周期，新旧镜像读写同一 `storage-data`；schema 有演进时按「升级」节的迁移策略处理。

### 备份与恢复

数据全部在 `storage-data` volume（SQLite + 密文文件），备份/恢复见上节「持久化与备份」——两种部署模式完全一致。

## 升级

1. 本地构建模式：`git pull`（或拉取新镜像 tag）→ 重新构建：`docker compose up -d --build`
2. GHCR 镜像模式：`docker compose -f compose.ghcr.yaml pull && docker compose -f compose.ghcr.yaml up -d`（或 `.env` 改 `IMAGE_TAG` 后 `up -d`）
3. 数据格式兼容策略：storage 的 SQLite schema 有版本演进时提供迁移；files/ 按内容寻址（fileId=SHA-1），旧文件天然兼容。
4. 前端跟随官方 upstream 的维护方案见 `notes/05-UPSTREAM-MAINTENANCE.md`。

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
