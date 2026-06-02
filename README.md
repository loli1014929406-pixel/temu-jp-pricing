# Temu JP 运营核算系统

用于 Temu 日本站半托管业务的商品资料、核价、利润分析、直发测算、订单履约、采购入库和库存管理。

项目使用 React + Vite + TypeScript 开发，Supabase 负责登录、数据存储和权限控制，Tailwind CSS 负责界面样式。

## 核心功能

- 商品管理：维护商品基础资料、包装尺寸、3cm 每包件数、配件库和 SKU。
- 核算定价：根据采购成本、包装成本、顺丰、头程、尾程和补贴计算申报价。
- 利润数据分析：维护核价、流量加速、活动折扣、优惠券、ROAS，并查看广告后利润。
- 多件利润测算：按商品和 SKU 测算多件直发、正常发货时的盈利或亏损停止点。
- 直发测算：按 OCS 3cm、OCS 小包等规则查看直发物流成本和利润表现。
- 订单管理：导入和维护 Temu 订单，处理物流方式、发货表格和履约状态。
- 采购管理：维护采购记录、包裹入库和采购成本。
- 仓储库存：查看 SKU 库存、配件库存和库存调整记录。
- 参数设置：维护汇率、补贴、物流、包装、目标利润等计算参数。

## 本地启动

1. 复制 `.env.example` 为 `.env`。
2. 填入：
   - `VITE_SUPABASE_URL`
   - `VITE_SUPABASE_ANON_KEY`
   - 可选：`VITE_ENABLE_SIGNUP=true`，仅在确实需要前台开放注册时配置。
   - 可选：`SUPABASE_SERVICE_ROLE_KEY`，只用于本地导出完整数据库快照，不能配置到前端托管平台。
3. 在 Supabase SQL Editor 执行 `supabase/schema.sql`。
4. 安装依赖并启动：

```bash
npm install
npm run dev
```

默认本地地址为 `http://127.0.0.1:5173/`。

## Cloudflare Pages

- Build command: `npm run build`
- Output directory: `dist`
- 环境变量：
  - `VITE_SUPABASE_URL`
  - `VITE_SUPABASE_ANON_KEY`

## 页面

- `/login` 登录
- `/orders` 订单管理
- `/products` 商品管理
- `/products/new` 新增商品
- `/products/:productCode/edit` 编辑商品
- `/products/:productCode/pricing` 核算定价结果
- `/products/:productCode/profit-calculation` 单商品 SKU 利润数据分析
- `/declaration-prices` 核算定价总览
- `/profit-calculation` 利润数据分析总览
- `/profit-calculation/recommendations` 促销投放推荐
- `/profit-calculation/direct-shipping` 多件直发商品选择
- `/profit-calculation/direct-shipping/:productCode` 单商品多件直发测算
- `/profit-calculation/standard-shipping` 多件正常发货商品选择
- `/profit-calculation/standard-shipping/:productCode` 单商品多件正常发货测算
- `/test-shipping` 直发测算
- `/purchases/new` 新增采购
- `/purchases/records` 采购记录
- `/inventory` 仓储库存
- `/parameter-settings` 参数设置

## 常用命令

```bash
npm run dev
npm run build
npm run test
npm run sync:data
npm run sync:backend-context
```

## 数据权限

前端只使用 `anon key`。商品资料按项目账号共享，RLS 通过 `account_permissions` 控制操作权限：登录账号可查看，`editor`/`admin` 可新增和编辑，只有 `admin` 可删除商品。参数设置仍按账号保存。

## 后端分析数据同步

给 `temu_japan_semi_managed_backend` 同步数据库快照和计算规则：

```bash
npm run sync:backend-context
```

该命令会先刷新 `local-data/codex-supabase-data.json`，再生成 `local-data/calculation-rules.json` 和 `local-data/backend-context.json`，并复制到相邻的 `../temu_japan_semi_managed_backend/data/`。如果 `.env` 配置了 `SUPABASE_SERVICE_ROLE_KEY`，导出会绕过 RLS 读取全库；否则按 `SUPABASE_SYNC_EMAIL` 与 `SUPABASE_SYNC_PASSWORD` 登录账号可见范围导出。

## 账号权限

账号权限在 Supabase 后台维护，应用只读取权限并由 RLS 强制限制；登录用户不能通过应用接口新增、修改或删除 `account_permissions`。执行 `supabase/schema.sql` 后，在 Supabase 的 Table Editor 打开 `account_permissions` 表，按登录邮箱新增或修改记录：

- `admin`：所有权限，可以新增、编辑、删除。
- `editor`：可以新增和编辑，不能删除。
- `viewer`：只读查看。

也可以在 SQL Editor 执行：

```sql
insert into public.account_permissions (email, permission_level)
values ('user@example.com', 'admin')
on conflict (email)
do update set permission_level = excluded.permission_level;
```

`account_permissions` 为空时，当前登录账号会按 `admin` 处理，方便初始化第一位管理员；只要表里已有任意权限记录，未配置账号会按 `viewer` 处理。
