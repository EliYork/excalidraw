# 交付报告（2026-08-12）

## 1. 原始 Git 基线

| 仓库 | branch | HEAD | remote |
|---|---|---|---|
| excalidraw/（用户 Fork ✓） | master | `abeeaeba217ab3b5193b78c8d8d63c373b518ced`（官方 #11872） | origin=EliYork/excalidraw，upstream=excalidraw/excalidraw（未改动） |
| excalidraw-room/（官方） | master | `03ff435860b508d7cd9e005cfc90f7977ae2a593`（#361） | origin=官方（未改动） |

working tree 初始干净（仅 `.reasonix/` untracked）。**未 push、未改 remote、未 force**。

## 2. 官方架构（调查结论摘要）

- 协作：前端 Collab/Portal 加密（AES-128-GCM，roomKey）后经 Socket.IO 转发；volatile 用于 cursor/idle/viewport，非 volatile 用于 scene 元素；增量广播 + 20s 全量；无重连重初始化
- 图片：FileManager（pending→saved→error 状态机）；deflate+加密后传 Firebase Storage（`files/rooms/{roomId}/{fileId}`）；远端按 fileId 下载解密；IndexedDB + 1 年 Cache-Control 双缓存
- Scene：Firestore `scenes/{roomId}` 文档 `{sceneVersion, iv, ciphertext}`，事务内解密-合并-重加密；20s 节流保存
- 配置：**全部 VITE_APP_* 为 build-time**；官方 Docker 镜像硬编码官方 .env.production（oss-collab + 官方 Firebase）

## 3. 原先图片无法共享的实际原因

官方实现依赖 Firebase Storage；自托管若直接用官方镜像或未正确替换存储层：
- 上传走官方 Firebase bucket（凭官方 config），自托管环境不可达/不可见 → 远端永远拉不到
- 即使 WS 通了，图片仍走 Firebase → "协作能画但图不显示"
（改造后：图片密文走自托管 storage，同源 /api/v2，不再依赖 Firebase）

## 4. 原先延迟高的已确认原因

**未在本机复现用户现场**（无公网环境）。已确认的架构级事实：
- 官方镜像 = 前端直连 `oss-collab.excalidraw.com` + 官方 Firebase → 自托管用户实际在跨境/跨运营商链路传输 → 高延迟主因之一（架构证据：.env.production 硬编码 + Dockerfile 零 env 注入）
- polling fallback：nginx 反代若未配 Upgrade 头/`proxy_http_version 1.1`，Socket.IO 静默降级 polling（每次消息 2 次 HTTP 往返）——已配置正确反代（nginx.conf.template），并新增诊断面板使降级可见
- 本机基线：websocket p50=0.5ms（scene/cursor），storage 0-4ms —— 本地链路无瓶颈
- **公网部署实际体感延迟待用户人工验收**（拖拽/光标延迟）

## 5. 最终架构

```
Browser ─┬─ /           → nginx 静态前端 + 启动时注入 config.js（runtime config）
         ├─ /socket.io/ → room（官方 excalidraw-room，WS upgrade）
         └─ /api/v2/    → storage（自研零依赖 Node：SQLite + filesystem）
持久化：storage-data volume（storage.sqlite + files/ 密文）
```
- 单域名同源部署，默认零配置（`docker compose up -d --build`）
- 保留官方加密/压缩/reconcile/FileManager 全部逻辑，仅替换传输层（StorageBackend 接口）
- runtime config 优先级：`window.__EXCALIDRAW_RUNTIME_CONFIG__`（nginx 生成）> build-time env

## 6. 新增和修改的文件

新增：
- `excalidraw-app/data/runtimeConfig.ts`、`data/storage/{types,httpBackend,index}.ts`
- `excalidraw-app/collab/diagnostics.ts`、`tests/storageBackend.test.ts`
- `public/config.js`、`compose.yaml`、`SELFHOST.md`
- `docker/storage/*`（服务源码+测试+Dockerfile）、`docker/room/*`（vendor 官方+修复 Dockerfile）、`docker/nginx/*`
- `scripts/{collab-diag,storage-e2e,ui-acceptance}.mjs`
- `notes/01..06`（本文档 07）

