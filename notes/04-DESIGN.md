# 阶段四：目标架构设计

## 1. 架构总览

```
Browser (Excalidraw SPA)
   │
   ├── GET /                 → nginx 静态托管 + 运行时注入 config.js
   ├── /socket.io/ (WS)      → nginx (Upgrade) → room 容器（官方 excalidraw-room）
   └── /api/v2/ (HTTP)       → nginx → storage 容器（自研 Node：SQLite + filesystem）
                                     ├── scenes/{roomId}    （密文 scene，CAS 并发控制）
                                     └── files/{prefix}/{fileId}（密文图片，1 年缓存）
   persistent volume: /data（SQLite 文件 + files/ 密文）
```

服务拓扑（Docker Compose，单域名，全部同源 → 无 CORS 问题，WebSocket 同源无跨域）：

| 服务 | 镜像/实现 | 端口 | 职责 |
|---|---|---|---|
| `app` | nginx（官方 Dockerfile 扩展） | 80 | 静态前端 + /socket.io/ 反代 + /api/v2/ 反代 + runtime config 注入 + healthcheck |
| `room` | 官方 excalidraw-room（node 镜像，修复过时 node:12 Dockerfile） | 80 | Socket.IO 转发（原样，零改动业务代码） |
| `storage` | 自研 Node.js（Express + better-sqlite3） | 80 | Scene/File HTTP API，SQLite 元数据 + filesystem 密文 |

## 2. 为什么 SQLite + filesystem 合适（对照用户约束）

- 数据完整性：SQLite 单文件事务（WAL 模式），scene 写入走事务 + 原子提交；文件先写临时文件再 rename（原子），fsync 落盘
- 并发安全：scene 用 **ETag/If-Match 乐观锁**（CAS），替代 Firestore runTransaction 的读-改-写语义；冲突 409 → 前端重读-合并-重试（官方 reconcile 逻辑不变，只是从"服务端事务"变成"客户端乐观重试"）
- 文件生命周期：SQLite `files` 表记录 (file_id, prefix, size, created_at, updated_at)，GC 脚本删除孤儿文件（prefix 对应 scene 不存在 或 超过 TTL）
- 备份：`sqlite3 .backup` 或直接复制 volume（WAL checkpoint）+ files 目录；文档化
- 升级：数据格式自持，storage 容器无状态化设计（SQLite 在 volume），版本兼容策略文档化
- 轻量：单容器、单文件 DB、无外部服务 —— 符合小规模私人/朋友场景

如果规模增长（多实例、S3 归档）→ Adapter 抽象层（见 §6），可替换存储实现。

## 3. 前端改造（最小侵入清单）

**核心原则：保留官方全部加密/压缩/reconcile/FileManager 逻辑，只替换"远端存储传输层"。**

| 文件 | 改动 | 说明 |
|---|---|---|
| `excalidraw-app/data/firebase.ts` | **主要改造** | 移除 firebase SDK 依赖；`saveToFirebase`/`loadFromFirebase` 内部改为 HTTP GET/PUT scenes；`saveFilesToFirebase`/`loadFilesFromFirebase` 改为 HTTP PUT/GET files；**函数签名与导出名不变**（Collab.tsx 等调用方零改动）；scene 保存加乐观锁重试 |
| `excalidraw-app/data/runtimeConfig.ts` | **新增** | 读取 `window.__EXCALIDRAW_RUNTIME_CONFIG__`（nginx 注入的 config.js），fallback 到 `import.meta.env` 默认值；提供 `getStorageBaseUrl()` / `getWsServerUrl()` 等 |
| `excalidraw-app/index.html` | +1 行 | `<script src="/config.js"></script>`（nginx 生成，未生成时 404 由 fallback 兜底——需保证 404 不阻塞，用 onerror 或 nginx 提供空 config.js） |
| `excalidraw-app/collab/Collab.tsx` | 0（期望） | 只用 `VITE_APP_WS_SERVER_URL` 一处（:534）→ 改为 runtimeConfig |
| 其余官方文件 | 0 | |

预期 diff 集中在 3 个文件 + 新增 1 个，满足"自定义代码集中"约束。

## 4. Storage API 规格

```
PUT /api/v2/scenes/{roomId}
  body: { "sceneVersion": number, "iv": base64, "ciphertext": base64 }
  headers: If-Match: "<etag>"（可选，乐观锁）
  200 → { "etag": "..." }（已更新） | 409 Conflict（版本冲突，前端重试）| 413 超限
GET /api/v2/scenes/{roomId}
  200 → { "sceneVersion": number, "iv": base64, "ciphertext": base64, "etag": "..." }
  404 → 不存在（前端视为空场景）

PUT /api/v2/files/{prefix}/{fileId}
  body: 密文二进制（application/octet-stream）
  200 | 413 超限
GET /api/v2/files/{prefix}/{fileId}
  200 密文二进制 + Cache-Control: public, max-age=31536000 | 404
DELETE /api/v2/files/{prefix}/{fileId}（可选，后续）
```

