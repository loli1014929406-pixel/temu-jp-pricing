import type { ProductItem, ProductSku, PurchaseOrder, PurchaseOrderItem, PurchasePackage } from "../../types";

export type DraftItem = { id: string; itemId: string; quantity: string; unitPriceRmb: string };
export type DraftSkuSelection = { id: string; skuId: string; quantity: string };
export type PurchaseSkuReceiptSummary = {
  key: string;
  label: string;
  quantity: number;
  receivedQuantity: number;
  amountRmb: number;
  inferred: boolean;
};
export type ReceiveSkuRow = {
  key: string;
  skuId: string;
  label: string;
  productCode: string;
  productName: string;
  remainingQuantity: number;
  components: Array<{
    item: PurchaseOrderItem;
    itemPerSku: number;
    remainingQuantity: number;
  }>;
};
export type SkuBindingPreview = {
  valid: boolean;
  quantity: number | null;
  message: string;
};
export type PreparedPurchaseItem = Pick<
  PurchaseOrderItem,
  | "product_id"
  | "item_id"
  | "sku_id"
  | "sku_quantity"
  | "product_code"
  | "product_name_cn"
  | "item_name"
  | "item_spec"
  | "purchase_url"
  | "quantity"
  | "unit_price_rmb"
>;
export type DraftProduct = {
  id: string;
  productId: string;
  skuId?: string;
  skuQuantity?: string;
  skuSelections?: DraftSkuSelection[];
  items: DraftItem[];
};
export type DraftPurchaseUrlItem = { component: ProductItem; draftItem: DraftItem };
export type DraftPurchaseUrlSummary = {
  urls: string[];
  itemsByUrl: Map<string, DraftPurchaseUrlItem[]>;
  totalsByUrl: Map<string, number>;
};
export type PurchaseCreateDraft = {
  warehouseId: string;
  purchasedAt: string;
  notes: string;
  draftProducts: DraftProduct[];
  linkMetaDrafts: Record<string, { alibabaOrderNo: string; freightRmb: string }>;
};
export type PurchaseRecordsDraft = {
  packageTrackingDrafts: Record<string, string>;
  existingPackageTrackingDrafts: Record<string, string>;
  sourceDrafts: Record<string, { alibabaOrderNo: string; freightRmb: string }>;
};

export function hasPurchaseCreateDraft(draft: PurchaseCreateDraft | null | undefined) {
  if (!draft) return false;

  return Boolean(
    draft.warehouseId ||
    draft.purchasedAt !== localDate() ||
    draft.notes.trim() ||
    Object.values(draft.linkMetaDrafts).some(
      (value) => value.alibabaOrderNo.trim() || value.freightRmb.trim(),
    ) ||
    draft.draftProducts.some(
      (product) =>
        product.productId ||
        product.skuId ||
        (product.skuQuantity ?? "1").trim() !== "1" ||
        (product.skuSelections ?? []).some(
          (selection) =>
            selection.skuId || (selection.quantity ?? "1").trim() !== "1",
        ) ||
        product.items.some(
          (item) =>
            item.itemId ||
            item.unitPriceRmb.trim() ||
            (item.quantity.trim() && item.quantity !== "1"),
        ),
    ),
  );
}

export function hasPurchaseRecordsDraft(draft: PurchaseRecordsDraft | null | undefined) {
  if (!draft) return false;

  return Boolean(
    Object.values(draft.packageTrackingDrafts).some((value) => value.trim()) ||
    Object.keys(draft.existingPackageTrackingDrafts).length > 0 ||
    Object.keys(draft.sourceDrafts).length > 0,
  );
}

export function getReceivedQuantityByOrderItem(order: PurchaseOrder) {
  return order.packages
    .filter((pkg) => pkg.status === "received")
    .flatMap((pkg) => pkg.items)
    .reduce<Record<string, number>>((quantities, item) => {
      quantities[item.order_item_id] =
        (quantities[item.order_item_id] ?? 0) + item.quantity;
      return quantities;
    }, {});
}

export function getRemainingSourceItems(
  sourceItems: PurchaseOrder["items"],
  receivedQuantityByOrderItem: Record<string, number>,
) {
  return sourceItems.flatMap((item) => {
    const remainingQuantity = item.quantity - (receivedQuantityByOrderItem[item.id] ?? 0);
    return remainingQuantity > 0
      ? [{ ...item, quantity: remainingQuantity }]
      : [];
  });
}

export function getMissingSkuRemainingItems(
  sourceItems: PurchaseOrder["items"],
  receivedQuantityByOrderItem: Record<string, number>,
) {
  return getRemainingSourceItems(sourceItems, receivedQuantityByOrderItem).filter(
    (item) => !item.sku_id || !item.sku_quantity || item.sku_quantity <= 0,
  );
}

