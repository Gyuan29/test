# 贡献指南

## 本地开发

```bash
npm install
npm run db:init
npm run dev
```

数据流水线必须按以下顺序运行：

```bash
npm run data:extract-organizations
npm run data:discover-sources
npm run db:import-sources
npm run ai:enrich
npm run ai:search-news
```

## 并发和超时

通过环境变量调整连接控制，默认值保持现有行为：

- `SEARXNG_CONCURRENCY=8`
- `HOMEPAGE_CONCURRENCY=4`
- `LLM_CONCURRENCY=3`
- `HTTP_TIMEOUT_MS=10000`

不要绕过 `http-control.ts`，也不要破坏任务的 `--resume`、checkpoint 和进度文件更新逻辑。

## 查看漏斗日志

检查 `data/search_progress.json`、`data/enrich_progress.json` 和 `data/event_search_progress.json`。终端日志使用 `[模块]` 前缀；事件搜索重点关注 `[漏斗]`，简介任务重点关注 `[enrich]`。

## 提交前检查

```bash
npx tsc --noEmit
npm run lint
npm test
```

不得提交 `.env.local`、API key、`.local/`、`data/` 运行数据、checkpoint 或构建产物。