- 数据格式与官方 Firebase 完全一致（scene: `{sceneVersion, iv, ciphertext}`；文件：deflate+AES-GCM 后的字节流）→ **加密边界不变：服务端只见密文**
- `fileId` 校验：`^[a-f0-9]{40}$`（SHA-1 hex）；`roomId` 校验：`^[a-f0-9]{20}$`；prefix 白名单（`files/rooms`、`files/shareLinks`）→ 防 path traversal
- 限制：body ≤ 10 MiB（官方 4MiB 原始 + deflate 后一般更小，留余量）；磁盘配额可选
- `roomId` 校验注意：官方 `getCollaborationLinkData` 只校验 key 长度；roomId 是 10 字节 hex（20 字符）。**服务端不信任 roomId**（新房间允许创建——无鉴权是官方语义）

## 5. Runtime 配置注入（nginx）

- build 时：`vite build` 产物包含 `config.js` 引用 + `import.meta.env` 默认值（指向相对路径/空）
- 运行时：nginx entrypoint 执行 `envsubst < /etc/nginx/templates/config.js.template > /usr/share/nginx/html/config.js`，生成：
  ```js
  window.__EXCALIDRAW_RUNTIME_CONFIG__ = {
    wsServerUrl: "${WS_SERVER_URL}",
    storageBaseUrl: "${STORAGE_BASE_URL}",
    backendV2GetUrl: "${BACKEND_V2_GET_URL}",
    backendV2PostUrl: "${BACKEND_V2_POST_URL}",
    libraryUrl: "${LIBRARY_URL}",
    ...
  };
  ```
- 默认值（未设 env）：`wsServerUrl: ""`（同源 /socket.io）、`storageBaseUrl: ""`（同源 /api/v2）→ **单域名部署零配置**
- 前端 `runtimeConfig.ts`：`const cfg = window.__EXCALIDRAW_RUNTIME_CONFIG__ ?? {}; export const WS_SERVER_URL = cfg.wsServerUrl || import.meta.env.VITE_APP_WS_SERVER_URL || undefined;`（undefined → socket.io-client 默认同源）

## 6. Storage Adapter 抽象（防散落）

前端 `excalidraw-app/data/` 下：
```
storage/
  types.ts        // StorageBackend 接口: saveScene/loadScene/saveFiles/loadFiles
  httpBackend.ts  // HTTP 实现（乐观锁重试）
  index.ts        // 根据 runtimeConfig.storageBackend 选择（"http" | "firebase" 兼容位）
```
- 默认 `http`；保留 firebase 分支（官方原代码搬迁）作为可选 adapter —— 与上游 merge 时冲突面最小（上游 firebase.ts 的改动集中在 adapter 内部）

## 7. 安全设计（对照用户清单）

| 风险 | 对策 |
|---|---|
| path traversal | fileId/roomId/prefix 白名单正则；路径由服务端拼装 |
| 任意文件覆盖 | 仅通过 API 写，文件名=fileId（内容寻址），同 ID 覆盖无害（内容相同） |
| 文件名不可信 | 客户端只传 ID，不传文件名；文件名由服务端生成 |
| MIME 欺骗 | 服务端不解析内容，密文直存；Content-Type 固定 octet-stream |
| body size | 10MiB 上限（Express body-parser limit）+ nginx client_max_body_size |
| disk exhaustion | 可选配额（每 room 上限）；上传失败事务回滚；GC |
| CORS | 同源部署默认无 CORS；跨域部署时按 env 白名单 |
| room ID 枚举 | 官方语义即无鉴权（key 即凭证）；可选 `ROOM_ACCESS_TOKEN` 环境变量（反向代理层 Basic Auth）作为部署加固，不做默认 |
| API abuse | 轻量速率限制（固定窗口 per-IP，默认关/可配）；日志不记 body/密钥 |
| XSS/SVG | 前端既有（图片密文不进 DOM，解密后 dataURL 由官方渲染路径处理）；服务端零解析 |
| image bombs | 4MiB 原始限制（官方）已在客户端执行；服务端 10MiB 硬上限 |
| malformed payload | 解密失败 → 前端 alert + 忽略（官方逻辑）；服务端只存字节 |
| database corruption | SQLite WAL + 事务 + 完整性检查（PRAGMA integrity_check 于 healthcheck） |
| secret logging | 不记录 roomKey（前端 hash 中，不发出）；日志脱敏 |

## 8. 性能/延迟设计（阶段十基线后再定优化）

- 全部同源单域名 → WebSocket 直连无跨域开销
- storage 与前端同机部署（compose 内网）→ scene/file RTT ≈ 局域网
- 图片下载 1 年 Cache-Control + IndexedDB 双缓存（官方已有）
- 诊断：`/api/v2/health` 供前端/运维探测

## 9. 测试设计

- storage 服务单测（vitest/node:test）：API 正确性、CAS 冲突、path traversal、超限、原子写
- 前端 adapter 单测：mock fetch，验证 URL/请求体/重试逻辑
- 集成：双浏览器（Playwright）同一房间画图/图片互见（阶段九）
- transport 证据：Socket.IO 客户端 `socket.io.engine.transport.name` + nginx access log + 服务端握手日志