export function getRemainingSkuReceiveRows(
  order: PurchaseOrder,
  receivedQuantityByOrderItem: Record<string, number>,
  skusById: Record<string, ProductSku>,
) {
  const groups = new Map<string, ReceiveSkuRow>();

  for (const item of order.items) {
    if (!item.sku_id || !item.sku_quantity || item.sku_quantity <= 0) continue;

    const remainingQuantity = item.quantity - (receivedQuantityByOrderItem[item.id] ?? 0);
    if (remainingQuantity <= 0) continue;

    const itemPerSku = item.quantity / item.sku_quantity;
    if (!Number.isFinite(itemPerSku) || itemPerSku <= 0) continue;

    const group = groups.get(item.sku_id) ?? {
      key: `sku:${item.sku_id}`,
      skuId: item.sku_id,
      label: skusById[item.sku_id] ? formatSkuLabel(skusById[item.sku_id]) : `${item.product_code} · SKU ${item.sku_id}`,
      productCode: item.product_code,
      productName: item.product_name_cn,
      remainingQuantity: 0,
      components: [],
    };

    group.components.push({ item, itemPerSku, remainingQuantity });
    groups.set(item.sku_id, group);
  }

  return Array.from(groups.values()).flatMap((group) => {
    const skuRemainingQuantity = Math.min(
      ...group.components.map((component) =>
        Math.floor(component.remainingQuantity / component.itemPerSku),
      ),
    );
    return skuRemainingQuantity > 0
      ? [{ ...group, remainingQuantity: skuRemainingQuantity }]
      : [];
  });
}

export function getSkuBindingPreview(item: PurchaseOrderItem, sku: ProductSku | undefined): SkuBindingPreview {
  if (!sku?.id) return { valid: false, quantity: null, message: "请选择 SKU" };
  if (!item.product_id || sku.product_id !== item.product_id) {
    return { valid: false, quantity: null, message: "SKU 不属于该商品" };
  }
  if (!item.item_id) {
    return { valid: false, quantity: null, message: "历史明细缺少组成绑定" };
  }

  const link = sku.component_links.find((entry) => entry.item_id === item.item_id);
  if (!link) {
    return { valid: false, quantity: null, message: "SKU 不包含该历史明细" };
  }

  const perSkuQuantity = Math.trunc(Number(link.quantity) || 0);
  if (perSkuQuantity <= 0) {
    return { valid: false, quantity: null, message: "SKU 组成数量异常" };
  }
  if (item.quantity % perSkuQuantity !== 0) {
    return { valid: false, quantity: null, message: "无法整除推导 SKU 数量" };
  }

  return {
    valid: true,
    quantity: item.quantity / perSkuQuantity,
    message: `推导 SKU 数量 ${item.quantity / perSkuQuantity}`,
  };
}

export function localDate() {
  const now = new Date();
  const offset = now.getTimezoneOffset() * 60 * 1000;
  return new Date(now.getTime() - offset).toISOString().slice(0, 10);
}

export function createDraftItem(): DraftItem {
  return { id: crypto.randomUUID(), itemId: "", quantity: "1", unitPriceRmb: "" };
}

export function createDraftSkuSelection(): DraftSkuSelection {
  return { id: crypto.randomUUID(), skuId: "", quantity: "1" };
}

export function createDraftProduct(): DraftProduct {
  return {
    id: crypto.randomUUID(),
    productId: "",
    skuId: "",
    skuQuantity: "1",
    skuSelections: [createDraftSkuSelection()],
    items: [createDraftItem()],
  };
}

export function formatSkuLabel(sku: ProductSku) {
  const attributes = Object.entries(sku.attributes ?? {})
    .filter(([, value]) => String(value).trim())
    .map(([name, value]) => `${name}: ${value}`);

  return attributes.length > 0
    ? `${sku.sku_code} · ${attributes.join(" / ")}`
    : sku.sku_code;
}

export function formatQuantity(value: number) {
  return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(4)));
}

export function normalizePositiveIntegerInput(value: string | undefined) {
  const quantity = Math.trunc(Number(value));
  return Number.isFinite(quantity) && quantity > 0 ? String(quantity) : "1";
}

export function getSkuQuantityFromComponentGroup(group: {
  quantity: number;
  skuQuantity: number;
  receivedQuantity: number;
}) {
  const itemPerSku = group.skuQuantity > 0 ? group.quantity / group.skuQuantity : 1;
  return {
    quantity: group.skuQuantity,
    receivedQuantity: itemPerSku > 0 ? Math.floor(group.receivedQuantity / itemPerSku) : 0,
  };
}

