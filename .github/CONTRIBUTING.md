# 贡献指南

感谢参与 Institution Intelligence。项目是“安全基座 + AI 引擎”的机构情报系统，贡献应同时考虑数据质量、访问安全和可恢复性。

## 分支策略

| 分支 | 用途 |
| --- | --- |
| `main` | 生产稳定版本，禁止直接 push |
| `develop` | 日常集成分支 |
| `feature/<name>` | 新功能 |
| `fix/<name>` | 缺陷修复 |
| `docs/<name>` | 文档和流程 |
| `hotfix/<name>` | 从 `main` 创建的紧急修复 |

功能分支从最新 `develop` 创建，完成验证后提交 Pull Request 合并到 `develop`。发布时由维护者创建 `develop` 到 `main` 的 Pull Request。

```bash
git fetch origin
git switch develop
git pull --ff-only origin develop
git switch -c feature/short-description
```

## 本地开发与初始账号

复制 `.env.example` 为 `.env.local`，设置 `AUTH_EMAIL` 和 `AUTH_PASSWORD`。启动本地服务后，使用该账号访问 `/login` 并成功登录一次，系统会自动在数据库中创建或更新用户记录。`.env.local` 包含凭据，不得提交。

## Conventional Commits

提交格式：

```text
<type>(<optional-scope>): <imperative summary>
```

常用类型：`feat`、`fix`、`refactor`、`perf`、`test`、`docs`、`security`、`chore`。

规则：

- 使用小写、现在时态和简洁动词开头，不加句号。
- 一个提交只表达一个可审查意图。
- 破坏性变更使用 `!`，并在正文说明迁移和回滚方式。
- 禁止提交 `.env.local`、API key、`.local/`、运行数据、原始 DOCX、checkpoint 和备份文件。

## 数据库迁移

数据库 schema 位于 `db/schema.ts`，迁移位于 `drizzle/`。当前融合版包含 `0002`（机构搜索状态）、`0003`（事件搜索状态）和 `0004`（事件相关性评分）迁移。

```bash
npm run db:generate
npm run db:init
```

修改 schema 时必须同时生成迁移。新增字段优先使用 nullable/default，保留外键、唯一约束和索引语义；PR 中必须说明数据回填、升级和回滚方案。不直接修改已发布迁移文件。

## 测试与质量门槛

提交前运行：

```bash
npx tsc --noEmit
npm run lint
npm test
```

涉及搜索、抓取或 API 的变更必须覆盖对应行为。安全与质量测试重点包括用户/管理员鉴权、会话隔离、速率限制、请求体大小限制、SSE 错误处理、URL/DNS 公网地址校验、私网阻断、SearXNG 健康检查、Brave/Bing fallback、来源质量验证、事件去重、checkpoint 原子写入和断点恢复。

新增 LLM 逻辑时，应测试无效 JSON、低相关性评分、重复标题和模型不可用场景。

## Pull Request 合并指南

PR 描述至少包含变更目标、受影响的页面/API/脚本/表/迁移、安全和数据隐私影响、测试命令及结果，以及配置、部署和回滚注意事项。

提交前确认没有冲突标记或调试代码，没有密钥和运行产物进入 diff；API 只返回允许公开的字段；数据库写入使用参数化查询或 ORM；失败任务仍可恢复且进度状态准确。

至少一名维护者审查通过后再合并，推荐使用 squash merge。涉及 schema、鉴权或抓取策略的变更应由相应领域维护者复核。
