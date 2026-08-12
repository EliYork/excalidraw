# 阶段一：真实基线（Git 基线记录）

调查日期：2026-08-12

## excalidraw/（主开发仓库，用户 Fork）

| 项目 | 值 |
|---|---|
| branch | `master`（与 `origin/master` 同步，working tree 干净，仅 `.reasonix/` untracked） |
| HEAD | `abeeaeba217ab3b5193b78c8d8d63c373b518ced` — "feat(editor): customizing color top picks (#11872)" |
| origin | `https://github.com/EliYork/excalidraw.git`（用户 Fork，**确认是 Fork**） |
| upstream | `https://github.com/excalidraw/excalidraw.git`（官方，已配置，未改动） |
| package manager | yarn 1.22.22（`packageManager` 字段；本机经 corepack 提供） |
| Node 要求 | `engines.node >= 18`；官方 Dockerfile 使用 `node:24` |
| 构建 | Vite 5.0.12（`excalidraw-app`），`vite.config.mts` 从仓库根 `loadEnv(mode, "../")` 读取 `.env.*` |
| 测试 | vitest 3.0.6（`yarn test:app`）、eslint、prettier、tsc typecheck |
| Dockerfile | 多阶段：`node:24` 构建 → `nginx:stable-alpine-slim` 静态托管 |
| Docker 构建 | `yarn build:app:docker` = `cross-env VITE_APP_DISABLE_SENTRY=true vite build`，**无任何 env 注入** |
| CI | `.github/workflows/build-docker.yml` / `publish-docker.yml`：`docker build -t excalidraw .`，无 build-arg |

## excalidraw-room/（官方协作服务器，参考对象）

| 项目 | 值 |
|---|---|
| branch | `master`（与 `origin/master` 同步，干净） |
| HEAD | `03ff435860b508d7cd9e005cfc90f7977ae2a593` — "Barnabasmolnar/follow mode (#361)" |
| origin | `https://github.com/excalidraw/excalidraw-room.git`（官方仓库，非 Fork） |
| 技术栈 | express 4.17 + socket.io 4.6.1 + TypeScript（编译到 dist） |
| 源码规模 | 单文件 `src/index.ts`（约 150 行） |
| Dockerfile | `node:12-alpine`（**已过时**），EXPOSE 80，无 healthcheck |
| 部署 | pm2 配置（pm2.json / pm2.production.json） |
| 环境变量 | `PORT`（默认 80/3002）、`CORS_ORIGIN`（默认 `*`）、dotenv 加载 `.env.production`/`.env.development` |

## 官方协作服务器行为（excalidraw-room/src/index.ts 全文确认）

- 纯消息转发，**零持久化、零鉴权、零速率限制**：
  - `server-broadcast` (roomID, encryptedData, iv) → `socket.broadcast.to(roomID).emit("client-broadcast", ...)`
  - `server-volatile-broadcast` → `socket.volatile.broadcast.to(roomID)`（volatile：连接断开即丢弃）
  - 房间管理：`join-room` → `first-in-room`（第一人）/ `new-user`（他人）
  - follow 模式：`user-follow` / `follow@<socketId>` 房间 / `user-follow-room-change` / `broadcast-unfollow`
  - `transports: ["websocket", "polling"]`，`allowEIO3: true`，CORS 可配置
- 服务端**看不到明文**：所有载荷已由客户端用 roomKey（AES-128-GCM）加密

## 关键配置事实（直接影响自托管）

1. **所有 `VITE_APP_*` 均为 build-time 变量**（`import.meta.env` 注入，vite-env.d.ts 声明），运行时容器 `-e` 无法改变。
2. 官方 `.env.production` 硬编码：
   - `VITE_APP_WS_SERVER_URL=https://oss-collab.excalidraw.com`
   - `VITE_APP_FIREBASE_CONFIG=<官方 Firebase project：excalidraw-room-persistence>`
   - `VITE_APP_BACKEND_V2_GET/POST_URL=https://json.excalidraw.com/api/v2/`
3. 官方 Docker 镜像（excalidraw/excalidraw:latest）因此**内置官方 collab server + 官方 Firebase**；自托管若直接用官方镜像，协作流量会走官方服务器——这是"自托管但延迟高/图片行为异常"的最可能根因之一（需实测确认）。
4. 无自定义 nginx.conf：Dockerfile 使用 nginx 默认配置（SPA 深链接 404，但 Excalidraw 用 hash 路由 `#room=...`，不受影响）。
5. 开发模式 `VITE_APP_WS_SERVER_URL=http://localhost:3002`（对应 excalidraw-room 默认 dev 端口）。

## 本机工具链（调查时）

- git 2.51.0、node v24.15.0、npm 11.12.1、corepack 0.34.6、python 3.13.0
- **yarn 需经 corepack 调用**（`corepack yarn`）
- **docker 不可用**（本机未安装）→ Docker 相关验收项将在交付报告标注"未验证（本机无 Docker）"或改为本地进程等价验证
