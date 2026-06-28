import { useState, useEffect } from "react";
import { fetchTemuOrders } from "../../lib/orders";
import { fetchPurchaseOrders } from "../../lib/purchases";
import { fetchProducts, fetchProductItemsByProductIds, fetchProductSkusByProductIds } from "../../lib/products";
import { fetchWarehouses, fetchWarehouseSkus } from "../../lib/inventory";
import { fetchLogisticsMethods, fetchWarehouseLogisticsMethods } from "../../lib/logistics-methods";
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
  LogisticsMethod,
  WarehouseLogisticsMethod,
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
  logistics?: boolean;
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
    logisticsMethods: [],
    warehouseLogisticsMethods: [],
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
      let optionalError = "";

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

      if (options.inventory || options.logistics) {
        promises.push(fetchWarehouses());
        keys.push("warehouses");
      }

      if (options.logistics) {
        promises.push(fetchLogisticsMethods());
        keys.push("logisticsMethods");
      }

      if (options.expenses) {
        promises.push(fetchExpenses());
        keys.push("expenses");
      }

      if (options.settlements) {
        // dynamically import to avoid circular dependencies or bloating non-settlement pages
        const { loadSettlementFiles } = await import("../../lib/settlement");
        promises.push(
          loadSettlementFiles(userId).catch((err) => {
            optionalError = getErrorMessage(err, "加载结算文件失败");
            return [] as SettlementFile[];
          }),
        );
        keys.push("settlements");
      }

      const results = await Promise.all(promises);
      const resultMap = Object.fromEntries(keys.map((k, i) => [k, results[i]]));

      let productItems: ProductItem[] = [];
      let productSkus: ProductSku[] = [];
      let warehouseSkus: WarehouseSku[] = [];
      let warehouseLogisticsMethods: WarehouseLogisticsMethod[] = [];
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
        const warehouseIds = warehouses.map((w) => w.id);
        if (options.inventory) {
          warehouseSkus = await fetchWarehouseSkus(warehouseIds);
        }
        if (options.logistics) {
          warehouseLogisticsMethods = await fetchWarehouseLogisticsMethods(warehouseIds);
        }
      }

      setData({
        orders: (resultMap.orders as FinanceData["orders"] | undefined) ?? [],
        purchases: (resultMap.purchases as FinanceData["purchases"] | undefined) ?? [],
        products,
        productItems,
        productSkus,
        warehouses,
        warehouseSkus,
        logisticsMethods: (resultMap.logisticsMethods as LogisticsMethod[] | undefined) ?? [],
        warehouseLogisticsMethods,
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
      if (optionalError) {
        setError(optionalError);
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
