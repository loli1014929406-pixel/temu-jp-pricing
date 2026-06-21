import { CheckCircle2, Plus, Search, Trash2 } from "lucide-react";
import { Link, useNavigate } from "react-router-dom";
import { useEffect, useMemo, useRef, useState } from "react";
import type { User } from "@supabase/supabase-js";
import { Field, TextArea, TextInput } from "../components/form-controls";
import { Badge, PageHeader } from "../components/ui";
import {
  clearDraft,
  readDraft,
  useDraftPersistence,
} from "../hooks/use-draft-persistence";
import { useAutoDismiss } from "../hooks/use-auto-dismiss";
import { usePermissions } from "../hooks/use-permissions";
import { fetchWarehouses } from "../lib/inventory";
import {
  createPurchaseOrder,
  createPurchasePackage,
  deletePurchasePackage,
  deletePurchaseOrder,
  fetchPurchaseOrders,
  receivePurchasePackage,
  receiveRemainingPurchaseOrder,
  updatePurchasePackageTrackingNo,
  updatePurchaseSource,
} from "../lib/purchases";
import {
  fetchProductItemsByProductIds,
  fetchProducts,
  fetchProductSkusByProductIds,
} from "../lib/products";
import type {
  Product,
  ProductItem,
  ProductSku,
  PurchaseOrder,
  PurchaseOrderItem,
  PurchasePackage,
  Warehouse,
} from "../types";
import { getErrorMessage } from "../utils/errors";
import { confirmAction, confirmDelete, confirmSave } from "../utils/confirmations";

type PurchasesPageProps = { user: User; view: "create" | "records" };
type DraftItem = { id: string; itemId: string; quantity: string; unitPriceRmb: string };
type DraftSkuSelection = { id: string; skuId: string; quantity: string };
type PreparedPurchaseItem = Pick<
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
type DraftProduct = {
  id: string;
  productId: string;
  skuId?: string;
  skuQuantity?: string;
  skuSelections?: DraftSkuSelection[];
  items: DraftItem[];
};
type DraftPurchaseUrlItem = { component: ProductItem; draftItem: DraftItem };
type DraftPurchaseUrlSummary = {
  urls: string[];
  itemsByUrl: Map<string, DraftPurchaseUrlItem[]>;
  totalsByUrl: Map<string, number>;
};
type PurchaseCreateDraft = {
  warehouseId: string;
  purchasedAt: string;
  notes: string;
  draftProducts: DraftProduct[];
  linkMetaDrafts: Record<string, { alibabaOrderNo: string; freightRmb: string }>;
};
type PurchaseRecordsDraft = {
  packageTrackingDrafts: Record<string, string>;
  existingPackageTrackingDrafts: Record<string, string>;
  sourceDrafts: Record<string, { alibabaOrderNo: string; freightRmb: string }>;
};

function hasPurchaseCreateDraft(draft: PurchaseCreateDraft | null | undefined) {
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

function hasPurchaseRecordsDraft(draft: PurchaseRecordsDraft | null | undefined) {
  if (!draft) return false;

  return Boolean(
    Object.values(draft.packageTrackingDrafts).some((value) => value.trim()) ||
    Object.keys(draft.existingPackageTrackingDrafts).length > 0 ||
    Object.keys(draft.sourceDrafts).length > 0,
  );
}

function getReceivedQuantityByOrderItem(order: PurchaseOrder) {
  return order.packages
    .filter((pkg) => pkg.status === "received")
    .flatMap((pkg) => pkg.items)
    .reduce<Record<string, number>>((quantities, item) => {
      quantities[item.order_item_id] =
        (quantities[item.order_item_id] ?? 0) + item.quantity;
      return quantities;
    }, {});
}

function getRemainingSourceItems(
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

function localDate() {
  const now = new Date();
  const offset = now.getTimezoneOffset() * 60 * 1000;
  return new Date(now.getTime() - offset).toISOString().slice(0, 10);
}

function createDraftItem(): DraftItem {
  return { id: crypto.randomUUID(), itemId: "", quantity: "1", unitPriceRmb: "" };
}

function createDraftSkuSelection(): DraftSkuSelection {
  return { id: crypto.randomUUID(), skuId: "", quantity: "1" };
}

function createDraftProduct(): DraftProduct {
  return {
    id: crypto.randomUUID(),
    productId: "",
    skuId: "",
    skuQuantity: "1",
    skuSelections: [createDraftSkuSelection()],
    items: [createDraftItem()],
  };
}

function formatSkuLabel(sku: ProductSku) {
  const attributes = Object.entries(sku.attributes ?? {})
    .filter(([, value]) => String(value).trim())
    .map(([name, value]) => `${name}: ${value}`);

  return attributes.length > 0
    ? `${sku.sku_code} · ${attributes.join(" / ")}`
    : sku.sku_code;
}

function formatQuantity(value: number) {
  return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(4)));
}

function normalizePositiveIntegerInput(value: string | undefined) {
  const quantity = Math.trunc(Number(value));
  return Number.isFinite(quantity) && quantity > 0 ? String(quantity) : "1";
}