export function getExplicitSkuReceiptSummaries(
  order: PurchaseOrder,
  receivedQuantityByOrderItem: Record<string, number>,
  skusById: Record<string, ProductSku>,
) {
  const groups = new Map<
    string,
    {
      sku: ProductSku | undefined;
      productCode: string;
      productName: string;
      amountRmb: number;
      components: Map<string, { quantity: number; skuQuantity: number; receivedQuantity: number }>;
    }
  >();

  for (const item of order.items) {
    if (!item.sku_id || !item.sku_quantity || item.sku_quantity <= 0) continue;
    const group = groups.get(item.sku_id) ?? {
      sku: skusById[item.sku_id],
      productCode: item.product_code,
      productName: item.product_name_cn,
      amountRmb: 0,
      components: new Map<string, { quantity: number; skuQuantity: number; receivedQuantity: number }>(),
    };
    const componentKey = item.item_id ?? item.id;
    const component = group.components.get(componentKey) ?? {
      quantity: 0,
      skuQuantity: 0,
      receivedQuantity: 0,
    };
    component.quantity += item.quantity;
    component.skuQuantity += item.sku_quantity;
    component.receivedQuantity += Math.min(
      item.quantity,
      receivedQuantityByOrderItem[item.id] ?? 0,
    );
    group.amountRmb += item.quantity * item.unit_price_rmb;
    group.components.set(componentKey, component);
    groups.set(item.sku_id, group);
  }

  return Array.from(groups.entries()).map(([skuId, group]) => {
    const componentQuantities = Array.from(group.components.values()).map(getSkuQuantityFromComponentGroup);
    const quantity = componentQuantities.length > 0
      ? Math.min(...componentQuantities.map((item) => item.quantity))
      : 0;
    const receivedQuantity = componentQuantities.length > 0
      ? Math.min(...componentQuantities.map((item) => item.receivedQuantity))
      : 0;

    return {
      key: `sku:${skuId}`,
      label: group.sku ? formatSkuLabel(group.sku) : `${group.productCode} · SKU ${skuId}`,
      quantity,
      receivedQuantity,
      amountRmb: group.amountRmb,
      inferred: false,
    };
  });
}

export function inferLegacySkuReceiptSummaries(
  order: PurchaseOrder,
  receivedQuantityByOrderItem: Record<string, number>,
  skusByProductId: Record<string, ProductSku[]>,
) {
  const legacyItems = order.items.filter((item) => !item.sku_id);
  const summaries: PurchaseSkuReceiptSummary[] = [];
  const missingByItemId = new Set(legacyItems.map((item) => item.id));

  const itemsByProductId = legacyItems.reduce<Record<string, PurchaseOrderItem[]>>((groups, item) => {
    if (!item.product_id || !item.item_id) return groups;
    groups[item.product_id] ??= [];
    groups[item.product_id].push(item);
    return groups;
  }, {});

  for (const [productId, productItems] of Object.entries(itemsByProductId)) {
    const productSkus = skusByProductId[productId] ?? [];
    if (productSkus.length === 0) continue;

    const skuIdsByItemId = productSkus.reduce<Record<string, Set<string>>>((groups, sku) => {
      const skuId = sku.id;
      if (!skuId) return groups;
      sku.component_links.forEach((link) => {
        (groups[link.item_id] ??= new Set<string>()).add(skuId);
      });
      return groups;
    }, {});

    const orderItemByItemId = new Map(
      productItems.flatMap((item) => item.item_id ? [[item.item_id, item]] : []),
    );
    const inferredForProduct: Array<{
      sku: ProductSku;
      quantity: number;
      receivedQuantity: number;
      amountRmb: number;
    }> = [];

    for (const sku of productSkus) {
      if (!sku.id) continue;
      const uniqueLinks = sku.component_links.filter(
        (link) => (skuIdsByItemId[link.item_id]?.size ?? 0) === 1,
      );
      if (uniqueLinks.length === 0) continue;

      const quantities = uniqueLinks.flatMap((link) => {
        const item = orderItemByItemId.get(link.item_id);
        const perSku = Math.trunc(Number(link.quantity) || 0);
        return item && perSku > 0 ? [Math.floor(item.quantity / perSku)] : [];
      });
      if (quantities.length !== uniqueLinks.length) continue;

      const quantity = Math.min(...quantities);
      if (quantity <= 0) continue;

      const receivedQuantities = uniqueLinks.map((link) => {
        const item = orderItemByItemId.get(link.item_id);
        const perSku = Math.trunc(Number(link.quantity) || 0);
        return item && perSku > 0
          ? Math.floor(Math.min(item.quantity, receivedQuantityByOrderItem[item.id] ?? 0) / perSku)
          : 0;
      });
      inferredForProduct.push({
        sku,
        quantity,
        receivedQuantity: Math.min(...receivedQuantities),
        amountRmb: 0,
      });
    }

    if (inferredForProduct.length === 0) continue;

    const requiredByItemId = new Map<string, number>();
    inferredForProduct.forEach(({ sku, quantity }) => {
      sku.component_links.forEach((link) => {
        requiredByItemId.set(
          link.item_id,
          (requiredByItemId.get(link.item_id) ?? 0) + quantity * Number(link.quantity || 0),
        );
      });
    });

    productItems.forEach((item) => {
      if (!item.item_id) return;
      const requiredQuantity = requiredByItemId.get(item.item_id) ?? 0;
      if (requiredQuantity >= item.quantity) {
        missingByItemId.delete(item.id);
      }
    });

    const amountBySkuId = new Map<string, number>();
    productItems.forEach((item) => {
      if (!item.item_id) return;
      const skuShares = inferredForProduct
        .map(({ sku, quantity }) => {
          const link = sku.component_links.find((entry) => entry.item_id === item.item_id);
          return link && sku.id ? { skuId: sku.id, required: quantity * Number(link.quantity || 0) } : null;
        })
        .filter((entry): entry is { skuId: string; required: number } => Boolean(entry?.required));
      const totalRequired = skuShares.reduce((sum, entry) => sum + entry.required, 0);
      if (totalRequired <= 0) return;
      const itemAmount = item.quantity * item.unit_price_rmb;
      skuShares.forEach((entry) => {
        amountBySkuId.set(
          entry.skuId,
          (amountBySkuId.get(entry.skuId) ?? 0) + itemAmount * (entry.required / totalRequired),
        );
      });
    });

    inferredForProduct.forEach(({ sku, quantity, receivedQuantity }) => {
      if (!sku.id) return;
      summaries.push({
        key: `legacy-sku:${order.id}:${sku.id}`,
        label: formatSkuLabel(sku),
        quantity,
        receivedQuantity,
        amountRmb: amountBySkuId.get(sku.id) ?? 0,
        inferred: true,
      });
    });
  }

  const missing = legacyItems
    .filter((item) => missingByItemId.has(item.id))
    .map((item) => ({
      key: `missing:${item.id}`,
      label: `${item.product_code} · 未绑定 SKU`,
      quantity: item.quantity,
      receivedQuantity: Math.min(item.quantity, receivedQuantityByOrderItem[item.id] ?? 0),
    }));

  return { summaries, missing };
}

