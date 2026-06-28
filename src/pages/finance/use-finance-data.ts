import { useState, useEffect } from "react";
import { fetchTemuOrders } from "../../lib/orders";
import { fetchPurchaseOrders } from "../../lib/purchases";
import { fetchProducts, fetchProductItemsByProductIds, fetchProductSkusByProductIds } from "../../lib/products";
import { fetchWarehouses, fetchWarehouseSkus } from "../../lib/inventory";
import { fetchSettings } from "../../lib/settings";
import { fetchExpenses } from "../../lib/expenses";
import { useAutoDismiss } from "../../hooks/use-auto-dismiss";
import { getErrorMessage } from "../../utils/errors";
import type {
  FinanceExpense,
  PricingSettings,
  Product,
  ProductItem,
  ProductSku,
  Warehouse,
  WarehouseSku,
} from "../../types";
import type { SettlementFile } from "../../lib/settlement";
import type { FinanceData } from "./shared";

type FetchOptions = {
  orders?: boolean;
  purchases?: boolean;
  products?: boolean;
  inventory?: boolean;
  expenses?: boolean;
  settlements?: boolean;
};

export function useFinanceData(userId: string, options: FetchOptions) {
  const [data, setData] = useState<FinanceData>({
    orders: [],
    purchases: [],
    products: [],
    productItems: [],
    productSkus: [],
    warehouses: [],
    warehouseSkus: [],
  });
  const [expenses, setExpenses] = useState<FinanceExpense[]>([]);
  const [settlementFiles, setSettlementFiles] = useState<SettlementFile[]>([]);
  const [settings, setSettings] = useState<PricingSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  useAutoDismiss(error, () => setError(""));

  const load = async () => {
    setLoading(true);
    setError("");
    try {
      const promises: Promise<unknown>[] = [];
      const keys: string[] = [];

      if (options.orders || options.products || options.inventory) {
         promises.push(fetchSettings(userId).catch(() => null));
         keys.push("settings");
      }

      if (options.orders) {
        promises.push(fetchTemuOrders());
        keys.push("orders");
      }

      if (options.purchases) {
        promises.push(fetchPurchaseOrders());
        keys.push("purchases");
      }

      if (options.products || options.orders) {
        promises.push(fetchProducts({ includeNotSelling: true }));
        keys.push("products");
      }

      if (options.inventory) {
        promises.push(fetchWarehouses());
        keys.push("warehouses");
      }

      if (options.expenses) {
        promises.push(fetchExpenses());
        keys.push("expenses");
      }

      if (options.settlements) {
        // dynamically import to avoid circular dependencies or bloating non-settlement pages
        const { loadSettlementFiles } = await import("../../lib/settlement");
        promises.push(loadSettlementFiles(userId));
        keys.push("settlements");
      }

      const results = await Promise.all(promises);
      const resultMap = Object.fromEntries(keys.map((k, i) => [k, results[i]]));

      let productItems: ProductItem[] = [];
      let productSkus: ProductSku[] = [];
      let warehouseSkus: WarehouseSku[] = [];
      const products = (resultMap.products as Product[] | undefined) ?? [];
      const warehouses = (resultMap.warehouses as Warehouse[] | undefined) ?? [];

      if (products.length > 0) {
        const productIds = products.map((p) => p.id);
        const [items, skus] = await Promise.all([
          fetchProductItemsByProductIds(productIds),
          fetchProductSkusByProductIds(productIds),
        ]);
        productItems = items;
        productSkus = skus;
      }

      if (warehouses.length > 0) {
         warehouseSkus = await fetchWarehouseSkus(warehouses.map((w) => w.id));
      }

      setData({
        orders: (resultMap.orders as FinanceData["orders"] | undefined) ?? [],
        purchases: (resultMap.purchases as FinanceData["purchases"] | undefined) ?? [],
        products,
        productItems,
        productSkus,
        warehouses,
        warehouseSkus,
      });

      if (resultMap.expenses) {
         setExpenses(resultMap.expenses as FinanceExpense[]);
      }
      if (resultMap.settlements) {
         setSettlementFiles(resultMap.settlements as SettlementFile[]);
      }
      if (resultMap.settings !== undefined) {
         setSettings(resultMap.settings as PricingSettings | null);
      }

    } catch (err) {
      setError(getErrorMessage(err, "加载数据失败"));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (userId) {
      void load();
    }
  }, [userId]);

  return { data, expenses, settlementFiles, settings, loading, error, reload: load };
}
