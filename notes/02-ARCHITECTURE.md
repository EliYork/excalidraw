# 阶段二：官方架构调查（源码级）

> 基于 fork HEAD `abeeaeba`（官方 #11872 之后的 master）源码逐行追踪。所有路径相对仓库根。

## A. 实时协作（WebSocket 链路）

### 创建/加入房间

1. UI 入口 → `App.tsx` 中 collab 按钮 → `collabAPIAtom`（`Collab.tsx` 暴露的 API）
2. `Collab.startCollaboration(existingRoomLinkData)`（`excalidraw-app/collab/Collab.tsx:481`）
   - 无现成房间 → `generateCollaborationLinkData()`（`data/index.ts:148`）：`roomId` = 10 字节随机 hex（20 字符），`roomKey` = AES-128-GCM 随机密钥 base64url（22 字符）
   - URL 形如 `#room=<roomId>,<roomKey>`（密钥在 hash 中，**永不发给服务器明文**）
3. 动态 `import("socket.io-client")` → `socketIOClient(import.meta.env.VITE_APP_WS_SERVER_URL, { transports: ["websocket", "polling"] })`（`Collab.tsx:533-536`）
   - **注意：优先 websocket，允许 polling 兜底；无任何 reconnection 自定义配置**（默认自动重连无限重试，delay 1000ms 指数退避）
4. `Portal.open()`（`collab/Portal.tsx:37`）：监听 `init-room` → `emit("join-room", roomId)`；`new-user` → 广播 SCENE_INIT 全量；`room-user-change` → 更新协作者列表

### 消息流

- 所有出站：`Portal._broadcastSocketData`（`Portal.tsx:85-102`）：`JSON.stringify → TextEncoder → encryptData(roomKey)`（AES-128-GCM，每次随机 12B IV）→ `emit(event, roomId, encryptedBuffer, iv)`
- 所有入站：`Collab` 监听 `client-broadcast`（`Collab.tsx:578`）→ `decryptPayload`（:458）→ 按 `type` 分发：
  - `SCENE_INIT`：首次初始化场景（:594-609）
  - `SCENE_UPDATE`：增量/全量元素更新（:611-618）→ `handleRemoteSceneUpdate` → `updateScene` + `loadImageFiles`（throttle 500ms）
  - `MOUSE_LOCATION` / `IDLE_STATUS` / `USER_VISIBLE_SCENE_BOUNDS`：协作者状态
- volatile 划分（`app_constants.ts:16-21`）：
  - **volatile（`server-volatile-broadcast`，丢失可接受）**：cursor 位置（33ms throttle ≈ 30fps）、idle 状态、视口边界（follow）
  - **非 volatile（`server-broadcast`）**：scene 元素数据（SCENE_INIT/SCENE_UPDATE）
- 增量广播：`broadcastScene`（`Portal.tsx:142-183`）按 `broadcastedElementVersions` Map 只广播版本有变化的元素；`syncAll=true` 才全量
- **完整同步**：`queueBroadcastAllElements` throttle `SYNC_FULL_SCENE_INTERVAL_MS = 20000ms`（20s 一次全量，`Collab.tsx:976-988`）
- 防回环：`lastBroadcastedOrReceivedSceneVersion` 只广播版本更高的（`Collab.tsx:960-969`）

### 初始化 / fallback

- `initializeRoom`（`Collab.tsx:714-759`）：
  - 收到 `SCENE_INIT` 且未初始化 → `fetchScene: false`
  - `connect_error`（once 监听）或 5s 超时（`INITIAL_SCENE_UPDATE_TIMEOUT`）→ `fetchScene: true` → `loadFromFirebase` 拉持久化场景
- 服务端判定：`join-room` 后 `fetchSockets().length <= 1` → `first-in-room`（客户端触发 `fetchScene: true`）；否则 `new-user` 广播
- `socketInitialized` 置 true 后才允许 emit（`Portal.tsx:76-83`），否则**静默丢弃**

### 服务端（excalidraw-room，全文 150 行已读）

纯转发 + 房间成员管理 + follow 房间。无状态、无持久化、无鉴权。

## B. 图片协作（FileManager 链路）

### 上传链路

1. 插入图片 → `newImageElement`（`packages/element/src/newElement.ts:575`）`status: "pending"`；`fileId` = SHA-1(dataURL) hex（`packages/excalidraw/data/blob.ts:260-272`）
2. `addFiles` → `App.tsx` 中 `addMissingFiles` → scene 变更 → `onSceneChange` → `Collab.broadcastElements` → `broadcastScene(UPDATE)`
3. `broadcastScene` 触发 `queueFileUpload`（throttle 300ms，`Portal.tsx:104-140`）→ `FileManager.saveFiles`
4. `FileManager.saveFiles`（`data/FileManager.ts:92-137`）→ `_saveFiles` → `encodeFilesForUpload`（:228-270）：dataURL → `compressData(buffer, {encryptionKey, metadata:{id,mimeType,created,lastRetrieved}})`（**先 pako deflate 压缩，再 AES-128-GCM 加密**，`packages/excalidraw/data/encode.ts:297-354`）→ `saveFilesToFirebase`（`data/firebase.ts:145`）：`uploadBytes(storage, buffer, {cacheControl: "public, max-age=31536000"})`，路径 `files/rooms/{roomId}/{fileId}`
5. 上传成功 → 元素 `status: "pending" → "saved"`（`Portal.tsx:124-129`）→ `updateScene` → 再次 `broadcastElements` 把 status 广播给远端
6. **大小限制**：`FILE_UPLOAD_MAX_BYTES = 4 MiB`（`app_constants.ts:12`），按**压缩前**字节检查（`FileManager.ts:255-261`）
7. 失败：`erroredFiles_save` 记录，status 保持 pending；重试依赖后续 broadcastScene 再次触发 queueFileUpload（画布静止则不重试）

