import { useState, useEffect } from "react";
import { fetchTemuOrders } from "../../lib/orders";
import { fetchPurchaseOrders } from "../../lib/purchases";
import { fetchProducts, fetchProductItemsByProductIds, fetchProductSkusByProductIds } from "../../lib/products";
import { fetchWarehouses, fetchWarehouseSkus } from "../../lib/inventory";
import { fetchSettings } from "../../lib/settings";
import { fetchExpenses } from "../../lib/expenses";
import { getErrorMessage } from "../../utils/errors";
import type { FinanceExpense } from "../../types";
import type { FinanceData } from "./shared";

type FetchOptions = {
  orders?: boolean;
  purchases?: boolean;
  products?: boolean;
  inventory?: boolean;
  expenses?: boolean;
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
  const [settings, setSettings] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = async () => {
    setLoading(true);
    setError("");
    try {
      const promises: any[] = [];
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

      const results = await Promise.all(promises);
      const resultMap = Object.fromEntries(keys.map((k, i) => [k, results[i]]));

      let productItems: any[] = [];
      let productSkus: any[] = [];
      let warehouseSkus: any[] = [];

      if (resultMap.products) {
        const productIds = resultMap.products.map((p: any) => p.id);
        const [items, skus] = await Promise.all([
          fetchProductItemsByProductIds(productIds),
          fetchProductSkusByProductIds(productIds),
        ]);
        productItems = items;
        productSkus = skus;
      }

      if (resultMap.warehouses) {
         warehouseSkus = await fetchWarehouseSkus(resultMap.warehouses.map((w: any) => w.id));
      }

      setData({
        orders: resultMap.orders || [],
        purchases: resultMap.purchases || [],
        products: resultMap.products || [],
        productItems,
        productSkus,
        warehouses: resultMap.warehouses || [],
        warehouseSkus,
      });

      if (resultMap.expenses) {
         setExpenses(resultMap.expenses);
      }
      if (resultMap.settings !== undefined) {
         setSettings(resultMap.settings);
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

  return { data, expenses, settings, loading, error, reload: load };
}
