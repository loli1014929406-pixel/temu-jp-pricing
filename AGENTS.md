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
  - 实际运费和物流付款通过 `finance_actual_shipping_fees`、`finance_logistics_settlements`、`finance_logistics_payments` 及其导入、报表、付款 RPC 进入财务结果。头程月结继续沿用 `get_finance_order_analysis` 的现有月份估算合计，不增加订单级实际头程；用户只在 `finance_first_leg_monthly_settlements` 确认或修改当月实际合计，并通过 `finance_first_leg_payments` 记录部分付款、付款时间、作废和状态。确认实际头程后，利润报表的月度利润、头程合计和总运费只在对应月份合计层以实际头程替换该月预估头程，不向订单、商品、仓库或发货方式分摊；分组明细必须明确保留“估算口径”标识，不能与实际月份合计混称。利润报表按物流月结的 `shipping_month` 归属物流付款成本；真实付款日期 `paid_at` 只保留为付款与流水事实，不能用于利润报表的成本月份。
  - 商品成本依赖商品 SKU/BOM，物流估算依赖 `pricing_settings`、`logistics_methods`、`warehouse_logistics_methods`；订单号、包裹、物流单号、实际发货/签收时间会影响匹配、计费和月份归属。
  - 按件数阶梯尾程依赖四参数 `finance_dynamic_method_cost(..., p_quantity)`；拆包财务通过 `finance_split_method_cost` 传入包裹商品数量，继续保证尾程费用每个 `shipment_id` 只计算一次。
  - 利润报表的仓库/发货方式重量由 `get_finance_order_analysis.shipping_methods.weight_g` 返回，按 `product_data.package_weight_g × quantity` 汇总，并与页面当前日期、结算状态、问题和搜索筛选保持同一范围；前端只负责换算为 kg 展示。
  - 利润报表的仓库/发货方式运费同时返回估算头程、实际尾程和估算尾程；总运费仍是头程加最终尾程，现有成本与利润公式不变。尾程有实际值时只进入实际尾程，无实际值时才进入估算尾程。
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
  - 结算回款按 `po_number` 对原始 `order_no` 每单只归属一次；`source_order_id` 是原始商品明细身份，同一订单多明细时不能用它作为回款去重键，否则会把整单回款重复计入每条明细。拆包后仍按原订单号计一次，合并发货中的不同原订单则分别计入。
  - 发货方式重量不能用当前分页明细在前端小计，否则会随页码变化；必须在 `get_finance_order_analysis` 的完整筛选结果中聚合。SKU 未匹配或商品重量为 0 时会令重量偏低，排查时需同时检查 `sku_data`、`product_data` 和 `package_weight_g`。
  - “自动估算运费”不能继续作为头程和尾程的混合展示；报表拆分时必须保证 `总运费 = 估算头程 + 实际尾程 + 估算尾程`，并保持实际与估算尾程互斥。
  - 若拆包财务上线时生产库仍只有三参数 `finance_dynamic_method_cost`，兼容分支会忽略数量并令 `quantity_tier` 返回 0；不能补跑会覆盖拆包财务 RPC 的旧迁移，应新增迁移补齐四参数函数并重新绑定 `finance_split_method_cost`。
  - 财务页面的样式调整也可能改变金额列、合计行、正负号或异常提示的可读性，不能只做截图级检查。

### 实际运费映射模板导入（`src/components/finance/ActualShippingFeesPanel.tsx`、`src/lib/actual-shipping-fee-parser.ts`、`src/lib/actual-shipping-fee-templates.ts`）

- 影响范围：
  - 实际运费上传支持 CSV、XLS、XLSX，通过用户模板把网站字段“物流单号、实际尾程运费（人民币）、物流方式”映射到 1 开始的表格列号或固定值，并由用户指定工作表和数据开始行。
  - 日本邮政和 OCS 自动生成模板允许用户删除；删除时保留带 `system_key` 的软删除记录，模板列表排除 `deleted_at` 非空记录，确保默认模板初始化函数不会在刷新后重新生成。
  - 可用物流方式只来自已启用且至少关联一个仓库的 `logistics_methods` / `warehouse_logistics_methods`；模板保存稳定的 `logistics_method_id`，表格列值按网站物流方式名称归一化匹配。
  - `preview_actual_shipping_fee_import_v2` 与 `import_actual_shipping_fees_v2` 只按物流单号匹配 `temu_order_shipments`。唯一包裹且物流方式一致才可导入；未匹配、多包裹冲突、文件内重复、物流方式不一致或已有实际运费均跳过。
  - 导入只新增 `finance_actual_shipping_fees` 并由既有同步触发器写回包裹实际运费；不修改仓库、物流方式、订单状态、库存、拆包结构、实际发货时间或月份归属规则。
  - 实际运费报表和物流付款使用稳定的 `logistics_method_id`，仍按包裹实际发货时间归月，金额不换算且保留来源精度。
