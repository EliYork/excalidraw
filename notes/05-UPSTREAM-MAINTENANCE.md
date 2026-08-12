# Upstream 维护方案（UPSTREAM_MAINTENANCE）

> 目标：Fork 持续跟进官方 `excalidraw/excalidraw`，自定义代码集中、可测试、可预期。
> 基线：官方 master `abeeaeba`（#11872），2026-08-12。

## 我们修改了哪些官方文件

| 文件 | 改动 | 与 upstream 冲突风险 |
|---|---|---|
| `excalidraw-app/data/firebase.ts` | **重写传输层**：Firestore/Storage SDK → HTTP storage backend（`./storage`）；保留全部导出签名（`saveToFirebase`/`loadFromFirebase`/`saveFilesToFirebase`/`loadFilesFromFirebase`/`isSavedToFirebase`/`loadFirebaseStorage`）与全部业务逻辑（加密、reconcile、版本缓存）；scene 保存由 Firestore 事务改为客户端 CAS 乐观重试 | **高**：upstream 常改此文件。merge 时以官方新逻辑为准，把官方新增行为移植回新结构 |
| `excalidraw-app/collab/Collab.tsx` | 2 行：import + `VITE_APP_WS_SERVER_URL` → `WS_SERVER_URL`（runtimeConfig） | 低（改动小、位置稳定） |
| `excalidraw-app/data/index.ts` | 3 行：BACKEND_V2 URL 来源改为 runtimeConfig | 低 |
| `excalidraw-app/index.html` | +1 script 标签（config.js） | 极低（head 追加） |
| `excalidraw-app/vite-env.d.ts` | +1 可选变量声明 `VITE_APP_STORAGE_BASE_URL` | 极低 |
| `public/config.js` | 新增（默认空配置占位） | 无冲突（新文件） |
| `Dockerfile` | nginx 阶段追加 3 行 COPY/RUN + healthcheck 路径 | 低（仅部署层） |

## 自定义模块（全部新增，不冲突）

```
excalidraw-app/data/runtimeConfig.ts        # runtime 配置读取（window.__EXCALIDRAW_RUNTIME_CONFIG__）
excalidraw-app/data/storage/types.ts        # StorageBackend 接口
excalidraw-app/data/storage/httpBackend.ts  # HTTP 实现（含 CAS、prefix 解析）
excalidraw-app/data/storage/index.ts        # backend 选择
docker/nginx/nginx.conf.template            # 反代 + WS upgrade
docker/nginx/10-runtime-config.sh           # config.js 生成（容器启动时）
docker/storage/                             # 自托管存储服务（零依赖 Node + SQLite + filesystem）
docker/room/                                # vendor 官方 excalidraw-room（业务代码未改）
compose.yaml                                # 单域名部署拓扑
```

## 后续 merge/rebase upstream 重点检查

1. **`excalidraw-app/data/firebase.ts`**：官方若改动（新字段/新函数/重构），需要把改动映射进我们的 HTTP 版本。方法：以官方版为基底重放我们的 diff（改动集中在文件后半部分）。
2. **`excalidraw-app/collab/Collab.tsx`**：检查 `socketIOClient(...)` 调用是否变化（transports 配置、重连选项）。若官方新增协作能力（如新的 WS 消息类型），对照 `app_constants.ts` 的 `WS_SUBTYPES` 与 Portal 广播逻辑是否需同步。
3. **`excalidraw-app/data/index.ts`**：`exportToBackend` 若改变分享链接流程，检查 `saveFilesToFirebase` 调用参数。
4. **`excalidraw-app/data/FileManager.ts` / `Portal.tsx`**：我们未改，但若官方改动上传/广播逻辑，可能影响图片共享链路（回归测试覆盖）。
5. **`package.json` / `vite.config.mts`**：若官方改构建（如 envDir、PWA 配置），检查 config.js 注入与 `public/` 是否受影响。
6. **firebase SDK 相关**：`package.json` 中 `firebase` 依赖若被官方移除/升级，我们已不引用（仅类型），merge 时确认无残留引用（`grep -r "firebase/" excalidraw-app`）。

## 预期冲突（normal）

- `firebase.ts`：每次官方触碰持久化都冲突 → 预期内，按上述映射重放。
- `Dockerfile`：官方改 nginx 阶段时（如加 PWA headers），小冲突，手工合并。
- `excalidraw-app/package.json`：依赖增删冲突频繁但机械。

## 同步 excalidraw-room（docker/room vendor）

- 官方 excalidraw-room 已基本停滞（最后 commit #361，2023-03）。同步方法：
  ```
  # 在 excalidraw-room 仓库 fetch 后：
  copy src/index.ts + package.json + yarn.lock + tsconfig.json → docker/room/
  ```
- 若未来官方有更新，仅替换这 4 个文件；**业务代码保持零改动**（我们的 Dockerfile 已修复 node:12 → node:24，勿覆盖）。

## 回归测试（自定义代码的自动化保障）

- `docker/storage/test/storage.test.js`（node:test，零依赖）：API/CAS/路径安全/超限/持久化
- `excalidraw-app/tests/collab.test.tsx`（官方，mock firebase 层）：确保签名兼容
- typecheck（`yarn test:typecheck`）与 `yarn test:app --watch=false`（vitest）
- 双浏览器验收脚本（阶段九）属手工/Playwright 验证