export function PurchasesPage({ user, view }: PurchasesPageProps) {
  const { canEdit, canDelete } = usePermissions();
  const navigate = useNavigate();
  const createDraftKey = `purchase-create-draft:v1:${user.id}`;
  const recordsDraftKey = `purchase-records-draft:v1:${user.id}`;
  const restoredCreateDraftRef = useRef(readDraft<PurchaseCreateDraft>(createDraftKey));
  const restoredRecordsDraftRef = useRef(readDraft<PurchaseRecordsDraft>(recordsDraftKey));
  const restoredCreateDraft = restoredCreateDraftRef.current;
  const restoredRecordsDraft = restoredRecordsDraftRef.current;
  const [warehouses, setWarehouses] = useState<Warehouse[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [items, setItems] = useState<ProductItem[]>([]);
  const [skus, setSkus] = useState<ProductSku[]>([]);
  const [orders, setOrders] = useState<PurchaseOrder[]>([]);
  const [warehouseId, setWarehouseId] = useState(restoredCreateDraft?.warehouseId ?? "");
  const [purchasedAt, setPurchasedAt] = useState(restoredCreateDraft?.purchasedAt ?? localDate());
  const [notes, setNotes] = useState(restoredCreateDraft?.notes ?? "");
  const [draftProducts, setDraftProducts] = useState<DraftProduct[]>(
    restoredCreateDraft?.draftProducts ?? [createDraftProduct()],
  );
  const [search, setSearch] = useState("");
  const [packageTrackingDrafts, setPackageTrackingDrafts] = useState<Record<string, string>>(
    restoredRecordsDraft?.packageTrackingDrafts ?? {},
  );
  const [existingPackageTrackingDrafts, setExistingPackageTrackingDrafts] = useState<Record<string, string>>(
    restoredRecordsDraft?.existingPackageTrackingDrafts ?? {},
  );
  const [sourceDrafts, setSourceDrafts] = useState<
    Record<string, { alibabaOrderNo: string; freightRmb: string }>
  >(restoredRecordsDraft?.sourceDrafts ?? {});
  const [expandedOrderIds, setExpandedOrderIds] = useState<Record<string, boolean>>({});
  const [loading, setLoading] = useState(true);
  const [busyKey, setBusyKey] = useState("");
  const [errorMessage, setErrorMessage] = useState("");
  const [noticeMessage, setNoticeMessage] = useState("");
  const [draftNotice, setDraftNotice] = useState(
    view === "create" && hasPurchaseCreateDraft(restoredCreateDraft)
      ? "已恢复上次未保存的采购管理单草稿。"
      : "",
  );
  useAutoDismiss(errorMessage, () => setErrorMessage(""));
  useAutoDismiss(noticeMessage, () => setNoticeMessage(""));
  useAutoDismiss(draftNotice, () => setDraftNotice(""));

  useEffect(() => {
    let active = true;
    async function load() {
      setLoading(true);
      try {
        const [nextWarehouses, nextProducts, nextOrders] = await Promise.all([
          fetchWarehouses(),
          fetchProducts(),
          fetchPurchaseOrders(),
        ]);
        const [nextItems, nextSkus] = await Promise.all([
          fetchProductItemsByProductIds(nextProducts.map((item) => item.id)),
          fetchProductSkusByProductIds(nextProducts.map((item) => item.id)),
        ]);
        if (!active) return;
        setWarehouses(nextWarehouses);
        setProducts(nextProducts);
        setItems(nextItems);
        setSkus(nextSkus);
        setOrders(nextOrders);
        const serverPackageTrackingDrafts = Object.fromEntries(
          nextOrders.flatMap((order) =>
            order.packages.map((pkg) => [pkg.id, pkg.tracking_no]),
          ),
        );
        const serverSourceDrafts = Object.fromEntries(
          nextOrders.flatMap((order) =>
            order.sources.map((source) => [
              source.id,
              {
                alibabaOrderNo: source.alibaba_order_no,
                freightRmb: String(source.freight_rmb),
              },
            ]),
          ),
        );
        const latestRecordsDraft = readDraft<PurchaseRecordsDraft>(recordsDraftKey);
        setExistingPackageTrackingDrafts({
          ...serverPackageTrackingDrafts,
          ...(latestRecordsDraft?.existingPackageTrackingDrafts ?? {}),
        });
        setSourceDrafts({
          ...serverSourceDrafts,
          ...(latestRecordsDraft?.sourceDrafts ?? {}),
        });
        setPackageTrackingDrafts(latestRecordsDraft?.packageTrackingDrafts ?? {});
        if (view === "records" && hasPurchaseRecordsDraft(latestRecordsDraft)) {
          setDraftNotice("已恢复上次未保存的采购记录编辑草稿。");
        }
      } catch (error) {
        if (active) setErrorMessage(getErrorMessage(error, "加载采购信息失败"));
      } finally {
        if (active) setLoading(false);
      }
    }
    void load();
    return () => {
      active = false;
    };
  }, [recordsDraftKey, user.id, view]);

  const warehousesById = useMemo(
    () => Object.fromEntries(warehouses.map((item) => [item.id, item])),
    [warehouses],
  );
  const productsById = useMemo(
    () => Object.fromEntries(products.map((item) => [item.id, item])),
    [products],
  );
  const itemsById = useMemo(
    () => Object.fromEntries(items.flatMap((item) => (item.id ? [[item.id, item]] : []))),
    [items],
  );
  const skusById = useMemo(
    () => Object.fromEntries(skus.flatMap((sku) => (sku.id ? [[sku.id, sku]] : []))),
    [skus],
  );
  const skusByProductId = useMemo(
    () =>
      skus.reduce<Record<string, ProductSku[]>>((groups, sku) => {
        if (!sku.product_id) return groups;
        groups[sku.product_id] ??= [];
        groups[sku.product_id].push(sku);
        return groups;
      }, {}),
    [skus],
  );
  const [receiveConfirmOrder, setReceiveConfirmOrder] = useState<PurchaseOrder | null>(null);
  const [receiveQuantities, setReceiveQuantities] = useState<Record<string, string>>({});

  const filteredOrders = useMemo(() => {
    const term = search.trim().toLowerCase();
    let result = orders;

    if (term) {
      result = orders.filter(
        (order) =>
          order.order_code.toLowerCase().includes(term) ||
          order.sources.some((source) => source.alibaba_order_no.toLowerCase().includes(term)) ||
          order.items.some(
            (item) =>
              item.product_code.toLowerCase().includes(term) ||
              item.product_name_cn.toLowerCase().includes(term),
          ),
      );
    }

    return [...result].sort((a, b) => {
      const weight: Record<string, number> = { pending: 0, partially_received: 0, received: 1 };
      const weightA = weight[a.status] ?? 0;
      const weightB = weight[b.status] ?? 0;
      if (weightA !== weightB) return weightA - weightB;
      return new Date(b.purchased_at).getTime() - new Date(a.purchased_at).getTime();
    });
  }, [orders, search]);

  const recordStats = useMemo(() => {
    const packageCount = filteredOrders.reduce(
      (sum, order) => sum + order.packages.length,
      0,
    );
    const receivedPackageCount = filteredOrders.reduce(
      (sum, order) =>
        sum + order.packages.filter((pkg) => pkg.status === "received").length,
      0,
    );

    return {
      pendingOrderCount: filteredOrders.filter((order) => order.status === "pending")
        .length,
      partiallyReceivedOrderCount: filteredOrders.filter(
        (order) => order.status === "partially_received",
      ).length,
      receivedOrderCount: filteredOrders.filter((order) => order.status === "received")
        .length,
      totalCostRmb: filteredOrders.reduce(
        (sum, order) => sum + order.total_cost_rmb,
        0,
      ),
      packageCount,
      receivedPackageCount,
    };
  }, [filteredOrders]);

  const draftItemsTotal = useMemo(
    () =>
      draftProducts.reduce(
        (sum, product) =>
          sum +
          product.items.reduce(
            (inner, item) => inner + Number(item.quantity || 0) * Number(item.unitPriceRmb || 0),
            0,
          ),
        0,
      ),
    [draftProducts],
  );
  const activePurchaseUrls = useMemo(
    () =>
      Array.from(
        new Set(
          draftProducts.flatMap((product) =>
            product.items.flatMap((item) => {
              const component = itemsById[item.itemId];
              return component?.purchase_url ? [component.purchase_url] : [];
            }),
          ),
        ),
      ),
    [draftProducts, itemsById],
  );
  const [linkMetaDrafts, setLinkMetaDrafts] = useState<
    Record<string, { alibabaOrderNo: string; freightRmb: string }>
  >(restoredCreateDraft?.linkMetaDrafts ?? {});

  const purchaseCreateDraftValue = useMemo<PurchaseCreateDraft>(
    () => ({
      warehouseId,
      purchasedAt,
      notes,
      draftProducts,
      linkMetaDrafts,
    }),
    [draftProducts, linkMetaDrafts, notes, purchasedAt, warehouseId],
  );

  useDraftPersistence(
    createDraftKey,
    purchaseCreateDraftValue,
    { enabled: view === "create", shouldPersist: hasPurchaseCreateDraft },
  );

  const purchaseRecordsDraftValue = useMemo<PurchaseRecordsDraft>(
    () => {
      const sourcesById = new Map(
        orders.flatMap((order) => order.sources.map((source) => [source.id, source])),
      );
      const packagesById = new Map(
        orders.flatMap((order) => order.packages.map((pkg) => [pkg.id, pkg])),
      );

      return {
        packageTrackingDrafts: Object.fromEntries(
          Object.entries(packageTrackingDrafts).filter(([, value]) => value.trim()),
        ),
        existingPackageTrackingDrafts: Object.fromEntries(
          Object.entries(existingPackageTrackingDrafts).filter(([packageId, value]) => {
            const pkg = packagesById.get(packageId);
            return pkg ? value !== pkg.tracking_no : false;
          }),
        ),
        sourceDrafts: Object.fromEntries(
          Object.entries(sourceDrafts).filter(([sourceId, value]) => {
            const source = sourcesById.get(sourceId);
            return source
              ? value.alibabaOrderNo !== source.alibaba_order_no ||
              Number(value.freightRmb || 0) !== source.freight_rmb
              : false;
          }),
        ),
      };
    },
    [existingPackageTrackingDrafts, orders, packageTrackingDrafts, sourceDrafts],
  );

  useDraftPersistence(
    recordsDraftKey,
    purchaseRecordsDraftValue,
    { enabled: view === "records" && !loading, shouldPersist: hasPurchaseRecordsDraft },
  );
  const draftFreightTotal = useMemo(
    () =>
      activePurchaseUrls.reduce(
        (sum, url) => sum + Number(linkMetaDrafts[url]?.freightRmb || 0),
        0,
      ),
    [activePurchaseUrls, linkMetaDrafts],
  );
  const draftTotal = draftItemsTotal + draftFreightTotal;
  const draftPurchaseUrlSummaries = useMemo(() => {
    const summaries = new Map<string, DraftPurchaseUrlSummary>();

    for (const draftProduct of draftProducts) {
      const urls: string[] = [];
      const itemsByUrl = new Map<string, DraftPurchaseUrlItem[]>();
      const totalsByUrl = new Map<string, number>();

      for (const item of draftProduct.items) {
        const component = itemsById[item.itemId];
        if (!component?.purchase_url) continue;

        const purchaseUrl = component.purchase_url;
        let itemsForUrl = itemsByUrl.get(purchaseUrl);
        if (!itemsForUrl) {
          urls.push(purchaseUrl);
          itemsForUrl = [];
          itemsByUrl.set(purchaseUrl, itemsForUrl);
          totalsByUrl.set(purchaseUrl, Number(linkMetaDrafts[purchaseUrl]?.freightRmb || 0));
        }

        itemsForUrl.push({ component, draftItem: item });
        totalsByUrl.set(
          purchaseUrl,
          (totalsByUrl.get(purchaseUrl) ?? 0) +
          Number(item.quantity || 0) * Number(item.unitPriceRmb || 0),
        );
      }

      summaries.set(draftProduct.id, { urls, itemsByUrl, totalsByUrl });
    }

    return summaries;
  }, [draftProducts, itemsById, linkMetaDrafts]);
  function getProductPurchaseUrls(draftProduct: DraftProduct) {
    return draftPurchaseUrlSummaries.get(draftProduct.id)?.urls ?? [];
  }
  function getDraftItemsByPurchaseUrl(draftProduct: DraftProduct, purchaseUrl: string) {
    return draftPurchaseUrlSummaries.get(draftProduct.id)?.itemsByUrl.get(purchaseUrl) ?? [];
  }
  function getDraftPurchaseUrlTotal(draftProduct: DraftProduct, purchaseUrl: string) {
    return (
      draftPurchaseUrlSummaries.get(draftProduct.id)?.totalsByUrl.get(purchaseUrl) ??
      Number(linkMetaDrafts[purchaseUrl]?.freightRmb || 0)
    );
  }

  function addDraftProduct() {
    setDraftProducts((current) => [...current, createDraftProduct()]);
  }

  function getDraftSkuSelections(draftProduct: DraftProduct): DraftSkuSelection[] {
    if (draftProduct.skuSelections?.length) return draftProduct.skuSelections;
    if (draftProduct.skuId) {
      return [{
        id: `${draftProduct.id}-legacy-sku`,
        skuId: draftProduct.skuId,
        quantity: draftProduct.skuQuantity || "1",
      }];
    }

    return [{
      id: `${draftProduct.id}-empty-sku`,
      skuId: "",
      quantity: "1",
    }];
  }

  function createDraftItemsFromSkuSelections(
    skuSelections: DraftSkuSelection[],
    existingItems: DraftItem[],
    fallbackItems: DraftItem[] = existingItems,
  ) {
    const existingByItemId = new Map(existingItems.map((item) => [item.itemId, item]));
    const quantityByItemId = new Map<string, number>();

    for (const selection of skuSelections) {
      if (!selection.skuId) continue;

      const sku = skusById[selection.skuId];
      if (!sku) continue;

      const skuPurchaseQuantity = Number(normalizePositiveIntegerInput(selection.quantity));
      sku.component_links.forEach((link) => {
        if (!link.item_id) return;
        quantityByItemId.set(
          link.item_id,
          (quantityByItemId.get(link.item_id) ?? 0) +
          Number(link.quantity || 0) * skuPurchaseQuantity,
        );
      });
    }

    if (quantityByItemId.size === 0) {
      return fallbackItems.length > 0 ? fallbackItems : [createDraftItem()];
    }

    const nextItems = Array.from(quantityByItemId.entries()).flatMap(([itemId, bomQuantity]) => {
      const component = itemsById[itemId];
      if (!component?.id) return [];

      const existing = existingByItemId.get(itemId);
      return [{
        id: existing?.id ?? crypto.randomUUID(),
        itemId,
        quantity: formatQuantity(bomQuantity),
        unitPriceRmb: existing?.unitPriceRmb || String(component.purchase_price_rmb),
      }];
    });

    return nextItems.length > 0 ? nextItems : [createDraftItem()];
  }

  function updateDraftProduct(productId: string, nextProductId: string) {
    setDraftProducts((current) =>
      current.map((product) =>
        product.id === productId
          ? {
            ...product,
            productId: nextProductId,
            skuId: "",
            skuQuantity: "1",
            skuSelections: [createDraftSkuSelection()],
            items: product.items.map((item) => ({ ...item, itemId: "", unitPriceRmb: "" })),
          }
          : product,
      ),
    );
  }

  function addDraftProductSkuSelection(productId: string) {
    setDraftProducts((current) =>
      current.map((product) =>
        product.id === productId
          ? {
            ...product,
            skuId: "",
            skuQuantity: "1",
            skuSelections: [...getDraftSkuSelections(product), createDraftSkuSelection()],
          }
          : product,
      ),
    );
  }

  function updateDraftProductSku(productId: string, selectionId: string, nextSkuId: string) {
    setDraftProducts((current) =>
      current.map((product) => {
        if (product.id !== productId) return product;

        const skuSelections = getDraftSkuSelections(product).map((selection) =>
          selection.id === selectionId
            ? {
              ...selection,
              skuId: nextSkuId,
              quantity: normalizePositiveIntegerInput(selection.quantity),
            }
            : selection,
        );
        return {
          ...product,
          skuId: "",
          skuQuantity: "1",
          skuSelections,
          items: createDraftItemsFromSkuSelections(skuSelections, product.items),
        };
      }),
    );
  }

  function updateDraftProductSkuQuantity(
    productId: string,
    selectionId: string,
    nextSkuQuantity: string,
  ) {
    setDraftProducts((current) =>
      current.map((product) => {
        if (product.id !== productId) return product;

        const skuSelections = getDraftSkuSelections(product).map((selection) =>
          selection.id === selectionId
            ? { ...selection, quantity: nextSkuQuantity }
            : selection,
        );
        return {
          ...product,
          skuId: "",
          skuQuantity: "1",
          skuSelections,
          items: createDraftItemsFromSkuSelections(skuSelections, product.items),
        };
      }),
    );
  }

  function removeDraftProductSkuSelection(productId: string, selectionId: string) {
    setDraftProducts((current) =>
      current.map((product) => {
        if (product.id !== productId) return product;

        const remainingSelections = getDraftSkuSelections(product).filter(
          (selection) => selection.id !== selectionId,
        );
        const skuSelections =
          remainingSelections.length > 0 ? remainingSelections : [createDraftSkuSelection()];

        return {
          ...product,
          skuId: "",
          skuQuantity: "1",
          skuSelections,
          items: createDraftItemsFromSkuSelections(
            skuSelections,
            product.items,
            [createDraftItem()],
          ),
        };
      }),
    );
  }

  function updateDraftItem(productId: string, itemId: string, field: keyof Omit<DraftItem, "id">, value: string) {
    setDraftProducts((current) =>
      current.map((product) =>
        product.id === productId
          ? {
            ...product,
            items: product.items.map((item) => {
              if (item.id !== itemId) return item;
              if (field !== "itemId") return { ...item, [field]: value };
              const component = itemsById[value];
              return {
                ...item,
                itemId: value,
                unitPriceRmb: component ? String(component.purchase_price_rmb) : "",
              };
            }),
          }
          : product,
      ),
    );
  }

  async function handleCreateOrder() {
    if (!canEdit) {
      setErrorMessage("当前账号没有编辑权限，不能新增采购管理单。");
      return;
    }

    const warehouse = warehousesById[warehouseId];
    const preparedItems: PreparedPurchaseItem[] = draftProducts.flatMap((draftProduct): PreparedPurchaseItem[] => {
      const product = productsById[draftProduct.productId];
      if (!warehouse || !product) return [];

      const draftItemByItemId = new Map(
        draftProduct.items.map((draftItem) => [draftItem.itemId, draftItem]),
      );
      const skuSelections = getDraftSkuSelections(draftProduct)
        .map((selection) => ({
          sku: skusById[selection.skuId],
          quantity: Number(normalizePositiveIntegerInput(selection.quantity)),
        }))
        .filter((selection) => selection.sku?.id && selection.quantity > 0);

      if (skuSelections.length > 0) {
        return skuSelections.flatMap(({ sku, quantity: skuQuantity }) => {
          if (!sku?.id) return [];

          return sku.component_links.flatMap((link) => {
            const component = itemsById[link.item_id];
            if (!component?.id || component.product_id !== product.id || link.quantity <= 0) {
              return [];
            }

            const draftItem = draftItemByItemId.get(component.id);
            return [{
              product_id: product.id,
              item_id: component.id,
              sku_id: sku.id ?? null,
              sku_quantity: skuQuantity,
              product_code: product.product_code,
              product_name_cn: product.product_name_cn,
              item_name: component.item_name,
              item_spec: component.item_spec,
              purchase_url: component.purchase_url,
              quantity: link.quantity * skuQuantity,
              unit_price_rmb: Number(draftItem?.unitPriceRmb || component.purchase_price_rmb || 0),
            }];
          });
        });
      }

      return draftProduct.items.flatMap((draftItem) => {
        const component = itemsById[draftItem.itemId];
        if (!component?.id || component.product_id !== product.id) return [];
        return [{
          product_id: product.id,
          item_id: component.id,
          sku_id: null,
          sku_quantity: null,
          product_code: product.product_code,
          product_name_cn: product.product_name_cn,
          item_name: component.item_name,
          item_spec: component.item_spec,
          purchase_url: component.purchase_url,
          quantity: Number(draftItem.quantity),
          unit_price_rmb: Number(draftItem.unitPriceRmb),
        }];
      });
    });
    const preparedSources = activePurchaseUrls.flatMap((purchaseUrl) => {
      const meta = linkMetaDrafts[purchaseUrl];
      return meta?.alibabaOrderNo.trim()
        ? [{
          purchase_url: purchaseUrl,
          alibaba_order_no: meta.alibabaOrderNo.trim(),
          freight_rmb: Number(meta.freightRmb || 0),
        }]
        : [];
    });
    if (!warehouse || preparedItems.length === 0 || preparedSources.length !== activePurchaseUrls.length) return;
    if (!confirmSave("确认保存这张采购管理单吗？")) return;

    setBusyKey("create-order");
    try {
      const order = await createPurchaseOrder({
        warehouse_id: warehouse.id,
        warehouse_name: warehouse.name,
        purchased_at: purchasedAt,
        notes: notes.trim(),
        sources: preparedSources,
        items: preparedItems,
      });
      setOrders((current) => [order, ...current]);
      setWarehouseId("");
      setLinkMetaDrafts({});
      setNotes("");
      setDraftProducts([createDraftProduct()]);
      clearDraft(createDraftKey);
      setDraftNotice("");
      navigate("/purchases/records");
    } catch (error) {
      setErrorMessage(getErrorMessage(error, "保存采购管理单失败"));
    } finally {
      setBusyKey("");
    }
  }

  async function handleSaveSource(order: PurchaseOrder, sourceId: string) {
    if (!canEdit) {
      setErrorMessage("当前账号没有编辑权限，不能更新采购信息。");
      return;
    }
    if (!confirmSave()) return;

    setBusyKey(`source-${sourceId}`);
    try {
      const next = await updatePurchaseSource(sourceId, {
        alibaba_order_no: sourceDrafts[sourceId]?.alibabaOrderNo ?? "",
        freight_rmb: Number(sourceDrafts[sourceId]?.freightRmb || 0),
      });
      setOrders((current) =>
        current.map((item) =>
          item.id === order.id
            ? {
              ...item,
              total_cost_rmb:
                item.items_total_rmb +
                item.sources.reduce(
                  (sum, source) =>
                    sum + (source.id === sourceId ? next.freight_rmb : source.freight_rmb),
                  0,
                ),
              sources: item.sources.map((source) => (source.id === sourceId ? next : source)),
            }
            : item,
        ),
      );
    } catch (error) {
      setErrorMessage(getErrorMessage(error, "更新运费失败"));
    } finally {
      setBusyKey("");
    }
  }

  async function handleAddPackage(
    order: PurchaseOrder,
    sourceId: string,
    packageKey: string,
    sourceItems: PurchaseOrder["items"],
  ) {
    if (!canEdit) {
      setErrorMessage("当前账号没有编辑权限，不能保存快递包裹。");
      return;
    }

    const trackingNo = (packageTrackingDrafts[packageKey] ?? "").trim();
    const itemsPayload = sourceItems.map((item) => ({
      order_item_id: item.id,
      quantity: item.quantity,
    }));
    if (!trackingNo || itemsPayload.length === 0) return;
    if (!confirmSave(`确认保存快递单号“${trackingNo}”吗？`)) return;
    setBusyKey(`package-${order.id}`);
    try {
      const pkg = await createPurchasePackage(order.id, sourceId, trackingNo, itemsPayload);
      setOrders((current) =>
        current.map((item) =>
          item.id === order.id ? { ...item, packages: [...item.packages, pkg] } : item,
        ),
      );
      setPackageTrackingDrafts((current) => ({ ...current, [packageKey]: "" }));
    } catch (error) {
      setErrorMessage(getErrorMessage(error, "保存快递包裹失败"));
    } finally {
      setBusyKey("");
    }
  }

  async function handleReceivePackage(order: PurchaseOrder, pkg: PurchasePackage) {
    if (!canEdit) {
      setErrorMessage("当前账号没有编辑权限，不能签收入库。");
      return;
    }

    if (!confirmAction(`确认签收快递单号“${pkg.tracking_no}”并增加库存吗？`)) return;
    setBusyKey(`receive-${pkg.id}`);
    setErrorMessage("");
    setNoticeMessage("");
    try {
      const result = await receivePurchasePackage(order, pkg);
      setOrders((current) =>
        current.map((item) =>
          item.id === order.id
            ? {
              ...item,
              ...result.order,
              items: item.items,
              packages: item.packages.map((entry) =>
                entry.id === pkg.id ? result.package : entry,
              ),
            }
            : item,
        ),
      );
    } catch (error) {
      setErrorMessage(getErrorMessage(error, "签收入库失败"));
    } finally {
      setBusyKey("");
    }
  }

  async function handleReceiveRemainingOrder(order: PurchaseOrder, skipConfirm = false) {
    if (!canEdit) {
      setErrorMessage("当前账号没有编辑权限，不能签收入库。");
      return;
    }

    if (
      !skipConfirm &&
      !confirmAction(
        `确认将采购管理单“${order.order_code}”剩余未签收明细全部签收，并增加库存吗？`,
      )
    ) {
      return;
    }

    setBusyKey(`receive-order-${order.id}`);
    setErrorMessage("");
    setNoticeMessage("");
    try {
      const result = await receiveRemainingPurchaseOrder(order);
      const count = result.inventory.reduce(
        (sum, entry) => sum + entry.adjustment.change_quantity,
        0,
      );
      setOrders((current) =>
        current.map((item) =>
          item.id === order.id
            ? {
              ...item,
              ...result.order,
              items: item.items,
              packages: [...item.packages, ...result.packages],
            }
            : item,
        ),
      );
      setNoticeMessage(count > 0 ? `已签收剩余明细并入库 ${count} 件` : "已将采购管理单标记为已签收");
    } catch (error) {
      setErrorMessage(getErrorMessage(error, "签收剩余明细失败"));
    } finally {
      setBusyKey("");
    }
  }

  async function handleReceiveCustomOrder(order: PurchaseOrder) {
    if (!canEdit) {
      setErrorMessage("当前账号没有编辑权限，不能签收入库。");
      return;
    }

    const remainingItems = getRemainingSourceItems(
      order.items,
      getReceivedQuantityByOrderItem(order),
    );

    const itemsToReceive = remainingItems
      .map((item) => ({
        ...item,
        quantity: Math.trunc(Number(receiveQuantities[item.id]) || 0),
      }))
      .filter((item) => item.quantity > 0);

    if (itemsToReceive.length === 0) {
      setErrorMessage("请至少填写一项大于 0 的签收数量。");
      return;
    }

    if (
      itemsToReceive.some(
        (item) =>
          item.quantity >
          (remainingItems.find((r) => r.id === item.id)?.quantity ?? 0),
      )
    ) {
      setErrorMessage("签收数量不能大于未收数量，请检查输入。");
      return;
    }

    const itemsBySourceId = itemsToReceive.reduce<Record<string, PurchaseOrder["items"]>>(
      (groups, item) => {
        if (!item.source_id) return groups;
        groups[item.source_id] ??= [];
        groups[item.source_id].push(item);
        return groups;
      },
      {},
    );

    if (Object.keys(itemsBySourceId).length === 0) {
      setErrorMessage("选择的商品缺少采购来源，无法自动补包裹签收。");
      return;
    }

    setBusyKey(`receive-order-${order.id}`);
    try {
      let index = 1;
      for (const [sourceId, items] of Object.entries(itemsBySourceId)) {
        const pkg = await createPurchasePackage(
          order.id,
          sourceId,
          `签收-${order.order_code}-${Date.now().toString().slice(-4)}-${index++}`,
          items.map((item) => ({ order_item_id: item.id, quantity: item.quantity })),
        );
        await receivePurchasePackage(order, pkg);
      }
      setReceiveConfirmOrder(null);
      const nextOrders = await fetchPurchaseOrders();
      setOrders(nextOrders);
      setNoticeMessage("签收成功");
    } catch (error) {
      setErrorMessage(getErrorMessage(error, "签收失败"));
    } finally {
      setBusyKey("");
    }
  }

  async function handleSavePackageTracking(order: PurchaseOrder, pkg: PurchasePackage) {
    if (!canEdit) {
      setErrorMessage("当前账号没有编辑权限，不能更新快递单号。");
      return;
    }

    const trackingNo = existingPackageTrackingDrafts[pkg.id]?.trim();
    if (!trackingNo) return;
    if (!confirmSave(`确认保存快递单号“${trackingNo}”吗？`)) return;
    setBusyKey(`update-package-${pkg.id}`);
    try {
      const next = await updatePurchasePackageTrackingNo(pkg.id, trackingNo);
      setOrders((current) =>
        current.map((item) =>
          item.id === order.id
            ? {
              ...item,
              packages: item.packages.map((entry) =>
                entry.id === pkg.id ? { ...entry, ...next } : entry,
              ),
            }
            : item,
        ),
      );
    } catch (error) {
      setErrorMessage(getErrorMessage(error, "更新快递单号失败"));
    } finally {
      setBusyKey("");
    }
  }

  async function handleDeletePackage(order: PurchaseOrder, pkg: PurchasePackage) {
    if (!canDelete) {
      setErrorMessage("当前账号没有删除权限。");
      return;
    }

    if (!confirmDelete(`快递单号“${pkg.tracking_no}”`)) return;
    setBusyKey(`delete-package-${pkg.id}`);
    try {
      await deletePurchasePackage(pkg.id);
      setOrders((current) =>
        current.map((item) =>
          item.id === order.id
            ? { ...item, packages: item.packages.filter((entry) => entry.id !== pkg.id) }
            : item,
        ),
      );
    } catch (error) {
      setErrorMessage(getErrorMessage(error, "删除快递包裹失败"));
    } finally {
      setBusyKey("");
    }
  }

  function openTrackingLookup(trackingNo: string) {
    const normalizedTrackingNo = trackingNo.trim();
    if (!normalizedTrackingNo) return;
    window.open(
      `https://t.17track.net/zh-cn#nums=${encodeURIComponent(normalizedTrackingNo)}`,
      "_blank",
      "noopener,noreferrer",
    );
  }

  async function handleDeleteOrder(order: PurchaseOrder) {
    if (!canDelete) {
      setErrorMessage("当前账号没有删除权限。");
      return;
    }

    if (!confirmDelete(`采购管理单“${order.order_code}”`)) return;
    setBusyKey(`delete-order-${order.id}`);
    try {
      await deletePurchaseOrder(order.id);
      setOrders((current) => current.filter((item) => item.id !== order.id));
    } catch (error) {
      setErrorMessage(getErrorMessage(error, "删除采购管理单失败"));
    } finally {
      setBusyKey("");
    }
  }

  return (
    <section className="flex flex-col gap-6 p-4 sm:p-6">
      <PageHeader
        title={view === "create" ? "新增采购管理单" : "采购管理记录"}
        description={view === "create" ? "保存采购管理单，后续在记录页补录物流并签收入库" : "查看采购管理单、补录物流并按包裹签收入库"}
        actions={
          view === "create" ? (
            <Link to="/purchases/records" className="btn-secondary">
              查看采购管理记录
            </Link>
          ) : canEdit ? (
            <Link to="/purchases/new" className="btn-primary">
              <Plus size={18} />
              新增采购管理单
            </Link>
          ) : null
        }
      />
      {errorMessage && <div className="rounded-md border border-rose-200 bg-rose-50 p-3 text-sm text-rose-700">{errorMessage}</div>}
      {noticeMessage && <div className="rounded-md border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-700">{noticeMessage}</div>}
      {draftNotice && <div className="rounded-md border border-sky-200 bg-sky-50 p-3 text-sm text-sky-700">{draftNotice}</div>}

      {view === "create" && <section className="grid gap-4 rounded-lg bg-panel p-5 shadow-soft">
        <div>
          <h2 className="text-base font-semibold text-ink">新增采购管理单</h2>
          <p className="mt-1 text-sm text-slate-500">同一个 1688 订单号保存为一张采购管理单。</p>
        </div>
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          <Field label="仓库">
            <select value={warehouseId} onChange={(event) => setWarehouseId(event.target.value)} className="h-11 rounded-xl border border-line bg-white px-3 text-sm">
              <option value="">选择仓库</option>
              {warehouses.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
            </select>
          </Field>
          <Field label="采购日期"><TextInput type="date" value={purchasedAt} onChange={(event) => setPurchasedAt(event.target.value)} /></Field>
        </div>

        <div className="grid gap-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-sm font-semibold text-ink">采购明细</h3>
            <button type="button" onClick={addDraftProduct} className="btn-secondary h-10 px-3"><Plus size={16} />增加商品</button>
          </div>
          {draftProducts.map((draftProduct, productIndex) => {
            const draftSkuSelections = getDraftSkuSelections(draftProduct);
            const productSkus = skusByProductId[draftProduct.productId] ?? [];

            return (
              <div key={draftProduct.id} className="grid gap-3 rounded-2xl border border-line bg-slate-50/60 p-4">
                <div className="flex flex-wrap items-end gap-2">
                  <div className="min-w-0 flex-1">
                    <Field label={`商品 ${productIndex + 1}`}>
                      <select value={draftProduct.productId} onChange={(event) => updateDraftProduct(draftProduct.id, event.target.value)} className="h-11 w-full rounded-xl border border-line bg-white px-3 text-sm">
                        <option value="">选择商品</option>
                        {products.map((item) => <option key={item.id} value={item.id}>{item.product_code} · {item.product_name_cn}</option>)}
                      </select>
                    </Field>
                  </div>
                  <button type="button" onClick={() => setDraftProducts((current) => current.map((item) => item.id === draftProduct.id ? { ...item, items: [...item.items, createDraftItem()] } : item))} className="btn-secondary h-10 shrink-0 px-3"><Plus size={16} />增加配件</button>
                  <button type="button" disabled={draftProducts.length === 1} onClick={() => setDraftProducts((current) => current.filter((item) => item.id !== draftProduct.id))} className="icon-btn-danger h-10 w-10"><Trash2 size={16} /></button>
                </div>
                {draftProduct.productId && (
                  <div className="grid gap-3 rounded-xl border border-line bg-white p-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="text-sm font-semibold text-slate-700">按 SKU 采购</span>
                      <button
                        type="button"
                        onClick={() => addDraftProductSkuSelection(draftProduct.id)}
                        className="btn-secondary h-9 px-3"
                      >
                        <Plus size={16} />
                        增加 SKU
                      </button>
                    </div>
                    {draftSkuSelections.map((selection, selectionIndex) => (
                      <div
                        key={selection.id}
                        className="grid gap-3 rounded-xl border border-line bg-slate-50/60 p-3 md:grid-cols-[minmax(0,1fr)_160px_44px]"
                      >
                        <Field label={`SKU ${selectionIndex + 1}`}>
                          <select
                            value={selection.skuId}
                            onChange={(event) =>
                              updateDraftProductSku(
                                draftProduct.id,
                                selection.id,
                                event.target.value,
                              )
                            }
                            className="h-11 w-full rounded-xl border border-line bg-white px-3 text-sm"
                          >
                            <option value="">
                              {productSkus.length === 0 ? "该商品暂无 SKU" : "选择 SKU"}
                            </option>
                            {productSkus.map((sku) => (
                              <option key={sku.id} value={sku.id}>
                                {formatSkuLabel(sku)}
                              </option>
                            ))}
                          </select>
                        </Field>
                        <Field label="采购数量">
                          <TextInput
                            type="number"
                            min="1"
                            step="1"
                            disabled={!selection.skuId}
                            value={selection.quantity}
                            onChange={(event) =>
                              updateDraftProductSkuQuantity(
                                draftProduct.id,
                                selection.id,
                                event.target.value,
                              )
                            }
                            onBlur={(event) =>
                              updateDraftProductSkuQuantity(
                                draftProduct.id,
                                selection.id,
                                normalizePositiveIntegerInput(event.target.value),
                              )
                            }
                          />
                        </Field>
                        <div className="flex items-end justify-end">
                          <button
                            type="button"
                            disabled={draftSkuSelections.length === 1}
                            onClick={() =>
                              removeDraftProductSkuSelection(draftProduct.id, selection.id)
                            }
                            className="icon-btn-danger h-11 w-11"
                            aria-label={`删除 SKU ${selectionIndex + 1}`}
                            title="删除 SKU"
                          >
                            <Trash2 size={16} />
                          </button>
                        </div>
                        {selection.skuId &&
                          (skusById[selection.skuId]?.component_links.length ?? 0) === 0 && (
                            <p className="text-sm text-amber-700 md:col-span-3">
                              该 SKU 未维护配件映射。
                            </p>
                          )}
                      </div>
                    ))}
                  </div>
                )}
                {draftProduct.items.map((draftItem, itemIndex) => (
                  <div key={draftItem.id} className="grid gap-3 rounded-xl border border-line bg-white p-3 md:grid-cols-[minmax(0,1fr)_110px_130px_44px]">
                    <Field label={`配件 ${itemIndex + 1}`}>
                      <select value={draftItem.itemId} onChange={(event) => updateDraftItem(draftProduct.id, draftItem.id, "itemId", event.target.value)} className="h-11 w-full rounded-xl border border-line bg-white px-3 text-sm">
                        <option value="">选择配件</option>
                        {items.filter((item) => item.product_id === draftProduct.productId).map((item) => <option key={item.id} value={item.id}>{item.item_name}{item.item_spec ? ` · ${item.item_spec}` : ""}</option>)}
                      </select>
                    </Field>
                    <Field label="采购数量"><TextInput type="number" min="1" step="1" value={draftItem.quantity} onChange={(event) => updateDraftItem(draftProduct.id, draftItem.id, "quantity", event.target.value)} /></Field>
                    <Field label="采购单价"><TextInput type="number" min="0" step="0.01" value={draftItem.unitPriceRmb} onChange={(event) => updateDraftItem(draftProduct.id, draftItem.id, "unitPriceRmb", event.target.value)} /></Field>
                    <div className="flex items-end justify-end"><button type="button" disabled={draftProduct.items.length === 1} onClick={() => setDraftProducts((current) => current.map((item) => item.id === draftProduct.id ? { ...item, items: item.items.filter((entry) => entry.id !== draftItem.id) } : item))} className="icon-btn-danger h-11 w-11"><Trash2 size={16} /></button></div>
                  </div>
                ))}
                {getProductPurchaseUrls(draftProduct).length > 0 && (
                  <div className="grid gap-3 rounded-2xl border border-line bg-white p-4">
                    <h4 className="text-sm font-semibold text-ink">
                      商品 {productIndex + 1} 的 1688 采购链接信息
                    </h4>
                    <div className="grid gap-3">
                      {getProductPurchaseUrls(draftProduct).map((purchaseUrl) => {
                        const groupedItems = getDraftItemsByPurchaseUrl(draftProduct, purchaseUrl);
                        return (
                          <section
                            key={purchaseUrl}
                            className="grid gap-4 rounded-xl border border-line bg-slate-50/60 p-4"
                          >
                            <div className="grid gap-1">
                              <p className="text-sm font-medium text-ink">采购链接</p>
                              <p className="break-all text-sm text-slate-500">{purchaseUrl}</p>
                            </div>

                            <div className="overflow-hidden rounded-xl border border-line bg-white">
                              <table className="data-table">
                                <thead>
                                  <tr>
                                    <th className="px-3 py-2 font-medium">配件名称</th>
                                    <th className="px-3 py-2 font-medium">数量</th>
                                    <th className="px-3 py-2 font-medium">单价</th>
                                    <th className="px-3 py-2 font-medium">金额</th>
                                  </tr>
                                </thead>
                                <tbody>
                                  {groupedItems.map(({ component, draftItem }) => (
                                    <tr key={draftItem.id} className="border-t border-line">
                                      <td className="px-3 py-2">{component.item_name}</td>
                                      <td className="px-3 py-2">{draftItem.quantity}</td>
                                      <td className="px-3 py-2">¥{Number(draftItem.unitPriceRmb || 0).toFixed(2)}</td>
                                      <td className="px-3 py-2">
                                        ¥
                                        {(
                                          Number(draftItem.quantity || 0) *
                                          Number(draftItem.unitPriceRmb || 0)
                                        ).toFixed(2)}
                                      </td>
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                            </div>

                            <div className="grid gap-3 xl:grid-cols-[minmax(0,1fr)_160px_170px]">
                              <Field label="1688 订单号">
                                <TextInput
                                  value={linkMetaDrafts[purchaseUrl]?.alibabaOrderNo ?? ""}
                                  onChange={(event) =>
                                    setLinkMetaDrafts((current) => ({
                                      ...current,
                                      [purchaseUrl]: {
                                        alibabaOrderNo: event.target.value,
                                        freightRmb: current[purchaseUrl]?.freightRmb ?? "0",
                                      },
                                    }))
                                  }
                                />
                              </Field>
                              <Field label="运费">
                                <TextInput
                                  type="number"
                                  min="0"
                                  step="0.01"
                                  value={linkMetaDrafts[purchaseUrl]?.freightRmb ?? "0"}
                                  onChange={(event) =>
                                    setLinkMetaDrafts((current) => ({
                                      ...current,
                                      [purchaseUrl]: {
                                        alibabaOrderNo:
                                          current[purchaseUrl]?.alibabaOrderNo ?? "",
                                        freightRmb: event.target.value,
                                      },
                                    }))
                                  }
                                />
                              </Field>
                              <div className="grid content-end gap-2 text-sm xl:min-w-[170px]">
                                <span className="font-medium text-teal-800">链接总费用</span>
                                <div className="flex h-11 items-center rounded-xl border border-teal-200 bg-teal-50 px-3 text-base font-bold text-teal-900 shadow-sm tabular-nums">
                                  ¥{getDraftPurchaseUrlTotal(draftProduct, purchaseUrl).toFixed(2)}
                                </div>
                              </div>
                            </div>
                          </section>
                        );
                      })}
                    </div>
                  </div>
                )}
              </div>
            );
          })}
          <div className="flex justify-end border-t border-dashed border-line pt-3">
            <button
              type="button"
              onClick={addDraftProduct}
              className="btn-secondary h-10 px-3"
            >
              <Plus size={16} />
              继续增加商品
            </button>
          </div>
        </div>
        <div className="grid gap-4 lg:grid-cols-[1fr_auto_auto]">
          <Field label="备注"><TextArea value={notes} onChange={(event) => setNotes(event.target.value)} /></Field>
          <div className="self-end text-sm text-slate-500">明细金额 ¥{draftItemsTotal.toFixed(2)}</div>
          <div className="self-end text-sm font-semibold text-ink">总费用 ¥{draftTotal.toFixed(2)}</div>
        </div>
        <div className="flex justify-end"><button type="button" disabled={busyKey === "create-order" || !warehouseId || activePurchaseUrls.some((url) => !linkMetaDrafts[url]?.alibabaOrderNo.trim())} onClick={() => void handleCreateOrder()} className="btn-primary"><Plus size={18} />保存采购管理单</button></div>
      </section>}

      {view === "records" && (
        <section className="grid gap-4">
          <section className="grid gap-4 rounded-lg bg-panel p-4 sm:p-5 shadow-soft">
            <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_minmax(280px,380px)] lg:items-end">
              <div>
                <h2 className="text-base font-semibold text-ink">采购管理记录</h2>
                <p className="mt-1 text-sm text-slate-500">
                  共 {filteredOrders.length} 张记录，待签收{" "}
                  {recordStats.pendingOrderCount + recordStats.partiallyReceivedOrderCount} 张
                </p>
              </div>
              <div className="relative w-full">
                <Search size={16} className="absolute left-3 top-3 text-slate-400" />
                <input
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder="搜索采购单 / 1688 订单 / 商品"
                  className="h-10 w-full rounded-xl border border-line bg-white pl-9 pr-3 text-sm outline-none transition focus:border-accent focus:ring-2 focus:ring-accent/20"
                />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-2 xl:grid-cols-4">
              <div className="rounded-lg bg-slate-50 px-3 py-2">
                <div className="text-xs font-semibold text-slate-500">待处理单据</div>
                <div className="mt-1 text-lg font-semibold text-ink">
                  {recordStats.pendingOrderCount + recordStats.partiallyReceivedOrderCount}
                </div>
              </div>
              <div className="rounded-lg bg-slate-50 px-3 py-2">
                <div className="text-xs font-semibold text-slate-500">已签收单据</div>
                <div className="mt-1 text-lg font-semibold text-ink">
                  {recordStats.receivedOrderCount}
                </div>
              </div>
              <div className="rounded-lg bg-slate-50 px-3 py-2">
                <div className="text-xs font-semibold text-slate-500">包裹签收</div>
                <div className="mt-1 text-lg font-semibold text-ink">
                  {recordStats.receivedPackageCount} / {recordStats.packageCount}
                </div>
              </div>
              <div className="rounded-lg bg-slate-50 px-3 py-2">
                <div className="text-xs font-semibold text-slate-500">筛选总费用</div>
                <div className="mt-1 text-lg font-semibold text-ink">
                  ¥{recordStats.totalCostRmb.toFixed(2)}
                </div>
              </div>
            </div>
          </section>

          {loading ? (
            <div className="text-sm text-slate-500">加载中...</div>
          ) : filteredOrders.length === 0 ? (
            <div className="empty-state">暂无采购管理单</div>
          ) : (
            <div className="grid gap-3">
              {filteredOrders.map((order) => {
                const orderFreightTotal = order.sources.reduce(
                  (sum, source) => sum + source.freight_rmb,
                  0,
                );
                const receivedQuantityByOrderItem = getReceivedQuantityByOrderItem(order);
                const totalItemQuantity = order.items.reduce(
                  (sum, item) => sum + item.quantity,
                  0,
                );
                const receivedItemQuantity = order.items.reduce(
                  (sum, item) =>
                    sum + Math.min(item.quantity, receivedQuantityByOrderItem[item.id] ?? 0),
                  0,
                );
                const sourceGroups = Object.values(
                  order.sources.reduce<
                    Record<
                      string,
                      {
                        key: string;
                        orderNo: string;
                        sources: typeof order.sources;
                        urls: string[];
                      }
                    >
                  >((groups, source) => {
                    const orderNo = source.alibaba_order_no.trim();
                    const key = orderNo || `__source_${source.id}`;
                    if (!groups[key]) {
                      groups[key] = { key, orderNo, sources: [], urls: [] };
                    }
                    groups[key].sources.push(source);
                    if (source.purchase_url && !groups[key].urls.includes(source.purchase_url)) {
                      groups[key].urls.push(source.purchase_url);
                    }
                    return groups;
                  }, {}),
                );

                const canQuickReceive =
                  canEdit &&
                  order.status !== "received" &&
                  order.sources.length > 0 &&
                  order.sources.every((s) => s.alibaba_order_no.trim()) &&
                  order.packages.length > 0;

                return (
                  <article
                    key={order.id}
                    className="rounded-xl border border-line bg-white p-3 shadow-sm sm:p-4"
                  >
                    <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_minmax(420px,520px)_auto] lg:items-center">
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <h3 className="text-base font-semibold text-ink">
                            {order.order_code}
                          </h3>
                          <Badge
                            tone={
                              order.status === "received"
                                ? "success"
                                : order.status === "partially_received"
                                  ? "warning"
                                  : "neutral"
                            }
                          >
                            {order.status === "received"
                              ? "已签收"
                              : order.status === "partially_received"
                                ? "部分签收"
                                : "待签收"}
                          </Badge>
                        </div>
                        <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-xs font-medium text-slate-500">
                          <span>{order.warehouse_name}</span>
                          <span>{order.purchased_at}</span>
                          <span>{order.items.length} 条明细</span>
                          <span>
                            包裹 {order.packages.filter((pkg) => pkg.status === "received").length} /{" "}
                            {order.packages.length}
                          </span>
                        </div>
                        {order.items.length > 0 && (
                          <div className="mt-2 flex flex-wrap gap-1">
                            {order.items.slice(0, 4).map((item) => (
                              <span
                                key={item.id}
                                className="rounded bg-slate-100 px-1.5 py-0.5 text-[11px] text-slate-600"
                              >
                                {item.product_name_cn} x {item.quantity}
                              </span>
                            ))}
                            {order.items.length > 4 && (
                              <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[11px] text-slate-500">
                                等 {order.items.length} 种明细...
                              </span>
                            )}
                          </div>
                        )}
                      </div>

                      <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
                        <div className="rounded-lg bg-slate-50 px-3 py-2">
                          <div className="text-[11px] font-semibold text-slate-500">
                            明细金额
                          </div>
                          <div className="mt-0.5 text-sm font-semibold text-ink">
                            ¥{order.items_total_rmb.toFixed(2)}
                          </div>
                        </div>
                        <div className="rounded-lg bg-slate-50 px-3 py-2">
                          <div className="text-[11px] font-semibold text-slate-500">运费</div>
                          <div className="mt-0.5 text-sm font-semibold text-ink">
                            ¥{orderFreightTotal.toFixed(2)}
                          </div>
                        </div>
                        <div className="rounded-lg bg-slate-50 px-3 py-2">
                          <div className="text-[11px] font-semibold text-slate-500">
                            总费用
                          </div>
                          <div className="mt-0.5 text-sm font-semibold text-ink">
                            ¥{order.total_cost_rmb.toFixed(2)}
                          </div>
                        </div>
                        <div className="rounded-lg bg-slate-50 px-3 py-2">
                          <div className="text-[11px] font-semibold text-slate-500">
                            入库数量
                          </div>
                          <div className="mt-0.5 text-sm font-semibold text-ink">
                            {receivedItemQuantity} / {totalItemQuantity}
                          </div>
                        </div>
                      </div>

                      <div className="flex w-full flex-wrap items-center gap-2 lg:w-auto lg:justify-end">
                        {canEdit && order.status === "partially_received" && !canQuickReceive && (
                          <button
                            type="button"
                            disabled={busyKey === `receive-order-${order.id}`}
                            onClick={() => {
                              const remainingItems = getRemainingSourceItems(
                                order.items,
                                getReceivedQuantityByOrderItem(order),
                              );
                              setReceiveQuantities(
                                Object.fromEntries(remainingItems.map(item => [item.id, String(item.quantity)]))
                              );
                              setReceiveConfirmOrder(order);
                            }}
                            className="btn-primary h-10 flex-1 px-3 sm:flex-none"
                          >
                            <CheckCircle2 size={16} />
                            签收剩余
                          </button>
                        )}
                        {canQuickReceive && (
                          <button
                            type="button"
                            onClick={() => {
                              const remainingItems = getRemainingSourceItems(
                                order.items,
                                getReceivedQuantityByOrderItem(order),
                              );
                              setReceiveQuantities(
                                Object.fromEntries(remainingItems.map(item => [item.id, String(item.quantity)]))
                              );
                              setReceiveConfirmOrder(order);
                            }}
                            className="btn-primary h-10 flex-1 bg-emerald-600 hover:bg-emerald-700 ring-emerald-600 px-3 sm:flex-none"
                          >
                            <CheckCircle2 size={16} />
                            签收
                          </button>
                        )}
                        <button
                          type="button"
                          onClick={() =>
                            setExpandedOrderIds((current) => ({
                              ...current,
                              [order.id]: !current[order.id],
                            }))
                          }
                          className="btn-secondary h-10 flex-1 px-3 sm:flex-none"
                        >
                          {expandedOrderIds[order.id] ? "收起" : "查看"}
                        </button>
                        {canDelete && (
                          <button
                            type="button"
                            disabled={busyKey === `delete-order-${order.id}`}
                            onClick={() => void handleDeleteOrder(order)}
                            className="icon-btn-danger h-10 w-10 shrink-0"
                            aria-label="删除采购单"
                          >
                            <Trash2 size={16} />
                          </button>
                        )}
                      </div>
                    </div>
                    {expandedOrderIds[order.id] && (
                      <div className="mt-4 grid gap-4 border-t border-slate-100 pt-4 lg:grid-cols-[minmax(0,0.95fr)_minmax(360px,1.05fr)]">
                        <div className="grid min-w-0 content-start gap-3">
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <h4 className="text-sm font-semibold text-ink">商品明细</h4>
                            <span className="text-xs font-semibold text-slate-500">
                              {order.items.length} 条
                            </span>
                          </div>

                          {order.items.length === 0 ? (
                            <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800">
                              这张采购管理单没有保存到商品明细，属于早期异常记录。
                            </div>
                          ) : (
                            <div className="table-card shadow-none">
                              <div className="overflow-x-auto">
                                <table className="data-table">
                                  <thead>
                                    <tr>
                                      <th>商品</th>
                                      <th>配件</th>
                                      <th>规格</th>
                                      <th className="number-cell">数量</th>
                                      <th className="number-cell">单价</th>
                                    </tr>
                                  </thead>
                                  <tbody>
                                    {order.items.map((item) => (
                                      <tr key={item.id}>
                                        <td>
                                          <div className="font-semibold text-ink">
                                            {item.product_code}
                                          </div>
                                          <div className="mt-0.5 text-xs text-slate-500">
                                            {item.product_name_cn}
                                          </div>
                                        </td>
                                        <td>{item.item_name}</td>
                                        <td>{item.item_spec || "--"}</td>
                                        <td className="number-cell">{item.quantity}</td>
                                        <td className="number-cell">
                                          ¥{item.unit_price_rmb.toFixed(2)}
                                        </td>
                                      </tr>
                                    ))}
                                  </tbody>
                                </table>
                              </div>
                            </div>
                          )}
                        </div>

                        <div className="grid min-w-0 content-start gap-3">
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <h4 className="text-sm font-semibold text-ink">
                              1688 订单与快递包裹
                            </h4>
                            <span className="text-xs font-semibold text-slate-500">
                              {sourceGroups.length} 个订单
                            </span>
                          </div>

                          {sourceGroups.length === 0 ? (
                            <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800">
                              这张采购管理单没有关联 1688 订单。
                            </div>
                          ) : (
                            sourceGroups.map((group) => {
                              const primarySource = group.sources[0];
                              if (!primarySource) return null;
                              const sourceIdSet = new Set(group.sources.map((entry) => entry.id));
                              const sourceUrlSet = new Set(group.urls);
                              const packageKey = `${order.id}:${group.key}`;
                              const sourceItems = order.items.filter((item) =>
                                sourceIdSet.has(item.source_id) ||
                                (!item.source_id && sourceUrlSet.has(item.purchase_url)),
                              );
                              const remainingSourceItems = getRemainingSourceItems(
                                sourceItems,
                                receivedQuantityByOrderItem,
                              );
                              const sourcePackages = order.packages.filter((pkg) =>
                                sourceIdSet.has(pkg.source_id),
                              );
                              const pendingSourcePackages = sourcePackages.filter(
                                (pkg) => pkg.status === "pending",
                              );
                              const receivedSourcePackages = sourcePackages.filter(
                                (pkg) => pkg.status === "received",
                              );
                              const canAddPackage =
                                canEdit &&
                                order.status !== "received" &&
                                remainingSourceItems.length > 0;

                              return (
                                <div
                                  key={group.key}
                                  className="grid gap-3 rounded-xl border border-line bg-slate-50/70 p-3"
                                >
                                  <div className="grid gap-3">
                                    <div className="min-w-0">
                                      <div className="flex flex-wrap items-center gap-2">
                                        <span className="text-sm font-semibold text-ink">
                                          1688 订单号
                                        </span>
                                        {group.orderNo ? (
                                          <a
                                            href={`https://air.1688.com/app/ctf-page/trade-order-detail/index.html?orderId=${group.orderNo}`}
                                            target="_blank"
                                            rel="noopener noreferrer"
                                            className="rounded-md bg-white px-2 py-1 text-sm font-semibold text-blue-600 ring-1 ring-blue-200 hover:bg-blue-50 hover:underline transition-colors"
                                          >
                                            {group.orderNo}
                                          </a>
                                        ) : (
                                          <span className="rounded-md bg-white px-2 py-1 text-sm font-semibold text-accent ring-1 ring-line">
                                            未填写
                                          </span>
                                        )}
                                      </div>
                                      <div className="mt-2 grid gap-1">
                                        {group.urls.map((url) => (
                                          <div
                                            key={url}
                                            className="break-all text-xs text-slate-500"
                                          >
                                            {url}
                                          </div>
                                        ))}
                                      </div>
                                      <div className="mt-2 text-xs text-slate-500">
                                        关联明细：{sourceItems.length} 条
                                      </div>
                                    </div>

                                    <div className="grid min-w-0 gap-2 sm:grid-cols-[minmax(0,1fr)_110px_auto] sm:items-end">
                                      <Field label="1688 订单号">
                                        <TextInput
                                          disabled={!canEdit}
                                          value={
                                            sourceDrafts[primarySource.id]?.alibabaOrderNo ??
                                            primarySource.alibaba_order_no
                                          }
                                          onChange={(event) =>
                                            setSourceDrafts((current) => ({
                                              ...current,
                                              [primarySource.id]: {
                                                alibabaOrderNo: event.target.value,
                                                freightRmb:
                                                  current[primarySource.id]?.freightRmb ??
                                                  String(primarySource.freight_rmb),
                                              },
                                            }))
                                          }
                                        />
                                      </Field>
                                      <Field label="运费">
                                        <TextInput
                                          disabled={!canEdit}
                                          type="number"
                                          min="0"
                                          step="0.01"
                                          value={
                                            sourceDrafts[primarySource.id]?.freightRmb ??
                                            String(primarySource.freight_rmb)
                                          }
                                          onChange={(event) =>
                                            setSourceDrafts((current) => ({
                                              ...current,
                                              [primarySource.id]: {
                                                alibabaOrderNo:
                                                  current[primarySource.id]?.alibabaOrderNo ??
                                                  primarySource.alibaba_order_no,
                                                freightRmb: event.target.value,
                                              },
                                            }))
                                          }
                                        />
                                      </Field>
                                      <button
                                        type="button"
                                        disabled={!canEdit}
                                        onClick={() => void handleSaveSource(order, primarySource.id)}
                                        className="btn-secondary h-10 px-3"
                                      >
                                        保存
                                      </button>
                                    </div>
                                  </div>

                                  <div className="rounded-lg border border-line bg-white p-3">
                                    <div className="mb-2 text-sm font-medium text-slate-700">
                                      该订单包含
                                    </div>
                                    <div className="flex max-h-24 flex-wrap gap-2 overflow-y-auto pr-1">
                                      {sourceItems.map((item) => (
                                        <span
                                          key={item.id}
                                          className="rounded-md bg-slate-100 px-2 py-1 text-xs font-semibold text-slate-700"
                                        >
                                          {item.product_code} · {item.item_name} x {item.quantity}
                                        </span>
                                      ))}
                                    </div>
                                  </div>

                                  {pendingSourcePackages.length > 0 && (
                                    <div className="grid gap-2 rounded-lg border border-line bg-white p-3">
                                      <div className="flex items-center gap-2">
                                        <span className="text-sm font-medium text-slate-700">
                                          已录入快递包裹
                                        </span>
                                        <Badge tone="neutral">待签收</Badge>
                                      </div>
                                      {pendingSourcePackages.map((pkg) => (
                                        <div
                                          key={pkg.id}
                                          className="grid gap-2 rounded-lg border border-slate-100 bg-slate-50/80 p-2"
                                        >
                                          <div className="grid gap-2 xl:grid-cols-[minmax(0,1fr)_auto] xl:items-center">
                                            <TextInput
                                              disabled={!canEdit}
                                              value={
                                                existingPackageTrackingDrafts[pkg.id] ??
                                                pkg.tracking_no
                                              }
                                              onChange={(event) =>
                                                setExistingPackageTrackingDrafts((current) => ({
                                                  ...current,
                                                  [pkg.id]: event.target.value,
                                                }))
                                              }
                                            />
                                            <div className="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap sm:justify-end">
                                              <button
                                                type="button"
                                                onClick={() =>
                                                  openTrackingLookup(
                                                    existingPackageTrackingDrafts[pkg.id] ??
                                                    pkg.tracking_no,
                                                  )
                                                }
                                                className="btn-secondary h-10 px-3"
                                              >
                                                <Search size={16} />
                                                查询
                                              </button>
                                              {canEdit && (
                                                <button
                                                  type="button"
                                                  onClick={() =>
                                                    void handleSavePackageTracking(order, pkg)
                                                  }
                                                  className="btn-secondary h-10 px-3"
                                                >
                                                  保存
                                                </button>
                                              )}
                                              {canDelete && (
                                                <button
                                                  type="button"
                                                  onClick={() => void handleDeletePackage(order, pkg)}
                                                  className="btn-danger h-10 px-3"
                                                  aria-label="删除快递包裹"
                                                >
                                                  <Trash2 size={16} />
                                                  删除
                                                </button>
                                              )}
                                              {canEdit && (
                                                <button
                                                  type="button"
                                                  onClick={() => void handleReceivePackage(order, pkg)}
                                                  className="btn-primary h-10 px-3"
                                                >
                                                  <CheckCircle2 size={16} />
                                                  签收
                                                </button>
                                              )}
                                            </div>
                                          </div>
                                          <div className="break-words text-xs text-slate-500">
                                            {pkg.items
                                              .map((packageItem) => {
                                                const item = order.items.find(
                                                  (entry) => entry.id === packageItem.order_item_id,
                                                );
                                                return item
                                                  ? `${item.product_code} · ${item.item_name} x ${packageItem.quantity}`
                                                  : `未知明细 x ${packageItem.quantity}`;
                                              })
                                              .join("，")}
                                          </div>
                                        </div>
                                      ))}
                                    </div>
                                  )}

                                  {receivedSourcePackages.length > 0 && (
                                    <div className="grid gap-2 rounded-lg border border-line bg-white p-3">
                                      <div className="text-sm font-medium text-slate-700">
                                        已签收快递包裹
                                      </div>
                                      <div className="flex flex-wrap gap-2">
                                        {receivedSourcePackages.map((pkg) => (
                                          <span
                                            key={pkg.id}
                                            className="inline-flex items-center gap-2 rounded-md bg-emerald-50 px-2 py-1 text-xs font-semibold text-emerald-700 ring-1 ring-emerald-100"
                                          >
                                            已签收 {pkg.tracking_no}
                                          </span>
                                        ))}
                                      </div>
                                    </div>
                                  )}

                                  {canAddPackage ? (
                                    <div className="grid gap-3 rounded-lg border border-dashed border-line bg-white p-3">
                                      <div>
                                        <div className="text-sm font-medium text-ink">
                                          添加快递包裹
                                        </div>
                                        <div className="mt-1 max-h-12 overflow-y-auto text-xs text-slate-500">
                                          剩余入包：
                                          {remainingSourceItems
                                            .map(
                                              (item) =>
                                                `${item.product_code} · ${item.item_name} x ${item.quantity}`,
                                            )
                                            .join("，")}
                                        </div>
                                      </div>
                                      <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
                                        <Field label="新增快递单号">
                                          <TextInput
                                            value={packageTrackingDrafts[packageKey] ?? ""}
                                            onChange={(event) =>
                                              setPackageTrackingDrafts((current) => ({
                                                ...current,
                                                [packageKey]: event.target.value,
                                              }))
                                            }
                                            placeholder="填写一个快递单号"
                                          />
                                        </Field>
                                        <button
                                          type="button"
                                          onClick={() =>
                                            void handleAddPackage(
                                              order,
                                              primarySource.id,
                                              packageKey,
                                              remainingSourceItems,
                                            )
                                          }
                                          className="btn-primary h-10 px-3"
                                        >
                                          <Plus size={16} />
                                          保存包裹
                                        </button>
                                      </div>
                                    </div>
                                  ) : sourcePackages.length === 0 ? (
                                    <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
                                      该订单已签收，历史快递单号记录缺失；不能继续新增快递单号。
                                    </div>
                                  ) : null}
                                </div>
                              );
                            })
                          )}
                        </div>
                      </div>
                    )}
                  </article>
                );
              })}
            </div>
          )}
        </section>
      )}
      {receiveConfirmOrder && (() => {
        const remainingItems = getRemainingSourceItems(
          receiveConfirmOrder.items,
          getReceivedQuantityByOrderItem(receiveConfirmOrder),
        );
        return (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4 backdrop-blur-sm">
            <div className="grid w-full max-w-4xl max-h-[90vh] grid-rows-[auto_minmax(0,1fr)_auto] gap-4 rounded-2xl bg-white p-6 shadow-xl">
              <div>
                <h2 className="text-xl font-bold text-ink">确认签收入库</h2>
                <p className="mt-1 text-sm text-slate-500">
                  采购单 {receiveConfirmOrder.order_code} 的剩余未签收明细如下，请核对并填写本次实到的数量（如果缺货请改为 0）：
                </p>
              </div>

              <div className="overflow-y-auto rounded-xl border border-line bg-white">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>商品</th>
                      <th>配件</th>
                      <th>规格</th>
                      <th className="number-cell">未收数量</th>
                      <th className="number-cell w-32">本次签收</th>
                    </tr>
                  </thead>
                  <tbody>
                    {remainingItems.map((item) => (
                      <tr key={item.id}>
                        <td>
                          <div className="font-semibold text-ink">{item.product_code}</div>
                          <div className="mt-0.5 text-xs text-slate-500">{item.product_name_cn}</div>
                        </td>
                        <td>{item.item_name}</td>
                        <td>{item.item_spec || "--"}</td>
                        <td className="number-cell font-bold text-slate-500">{item.quantity}</td>
                        <td className="p-2 align-middle text-right">
                          <TextInput
                            type="number"
                            min="0"
                            max={item.quantity}
                            value={receiveQuantities[item.id] ?? ""}
                            onChange={(e) => {
                              const val = e.target.value;
                              setReceiveQuantities(prev => ({ ...prev, [item.id]: val }));
                            }}
                            className="text-right h-9 w-24 ml-auto"
                          />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <div className="flex items-center justify-end gap-3 pt-2">
                <button
                  type="button"
                  onClick={() => setReceiveConfirmOrder(null)}
                  className="btn-secondary h-11 px-6"
                >
                  取消
                </button>
                <button
                  type="button"
                  disabled={busyKey === `receive-order-${receiveConfirmOrder.id}`}
                  onClick={() => void handleReceiveCustomOrder(receiveConfirmOrder)}
                  className="btn-primary h-11 px-6 bg-emerald-600 hover:bg-emerald-700"
                >
                  <CheckCircle2 size={18} />
                  {busyKey === `receive-order-${receiveConfirmOrder.id}` ? "处理中..." : "确认无误，提交签收"}
                </button>
              </div>
            </div>
          </div>
        );
      })()}
    </section>
  );
}
