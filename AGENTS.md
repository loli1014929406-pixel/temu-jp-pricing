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

## 变更影响地图

以下内容基于当前代码依赖关系，说明“修改此处，已知会连带影响哪些地方”。涉及库存、订单、财务或数据库的改动，除前端调用点外，还必须检查对应 Supabase 迁移、RPC、视图、RLS、测试与本地数据同步脚本。

### 库存扣减与仓库优先级自动匹配（`src/pages/orders-page.tsx`、`src/domain/order-auto-match.ts`、`src/lib/orders.ts`、`src/lib/inventory.ts`）

- 影响范围：
  - `matchSingleSkuThreeCmShipment` 按 `warehouses.auto_match_priority` 从小到大匹配；只有 `auto_match_enabled=true` 且优先级为正整数的仓库参与。仓库身份只使用 `warehouse_id`，禁止别名、包含、相似或音译匹配。
  - 自动匹配只处理单 SKU 包裹；同一 SKU 多明细会聚合数量。商品在各仓库的 `product_warehouse_shipping_limits.max_units_per_parcel` 默认 1、允许 0；0 表示该商品不在该仓库自动匹配 3cm。
  - 自动匹配只选择仓库已绑定、启用、`leg_type=last_leg` 且 `parcel_type=three_cm_only` 的尾程，并按 `warehouse_logistics_methods.sort_order` 决定同仓库内优先顺序。数量超限时不回退普通尾程，整单保持待分配。
  - `order_auto_match_settings.enabled` 是全局总开关；上线或配置不完整时必须保持关闭。`auto_assign_temu_order_shipment` 在数据库内再次校验总开关、单 SKU、仓库参与状态、3cm 上限和精确尾程 ID，再调用原子库存分配 RPC。
  - `saveOrderEntriesWithInventory` 按 `shipment_id` 聚合保存，结合 `getOrderStage` 和 `shouldReserveOrderInventory` 判断占用、换仓回补或释放库存；`buildOrderStockDeductions` 将包裹商品映射到 `warehouse_skus`。
  - `src/lib/orders.ts` 的 `assignTemuOrderShipment`、`releaseTemuOrderShipmentInventory` 分别调用 `assign_temu_order_shipment`、`release_temu_order_shipment_inventory`。RPC 会联动 `temu_order_shipments`、`temu_order_shipment_items`、`temu_order_sku_inventory_reservations`、`warehouse_skus` 和 `warehouse_sku_stock_adjustments`。
  - 拆单、取消拆单、删除订单也会释放或重建库存占用，需同时检查 `save_temu_order_split`、`cancel_temu_order_split`、`delete_temu_order_group`。
  - 同一 `warehouse_skus` 余额也被库存页、库存调拨、采购入库和库存一致性检查使用，订单扣减规则改变会影响这些页面显示和后续可分配数量。
- 修改前需确认：
  - 确认参与仓库、唯一优先级、商品各仓 3cm 最大数、尾程全局分类和仓库尾程顺序；不得通过仓库名称推断仓库 ID 或物流能力。
  - 确认扣减粒度是包裹商品 `shipment_item_id`，每个包裹商品均完整分配且数量为正；同一包裹必须使用同一仓库和同一尾程方式。
  - 确认哪些阶段应占用库存。当前只有 `pending_assignment` 不占用，进入其他阶段即应保留占用；退回待分配时必须同步释放。
  - 确认库存余额、占用记录和调整流水在同一数据库事务中完成，并保留稳定顺序的行锁、库存不足校验、幂等检查和失败回滚。
  - 修改后至少运行相关 Vitest、`npm run check:inventory`、`npm run check:rpcs`、`npm run check:rpc-contracts` 和 `npm run build`。
