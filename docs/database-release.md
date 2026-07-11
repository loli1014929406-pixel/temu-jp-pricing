# 数据库迁移发布流程

数据库结构变更统一写入 `supabase/migrations/`，先提交代码，再通过 GitHub Actions 的 `Database migration release` 手动发布。工作流默认是 `dry-run`，只有明确选择 `apply` 才会修改生产数据库。

## GitHub production 环境密钥

- `SUPABASE_ACCESS_TOKEN`：Supabase Personal Access Token。
- `SUPABASE_DB_PASSWORD`：项目数据库密码。
- `SUPABASE_PROJECT_ID`：Dashboard URL 中的项目 reference ID。

建议为 GitHub 的 `production` Environment 设置人工审批，避免单人误操作。

## 首次启用

本项目以前的 SQL 通过 Dashboard 手动执行，Git 仓库与 Supabase 的迁移历史可能不同步。迁移文件已经转换为 Supabase CLI 要求的唯一 14 位时间戳。首次运行时必须先选择 `dry-run` 并查看 `supabase migration list`，不要直接选择 `apply` 重放旧迁移。

如果已经确认生产数据库包含截至订单分页和团队共享迁移的全部结构，可以在人工审批后运行一次 `baseline-history`，`baseline_through` 使用 `20260711000001`。该操作只登记迁移历史，不执行 SQL。若不能确认数据库结构完整，停止操作并逐条核对，不能用 baseline 掩盖缺失迁移。

## 日常发布

1. 新建迁移文件并运行 `npm run check:migrations`。
2. 推送代码，等待常规 CI 全部通过。
3. 手动运行 `Database migration release`，先选 `dry-run`。
4. 核对待执行文件后再次运行，选择 `apply`。
5. 发布后运行 RPC 健康检查和网站 E2E 回归。

参考：[Supabase 数据库迁移](https://supabase.com/docs/guides/deployment/database-migrations)与[多环境部署](https://supabase.com/docs/guides/deployment/managing-environments)。