- 修改前需确认：
  - 不得新增订单号兜底匹配或覆盖已有运费；重复物流单号必须整组跳过，汇总/无效行继续跳过。
  - 新物流方式必须先在网站物流设置中启用并关联仓库，不能在上传流程中自动创建或改写订单物流方式。
  - 拆单后必须以 `shipment_id` 为唯一匹配粒度，同一物流单号对应多个包裹时保持跳过。
  - 修改后至少检查模板 RLS、默认模板幂等、CSV/XLS/XLSX 解析、包裹级 RPC、付款报表、数据同步覆盖、测试和构建。
- 常见陷阱：
  - 表格列号是 1 开始，代码数组索引是 0 开始；默认日本邮政 H/Y 列分别为 8/25，OCS C/BC 列分别为 3/55。
  - 表头文案不是映射依据；模板指定的工作表或开始行不存在时应阻止预览，不能静默猜测其他列。
  - 表格物流方式名称匹配成功不代表订单可导入，数据库仍需校验包裹保存的稳定 `logistics_method_id` 一致。
  - 自动生成模板不能直接物理删除，否则 `ensure_actual_shipping_fee_default_templates` 会在下次加载时重新创建；必须保留系统键并使用 `deleted_at` 隐藏。
  - 不要按订单明细重复写入或计费；实际运费和付款归属均保持包裹级。

### 订单表与物流单号映射模板导入（`src/components/orders/OrderFileImportModal.tsx`、`src/lib/order-file-import-parser.ts`、`src/lib/order-file-import-templates.ts`、`src/lib/order-tracking-import.ts`）

- 影响范围：
  - 上传订单表和上传物流单号各自使用独立的 CSV/XLS/XLSX 映射模板，可指定工作表、数据开始行、表格列或固定值；选择已有模板后可直接上传和预览，无需再次绑定。
  - 现有订单表表头兼容规则和现有物流单号表头兼容规则分别初始化为系统模板。系统模板删除时写入 `deleted_at` 软删除标记，自定义模板物理删除；默认模板初始化不得恢复已软删除的系统模板。
  - 订单表模板只改变文件解析与预览，仍沿用原有必填字段、SKU 规格匹配、去重、`importTemuOrders` 导入和后续订单加载规则。
  - 物流单号模板只处理当前“待发货”包裹：未拆包时按订单号精确匹配；已拆包时必须同时按订单号和子订单号精确匹配。确认导入后仍沿用 `saveOrderEntriesWithInventory`、物流状态初始化和现有库存、阶段规则。
  - 模板数据存储于 `temu_order_file_import_templates`，需同步检查 RLS、账号编辑权限、默认模板幂等、`scripts/sync-codex-data.mjs` 数据覆盖和前端类型归一化。
- 修改前需确认：
  - 确认目标只是文件解析、模板、预览或匹配键；不得顺带修改订单阶段、待分配规则、拆包结构、仓库物流归属、库存占用或追踪刷新逻辑。
  - 确认新增物流文件格式能提供拆包订单的子订单号；缺少子订单号的拆包记录必须跳过，不能回退到模糊匹配。
  - 确认同一“订单号 + 子订单号”只对应一个待发货包裹；若对应多个包裹，应在预览中标记冲突并整组跳过。
  - 修改后至少检查 CSV/XLS/XLSX 解析、默认模板生成与删除、精确匹配和冲突跳过测试，并运行订单页相关测试与构建。
