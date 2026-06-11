# Codex Project Rules

## Data Lookup Rule

When answering questions about product information, purchase records, inventory, pricing, or profit data for this project:

- Prefer the local Supabase snapshot at `local-data/codex-supabase-data.json`.
- The snapshot stores rows under the top-level `tables` object.
- If the user asks for the latest data, or if the snapshot is missing or clearly stale for the question, run `npm run sync:data` first, then read the refreshed snapshot.
- Do not query Supabase directly unless the local snapshot is unavailable, sync fails, or the user explicitly asks for a live database check.
- `local-data/` is local-only project data and should remain ignored by git.

---

## Bug Fix Tasks

以下是经过代码审查后需要修复的 Bug，按优先级排列。每项都列出了**文件路径、问题描述、修改要求**。

### 验证要求（所有任务通用）

- 修改后运行 `npm run build`，确保 TypeScript 编译通过，无类型错误。
- 运行 `npm test`，确保所有测试通过。
- 不要修改 `supabase/schema.sql`（除非任务明确要求）。
- 不要修改 `AGENTS.md` 本身。

---

## TASK-01（P0）：抽取公共工具函数 `withTimeout` 和 `requireSession`

**文件：**
- 新建 `src/lib/supabase-helpers.ts`
- 修改 `src/lib/inventory.ts`
- 修改 `src/lib/purchases.ts`
- 修改 `src/lib/orders.ts`

**问题：**
`withTimeout` 和 `requireSession` 在 `inventory.ts`、`purchases.ts`、`orders.ts` 三个文件中各自重复定义，代码冗余，修改需同步三处。

**修改要求：**

1. 新建 `src/lib/supabase-helpers.ts`，内容如下：

```ts
import { getSupabaseClient } from "./supabase";

export const requestTimeoutMs = 15000;

export async function withTimeout<T>(promise: PromiseLike<T>, label: string): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(
      () => reject(new Error(`${label}超时，请稍后重试`)),
      requestTimeoutMs,
    );
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

export async function requireSession() {
  const supabase = getSupabaseClient();
  const {
    data: { session },
  } = await supabase.auth.getSession();
  if (!session?.user) throw new Error("当前登录已失效，请重新登录");
  return { supabase, session };
}
```

2. 在 `inventory.ts`、`purchases.ts`、`orders.ts` 中：
   - 删除各自文件顶部的 `withTimeout`、`requireSession`、`requestTimeoutMs` 定义。
   - 在文件顶部添加 `import { withTimeout, requireSession } from "./supabase-helpers";`。
   - 确保所有调用点行为完全不变。

---

## TASK-02（P0）：修复 `fetchWarehouseSkus` 的 select 字段缺失

**文件：** `src/lib/inventory.ts`

**问题：**
```ts
// 当前代码（错误）
.select("id, warehouse_id, product_id, sku_id, created_at")
```
`owner_id` 字段未查询，但断言为 `WarehouseSku[]`，导致后续使用 `owner_id` 字段时为 `undefined`。

**修改要求：**
将 `fetchWarehouseSkus` 中的 select 字段改为包含所有 `WarehouseSku` 类型要求的字段：
```ts
.select("id, warehouse_id, product_id, sku_id, owner_id, stock_quantity, created_at, updated_at")
```

---

## TASK-03（P0）：修复 `fetchWarehouses` 的 select 字段缺失

**文件：** `src/lib/inventory.ts`

**问题：**
```ts
// 当前代码（错误）
.select("id, name")
```
`owner_id`、`created_at`、`updated_at` 未查询，但类型断言为 `Warehouse[]`，导致排序逻辑使用 `created_at` 时得到 `undefined`。

**修改要求：**
将 `fetchWarehouses` 中的 select 改为：
```ts
.select("id, name, owner_id, created_at, updated_at")
```
同样检查 `createWarehouse` 和 `updateWarehouse` 的 `.select("id, name")`，统一改为：
```ts
.select("id, name, owner_id, created_at, updated_at")
```

---

## TASK-04（P0）：修复 `removeWarehouseProduct` 误删其他仓库库存

**文件：** `src/lib/inventory.ts`

**问题：**
```ts
// 当前代码（错误）
supabase
  .from("warehouse_item_stocks")
  .delete()
  .eq("warehouse_id", warehouseId)
  .in("item_id", itemIds)
  // ↑ 正确，有 warehouse_id 过滤
```
等等，实际代码是：
```ts
supabase
  .from("warehouse_item_stocks")
  .delete()
  .eq("warehouse_id", warehouseId)
  .in("item_id", itemIds)
```
看起来有 `warehouse_id`，**但需要核实**：请打开 `src/lib/inventory.ts` 中 `removeWarehouseProduct` 函数，确认两个 delete 操作（`warehouse_skus` 和 `warehouse_item_stocks`）都有正确的 `warehouse_id` 过滤。如果缺少，补上 `.eq("warehouse_id", warehouseId)`。

---

## TASK-05（P0）：删除生产代码中的 `console.log`

**文件：** `src/lib/purchases.ts`

