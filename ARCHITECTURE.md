# 系统架构说明

> 生成基线：2026-07-28，`main` 分支，提交 `2656c1f`。  
> 阅读范围：`src/`、`supabase/`、`api/`、`cloudflare/`、`scripts/`、`e2e/`、部署与 CI 配置。  
> 数据库事实来源：按文件名排序的 `supabase/migrations/`。`supabase/schema.sql` 是旧的初始化快照，不能代表全部当前结构。

## 1. 项目概览

一句话说明：**Temu 日本站半托管业务运营核算系统**。

系统覆盖商品与 SKU、核价与利润、Temu 订单履约、采购入库、仓储库存、物流跟踪、实际运费、平台结算、经营费用和权限控制。当前前端是浏览器端单页应用，业务数据通过 Supabase Data API 与 RPC 读写；复杂的库存、采购、拆单、结算和财务查询下沉到 PostgreSQL 函数。

### 1.1 总体分层

1. **展示层**：React 页面与组件负责路由、表单、表格、导入导出和交互状态。
2. **前端应用层**：`src/hooks/` 组合页面状态；`src/domain/` 表达订单阶段等领域规则。
3. **前端数据与计算层**：`src/lib/` 封装 Supabase、缓存、文件处理和业务读写；`src/utils/` 保存纯计算公式。
4. **数据库业务层**：Supabase Postgres 表、RLS、视图、触发器和 RPC 保证权限、事务与聚合查询。
5. **外部集成层**：Supabase Edge Function、Vercel Function 和仓库中的 Cloudflare Worker 负责日本邮政/Yamato 物流查询代理。

### 1.2 技术栈及用途

| 技术 | 当前用途 |
| --- | --- |
| React 19 | 页面、表单、业务组件和状态驱动 UI |
| TypeScript 5.8 | 前端、Worker、Vercel Function 周边代码的静态类型约束 |
| Vite 6 | 本地开发、生产构建、按页面拆包、开发期物流代理 |
| React Router 7 | 登录页、业务页、详情页和财务子路由 |
| Tailwind CSS 3 + `src/index.css` | 页面布局、设计令牌、共享业务表格样式 |
| Supabase JS 2.49.4 | Auth、Data API、RPC、Edge Function 调用 |
| Supabase Postgres | 业务数据、RLS、事务函数、聚合分析、Cron/Vault 相关能力 |
| Vitest 4 | 领域规则、解析器、计算、缓存和数据访问辅助逻辑的单元测试 |
| Playwright | 登录态关键流程、响应式布局和可访问性回归 |
| `read-excel-file` / `write-excel-file` | 商品、订单、结算、运费和费用文件的导入导出 |
| Web Worker | 在后台线程解析表格文件，失败时回退主线程 |
| Vercel | SPA 静态部署、路由回退和 Yamato Serverless 代理 |
| GitHub Actions | 单元测试、E2E、lint、构建、数据库静态检查和手动迁移发布 |

## 2. 目录结构说明

### 2.1 `src/` 分类逻辑

```text
src/
├─ App.tsx                 路由、懒加载、认证/权限外壳
├─ main.tsx                React 入口与全局诊断安装
├─ types.ts                跨模块共享的数据库/业务类型
├─ pages/                  以路由和业务场景划分的页面
│  ├─ finance/             财务总览、流水、费用、利润、结算及查询 Hooks
│  ├─ orders/              订单表格行和订单页纯辅助逻辑
│  ├─ purchases/           采购草稿、收货和展示辅助逻辑
│  └─ inventory/           库存页错误与展示辅助逻辑
├─ components/             可复用 UI 与跨页面业务组件
│  ├─ orders/              订单筛选、详情、批量操作、拆单和补发
│  ├─ inventory/           异步商品选择
│  ├─ finance/             实际运费导入与物流付款面板
│  └─ ui/                  标准表格、详情弹窗、确认框和通知中心
├─ hooks/                  认证、权限、订单页面状态、草稿与自动消失提示
├─ domain/                 不依赖 React 的领域规则
├─ lib/                    Supabase 访问、业务读写、缓存、表格和共享服务
├─ utils/                  核价、利润、物流、SKU 等纯计算/格式化逻辑
└─ workers/                Excel/CSV 解析 Worker
```

分类原则如下：

- `pages/` 决定“用户在哪个业务场景完成任务”，允许组合多个领域和数据源。
- `components/` 决定“哪些 UI 或局部业务交互可以复用”，不应成为数据库访问的主要入口。
- `hooks/` 负责页面级异步状态和生命周期，不承载核心财务或库存公式。
- `domain/` 放稳定的业务概念，例如 `getOrderStage`、`shouldReserveOrderInventory`。
- `lib/` 是外部 IO 边界，包含表/RPC 调用、缓存和导入导出。
- `utils/` 尽量保持纯函数，便于 Vitest 对公式做回归。

### 2.2 仓库内其他关键目录