- 常见陷阱：
  - 先在客户端查询库存或查询历史调整记录，再分步更新库存，会产生并发窗口。当前包裹分配 RPC 会锁定包裹及相关库存行；不要退回到“先查后扣”的非原子实现。
  - `availableStockByKey` 只是自动匹配时的前端批次内预占模拟，不能代替数据库最终校验。
  - 前端批次模拟成功不代表最终可占用；`auto_assign_temu_order_shipment` 必须保持服务端二次校验，并允许并发变化导致该包裹继续停留待分配。
  - PostgreSQL 不提供 `min(uuid)` / `max(uuid)` 聚合。RPC 聚合 UUID 字段时应使用已经过唯一性校验的数据配合 `array_agg(...)[1]`，并通过事务内真实调用后回滚验证函数可执行。
  - 多 SKU、数量超过全部仓库上限、无 3cm 尾程或所有参与仓库库存不足时都必须保持待分配，不能自动拆单或回退普通尾程。
  - 仅按 `order_no` 聚合会掩盖拆单后的包裹级库存归属；库存占用必须跟随 `shipment_id`/`shipment_item_id`。
  - `deductWarehouseItemStocksLegacy` 和旧的直接库存更新函数属于兼容路径，不应被重新用于当前订单履约主流程。

### 订单状态变更流程（`src/domain/order-workflow.ts`、`src/pages/orders-page.tsx`、`src/lib/orders.ts`）

- 影响范围：
  - `getOrderStage` 决定订单页标签、筛选、按钮可用性、物流刷新范围和库存占用边界。当前优先级依次为：实际签收时间、上传 Temu 状态、实际发货时间/物流单号、面单时间、仓库及物流方式完整性。
  - `buildPendingAssignmentResetUpdates`、`getOrderFulfillmentAssignmentIssue`、`getSplitOrderFulfillmentIssue` 控制退回待分配和包裹内履约一致性。
  - 单条、批量、自动匹配、导入物流单号、打印面单、上传 Temu、完成及退回操作最终会经过 `saveOrderEntriesWithInventory`，并可能触发库存占用或释放。
  - `updateTemuOrder` 会根据字段更新 `temu_order_shipments` 或履约视图背后的数据；服务端分页和阶段统计依赖 `temu_order_shipment_stage`、`get_temu_orders_page` 与 `temu_order_fulfillment_lines`。
  - `refresh-temu-tracking` 可写入物流状态、异常和签收时间；签收结果又会把订单推进完成阶段。财务页同时依赖实际发货时间、签收时间、物流方式和结算状态。
- 修改前需确认：
  - 确认目标阶段由哪些持久化字段推导，不能只确认界面显示文案或 `order_status` 字符串。
  - 确认状态变化是在订单、包裹还是包裹商品粒度发生，并检查拆单后的所有同包裹行是否保持一致。
  - 确认状态变化是否跨越库存占用边界，以及已有面单、物流单号、发货或签收记录时是否允许回退。
  - 确认 `uploaded_temu` 的特殊物流告警规则、自动签收完成规则和财务日期归属是否需要同步调整。
  - 修改后检查 `src/domain/order-workflow.test.ts`、`src/domain/order-tracking.test.ts`、订单页相关测试、RPC 合同和订单分页 RPC。
- 常见陷阱：
  - `order_status` 不是唯一状态源；例如有物流单号时会被判定为已发货，有实际签收时间时始终为已完成。
  - 只改前端 `getOrderStage` 会造成前端标签、SQL 分页计数和 Edge Function 判断不一致。
  - 只更新 `temu_orders` 原始行可能绕过包裹层；拆单后共享字段应写入 `temu_order_shipments`，读取以 `temu_order_fulfillment_lines` 为准。
  - 状态保存与库存保存若拆成互不回滚的客户端操作，容易出现“状态已前进但库存未占用”或相反的不一致。

### 财务结算与利润计算（`src/pages/finance/`、`src/lib/finance-queries.ts`、`src/lib/settlement.ts`、`src/pages/finance/shared.tsx`）

- 影响范围：
  - `/finance`、`/finance/ledger`、`/finance/expenses`、`/finance/settlement`、`/finance/profit` 共享订单、采购、费用、结算、实际运费和参数数据。
  - `get_finance_order_metrics`、`get_finance_orders_page`、`get_finance_order_analysis`、`get_finance_operating_overview`、`get_finance_ledger_page` 共同决定看板、对账、利润和流水口径。
  - 结算导入通过 `parseSettlementData`、`import_finance_settlement_atomic` 写入 `finance_settlement_files`、`finance_settlement_records`；退款/冲回体现在 `sales_reversal`、`freight_reversal`。
  - 实际运费和物流付款通过 `finance_actual_shipping_fees`、`finance_logistics_settlements`、`finance_logistics_payments` 及其导入、报表、付款 RPC 进入财务结果。
  - 商品成本依赖商品 SKU/BOM，物流估算依赖 `pricing_settings`、`logistics_methods`、`warehouse_logistics_methods`；订单号、包裹、物流单号、实际发货/签收时间会影响匹配、计费和月份归属。
