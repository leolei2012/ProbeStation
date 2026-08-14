# @probebench/cli

ProbeStation 启动入口：装配全部插件并启动完整应用。

## 运行

```bash
# 构建前端 + 启动完整应用（http://localhost:8080）
npm run start

# 不重建前端，直接启动（若 dist 已存在）
npm run dev
```

## 装配的插件（按依赖顺序）

1. `config`（SQLite 元数据 → `data/config.db`）
2. `store`（DuckDB 时序 → `data/poll.duckdb`，2s 定期 flush）
3. `modbus`（jsmodbus 驱动）
4. `api`（Fastify REST+WS + 前端静态托管，监听 8080）
5. `poller`（循环轮询，1s 间隔）

## 启动逻辑

- 若 `data/config.db` 为空，播种演示设备「雪融机」（192.168.90.32:8899，5 个寄存器）。
- `poller.startAll()` 开始循环轮询（设备不可达时静默跳过，不阻塞启动）。
- `app.listen(8080)` 提供 REST + WS + 前端。

## 数据目录

- `data/`（gitignore）：运行时 SQLite + DuckDB 文件，删掉即重置。