**问题：**
`persistResolvedPurchaseItemIds` 函数中有调试日志：
```ts
console.log("[persist] missedUpdates", missedUpdates.map(...));
```
会将内部 ID、item_id 等信息打印到浏览器控制台。

**修改要求：**
删除该 `console.log(...)` 这一整行，不替换为其他输出。

---

## TASK-06（P0）：修复 `applyPurchasePackageInventory` 中 `warehouse_item_stocks` select 字段缺失

**文件：** `src/lib/purchases.ts`

**问题：**
```ts
// 当前代码（错误）
.select("id, stock_quantity")  // 缺少 warehouse_id, item_id
```
断言为 `WarehouseItemStock` 后，返回给调用方的 inventory 数据中 `warehouse_id` 和 `item_id` 都是 `undefined`，导致库存更新回调数据不完整。

**修改要求：**
在 `applyPurchasePackageInventory` 中，找到扣减配件库存的 update 语句：
```ts
.select("id, stock_quantity")
```
改为：
```ts
.select("id, warehouse_id, item_id, stock_quantity")
```

---

## TASK-07（P1）：修复 `receiveRemainingPurchaseOrder` 操作顺序问题

**文件：** `src/lib/purchases.ts`

**问题：**
`receiveRemainingPurchaseOrder` 在写库存流水后才更新包裹状态为 `received`。如果包裹状态更新失败，包裹永远是 `pending`，但库存已经增加，下次重试会重复入库。

`receivePurchasePackage` 已经修复为"先更新包裹状态，再写库存"，`receiveRemainingPurchaseOrder` 应保持一致。

**修改要求：**
在 `receiveRemainingPurchaseOrder` 中，对每个新创建的包裹，调整操作顺序：
1. **先** 将包裹状态更新为 `received`（`purchase_packages.update({ status: "received", received_at })`）
2. **再** 调用 `applyPurchasePackageInventory`

如果 `applyPurchasePackageInventory` 失败，由其内部的幂等去重逻辑（检查 `purchase_package_id` 是否已有 adjustment 记录）保证不会重复入库。

---

## TASK-08（P1）：修复 `useOrders.ts` 中 `mergeOrders` 覆盖未保存 draft

**文件：** `src/hooks/useOrders.ts`

**问题：**
```ts
function mergeOrders(nextOrders: TemuOrderRecord[]) {
  setOrders(...);
  setDrafts((current) => ({
    ...current,
    ...buildDraftMap(nextOrders),  // ← 覆盖了用户正在编辑的 draft 字段
  }));
}
```
`buildDraftMap` 会把 `nextOrders` 的字段（仓库、物流方式等）覆盖进 `drafts`，丢失用户尚未保存的编辑。

**修改要求：**
`mergeOrders` 中的 `setDrafts` 逻辑改为：只为 **当前 drafts 中不存在** 的 orderId 初始化 draft，不覆盖已有的 draft：
```ts
function mergeOrders(nextOrders: TemuOrderRecord[]) {
  setOrders((current) =>
    current.map(
      (order) => nextOrders.find((nextOrder) => nextOrder.id === order.id) ?? order,
    ),
  );
  setDrafts((current) => {
    const next = { ...current };
    nextOrders.forEach((order) => {
      // 只初始化还没有 draft 的订单，不覆盖已有编辑
      if (!(order.id in next)) {
        next[order.id] = toDraft(order);
      }
    });
    return next;
  });
}
```

---

## TASK-09（P1）：修复 `inventory-page.tsx` 中 `sortedWarehouseSkusByWarehouseId` 的 useMemo 依赖

**文件：** `src/pages/inventory-page.tsx`

**问题：**
`sortedWarehouseSkusByWarehouseId` 的 `useMemo` 内部通过 `getSkuDisplayCode` 函数间接使用了 `skuDisplayCodesById`，但 `getSkuDisplayCode` 是普通函数（不是 `useCallback`），且 `skuDisplayCodesById` 没有被加入依赖数组，导致 `skuDisplayCodesById` 更新后排序不刷新。

**修改要求：**

1. 将 `getSkuDisplayCode` 改为 `useCallback`：
```ts
const getSkuDisplayCode = useCallback(
  (sku?: ProductSku) => {
    if (!sku?.id) return "--";
    return skuDisplayCodesById[sku.id] || sku.sku_code || "--";
  },
  [skuDisplayCodesById],
);
```

2. 在 `sortedWarehouseSkusByWarehouseId` 的 `useMemo` 依赖数组中，将原来的 `skuDisplayCodesById` 替换为 `getSkuDisplayCode`（如果原来没有 `skuDisplayCodesById`，则添加 `getSkuDisplayCode`）：
```ts
}, [productCodeCollator, productsById, skusById, warehouseSkusByWarehouseId, getSkuDisplayCode]);
```

---

## 完成标准

所有任务完成后：

1. `npm run build` 无错误
2. `npm test` 全部通过
3. 提交信息格式：`fix: [TASK-XX] 简短描述`，多个任务可合并为一次提交
4. 不引入任何新的 `console.log`、`any` 类型断言、或 `// TODO` 注释
