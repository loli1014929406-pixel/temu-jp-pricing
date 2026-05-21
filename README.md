# Temu 日本站申报核算

React + Vite + TypeScript 的 MVP，使用 Supabase 做登录与数据存储，使用 Tailwind CSS 做样式。

## 本地启动

1. 复制 `.env.example` 为 `.env`。
2. 填入：
   - `VITE_SUPABASE_URL`
   - `VITE_SUPABASE_ANON_KEY`
3. 在 Supabase SQL Editor 执行 `supabase/schema.sql`。
4. 安装依赖并启动：

```bash
npm install
npm run dev
```

## Cloudflare Pages

- Build command: `npm run build`
- Output directory: `dist`
- 环境变量：
  - `VITE_SUPABASE_URL`
  - `VITE_SUPABASE_ANON_KEY`

## 页面

- `/auth` 登录与注册
- `/products` 商品列表
- `/products/new` 新增商品
- `/products/:productCode/edit` 编辑商品
- `/products/:productCode/pricing` 申报价结果
- `/purchases/records` 采购记录
- `/inventory` 库存
- `/parameter-settings` 参数设置

## 数据隔离

前端只使用 `anon key`。`products`、`product_items`、`pricing_settings` 全部启用 RLS，并按 `auth.uid() = owner_id` 隔离。

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
