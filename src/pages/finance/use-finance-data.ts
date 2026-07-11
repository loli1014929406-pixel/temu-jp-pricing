import { useCallback, useEffect, useState } from "react";
import { fetchTemuOrders } from "../../lib/orders";
import { fetchPurchaseOrders } from "../../lib/purchases";
import { fetchProducts, fetchProductItemsByProductIds, fetchProductSkusByProductIds } from "../../lib/products";
import { fetchWarehouses, fetchWarehouseSkus } from "../../lib/inventory";
import { fetchLogisticsMethods, fetchWarehouseLogisticsMethods } from "../../lib/logistics-methods";
import { fetchSettings } from "../../lib/settings";
import { fetchExpenses } from "../../lib/expenses";
import { useAutoDismiss } from "../../hooks/use-auto-dismiss";
import { getErrorMessage } from "../../utils/errors";
import { getCachedAsync } from "../../lib/async-cache";
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
  const ordersEnabled = Boolean(options.orders);
  const purchasesEnabled = Boolean(options.purchases);
  const productsEnabled = Boolean(options.products);
  const inventoryEnabled = Boolean(options.inventory);
  const expensesEnabled = Boolean(options.expenses);
  const settlementsEnabled = Boolean(options.settlements);
  const logisticsEnabled = Boolean(options.logistics);
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

  const load = useCallback(async (force = false) => {
    setLoading(true);
    setError("");
    try {
      const promises: Promise<unknown>[] = [];
      const keys: string[] = [];
      let optionalError = "";

       if (ordersEnabled || productsEnabled || inventoryEnabled) {
          promises.push(
            getCachedAsync(
              `finance:${userId}:settings`,
              () => fetchSettings(userId),
              { force },
            ).catch(() => null),
          );
          keys.push("settings");
       }

       if (ordersEnabled) {
         promises.push(
           getCachedAsync(`finance:${userId}:orders`, fetchTemuOrders, { force }),
         );
         keys.push("orders");
       }

       if (purchasesEnabled) {
         promises.push(
           getCachedAsync(`finance:${userId}:purchases`, fetchPurchaseOrders, { force }),
         );
         keys.push("purchases");
       }

       if (productsEnabled) {
         promises.push(
           getCachedAsync(
             `finance:${userId}:products`,
             () => fetchProducts({ includeNotSelling: true }),
             { force },
           ),
         );
         keys.push("products");
       }

       if (inventoryEnabled || logisticsEnabled) {
         promises.push(
           getCachedAsync(`finance:${userId}:warehouses`, fetchWarehouses, { force }),
         );
         keys.push("warehouses");
       }

       if (logisticsEnabled) {
         promises.push(
           getCachedAsync(
             `finance:${userId}:logistics-methods`,
             fetchLogisticsMethods,
             { force },
           ),
         );
         keys.push("logisticsMethods");
       }

       if (expensesEnabled) {
         promises.push(
           getCachedAsync(`finance:${userId}:expenses`, fetchExpenses, { force }),
         );
         keys.push("expenses");
       }

       if (settlementsEnabled) {
         promises.push(
           getCachedAsync(
             `finance:${userId}:settlements`,
             async () => {
               const { loadSettlementFiles } = await import("../../lib/settlement");
               return loadSettlementFiles(userId);
             },
             { force },
           ).catch((err) => {
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
         const productDetailKey = productIds.slice().sort().join(",");
         const [items, skus] = await getCachedAsync(
           `finance:${userId}:product-details:${productDetailKey}`,
           () => Promise.all([
             fetchProductItemsByProductIds(productIds),
             fetchProductSkusByProductIds(productIds),
           ]),
           { force },
         );
         productItems = items;
        productSkus = skus;
      }

      if (warehouses.length > 0) {
        const warehouseIds = warehouses.map((w) => w.id);
         if (inventoryEnabled) {
           warehouseSkus = await getCachedAsync(
             `finance:${userId}:warehouse-skus:${warehouseIds.slice().sort().join(",")}`,
             () => fetchWarehouseSkus(warehouseIds),
             { force },
           );
         }
         if (logisticsEnabled) {
           warehouseLogisticsMethods = await getCachedAsync(
             `finance:${userId}:warehouse-logistics:${warehouseIds.slice().sort().join(",")}`,
             () => fetchWarehouseLogisticsMethods(warehouseIds),
             { force },
           );
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
  }, [
    expensesEnabled,
    inventoryEnabled,
    logisticsEnabled,
    ordersEnabled,
    productsEnabled,
    purchasesEnabled,
    settlementsEnabled,
    userId,
  ]);

  useEffect(() => {
    if (userId) {
      void load(false);
    }
  }, [load, userId]);

  return {
    data,
    expenses,
    settlementFiles,
    settings,
    loading,
    error,
    reload: () => load(true),
  };
}
