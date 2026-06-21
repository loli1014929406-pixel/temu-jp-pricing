## User Confirmation Rule

- 严禁推测用户行为来执行任务。
- 用户没有明确要求的任务，严禁执行。
- 不明白或存在多种理解的地方，必须先向用户确认。
- 除 Codex 外，其他编程工具、自动化工具、AI 模型或编辑代理如果要修改本项目内容，必须先向用户确认并获得明确同意。

## Project Scope

本项目是 Temu 日本站半托管业务运营核算系统，主要覆盖：

- 商品资料、配件和 SKU 管理。
- 商品核价、申报价、物流成本和利润测算。
- Temu 订单导入、履约、物流状态和发货数据维护。
- 采购记录、包裹入库、SKU 库存、配件库存和库存调整。
- 财务费用、结算、利润和经营看板。
- 参数设置、账号资料和权限控制。

## Tech Stack

- Frontend: React, TypeScript, Vite.
- Styling: Tailwind CSS.
- Backend and auth: Supabase.
- Tests: Vitest.
- Spreadsheet import/export: `read-excel-file`, `write-excel-file`.

## Data Lookup Rule

When answering questions about product information, purchase records, inventory, pricing, orders, settlements, finance, or profit data for this project:

- Prefer the local Supabase snapshot at `local-data/codex-supabase-data.json`.
- The snapshot stores rows under the top-level `tables` object.
- If the user asks for the latest data, or if the snapshot is missing or clearly stale for the question, run `npm run sync:data` first, then read the refreshed snapshot.
- Do not query Supabase directly unless the local snapshot is unavailable, sync fails, or the user explicitly asks for a live database check.
- `local-data/` is local-only project data and must remain ignored by git.

## Development Rules

- Before changing behavior, inspect the relevant page, library function, type definition, and Supabase migration or schema.
- Keep calculation changes traceable. Pricing, logistics, profit, inventory, purchase, order, and finance logic must be changed with care because they affect operational data.
- Do not change Supabase policies, migrations, permissions, inventory deduction logic, or financial calculation formulas unless the user explicitly asks for that change.
- Do not commit secrets. `.env`, service role keys, exported snapshots, and `local-data/` must stay local.
- Prefer existing utilities and page patterns over adding unrelated abstractions.
- For code changes, run the most relevant checks when practical:
  - `npm run test`
  - `npm run build`

## Common Commands

```bash
npm install
npm run dev
npm run build
npm run test
npm run sync:data
npm run sync:backend-context
```