| 目录 | 职责 |
| --- | --- |
| `supabase/migrations/` | 数据库变更的唯一事实来源，含表、RLS、视图、触发器、RPC 和 Cron |
| `supabase/functions/` | `refresh-temu-tracking` Edge Function 及承运商 HTML 解析 |
| `supabase/manual/` | 手工运行的诊断或一次性维护 SQL，不进入自动迁移链 |
| `api/` | Vercel Serverless Functions，目前是 Yamato 代理 |
| `cloudflare/` | Cloudflare Worker 的静态站点与物流代理实现，属于另一套部署路径 |
| `scripts/` | 快照同步、迁移/RPC 检查、库存校验/修复和后端上下文同步 |
| `e2e/` | Playwright 关键流程、响应式和可访问性测试 |
| `local-data/` | 本地 Supabase 快照与派生上下文，已被 Git 忽略 |
| `.github/workflows/` | CI 与生产数据库迁移发布 |

## 3. 核心业务模块梳理

### 3.1 商品资料、配件与 SKU 管理

**解决的问题**

- 维护商品中日英资料、包装尺寸/重量、组合说明、销售状态和备注。
- 维护配件/BOM：配件规格、单件用量、采购价、采购运费、采购链接。
- 维护 SKU 编号、销售属性、Temu 图片及 SKU 与配件的组成关系。
- 维护不同仓库下单包裹最大可发件数。
- 支持商品文件导入、导出、复制和批量状态维护。

**页面、组件与关键函数**

- 页面：`/products`、`/products/new`、`/products/:productId/edit`。
- 组件：`ProductForm`、`AsyncProductSelect`、`StandardTable`。
- 数据函数：`fetchProductsPaginated`、`fetchProductItems`、`fetchProductSkus`、`createProduct`、`updateProduct`、`deleteProduct`、`importProductsData`、`exportProductsData`。
- 数据库事务：更新已有商品结构使用 `update_product_structure_atomic`；新增商品仍由前端串联多表写入并在失败时尽力回滚。
- 文件转换：`product-transfer.ts`、`excel.ts`、`tabular-parser.ts`。

**数据来源与去向**

- `products`：商品主数据。
- `product_items`：商品配件/BOM 项。
- `product_skus`：SKU、销售属性和 `temu_image_url`。
- `product_sku_items`：SKU 与配件的多对多关系及用量。
- `product_warehouse_shipping_limits`：商品在各仓库的单包件数上限。
- `account_profiles`：商品列表中展示创建账号信息。

**与其他模块的依赖**

- 核价读取包装、重量、配件成本和用量。
- 采购引用商品、配件和 SKU。
- 库存以商品/SKU 为主键，并用 BOM 推导配件数量。
- 订单与财务通过 `sku_code`/销售规格匹配 SKU；当前没有订单行到 `product_skus.id` 的正式外键。

**平台耦合**

- 商品、配件、SKU 和 BOM 本身可复用。
- `title_jp`、`temu_image_url`、Temu 申报相关字段把平台/站点属性放进了通用商品表。
- 新平台接入时，建议保留通用商品核心，新增“平台刊登/平台 SKU 映射”层，而不是继续向 `products`、`product_skus` 增加平台专属列。

### 3.2 核价、申报价、物流成本与利润测算

**解决的问题**

- 汇总采购成本、采购运费、包装费、头程、尾程、汇率和平台补贴。
- 根据目标利润率计算 Temu 申报价。
- 维护流量加速让价、活动折扣、优惠券、ROAS，计算广告后利润。
- 支持直发/正常发货、多件组合、3cm/小包限制和促销建议。

**页面、组件与关键函数**

- 页面：`/declaration-prices`、`/products/:productId/pricing`、`/profit-calculation`、`/products/:productId/profit-calculation`。
- 多件测算：`/profit-calculation/direct-shipping/*`、`/profit-calculation/standard-shipping/*`。
- 其他入口：`/profit-calculation/recommendations`、`/test-shipping`。
- 核心函数：
  - `calculatePricing`：成本、补贴、默认头尾程和申报价。
  - `calculateDynamicMethodCost`：按固定价、重量、票、日元、关税或件数阶梯计算物流成本。
  - `calculateProfitProjection`：折后收入、广告费、补贴资格、各物流方案利润。
  - `calculateMultiShipmentProfitRows`、`calculateTestShipping`：多件与直发专项测算。
  - `getDefaultPricingLogisticsSelection`：要求恰好一个启用的默认头程和尾程。

**数据来源与去向**

- 读取：`products`、`product_items`、`product_skus`、`product_sku_items`。
- 参数：`pricing_settings` 的汇率、补贴、目标利润和 JSONB 物流公式。
- 物流主数据：`logistics_methods`、`warehouse_logistics_methods`、`product_warehouse_shipping_limits`。
- 保存：`pricing_results` 保存核价快照，`profit_calculations` 保存每个 SKU 的折扣/ROAS 输入与版本化 `result_json`。

**与其他模块的依赖**

- 依赖商品 BOM 与参数设置。
- 仓库和物流绑定决定订单可选发货方式以及财务的头尾程估算。
- 财务分析复用部分成本语义，但主要聚合逻辑已下沉到 SQL RPC；修改公式时必须同时检查 TypeScript 与 SQL。

**平台耦合**