- 常见陷阱：
  - 不得重新使用姓名、电话、邮编、地址、备注或文件行顺序为拆包包裹打分；这些字段存在相同值时会把物流单号写入错误包裹。
  - 未拆包记录即使文件中带子订单号，也只以订单号为匹配键；拆包记录不能只按订单号匹配。
  - 模板预览成功不代表允许覆盖已有物流单号；实际确认导入仍必须受现有“待发货”范围和保存规则约束。
  - 表格列号按 1 开始，代码数组索引按 0 开始；模板指定的工作表或开始行不存在时必须阻止预览，不能静默猜测。

### 待分配订单合并发货（`temu_order_combined_shipments`、`src/components/orders/MergeShipmentModal.tsx`、`src/pages/orders-page.tsx`）

- 影响范围：
  - 合并发货只在待分配阶段处理未拆包、未分配、未占用库存且收件人、电话、邮编和完整地址一致的不同原始订单；原订单号、子订单号和原包裹记录保持不变。
  - `temu_order_combined_shipments` 与 `temu_order_combined_shipment_members` 记录独立物理包裹、成员顺序和唯一主订单；订单分页和前端显示以 `combined_shipment_id` 优先作为履约分组键。
  - 合并包裹统一选择一个仓库和一个稳定物流方式 ID，`assign_temu_combined_shipment` / `release_temu_combined_shipment_inventory` 在同一数据库事务中覆盖全部成员商品和库存占用。
  - 物流单号导入允许同一已确认合并包裹的多个订单行使用相同单号，并折叠为一次写入；物流追踪、发货、签收和异常处理同步到全部成员。未合并的不同物理包裹仍禁止复用同一“物流方式 ID + 物流单号”。
  - 发货表第一类工作表每个合并包裹只输出一行并使用合并包裹号，商品申报合并全部成员商品；Temu 上传表仍保留每个子订单一行并共享物流单号。
  - 财务以“物流方式 ID + 物流单号”为实际运费身份，合并包裹只在持久化主订单计算一次头程、尾程和实际运费，其他成员显示 0 和主订单提示。
- 修改前需确认：
  - 确认目标订单仍全部处于待分配、未拆包且收件信息完全一致；拆包订单不得加入、再次合并或借合并流程改变拆包内容。
  - 确认主订单选择；主订单决定唯一运费归属，但不改变任何 Temu 原始订单和子订单身份。
  - 取消合并只允许全部成员仍处于待分配且没有库存、面单、物流单号、发货、签收或实际运费记录时执行。
  - 修改后检查合并/取消 RPC 原子性、库存一致性、订单分页、物流文件去重、追踪同步、双工作表发货导出、Temu 上传导出和财务一次计费。
- 常见陷阱：
  - 不得把多个原订单物理改写成同一 `order_no`，也不得把成员商品移动到主订单；合并关系只能存在于独立物理包裹层。
  - 不得按物流单号单独判重；同一号码在不同物流方式下是不同身份，同一方式下只能属于一个普通包裹或一个已确认合并包裹。
  - 合并包裹不能逐成员分配仓库、物流或库存；客户端逐条成功不能替代原子组合 RPC。
  - 自动匹配不得处理合并包裹，拆包 RPC 和取消拆包 RPC 也不得修改合并关系。

### Temu 上传表格模板下载（`src/components/orders/OrderFileImportModal.tsx`、`src/lib/temu-upload-export.ts`、`src/pages/orders-page.tsx`）

- 影响范围：
  - “下载上传表格”只处理订单页已勾选的已发货订单，使用独立的 `temu_upload` 模板类型保存工作表、数据开始行、网站字段到目标列的映射及固定值。
  - 下载模板沿用 `temu_order_file_import_templates` 的用户级 RLS、自动模板软删除和账号编辑权限，但不改变“上传订单表”与“上传物流单号”的解析、预览或确认导入流程。
  - 下载时只在浏览器内复制用户上传的 CSV/XLS/XLSX 表格内容，从数据开始行写入订单号、子订单号、商品件数、跟踪单号、物流承运商和发货仓库名称；不会保存订单、改变阶段、扣减库存或刷新物流。
- 修改前需确认：
  - 确认目标工作表、数据开始行、六个网站字段的目标列或固定值；必填字段必须全部解析到唯一列。
  - 修改后检查默认模板初始化、模板保存/删除、表头自动识别、固定值、重复目标列拒绝，并回归原有两种订单文件上传测试和构建。
