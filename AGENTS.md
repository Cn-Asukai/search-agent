# Agent 规则

本仓库的协作产出默认使用中文。代码标识符、API、路径、命令和配置键保持英文。

## 语言

以下场景必须使用中文：

- 计划、方案、设计说明
- Git 提交说明（subject 与 body）。可用 `feat:` / `fix:` / `docs:` / `ci:` 等 conventional 前缀，说明部分用中文
- Pull Request 的标题、正文、评论、回复
- Issue 的标题、正文、评论
- 对用户的说明、进度和总结

例外：

- 源码注释跟随当前文件已有语言，不要整文件翻译
- 用户明确要求英文时，该次产出改用英文

## 开 PR 后必须跟 GitHub Actions

创建或更新 Pull Request 之后，**不能开完就结束**。必须确认是否触发了 GitHub Actions，等到终态，再按结果自动迭代。

本仓库当前工作流：

| 工作流 | 文件 | 何时触发 |
|---|---|---|
| OpenCodeReview PR Review | `.github/workflows/ocr-review.yml` | `pull_request_target`：opened / synchronize / reopened |
| Publish Docker images | `.github/workflows/publish-docker.yml` | 仅 tag push；推送 GHCR 与 CNB 镜像。**PR 不会触发，不要空等** |
| Sync to CNB | `.github/workflows/sync-cnb.yml` | 任意 `push`（含 tag）；同步到 CNB `longlian.online/search-agent` |

### 流程

```
创建/更新 PR
  → 用 gh 查该 PR / 该 head SHA 是否出现 GitHub Actions run
  → 短轮询 30–60 秒：仍没有 run → 视为未触发，用中文向用户说明后继续
  → 有 run：等到终态（success / failure / cancelled / timed_out）
  → 成功：再拉评审评论（OCR 常在 check 成功后仍贴评论）
  → 失败或有可执行评审意见：读日志/评论 → 改代码 → 中文 commit → push
  → 新 push 会再触发 OCR（synchronize），重新等待
  → 最多 3 轮自动修复；仍红或无法自动处理则停，用中文汇报原因和已做修改
```

### 命令

只跟当前 PR 的 head SHA / head 分支，不要跟到 `main` 或旧 run。

```bash
gh pr view --json number,url,headRefOid,statusCheckRollup
gh pr checks <number>
gh run list --branch <head> --limit 10
gh run watch <run_id>
# 或
gh pr checks <number> --watch
gh run view <run_id> --log-failed
```

### 约束

- OCR 作业超时上限是 60 分钟；等待时不要静默放弃，也不要无限挂起
- 不自动 merge
- 不使用 `git push --force`；需要变基时用 `--force-with-lease`
- 修 CI / 评审前先本地跑相关检查（`npm test`、`npm run typecheck`），再推
- 评审批注里「建议 / 可选」可以解释后不改；明确的 bug、正确性、安全问题必须改
- 每一轮修复的 commit 和 PR 评论也用中文