### 下载链路（远端）

1. 收到 SCENE_UPDATE → `handleRemoteSceneUpdate` → `loadImageFiles`（throttle 500ms，`Collab.tsx:795-808`）
2. `fetchImageFilesFromFirebase`（`Collab.tsx:430-456`）：筛选 `isInitializedImageElement && !fileManager.isFileTracked(fileId) && !isDeleted && status === "saved"`（默认只拉 saved）
3. `FileManager.getFiles` → `loadFilesFromFirebase`（`data/firebase.ts:274`）：`fetch("https://firebasestorage.googleapis.com/v0/b/{bucket}/o/{prefix}%2F{id}?alt=media")` → `decompressData`（先解密后 inflate）→ `BinaryFileData {mimeType, id, dataURL, created, lastRetrieved}` → `excalidrawAPI.addFiles`
4. 失败 → `erroredFiles_fetch` 永久标记（同会话不再重拉，除非 `reset()`）+ `updateStaleImageStatuses` 把元素 status 置 `"error"`

### 缓存策略

- IndexedDB（`LocalData.ts` `files-db/files-store`，idb-keyval）：**图片二进制以 fileId 为键缓存**，读取时刷新 `lastRetrieved`；`clearObsoleteFiles` 删除不在画布且 24h 未用的文件
- HTTP 缓存：Firebase 返回 `Cache-Control: public, max-age=31536000`（1 年）
- collab 期间本地自动保存暂停（`LocalData.pauseSave("collaboration")`）

### 已知薄弱点（供阶段十优化参考）

1. `_broadcastSocketData` 在 socket 未初始化/断开时静默丢弃 → status:"saved" 可能永远不广播
2. 断线重连后**无重新 join-room / 无重新初始化**（依赖服务端重发 init-room）
3. 远端默认只拉 `status === "saved"` 的图
4. 上传失败无主动重试定时器

## C. Scene 持久化（Firestore 链路）

### 保存 `saveToFirebase`（`data/firebase.ts:187-247`）

- 触发：`syncElements` → `queueSaveToFirebase` throttle **20s**（`Collab.tsx:990-1002`，leading: false）+ 卸载前 `beforeUnload` + `stopCollaboration` 时
- 流程：`doc(firestore, "scenes", roomId)` → `runTransaction`：
  - 不存在 → 直接写 `{sceneVersion, ciphertext, iv}`
  - 存在 → 读旧文档 → `decryptElements`（用 roomKey）→ `reconcileElements`（与内存元素合并）→ 重新加密写入
- 存储格式（`FirebaseStoredScene`）：`{ sceneVersion: number, iv: Bytes, ciphertext: Bytes }` —— 元素 JSON 压缩加密（`encryptElements`：直接 `JSON.stringify(elements)` 后 `encryptData`，无 deflate）
- 缓存：`FirebaseSceneVersionCache`（WeakMap<Socket, sceneVersion>）避免重复保存（`isSavedToFirebase`）

### 加载 `loadFromFirebase`（`data/firebase.ts:249-272`）

- `getDoc` → 解密 → `restoreElements(..., {deleteInvisibleElements: true})` → `getSyncableElements`
- 触发：`initializeRoom(fetchScene: true)`（connect_error / 超时 / first-in-room）

### 移除 Firebase 需替代的能力（清单）

| 能力 | 官方实现 | 自托管替代 |
|---|---|---|
| Scene 文档读写 + 事务合并 | Firestore `scenes/{roomId}` + runTransaction | HTTP API：GET/PUT `scenes/{roomId}`，服务端读-改-写（需并发安全） |
| 文件上传 | Firebase Storage `files/rooms/{roomId}/{fileId}` | HTTP PUT `files/rooms/{roomId}/{fileId}`（密文直存，服务端不可见明文） |
| 文件下载 | `.../o/...?alt=media` | HTTP GET 同路径（1 年缓存头） |
| 分享链接文件 | Firebase Storage `files/shareLinks/{id}` | 同一文件 API |
| 删除/生命周期 | 无自动清理（官方也不删） | 可选 GC：孤儿文件 + 过期 scene |

## D. Docker / 配置（build-time vs runtime）

- 全部 `VITE_APP_*` 是 **build-time**（`import.meta.env`），vite 从仓库根 `.env.{mode}` 读取（`vite.config.mts:13,23`）
- 官方 Dockerfile 构建时**不注入任何 env** → 官方镜像 = 官方配置（oss-collab + 官方 Firebase）
- 结论：自托管必须解决 runtime config。方案选项：
  1. **构建时注入**（官方方式）：`docker build --build-arg VITE_APP_WS_SERVER_URL=...` —— 换域名要重建，不满足"部署者不重建"需求
  2. **运行时注入**：构建产物为静态文件 → 需要 nginx 用 `envsubst` 模板注入，或前端加 runtime config 加载层（`/config.json` + 启动时 fetch），把 `import.meta.env` 默认值替换为 runtime 值
- 官方 nginx 无自定义配置；WebSocket 反代需显式配置（Upgrade 头）——官方默认 nginx.conf 甚至没有反代（因为前端直连 oss-collab）

## E. 加密边界（确认）

- 服务端（room + storage）只接触：密文、IV、roomId、fileId、sceneVersion
- roomKey 只在客户端 URL hash 中流转；storage 密钥=roomKey（同一密钥加密 scene 与文件）
- 加密：AES-128-GCM（`packages/common/src/constants.ts:350` `ENCRYPTION_KEY_BITS=128`），文件先 deflate 后加密，scene 直接 JSON 后加密