修改（官方文件，全部最小侵入）：
- `excalidraw-app/data/firebase.ts`（传输层替换，导出签名不变）
- `excalidraw-app/collab/Collab.tsx`（WS URL 来源 + getDiagnostics + reconnect 计数）
- `excalidraw-app/data/index.ts`（backend URL 来源）
- `excalidraw-app/index.html`（+config.js script）、`index.tsx`（+initDiagnostics）、`vite-env.d.ts`（+1 变量）
- `Dockerfile`（nginx 阶段 + 模板/entrypoint）、`.gitignore`（+storage data）

## 7. Docker 服务拓扑

| 服务 | 实现 | 暴露 | 依赖 |
|---|---|---|---|
| app | 根 Dockerfile（node:24 build → nginx），/socket.io/ + /api/v2/ 反代 | 8080→80 | room, storage |
| room | docker/room（官方 excalidraw-room 业务零改动，node:24，健康检查） | 内网 80 | — |
| storage | docker/storage（零 npm 依赖，node:24-alpine） | 内网 8080 | storage-data volume |

`compose.yaml` 单文件；环境变量（WS_SERVER_URL 等）可经 .env 覆盖。

## 8. Storage 数据格式

- SQLite `scenes(room_id PK, scene_version, iv BLOB, ciphertext BLOB, created_at, updated_at)`；etag=`{scene_version}-{updated_at}`
- SQLite `files(kind, owner_id, file_id, size, created_at, updated_at)`
- filesystem `DATA_DIR/files/{kind}/{ownerId}/{fileId}` = 密文字节（kind ∈ rooms|shareLinks）
- 传输格式与官方 Firebase 完全一致（scene JSON `{sceneVersion, iv, ciphertext}`；文件为 deflate+AES-GCM 字节流）
- 原子写（tmp+rename）、WAL、CAS（If-Match/409）、可选 GC（`node src/gc.js`）

## 9. 图片协作完整数据流（改造后）

A 上传 → `addFiles`（fileId=SHA-1）→ `broadcastScene(UPDATE)`（status=pending）→ `queueFileUpload`(300ms) → `encodeFilesForUpload`（deflate→AES-GCM，roomKey）→ `PUT /api/v2/files/rooms/{roomId}/{fileId}` → 成功置 status=saved → 广播 UPDATE → B 收到 → `loadImageFiles`(500ms throttle) → `GET /api/v2/files/...` → `decompressData`（解密→inflate）→ `addFiles` → 渲染。缓存：IndexedDB（fileId 键）+ 1 年 Cache-Control。

## 10. Scene 持久化数据流

保存：`syncElements` → `queueSaveToFirebase`（20s throttle）→ `saveToFirebase`：GET scene → 解密 → `reconcileElements` 合并 → 加密 → `PUT (If-Match)` → 409 重读重试（≤3 次，替代 Firestore 事务）。
加载：join 房间初始化（connect_error/5s 超时/first-in-room）→ `loadFromFirebase`：GET → 解密 → restoreElements → 渲染。

## 11. 加密边界

- 服务端（room + storage）只见：密文、IV、roomId、fileId、sceneVersion。**无明文**
- roomKey 只在客户端 URL hash（`#room=roomId,key`），不发给服务器；scene 与文件同 key（AES-128-GCM）
- 验证：storage-e2e 协议级验证了"服务端存取的是密文"（解密只在客户端侧完成）

## 12. 自动测试（本机已执行）

| 测试 | 结果 |
|---|---|
| docker/storage/test/storage.test.js（node:test，8 项：API/CAS/path traversal/413/持久化） | 8/8 ✓ |
| excalidraw-app/tests/storageBackend.test.ts（vitest，9 项：URL/编码/409/prefix） | 9/9 ✓ |
| excalidraw-app/tests/collab.test.tsx（官方，2 项） | 2/2 ✓ |
| scripts/storage-e2e.mjs（协议级 15 项：加密 scene/文件往返、双客户端 CAS 冲突合并） | 15/15 ✓ |
| scripts/collab-diag.mjs（协议级双客户端：transport + 延迟） | ✓（websocket，p50 0.5ms） |
| `yarn test:typecheck`（tsc） | ✓ 无错误 |
| `yarn build:app:docker`（vite build） | ✓ built in ~17s，产物含 config.js |

## 13. 双客户端协作测试