- 当前实现高度耦合 Temu 日本站：字段名含 Temu，使用 JPY/RMB 汇率、Temu 运费补贴、3500 日元补贴阈值、OCS/Japan Post/Yamato 和日本仓线路。
- 可复用部分是“成本项 + 物流公式 + 目标利润 + 活动/广告输入”的计算框架。
- 新平台需要独立的定价策略/补贴策略适配器；不应在 `calculatePricing` 中继续加入平台条件分支。

### 3.3 订单导入、履约、物流状态与发货数据

**解决的问题**

- 从 Temu 表格导入订单行并去重。
- 按待分配、新订单、待发货、已发货、上传 Temu、已完成组织履约。
- 分配仓库和尾程方式、占用库存、打印/导出发货表、回填面单和运单。
- 支持同一订单拆为多个包裹、取消拆单、补发订单和删除时释放库存。
- 查询 Japan Post/Yamato 轨迹、标记异常、自动完成已签收订单。

**页面、组件与关键函数**

- 页面：`/orders`，主体为 `orders-page.tsx`。
- 组件：`OrderFilters`、`OrderBulkActions`、`OrderDetailPanel`、`OrderTableRow`、`SplitOrderModal`、`ReshipOrderModal`、`OrderTrackingAlerts`。
- 页面状态：`useOrders`；订单阶段规则：`order-workflow.ts`；客户历史着色：`order-customer-history.ts`。
- 数据函数：
  - `fetchTemuOrdersPage` → `get_temu_orders_page`。
  - `importTemuOrders`：按订单/子单或订单+SKU+销售规格去重后写入。
  - `assignTemuOrderShipment`、`releaseTemuOrderShipmentInventory`。
  - `saveTemuOrderSplit`、`cancelTemuOrderSplit`。
  - `updateTemuOrder`、`deleteTemuOrder`、`createReshipmentOrder`。
  - `refreshTemuTrackingForOrderIds`、`fetchTemuTrackingAlerts`。
- 物流服务：`supabase/functions/refresh-temu-tracking` 调用承运商，并通过 `save_temu_tracking_result` 持久化。

**数据来源与去向**

- `temu_orders`：Temu 原始订单行、收件信息、时限和兼容汇总字段。
- `temu_order_shipments`：包裹级仓库、物流、轨迹、发货、签收和实际运费。
- `temu_order_shipment_items`：原始订单行在包裹中的数量分配。
- `temu_order_fulfillment_lines`：把订单行、包裹和数量投影为前端统一读取模型。
- `temu_order_split_events`：拆单/替换/取消前后快照。
- `temu_order_sku_inventory_reservations`：包裹明细到 `warehouse_skus` 的活动占用与释放历史。
- `warehouse_sku_stock_adjustments`：订单占用、释放和删除回补的库存审计。

**与其他模块的依赖**

- 依赖商品 SKU 映射、仓库、物流主数据和仓库可用库存。
- 订单的实际发货时间、运单和包裹数进入实际运费与财务分析。
- `finance_settlement_records.po_number` 通过文本订单号与订单匹配。
- 客户退款/重复下单信号由订单、收件信息和结算冲回记录共同计算。

**平台耦合**

- 导入列、`TemuOrderRecord`、`temu_*` 表/RPC、上传 Temu 状态、Temu 发货导出和结算语义均高度平台特有。
- “订单行—包裹—包裹明细—库存占用”的履约模型可复用，但当前表名和外键直接指向 Temu。
- 新平台需要重新设计订单标准模型和平台适配器；包裹与库存占用层可迁移为平台无关的 `fulfillment_*`/`inventory_reservations`。

### 3.4 采购、包裹入库、SKU 库存、配件库存与库存调整

**解决的问题**

- 创建采购单，记录多采购来源、平台单号、采购价与运费。
- 将采购明细分配到快递包裹并分批签收。
- 签收时增加仓库 SKU 库存，更新采购单/包裹状态并写调整记录。
- 支持手工校准、仓间调拨、调拨签收和订单库存占用/释放。
- 通过 SKU 的 BOM 关系展示配件推导库存。

**页面、组件与关键函数**

- 采购：`/purchases/new`、`/purchases/records`，页面 `PurchasesPage`。
- 库存：`/inventory`、`/inventory/:warehouseSlug`、`/inventory/transfer`。
- 采购函数：`createPurchaseOrder`、`createPurchasePackage`、`receivePurchasePackage`、`receiveRemainingPurchaseOrder`、`deletePurchaseOrder`。
- 采购事务：`create_purchase_order_atomic`、`receive_purchase_package_atomic`。
- 库存函数：`fetchWarehouseInventoryPage`、`updateWarehouseSkuStock`、`transferWarehouseInventory`、`receiveWarehouseTransferInventory`。
- 调拨事务：`transfer_warehouse_sku_inventory_atomic`、`receive_warehouse_sku_transfer_atomic`。
- 订单库存事务：`assign_temu_order_shipment`、`release_temu_order_shipment_inventory`；旧接口仍保留 `reserve_order_sku_inventory`、`release_order_sku_inventory`。

**数据来源与去向**

- `purchase_orders` → `purchase_order_sources`、`purchase_order_items`。
- `purchase_packages` → `purchase_package_items`。
- `warehouse_skus`：当前主库存账，唯一键为仓库+SKU。
- `warehouse_sku_stock_adjustments`：采购入库、调拨、校准、订单占用/释放审计。
- `warehouse_item_stocks`、`warehouse_item_stock_adjustments`：旧配件库存与修复兼容路径。
- 当前库存 UI 以 `warehouse_skus` 为准，配件展示值为“SKU 库存 × BOM 用量”。

