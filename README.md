# Temu JP 运营核算系统

Temu JP 运营核算系统用于 Temu 日本站半托管业务的商品资料、核价定价、利润分析、订单履约、采购入库、仓储库存和财务核算。

项目使用 React + Vite + TypeScript 开发，Supabase 负责登录、数据存储和权限控制，Tailwind CSS 负责界面样式。

## 核心功能

- 商品管理：维护商品基础资料、包装尺寸、包裹容量、配件库、SKU、Temu 图片和销售状态。
- 核算定价：根据采购成本、包装成本、头程、尾程、补贴、目标利润率等参数计算申报价。
- 利润分析：维护核价、流量加速、活动折扣、优惠券、ROAS，并查看广告后利润。
- 多件测算：按商品和 SKU 测算多件直发、正常发货时的盈利、亏损点和推荐投放区间。
- 直发测算：按 OCS 3cm、OCS 小包等规则查看直发物流成本和利润表现。
- 订单管理：导入和维护 Temu 订单，处理仓库、物流方式、面单、履约数量、物流状态和实际运费。
- 采购管理：维护采购记录、采购来源、包裹物流、入库状态和采购成本。
- 仓储库存：查看和维护 SKU 库存，配件数量由 SKU 库存和 SKU 组成关系推导。
- 财务管理：维护经营费用、结算数据、利润看板和资金流水。
- 参数设置：维护汇率、补贴、物流、包装、目标利润、仓库物流方式和账号资料。

## 技术栈

- React 19
- TypeScript
- Vite
- React Router
- Supabase
- Tailwind CSS
- Vitest

## 本地启动

1. 复制 `.env.example` 为 `.env`。
2. 填入必要环境变量：

```bash
VITE_SUPABASE_URL=
VITE_SUPABASE_ANON_KEY=
```

3. 按需填入可选环境变量：

```bash
VITE_ENABLE_SIGNUP=true
SUPABASE_SERVICE_ROLE_KEY=
SUPABASE_SYNC_EMAIL=
SUPABASE_SYNC_PASSWORD=
```

`VITE_ENABLE_SIGNUP=true` 仅在确实需要前台开放注册时配置。`SUPABASE_SERVICE_ROLE_KEY` 只用于本地导出完整数据库快照，不能配置到前端托管平台。

4. 在 Supabase SQL Editor 执行 `supabase/schema.sql`，并按需要执行 `supabase/migrations/` 下的迁移。
5. 安装依赖并启动：

```bash
npm install
npm run dev
```

默认本地地址为 `http://127.0.0.1:5173/`。

## 常用命令

```bash
npm run dev
npm run build
npm run preview
npm run test
npm run sync:data
npm run sync:backend-context
npm run recalculate:inventory
```

## 页面路由

- `/login`：登录
- `/user`：账号资料
- `/products`：商品管理
- `/products/new`：新增商品
- `/products/:productId/edit`：编辑商品
- `/products/:productId/pricing`：核算定价结果
- `/products/:productId/profit-calculation`：单商品 SKU 利润数据分析
- `/declaration-prices`：核算定价总览
- `/profit-calculation`：利润数据分析总览
- `/profit-calculation/recommendations`：促销投放推荐
- `/profit-calculation/direct-shipping`：多件直发商品选择
- `/profit-calculation/direct-shipping/:productKey`：单商品多件直发测算
- `/profit-calculation/standard-shipping`：多件正常发货商品选择
- `/profit-calculation/standard-shipping/:productKey`：单商品多件正常发货测算
- `/test-shipping`：直发测算
- `/orders`：订单管理
- `/purchases/new`：新增采购
- `/purchases/records`：采购记录
- `/inventory`：仓储库存
- `/inventory/transfer`：库存调拨
- `/inventory/:warehouseSlug`：指定仓库库存
- `/finance`：财务总览
- `/finance/ledger`：资金流水
- `/finance/expenses`：费用管理
- `/finance/profit`：财务利润
- `/finance/settlement`：结算管理
- `/parameter-settings`：参数设置

## 数据与权限

前端只使用 `anon key`。商品、订单、采购、库存、财务和参数数据由 Supabase 保存，RLS 通过 `account_permissions` 控制操作权限。

- `admin`：所有权限，可以新增、编辑、删除。
- `editor`：可以新增和编辑，不能删除。
- `viewer`：只读查看。

账号权限在 Supabase 后台维护。应用只读取权限并由 RLS 强制限制；登录用户不能通过应用接口新增、修改或删除 `account_permissions`。

执行 `supabase/schema.sql` 后，在 Supabase 的 Table Editor 打开 `account_permissions` 表，按登录邮箱新增或修改记录。也可以在 SQL Editor 执行：

```sql
insert into public.account_permissions (email, permission_level)
values ('user@example.com', 'admin')
on conflict (email)
do update set permission_level = excluded.permission_level;
```

`account_permissions` 为空时，当前登录账号会按 `admin` 处理，方便初始化第一位管理员；只要表里已有任意权限记录，未配置账号会按 `viewer` 处理。

## 本地数据快照

项目的本地分析数据默认读取：

```text
local-data/codex-supabase-data.json
```

该文件在顶层 `tables` 对象下保存 Supabase 表数据。查询商品、采购、库存、订单、核价、利润或财务数据时，应优先读取本地快照。

刷新快照：

```bash
npm run sync:data
```

如果 `.env` 配置了 `SUPABASE_SERVICE_ROLE_KEY`，导出会绕过 RLS 读取全库；否则按 `SUPABASE_SYNC_EMAIL` 与 `SUPABASE_SYNC_PASSWORD` 登录账号可见范围导出。

`local-data/` 是本地数据目录，不能提交到 git。

## 后端分析数据同步

给相邻的 `temu_japan_semi_managed_backend` 同步数据库快照和计算规则：

```bash
npm run sync:backend-context
```

该命令会先刷新 `local-data/codex-supabase-data.json`，再生成：

- `local-data/calculation-rules.json`
- `local-data/backend-context.json`

随后复制到：

```text
../temu_japan_semi_managed_backend/data/
```

## 部署

Cloudflare Pages:

- Build command: `npm run build`
- Output directory: `dist`
- 环境变量：
  - `VITE_SUPABASE_URL`
  - `VITE_SUPABASE_ANON_KEY`

Vercel 也可以按同样的构建命令和输出目录部署。

## 目录说明

- `src/pages/`：页面级功能。
- `src/components/`：通用组件和业务组件。
- `src/lib/`：Supabase 数据访问、业务数据读写和共享逻辑。
- `src/utils/`：核价、利润、物流、SKU、表格解析等计算工具。
- `src/hooks/`：认证、权限、草稿和交互状态。
- `src/workers/`：Excel 解析 Worker。
- `supabase/schema.sql`：数据库初始化结构。
- `supabase/migrations/`：数据库迁移。
- `scripts/`：数据同步、库存修复和后端上下文生成脚本。
- `local-data/`：本地快照和导出数据，不提交 git。

## 开发注意事项

- 修改核价、利润、物流、库存、订单、采购或财务逻辑前，需要先确认对应的数据结构和计算公式。
- 修改 Supabase RLS、权限、迁移或库存扣减 RPC 前，需要明确变更目的和影响范围。
- 不要提交 `.env`、服务端密钥、导出的数据库快照或其他敏感数据。
- 文档、配置或代码修改后，按变更范围运行 `npm run test` 或 `npm run build`。
