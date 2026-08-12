# 阶段六：性能与延迟基线（2026-08-12，本机 localhost）

> 方法：协议级双客户端（scripts/collab-diag.mjs）+ storage 请求日志。浏览器端
> 拖拽/光标体感延迟由用户人工验收（本机未执行 Playwright 浏览器自动化）。

## 环境

- 单机 Windows，room（ts-node-dev 转译官方 excalidraw-room）:3002，storage:8080，前端 vite dev :3001
- 无中间代理（直连本机服务）——这是"零代理开销"的对照基线

## Transport 确认（关键证据）

```
[A] connected, transport=websocket
[B] connected, transport=websocket
A: websocket   B: websocket
```

- Socket.IO 实际使用 **websocket**（非 polling）。协议级证据充分；
  浏览器 devtools Network → WS 帧 由用户人工确认。

## 消息延迟（A → room → B，30 轮）

| 路径 | min | p50 | p95 | avg |
|---|---|---|---|---|
| scene update（server-broadcast，非 volatile） | 0.40ms | 0.50ms | 0.70ms | 0.51ms |
| cursor 类（server-volatile-broadcast） | 0.41ms | 0.49ms | 0.74ms | 0.51ms |

（重复运行 2 次，结果一致：p50 ≈ 0.5ms）

## Storage 请求耗时（storage 服务日志实测）

| 请求 | 耗时 |
|---|---|
| PUT/GET scenes | 0–2ms |
| PUT/GET files | 1–4ms |
| /health | ~2ms |

（单机 SQLite + filesystem，符合预期；公网部署时此项由网络 RTT 主导）

## 结论与归因框架

- 官方前端 throttle 常量（app_constants.ts）：cursor 33ms、全量同步 20s、scene 保存 20s ——
  这些是**前端固有节流**，与网络无关；体感"拖拽跟随"的延迟下限 ≈ cursor 节流 + 网络 RTT + 浏览器渲染。
- 延迟分层归因（供人工验收时对照）：
  1. 网络 RTT（ping 目标域名）
  2. transport（必须 websocket；若 polling 则每次消息多一次 HTTP 往返）
  3. 前端节流（cursor 33ms / scene 20s 全量）
  4. storage round-trip（scene 保存 20s 节流 + 保存时 GET+PUT 两次请求）
  5. 反代（nginx upgrade 配置错误 → polling 静默降级；`proxy_buffering off` + Upgrade 头已配置）
- 诊断手段：`window.excalidrawDiag()`（console.table）直接显示 transport/reconnect/pending files/storage 状态；
  降级到 polling 时 transport 字段会从 "websocket" 变为 "polling"，不再静默。

## 优化决策（阶段十）

本轮**未做**任何性能优化（符合"先测后优化"）。已识别候选（按优先级）：
1. polling fallback 静默问题 → 已由诊断面板解决（显式可见）；未改 transport 策略（保持官方默认 websocket+polling，避免破坏官方体验）
2. 图片下载 1 年 Cache-Control + IndexedDB（官方已有，保留）
3. scene 保存 20s 节流（官方语义，保留）
4. 上传失败重试仅依赖后续广播（官方行为，阶段八记录为已知弱点，未改——避免侵入 FileManager）