`warehouse_item_stocks` 是否仍被其他外部流程作为权威库存使用，代码中无法完全证明；**此处逻辑需人工确认**。

**与其他模块的依赖**

- 采购明细必须映射商品/SKU，才能可靠签收入库。
- 订单从待分配进入已分配阶段时即扣减 `warehouse_skus` 并创建活动占用；退回待分配或删除时恢复。
- 财务读取采购总额和库存对应的商品成本。

**平台耦合**

- 采购、仓库、SKU 库存、调拨和调整账总体平台无关，可直接复用。
- 当前订单库存占用表与 RPC 直接命名并外键到 `temu_orders`，这部分需要抽象后才能服务多平台。
- 配件库存的“由 SKU 推导”是内部库存策略，与销售平台无关。

### 3.5 财务费用、结算、利润与经营看板

**解决的问题**

- 维护广告费、关税、包装、平台佣金、退款损失和其他经营费用。
- 导入 Temu `SettledParentFlow` 结算文件并按 PO/SKU 去重。
- 导入承运商实际运费，记录物流月度应付、付款和作废。
- 汇总订单收入、采购成本、头尾程、实际运费、结算状态、利润和资金流水。
- 识别未匹配 SKU、缺运费、超期未结算、仓库物流配置不完整等问题。

**页面、组件与关键函数**

- `/finance`：经营/现金总览。
- `/finance/ledger`：订单回款、采购付款、物流付款、其他费用流水。
- `/finance/expenses`：费用增删改和广告费文件导入。
- `/finance/profit`：月度、商品和物流方式利润。
- `/finance/settlement`：结算文件、对账、收入与实际运费。
- `ActualShippingFeesPanel`：实际运费与物流付款。
- 核心 RPC：`get_finance_operating_overview`、`get_finance_ledger_page`、`get_finance_order_analysis`、`get_finance_orders_page`。
- 结算：`parseSettlementData`、`addSettlementFile`、`import_finance_settlement_atomic`。
- 运费：`preview_actual_shipping_fee_import`、`import_actual_shipping_fees`、`get_actual_shipping_fee_report`、`record_logistics_payment`。

**数据来源与去向**

- `finance_expenses`：用户自己的经营费用。
- `finance_settlement_files` → `finance_settlement_records`：Temu 结算文件与明细。
- `finance_actual_shipping_fees`：按运单号保存承运商实际运费。
- `finance_logistics_settlements` → `finance_logistics_payments`：承运商月份应付快照与付款流水。
- 财务 RPC 同时读取履约视图、商品/BOM、仓库物流参数、采购和结算数据。

**与其他模块的依赖**

- 订单号决定结算匹配；当前 SQL 主要按 `finance_settlement_records.po_number = order_no` 聚合。
- SKU 文本匹配决定商品成本；包裹决定尾程成本只计一次。
- 实际运费优先于估算运费，按运单号/包裹归属。
- 采购和费用进入现金流水或经营利润口径。

**平台耦合**

- 费用表、资金流水框架、物流付款和利润指标框架可复用。
- Temu 结算文件字段、PO 匹配、冲回规则、平台运费收入和 `temu_order_*` 财务 RPC 高度耦合。
- 新平台需要独立结算解析器和收入标准化层；看板应消费平台无关的财务事实，而不是直接联结各平台订单表。

### 3.6 参数设置、账号与权限

**解决的问题**

- Supabase 邮箱密码登录、忘记密码和重置密码。
- 为用户生成/维护用户名与五位用户代码。
- 维护汇率、Temu 补贴、包装费、目标利润、头尾程物流公式和默认物流方案。
- 以 `admin`、`editor`、`viewer` 控制编辑与删除能力。
- 采集脱敏错误、慢请求和 Web Vitals，供管理员诊断。

**页面、组件与关键函数**

- `/login`、`/forgot-password`、`/reset-password`。
- `/user`：账号资料与个人诊断。
- `/parameter-settings`：核价和物流参数。
- `/admin/diagnostics`：管理员诊断页。
- `ProtectedRoute`、`PermissionProvider`、`PermissionGate`、`PageShell`。
- `useAuth`、`fetchCurrentAccountPermission`、`fetchOrCreateCurrentAccountProfile`。
- `fetchSettings`、`saveSettings`、`syncLogisticsMethodsFromSettings`。

**数据来源与去向**

- `auth.users`：Supabase 登录身份。
- `account_permissions`：以登录邮箱映射角色；缺失或异常时前端按 `viewer` 失败关闭。
- `account_profiles`：用户名与用户代码。
- `pricing_settings`：按 `owner_id` 保存个人核价参数。
- `logistics_methods`、`warehouse_logistics_methods`：团队共享物流主数据和仓库绑定。
- `app_diagnostics`：脱敏诊断，用户读自己的记录，管理员可读全体。

**与其他模块的依赖**