export function getPurchaseSkuReceiptView(
  order: PurchaseOrder,
  receivedQuantityByOrderItem: Record<string, number>,
  skusById: Record<string, ProductSku>,
  skusByProductId: Record<string, ProductSku[]>,
) {
  const explicitSummaries = getExplicitSkuReceiptSummaries(order, receivedQuantityByOrderItem, skusById);
  const legacyView = inferLegacySkuReceiptSummaries(order, receivedQuantityByOrderItem, skusByProductId);
  return {
    summaries: [...explicitSummaries, ...legacyView.summaries],
    missing: legacyView.missing,
  };
}

export function formatPackageReceiptItems(
  packageItems: PurchasePackage["items"],
  orderItems: PurchaseOrder["items"],
  skusById: Record<string, ProductSku>,
) {
  const orderItemsById = Object.fromEntries(orderItems.map((item) => [item.id, item]));
  const groups = new Map<
    string,
    {
      label: string;
      components: Map<string, { quantity: number; skuQuantity: number; receivedQuantity: number }>;
    }
  >();
  const missing: string[] = [];

  packageItems.forEach((packageItem) => {
    const item = orderItemsById[packageItem.order_item_id];
    if (!item) {
      missing.push(`未知明细 x ${packageItem.quantity}`);
      return;
    }
    if (!item.sku_id || !item.sku_quantity || item.sku_quantity <= 0) {
      missing.push(`缺 SKU：${item.product_code} x ${packageItem.quantity}`);
      return;
    }

    const group = groups.get(item.sku_id) ?? {
      label: skusById[item.sku_id] ? formatSkuLabel(skusById[item.sku_id]) : `${item.product_code} · SKU ${item.sku_id}`,
      components: new Map<string, { quantity: number; skuQuantity: number; receivedQuantity: number }>(),
    };
    const componentKey = item.item_id ?? item.id;
    const component = group.components.get(componentKey) ?? {
      quantity: 0,
      skuQuantity: 0,
      receivedQuantity: 0,
    };
    component.quantity += item.quantity;
    component.skuQuantity += item.sku_quantity;
    component.receivedQuantity += Math.max(0, Math.trunc(Number(packageItem.quantity) || 0));
    group.components.set(componentKey, component);
    groups.set(item.sku_id, group);
  });

  const skuLines = Array.from(groups.values()).map((group) => {
    const quantities = Array.from(group.components.values())
      .map(getSkuQuantityFromComponentGroup)
      .map((item) => item.receivedQuantity);
    return `${group.label} x ${quantities.length > 0 ? Math.min(...quantities) : 0}`;
  });

  return [...skuLines, ...missing].join("，");
}