- 修改前需确认：
  - 确认结算匹配键和规范化规则。当前核心路径以结算 `po_number` 对订单 `order_no`，并结合 SKU 信息处理明细。
  - 确认收入是否包含销售/运费冲回，实际运费是否优先于估算运费，月份是否继续按实际发货时间归属。
  - 确认拆单后商品数量和结算收入不能重复，尾程费用应按包裹计一次而不是按订单明细行重复计费。
  - 确认财务 SQL RPC 与前端 `shared.tsx`、利润页中的计算展示口径一致，并明确四舍五入、空值和负数规则。
  - 修改后用同一组订单对比结算页、利润页、经营看板和流水页总额，并运行财务相关测试、RPC 合同、迁移检查和构建。
- 常见陷阱：
  - 按订单明细行累加包裹尾程费会重复计算；拆单后应以 `shipment_id` 为费用归属。
  - 用可变的物流名称代替稳定 `logistics_method_id` 会在重命名后破坏分组和费用公式。
  - 忽略 `sales_reversal`/`freight_reversal` 会高估收入，忽略实际运费优先级会让利润与对账不一致。
  - SQL 聚合与前端再次聚合并存；只改一侧可能使看板摘要和明细页出现不同数字。
  - 财务页面的样式调整也可能改变金额列、合计行、正负号或异常提示的可读性，不能只做截图级检查。

### Supabase 表结构变更（`supabase/migrations/`、`src/types.ts`、`src/lib/`）

- 影响范围：
  - `supabase/migrations/` 是生产数据库结构的唯一事实来源；`supabase/schema.sql` 只是旧启动快照。表字段变化会连带影响前端类型、查询字段清单、行归一化、缓存键、导入导出和本地快照。
  - 视图或 RPC 返回结构变化会影响 `src/lib/` 调用者、页面 Hook、分页/统计结果以及 Edge Functions；订单和财务尤其依赖多个数据库视图和函数。
  - 新表或字段还会涉及 RLS、`GRANT`/`REVOKE`、外键、索引、触发器、审计流水、数据回填和团队共享范围。
  - `scripts/sync-codex-data.mjs`、`scripts/check-data-coverage.mjs`、`scripts/check-rpc-contracts.mjs`、事务 RPC 检查和 `local-data/codex-supabase-data.json` 需要覆盖新增运行时依赖。
- 修改前需确认：
  - 先检查最新迁移和目标环境实际已部署的迁移/函数签名；不要根据 `schema.sql` 或旧快照推断生产状态。
  - 确认变更是兼容新增还是破坏性修改，是否需要回填、双读/兼容字段、旧调用方过渡和回滚方案。
  - 确认 exposed schema 中的表已启用 RLS，策略、函数执行权限、视图调用者权限和账号角色符合现有团队边界。
  - 确认新增/修改索引覆盖高频分页、关联和外键；大表变更需评估锁表和执行时间。
  - 修改后运行 `npm run check:migrations`、`npm run check:rpc-contracts`、`npm run check:data-coverage`、相关事务检查、测试和构建；涉及数据读取时刷新本地快照。
- 常见陷阱：
  - PostgreSQL 函数 OUT 参数或返回表结构改变时，`CREATE OR REPLACE FUNCTION` 不能直接替换，通常需要按精确签名先删除再重建，并恢复授权。
  - 新增表但遗漏 RLS/Data API 授权会导致前端不可访问；使用 `SECURITY DEFINER` 绕过权限会扩大风险，当前业务函数优先保持 `SECURITY INVOKER`。
  - 只新增数据库字段、不更新显式 `.select(...)` 字段和 TypeScript 类型，会产生“数据库有值但前端永远读不到”的假象。
  - 新增运行表却未加入快照同步清单，会让离线排查和 `check:data-coverage` 失真。
  - 迁移文件已存在不代表生产已部署，生产已部署也不代表本地快照已刷新。

### 物流追踪 API 对接（`vite.config.ts`、`vercel.json`、`api/yamato-tracking.mjs`、`supabase/functions/refresh-temu-tracking/`）