- 所有业务页都依赖有效 Supabase Session。
- 商品、订单、采购、仓库、物流和库存属于同一运营团队并共享可见；创建者 `owner_id` 保留且不可转移。
- 费用、结算、账号资料和个人参数按用户隔离。

**平台耦合**

- Supabase Auth、角色能力、账号资料和诊断机制可复用。
- `pricing_settings` 内的 Temu 补贴和日本物流参数不可直接复用。
- 当前没有公司/租户边界。若未来多平台仍属于同一团队，权限框架可继续使用；若引入其他团队或公司，必须增加 tenant/company 维度并重审全部 RLS。

## 4. 平台耦合度标注

### 4.1 模块级结论

| 模块 | 当前耦合度 | 可直接复用 | 新平台必须调整/重设计 |
| --- | --- | --- | --- |
| 商品、配件、SKU | 中 | 商品核心、BOM、内部 SKU、包装资料 | 平台标题、图片、平台 SKU/刊登映射 |
| 核价/申报价/利润 | 高 | 成本项、物流公式引擎、目标利润框架 | 补贴、币种、阈值、申报价和活动/广告规则 |
| 订单导入与状态 | 很高 | 文件解析基础设施、分页/筛选组件 | 订单字段、导入器、状态映射、平台回传 |
| 履约/包裹 | 中高 | 包裹、包裹明细、分配、拆单概念 | 从 `temu_*` 中抽离并关联通用订单行 |
| 物流跟踪 | 高 | 跟踪分类、异常提醒框架 | 承运商识别、代理、平台阶段规则 |
| 采购/仓储/调拨 | 低 | 采购单、包裹入库、SKU 库存、调整账 | 订单占用引用需从 Temu 改为通用来源 |
| 费用/现金流水 | 低到中 | 费用、收入/支出流水、物流付款 | 平台佣金/退款科目映射 |
| 结算/利润看板 | 高 | 聚合指标和对账框架 | 文件解析、结算匹配、收入/冲回规则、SQL 联结 |
| 账号/权限/诊断 | 低 | Auth、角色、资料、诊断 | 多团队场景的租户边界与 RLS |

### 4.2 多平台扩展的建议边界

以下是演进建议，不是当前已实现结构：

1. **平台注册层**：引入平台/站点/店铺账号实体，例如 `sales_channels`、`platform_accounts`，业务记录统一带 `platform` 与 `platform_account_id`。
2. **标准订单层**：平台适配器把原始文件/API 映射为通用 `orders`、`order_lines`；保留外部订单号、外部 SKU、原始 payload 和导入批次。
3. **平台映射层**：用 `platform_listings`、`platform_sku_mappings` 连接内部 `products/product_skus`，避免把更多平台列加入商品主表。
4. **通用履约层**：把现有 shipment、shipment item、inventory reservation 模型抽离 Temu 命名，并通过通用订单行 ID 关联。
5. **策略接口**：将定价、补贴、状态、履约回传、结算解析分别实现为平台策略；页面只调用标准接口。
6. **财务事实层**：各平台结算先标准化为收入、折扣、退款、运费收入、佣金等事实，再由统一看板聚合。

如果只增加一套与 Temu 并列的表和页面，会复制订单、库存和财务联结逻辑，后续第三个平台的成本会继续上升。

## 5. 数据库结构概览

### 5.1 事实来源与访问模型

- `supabase/migrations/` 当前有 86 个有序迁移，是生产结构的唯一事实来源。
- `supabase/schema.sql` 仅用于旧环境初始化参考，未包含全部近期 RPC、索引、拆单和跟踪结构。
- RLS 以 Supabase Session 和 `account_permissions` 为基础。
- 团队运营数据共享；用户财务、结算、资料和个人参数按用户隔离。
- 新写入的团队运营记录保留创建者 `owner_id`，触发器禁止后续转移。

### 5.2 主要表与关联

| 领域 | 表/视图 | 用途与关键关联 |
| --- | --- | --- |
| 身份与运维 | `auth.users`、`account_permissions`、`account_profiles`、`app_diagnostics` | `account_permissions.email` 决定角色；资料和诊断通过 `owner_id/user_id` 关联登录用户 |
| 商品 | `products`、`product_items`、`product_skus`、`product_sku_items` | 商品一对多配件和 SKU；`product_sku_items(sku_id,item_id,quantity)` 表达 BOM |
| 核价 | `pricing_settings`、`pricing_results`、`profit_calculations`、`product_warehouse_shipping_limits` | 参数按用户；核价/利润记录关联 `product_id`、`sku_id`；仓库限制关联商品和仓库 |
| 仓库与物流 | `warehouses`、`logistics_methods`、`warehouse_logistics_methods` | 仓库与物流方式多对多；每仓可标记默认方式 |
| 库存 | `warehouse_skus`、`warehouse_sku_stock_adjustments` | 仓库+SKU 唯一库存；每次变化记录前后数量、原因和采购来源 |
| 旧配件库存 | `warehouse_item_stocks`、`warehouse_item_stock_adjustments` | 保留旧配件库存/修复轨迹；当前主 UI 使用 SKU 库存推导配件 |
| 采购 | `purchase_orders`、`purchase_order_sources`、`purchase_order_items`、`purchase_packages`、`purchase_package_items` | 采购单关联仓库；来源和明细属于采购单；包裹属于来源；包裹明细指向采购明细 |
| Temu 原始订单 | `temu_orders` | 订单/子单/SKU/收件信息/时限；`warehouse_id`、`logistics_method_id` 等旧汇总列用于兼容 |
| 履约 | `temu_order_shipments`、`temu_order_shipment_items`、`temu_order_fulfillment_lines` | 包裹存物流状态；包裹明细连接 `shipment_id` 与 `temu_orders.id`；视图提供前端统一行 |
| 订单库存 | `temu_order_sku_inventory_reservations` | 关联原始订单、包裹明细与 `warehouse_skus`，用 `released_at` 表示活动/已释放 |
| 拆单审计 | `temu_order_split_events` | 保存订单拆分/替换/取消的前后 JSON 快照 |
| 费用与平台结算 | `finance_expenses`、`finance_settlement_files`、`finance_settlement_records` | 费用按用户；结算文件一对多明细；`po_number`/`sku_code` 用于订单匹配与去重 |
| 实际运费与物流付款 | `finance_actual_shipping_fees`、`finance_logistics_settlements`、`finance_logistics_payments` | 实际运费按用户+运单唯一；月度应付快照一对多付款 |

