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
- `/products/:id/edit` 编辑商品
- `/products/:id/pricing` 申报价结果
- `/purchases` 采购记录
- `/inventory` 库存
- `/settings` 参数设置

## 数据隔离

前端只使用 `anon key`。`products`、`product_items`、`pricing_settings` 全部启用 RLS，并按 `auth.uid() = owner_id` 隔离。