- 影响范围：
  - 浏览器同源代理路径由 `vite.config.ts` 的开发代理和 `vercel.json` 的生产 rewrite 分别负责；大和运输在 Vercel 还经过 `api/yamato-tracking.mjs` 的登录用户校验。
  - 批量/定时刷新由 `src/lib/order-tracking.ts` 调用 Supabase `refresh-temu-tracking` Edge Function；该函数当前直接请求日本邮政，并通过带密钥的 Cloudflare Worker 请求大和运输。
  - HTML 解析和状态分类位于 `supabase/functions/_shared/order-tracking.ts`，`applyTrackingStageRules` 再叠加 `shipped`/`uploaded_temu` 业务阶段规则。
  - 结果通过追踪 RPC 写入包裹级物流状态、事件、异常指纹、已处理时间和签收时间，并影响订单页提醒、订单完成阶段和财务签收/结算提示。
  - Cloudflare Worker、Vercel Function、Edge Function、pg_cron、代理密钥校验 RPC 和相关环境变量属于同一链路的不同部署面。
- 修改前需确认：
  - 明确修改的是浏览器手动访问、Vercel 同源代理、Supabase Edge Function 定时刷新还是 Cloudflare 代理；一条链路验证成功不能替代其他链路验证。
  - 确认承运商识别规则仍以稳定物流配置为主，并检查福冈/日本邮政别名及默认回退到大和运输的行为。
  - 确认两家承运商的请求方法、参数、编码、HTML 结构、超时、重试和无轨迹文案；解析变化要补 `src/domain/order-tracking.test.ts`。
  - 确认 Vercel JWT 校验、Cloudflare 代理密钥、Supabase anon/service-role 密钥分别只存在于正确的服务端环境。
  - 确认事实分类与业务阶段规则仍分离；承运商的“暂无轨迹”不应在所有订单阶段被一律判为异常。
- 常见陷阱：
  - Vite `server.proxy` 仅在开发服务器生效，生产必须配置并实际验证 `vercel.json` rewrite/API 路径。
  - SPA 的兜底 rewrite 顺序错误会吞掉物流 API 请求；大和运输 POST 的请求体或鉴权头丢失也会让本地成功、生产失败。
  - Supabase Edge Function 不经过 Vite/Vercel 开发代理；修改 Vercel rewrite 不会自动修复定时刷新链路。
  - 日本邮政和大和运输返回的是 HTML，页面结构或日文状态文案变化会导致“HTTP 成功但解析结果错误”。
  - `uploaded_temu` 的 pending 状态需触发业务异常，而普通 `shipped` pending 不应误报；不要把该规则塞进承运商事实解析器。

## 已知问题与历史坑点

- 库存扣减存在过非原子性幂等检查导致的 race condition（重复扣减），修改库存相关逻辑时需特别注意并发安全。当前订单包裹主路径已使用带行锁和事务回滚的数据库 RPC，但历史/兼容扣减函数仍需谨慎，不能把原子流程重新拆回客户端。
- Vite 的 dev-only proxy 不会带到 Vercel 生产环境，物流追踪接口（日本邮政/大和）需要通过 `vercel.json` 的 rewrite 配置处理，本地能跑通不代表生产环境能跑通。同时，Supabase Edge Function/Cloudflare 的定时追踪链路需要独立验证。
- finance 相关页面（费用、结算、经营看板）历史上曾因涉及财务计算展示，被单独排除在某次样式重构范围外；这不是永久禁改规则，但修改前建议额外确认改动不会影响计算展示的准确性。

## 文档维护规则

以下情况发生时，必须同步更新本文档对应新增章节：

- 新增/删除页面或核心模块。
- 改变了模块间的数据依赖关系。
- 发现新的实现陷阱或临时解决方案。
- 开始接入新的电商平台。

更新时请在本节末尾追加“更新记录”：日期 + 简述改动。

### 更新记录

- 2026-07-28：新增变更影响地图、已知问题与历史坑点、文档维护规则。
- 2026-07-28：自动匹配改为仓库唯一优先级、单 SKU 3cm 专用尾程和数据库二次校验；仓库身份统一使用精确 UUID。
- 2026-07-29：修复自动匹配 RPC 使用 `min(uuid)` 导致生产调用失败，并补充事务内真实调用回滚验证要求。