### 5.3 重要的非外键关联

这些关联依赖文本规范化，是扩展和数据质量的主要风险：

- 订单行通过 `sku_code` 或 `product_attributes` 匹配内部 SKU，没有 `product_sku_id` 外键。
- 结算通过 `po_number` 匹配 `order_no`，没有订单外键。
- 实际运费通过 `logistics_tracking_no` 匹配包裹，没有包裹外键。
- `logistics_method` 文本与 `logistics_method_id` 同时存在，以兼容旧数据；同步依赖名称规范化。

### 5.4 需要人工确认的旧结构

- `purchase_records` 出现在早期迁移，但当前前端采购流程使用 `purchase_orders` 及其来源/明细/包裹子表。是否可以归档或删除，**此处逻辑需人工确认**。
- `pricing_results` 当前主要由核价页写入，而多个总览页面会根据最新商品与参数即时重算。该表是否作为正式历史快照长期使用，**此处逻辑需人工确认**。

## 6. 关键业务流程的数据流向

### 6.1 一笔订单从创建到结算

1. **导入**：`orders-page.tsx` 用表格解析器把 Temu 文件映射为 `TemuOrderImportRow`；`importTemuOrders` 按订单/子单或订单+SKU+销售规格去重后写入 `temu_orders`。
2. **建立履约**：数据库触发器为新订单创建默认 `temu_order_shipments` 与 `temu_order_shipment_items`；页面通过 `temu_order_fulfillment_lines` 和 `get_temu_orders_page` 读取。
3. **待分配**：缺仓库或缺尾程方式时，`getOrderStage` 判为 `pending_assignment`。
4. **可选拆单**：`save_temu_order_split` 验证所有原始数量被正数、完整且只分配一次，并创建至少两个包裹；取消拆单恢复一个待分配包裹。
5. **分配与占用库存**：`assign_temu_order_shipment` 校验仓库、启用的尾程方式和每条包裹明细的 SKU 库存，原子扣减 `warehouse_skus`，写 reservation 和 adjustment。
6. **新订单**：仓库与发货方式完整后进入 `new_order`；库存保持占用。
7. **待发货**：生成/下载发货表并写 `label_printed_at`，阶段进入 `pending_shipping`。
8. **已发货**：写运单号或 `actual_ship_time` 后进入 `shipped`。
9. **上传 Temu**：下载 Temu 上传表并人工标记 `order_status = 上传Temu`，进入 `uploaded_temu`。
10. **物流跟踪**：前端手动或 pg_cron 调用 `refresh-temu-tracking`；Edge Function 查询承运商、分类轨迹、保存异常。已上传 Temu 的包裹若承运商返回已签收，会写签收时间并完成订单。
11. **实际运费**：承运商账单经 `preview_actual_shipping_fee_import` 预览，再按运单写 `finance_actual_shipping_fees` 并同步包裹实际运费/发货时间。
12. **平台结算**：Temu 结算文件解析后，由 `import_finance_settlement_atomic` 写入结算文件与明细；重复键为用户范围内的 `(po_number, sku_code)`。
13. **财务聚合**：财务 RPC 按订单号联结结算，按 SKU/销售规格估算产品成本，按包裹计头尾程与实际运费，输出已结算/未结算、利润、问题项和资金流水。

注意：页面展示的一行已经是“履约包裹明细”，并不等同于 `temu_orders` 的一条原始记录。

### 6.2 库存从入库到扣减

