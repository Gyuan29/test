# 全量翻译执行手册

本项目保留英文原文，同时将 AI 生成的中文结果写入独立字段，便于审计、重试和切换模型。

## 前置条件

1. 启动 Ollama 服务。
2. 下载模型（默认是 `qwen2.5:3b`）：

   ```bash
   ollama pull qwen2.5:3b
   ```

3. 确认 `.env.local` 中的 `LLM_BASE_URL`、`LLM_API_KEY` 和 `LLM_MODEL_NAME` 与实际服务一致。
4. 确认 `LOCAL_SQLITE_PATH` 指向要处理的数据库。

## 机构简介

执行：

```bash
npm run ai:translate -- --resume
```

脚本会跳过已完成的机构，只处理剩余的非中文简介，并把翻译结果写回机构简介字段（带 `[译]` 前缀）。原始数据库备份应在批处理前完成。

## 事件内容

执行：

```bash
npm run ai:translate-events -- --resume
```

脚本会遍历翻译字段为空的事件，调用 LLM 翻译标题和描述，并写入 `translated_title` 与 `translated_description`；`title`、`summary` 等原始字段不会被覆盖。首次运行可加 `--limit 10` 做小批量验证。

## 容错与恢复

- 两个脚本都支持 `--resume`，会读取 `data/` 下的进度文件并跳过已完成记录。
- 失败记录追加到 `data/translation_errors.log`，不会阻断其他记录。
- 中断进程后可以直接重新执行相同命令；已完成记录不会重复请求模型。
- 更换模型或修复失败记录后，可删除对应进度项，再使用 `--resume` 重试；不要删除原文列。

## 建议流程

先用 `--limit 10` 验证模型输出和数据库连接，再运行机构翻译，最后运行事件翻译。批处理期间观察 Ollama 显存、请求耗时和错误日志，完成后在事件档案、机构目录和详情页抽样检查中文质量。