- 常见陷阱：
  - 下载映射方向是“网站字段写入目标列”，与上传时“表格列读取为网站字段”相反；固定值仍必须绑定目标列。
  - 生成结果会保留数据开始行之前的模板内容，并以所选订单替换数据区；不得把样例数据残留为额外订单行。
  - 此流程不能调用 `saveOrderEntriesWithInventory`、`updateTemuOrder` 或阶段转换函数。

### 发货表格模板下载（`src/components/orders/OrderFileImportModal.tsx`、`src/lib/shipping-table-export.ts`、`src/pages/orders-page.tsx`）

- 影响范围：
  - “下载发货表格”只处理订单页已勾选的待发货订单，使用独立的 `shipping_export` 模板类型保存双工作表字段映射。
  - 包裹/收件信息继续按订单显示行写入第一类工作表，商品申报信息继续按商品声明分组写入第二类工作表；模板可以记录各字段所属工作表和目标列。
  - 下载只在浏览器内生成文件，不保存订单、不改变待发货阶段、不扣减或释放库存，也不修改物流方式和物流单号。
- 修改前需确认：
  - 确认模板包含分别承载包裹行与商品明细行的工作表；同一工作表不能混合两种行粒度。
  - 确认收件信息格式化、商品声明分组、申报单价、英文品名/材质、样式颜色和既有固定值保持原口径。
  - 修改后检查双工作表表头识别、字段到工作表/列的绑定、重复列与混合粒度拒绝，并回归订单上传、物流单号上传和 Temu 上传表格下载。
- 常见陷阱：
  - 第一张表是一包裹/订单一行，第二张表可能是一订单多商品声明行；不能用同一行数组写入两张表。
  - 用户切换样例工作表后绑定字段时，必须把工作表名称与列号一起保存，不能只保存列号。
  - 模板生成不能绕过 `validateOrdersReadyForFulfillment` 对仓库、物流、收件信息和英文申报资料的校验。

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
  - 页面仍能读取已缓存订单不代表 Edge Function 会话令牌仍有效。手动物流查询前需刷新会话并显式传入最新 Bearer JWT；`FunctionsHttpError` 还需读取响应体，不能只向用户显示 `Edge Function returned a non-2xx status code`。
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
- 2026-07-29：手动物流查询改为刷新并显式携带最新会话 JWT，同时显示 Edge Function 返回的具体中文错误。
- 2026-07-30：实际运费上传改为 CSV/XLS/XLSX 自定义映射模板，并将导入、报表和物流付款统一到包裹级稳定物流方式 ID。
- 2026-07-30：允许删除日本邮政和 OCS 自动生成运费模板，并用软删除标记阻止初始化函数重新生成。
- 2026-07-30：修复拆包财务兼容分支忽略 `quantity_tier` 包裹数量，恢复神户 Yamato3cm 自动估算。
- 2026-07-30：订单表和物流单号上传改为独立映射模板与导入预览；未拆包按订单号匹配，拆包按订单号和子订单号匹配。
- 2026-07-31：“下载上传Temu表格”改为“下载上传表格”，新增独立的 Temu 上传表格映射模板和浏览器内模板写入下载。
- 2026-07-31：“下载发货表格”新增双工作表映射模板下载，保持包裹行与商品申报行分离且不触发订单写入。
- 2026-08-01：待分配订单新增独立合并包裹层，统一履约、追踪、导出和按“物流方式 ID + 物流单号”一次计费，同时保持拆包逻辑不变。
- 2026-08-01：利润报表的仓库/发货方式分析新增 SKU 履约总重量，数据库按完整筛选范围聚合克数，前端统一换算为 kg 展示。
- 2026-08-01：利润报表将自动估算运费拆分为估算头程、实际尾程和估算尾程，保持总运费及利润核算口径不变。
- 2026-08-01：利润报表的实际物流付款成本改按物流月结 `shipping_month` 归月，付款日期继续保留为现金流水日期。
- 2026-08-01：物流商月结新增头程当月合计确认，仅允许修改月份实际合计，并复用尾程的部分付款、付款记录与作废流程，不增加订单级实际头程。
- 2026-08-01：利润报表的头程合计和总运费改为优先显示已确认月份实际头程；仓库/发货方式明细因无实际分摊数据继续标记为估算口径。
- 2026-08-02：修复多商品明细订单按 `source_order_id` 重复累计整单结算回款；结算收入改为每个原始订单号只归属一次，并保持拆包与合并发货口径。