1. **采购建单**：`create_purchase_order_atomic` 一次写入采购单、来源和采购明细；采购明细应绑定 SKU。
2. **采购组包**：`create_purchase_package` 把采购明细数量分配到一个或多个包裹。
3. **包裹签收**：`receive_purchase_package_atomic` 锁定包裹和库存，增加目标仓库 `warehouse_skus.stock_quantity`，写 `warehouse_sku_stock_adjustments`，更新包裹及采购单状态。
4. **库存展示**：库存页读取 `warehouse_skus`；配件数量通过 `product_sku_items.quantity × SKU 库存` 推导。
5. **仓间调拨**：调出 RPC 原子扣减源仓并写出库调整；调拨签收 RPC 增加目标仓并写入库调整。调拨元数据编码在 adjustment reason 中用于配对展示。
6. **手工校准**：以旧数量为条件进行乐观更新，然后写库存调整记录。
7. **订单占用**：包裹完成仓库/物流分配时，`assign_temu_order_shipment` 立即扣减可用 SKU 库存，并创建活动 reservation；这里的“占用”已经反映在 `stock_quantity` 的减少中。
8. **释放/回补**：退回待分配、取消有效占用或删除未完成订单时，RPC 恢复库存、标记 reservation 已释放并写正向 adjustment。
9. **审计与修复**：`scripts/check-inventory-consistency.mjs`、`recalculate-inventory-from-source.mjs` 和修复脚本用于对账；修复操作不是常规页面流程。

## 7. 部署与环境

### 7.1 Vercel 部署配置要点

- 生产构建命令为 `npm run build`，产物目录为 `dist/`。
- `vite.config.ts` 按 React、Supabase、Router、图标、Excel和主要页面拆包；应用版本从 `VITE_APP_VERSION`、Git/Vercel 提交 SHA 等注入。
- `vercel.json` 的重写顺序：
  1. `/yamato-tracking/:path*` → `/api/yamato-tracking`。
  2. `/japanpost-tracking/:path*` → Japan Post 上游。
  3. 其他路径 → `/index.html`，支持 React Router SPA 刷新。
- `api/yamato-tracking.mjs` 仅接受 POST，先用 Bearer Token 调 Supabase Auth 校验用户，再校验运单号并代理 Yamato；响应禁用缓存。
- 仓库没有在 `vercel.json` 中显式声明 `buildCommand`、`outputDirectory` 或 Node 版本，这些值依赖 Vercel 项目设置和 `package.json` 自动识别。

本次需求说明当前部署在 Vercel；但仓库 README 同时写明 Cloudflare Custom Domain 是当前入口、Vercel 是备用入口，且 Edge Function 的 Yamato 查询固定调用 Cloudflare 域名。**部署主入口和两套代理的实际生产职责此处需人工确认**。

### 7.2 环境变量清单

| 变量 | 使用位置与用途 |
| --- | --- |
| `VITE_SUPABASE_URL` | 浏览器 Supabase Project URL；构建时写入前端 |
| `VITE_SUPABASE_ANON_KEY` | 浏览器 anon/publishable key；受 RLS 约束 |
| `SUPABASE_URL` | Vercel/Cloudflare 服务端代理连接 Supabase |
| `SUPABASE_ANON_KEY` | Vercel/Cloudflare 服务端代理校验用户或代理密钥 |
| `VITE_APP_VERSION` | 可选，诊断记录中的应用版本 |
| `SUPABASE_SERVICE_ROLE_KEY` | 本地快照全库导出及 Supabase Edge Function；严禁进入浏览器/Vercel 前端变量 |
| `SUPABASE_SYNC_EMAIL` | 无 service role 时，本地快照登录邮箱 |
| `SUPABASE_SYNC_PASSWORD` | 无 service role 时，本地快照登录密码 |
| `VITE_AUTO_LOGIN_EMAIL` / `VITE_AUTO_LOGIN_PASSWORD` | 部分本地 RPC/校验脚本的兼容登录变量 |
| `E2E_BASE_URL` | Playwright 测试目标地址 |
| `E2E_USER_EMAIL` / `E2E_USER_PASSWORD` | CI 的登录态 E2E 账号 |
| `SUPABASE_ACCESS_TOKEN` | GitHub Actions 连接 Supabase CLI |
| `SUPABASE_DB_PASSWORD` | GitHub Actions 数据库迁移发布 |
| `SUPABASE_PROJECT_ID` | GitHub Actions 目标 Supabase project ref |
| `TEMU_BACKEND_PROJECT_DIR` | `sync:backend-context` 的目标后端目录覆盖值 |
| `TEMU_PRICING_APP_URL` | 同步给相邻后端的应用地址 |
| Vault secret `temu_tracking_cron_secret` | pg_cron 调 Edge Function和 Cloudflare 跟踪代理鉴权 |

`.env.example` 和 README 记录了 `VITE_ENABLE_SIGNUP`，但当前 `AuthPage` 只有登录，没有读取该变量或开放注册。是否恢复注册开关，**此处逻辑需人工确认**。

### 7.3 本地数据快照机制

`npm run sync:data` 执行 `scripts/sync-codex-data.mjs`：

1. 读取 `.env`，优先使用 `SUPABASE_SERVICE_ROLE_KEY`；否则用同步账号登录。
2. 按脚本中的表清单分页读取，每页 1000 条。
3. 表不存在或当前身份无权读取时记录到 `skipped_tables`，其他错误终止同步。
4. 写入 `local-data/codex-supabase-data.json`，顶层包含：
   - `exported_at`
   - `auth_mode`
   - `user`
   - `tables`
   - `skipped_tables`
   - `summary`
5. `local-data/` 被 `.gitignore` 排除，不能提交。