- 协议级（socket.io-client ×2，模拟官方协议）：join/first-in-room/new-user、scene 广播、volatile 广播、transport=websocket —— **已自动验证**
- **浏览器 UI 级（画图互见、光标、拖拽）：未执行浏览器自动化，待用户人工验收**（验收步骤见 SELFHOST.md / scripts/ui-acceptance.mjs 说明）

## 14. transport 证据

- 协议级：`[A]/[B] transport=websocket`（collab-diag 输出，两轮一致）
- 浏览器 devtools 人工确认方法：F12 → Network → WS → 查看帧；或 console 执行 `window.excalidrawDiag()`（transport 字段）

## 15. 性能优化前后数据

本轮未做优化（阶段十前置条件是公网基线）。已记录本机基线（notes/06）与候选优化清单。**无优化前后对比数据**（如实标注）。

## 16. 安全检查（对照清单）

| 项 | 状态 |
|---|---|
| path traversal | ✓ ID 白名单正则（roomId 20hex/fileId 40hex/prefix 白名单）+ 测试 |
| 任意文件覆盖 | ✓ 仅 API 可写；内容寻址 fileId，同 ID 覆盖内容相同 |
| 文件名不可信 | ✓ 服务端不使用客户端文件名 |
| MIME 欺骗 | ✓ 服务端零解析，固定 octet-stream |
| body size | ✓ 10MiB 服务端硬限（413 测试）+ nginx 12m |
| disk exhaustion | ⚠️ 无配额；GC 脚本回收孤儿文件；文档建议磁盘监控 |
| CORS | ✓ `*`（密文无凭证；同源部署无 CORS） |
| room ID | ✓ 校验；官方语义无鉴权（key 即凭证） |
| 未授权枚举 | ⚠️ 与官方一致（无鉴权）；文档建议反代层 Basic Auth 加固 |
| API abuse | ⚠️ 无内置限速；密钥不落日志 |
| XSS / SVG | ✓ 服务端零解析；前端官方渲染路径 |
| image bombs | ✓ 客户端 4MiB + 服务端 10MiB 上限 |
| malformed payload | ✓ 解密失败前端忽略（官方逻辑） |
| database corruption | ✓ WAL + health 内 PRAGMA integrity_check |
| secret logging | ✓ 日志仅 method/path/status/ms；roomKey 在 hash 不落服务端 |

## 17. Upstream 维护方案

见 `notes/05-UPSTREAM-MAINTENANCE.md`：修改文件清单与冲突预期、自定义模块位置、merge 检查点、room vendor 同步方法。核心：自定义代码集中（storage/ + runtimeConfig + docker/），官方文件改动收敛在 firebase.ts（接口签名不变）。

## 18. 尚未解决的问题 / 待用户人工验收

1. **浏览器 UI 级双客户端协作**（A 画 B 收、光标、拖拽体感）
2. **浏览器图片共享**（上传→远端自动显示、刷新/重进恢复、B→A 反向）
3. **浏览器 transport 实际状态**（devtools WS 帧确认）
4. **Docker compose 实际起栈**（本机无 Docker，Dockerfile/compose 静态检查通过但未运行；建议在目标服务器 `docker compose up -d --build`）
5. **nginx 模板/envsubst 渲染**（本机无 nginx；风险点：`$http_upgrade` 等 nginx 变量在官方镜像 envsubst 下仅替换已定义变量——已按官方机制规避）
6. **公网部署延迟体验**（依赖真实网络；诊断面板可现场确认 transport/RTT 分层）
7. 分享链接（`exportToBackend`）：scene 主体默认仍指向官方 json.excalidraw.com（BACKEND_V2_* 可配自托管端点，但 storage 的 shareLinks 文件 API 已就绪；如需完全自托管分享链接，需为 storage 增加 POST /api/v2/post/ 与 GET /api/v2/{id} 端点——未实现）
8. 上传失败主动重试定时器、断线重连后重新初始化（官方行为，已记录为已知弱点，未改）

## 19. 推荐下一步

1. 目标服务器上跑通 `docker compose up -d --build`，人工双浏览器验收（步骤见 SELFHOST.md 与 scripts/ui-acceptance.mjs 的说明）
2. 公网部署后执行 `window.excalidrawDiag()` + collab-diag 记录真实基线 → 再进入阶段十优化
3. 按需实现分享链接自托管端点（第 18.7 项）
4. 定期 `git fetch upstream && git merge`，按 notes/05 检查点处理冲突