`npm run sync:backend-context` 会先刷新快照，再打包计算规则、旧 schema 和全部迁移，并复制到相邻后端项目。

生成本文档时，本地快照已于 2026-07-28 刷新且没有 `skipped_tables`；但同步清单尚未包含拆单表和物流月结/付款表，详见技术债务。

### 7.4 数据库发布

- CI 会检查迁移命名、安全约束、前端 RPC 名称和数据作用域。
- `.github/workflows/database-deploy.yml` 通过手动 `workflow_dispatch` 发布。
- 默认 `dry-run`；`apply` 才修改生产数据库；旧环境首次接入可在人工确认后使用 `baseline-history`。
- `supabase/manual/` 不会被自动发布。

## 8. 当前已知的技术债务/待优化点

| 优先级 | 问题 | 影响与建议 |
| --- | --- | --- |
| 高 | 缺少平台抽象 | `TemuOrderRecord`、`temu_*` 表/RPC、状态、文件列和财务 SQL 贯穿全栈。接入新平台前先建立平台账号、标准订单、平台 SKU 映射、通用履约和财务事实层。 |
| 高 | 快照覆盖与最新履约结构不一致 | `npm run check:data-coverage` 当前失败，报 `temu_order_fulfillment_lines` 未覆盖；同步脚本也未列入 `temu_order_shipments`、`temu_order_shipment_items`、`temu_order_split_events`、`finance_logistics_settlements`、`finance_logistics_payments`。应让覆盖检查识别表/视图/RPC 数据源，并更新导出清单。 |
| 高 | 部署路径并存且职责冲突 | 用户说明 Vercel 是当前部署，README 说明 Cloudflare 是当前入口；Edge Function 还硬编码 Cloudflare 域名，Cron SQL 硬编码 Supabase Function URL。应确认生产拓扑后用环境配置替代固定域名。 |
| 高 | 文本关联缺少数据完整性 | 订单-SKU、订单-结算、包裹-实际运费依赖 `sku_code`、`product_attributes`、`po_number`、`tracking_no` 文本匹配。建议导入时建立稳定映射 ID，并保留未匹配队列。 |
| 中高 | 页面和数据模块过大 | `orders-page.tsx` 约 3200 行，`purchases-page.tsx` 约 2200 行，`inventory-page.tsx` 约 1800 行；多个 lib 也超过 1000 行。建议按用例拆分 controller hooks、commands、queries 和表格 section，避免继续向单文件追加平台分支。 |
| 中高 | 数据库基线和兼容分支负担 | `schema.sql` 已是旧快照，前端大量保留缺列/缺 RPC 的兼容路径。应明确最低生产 migration 版本，逐步删除不再可能触发的 fallback，减少双路径行为。 |
| 中高 | 财务/成本存在 TypeScript 与 SQL 双实现 | 核价和利润在前端计算，经营财务由大型 SQL RPC 聚合，财务页面还保留部分 legacy 计算路径。变更公式时容易漂移；应建立同一组合同测试/金样数据校验两端口径。 |
| 中 | 手工库存校准不是单一事务 | `updateWarehouseSkuStock` 先更新库存再写 adjustment；若第二步失败，会出现库存已变但审计缺失。调拨/采购也保留非事务兼容 fallback。建议所有库存写入只暴露事务 RPC。 |
| 中 | 日期字段类型不统一 | Temu 的发货、签收和时限字段多为 `text`，SQL 需 `try_parse_temu_order_time`，前端也有多种解析回退。建议标准化为 `timestamptz`，原始字符串另存。 |
| 中 | 物流参数双重建模 | `pricing_settings` 用 JSONB 存公式，同时有 `logistics_methods` 与仓库绑定表；同步兼容名称和 ID。多平台前应拆分物流主数据、费率版本、适用平台/仓库和生效期。 |
| 中 | 当前权限模型只有一个运营团队 | 团队运营表全员共享，角色按邮箱映射，没有 tenant/company。若未来新增其他组织，现有 RLS 不能直接复用。 |
| 中 | 草稿和部分动态物流参数依赖浏览器存储 | 草稿与缓存主要在 localStorage/sessionStorage，跨设备不可用；`use-draft-persistence.ts` 已有迁移到 Supabase 的 TODO。 |
| 低 | 环境文档存在未使用变量 | `VITE_ENABLE_SIGNUP` 已写入文档和示例，但代码未读取；应删除或实现。 |
| 低 | 当前 lint 有一条未使用类型警告 | `orders-page.tsx` 的 `WarehouseSku` 未使用，不影响构建，但应清理。 |

### 8.1 生成时验证基线

- `npm run test`：通过，23 个测试文件、101 个测试。
- `npm run build`：通过。
- `npm run lint`：0 error，1 warning。
- `npm run check:rpc-contracts`：通过，检查 36 个前端 RPC 名称。
- `npm run check:migrations`：通过，检查 86 个迁移文件。
- `npm run check:data-coverage`：失败，缺少 `temu_order_fulfillment_lines` 快照覆盖。
- 本次未执行需要真实登录环境的 Playwright E2E。

本文档由 codex 于 2026-07-28 基于代码库生成，如后续新增/删除模块、数据流向改变、或开始接入新平台，应重新审视并更新本文档。
