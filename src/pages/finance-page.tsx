import type { User } from "@supabase/supabase-js";
import { Download, RefreshCw } from "lucide-react";
import { NavLink } from "react-router-dom";
import { useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { Badge, PageHeader, StatCard } from "../components/ui";
import { addObjectSheet, createWorkbook, downloadWorkbook } from "../lib/excel";
import { fetchTemuOrders } from "../lib/orders";
import {
  fetchProducts,
  fetchProductItemsByProductIds,
  fetchProductSkusByProductIds,
} from "../lib/products";
import { fetchPurchaseOrders } from "../lib/purchases";
import type {
  Product,
  ProductItem,
  ProductSku,
  PurchaseOrder,
  TemuOrderRecord,
} from "../types";
import { getErrorMessage } from "../utils/errors";
import { calculatePurchaseShippingRmb } from "../utils/shipping-costs";
import { buildDefaultSkuCode, isLegacyDefaultSkuCode } from "../utils/sku-code";
import { formatCurrency } from "../utils/pricing";

const financeViews = [
  { key: "overview", label: "财务总览", path: "/finance" },
  { key: "cashflow", label: "收支流水", path: "/finance/cashflow" },
  { key: "orders", label: "订单收入", path: "/finance/orders" },
  { key: "purchases", label: "采购付款", path: "/finance/purchases" },
  { key: "expenses", label: "费用管理", path: "/finance/expenses" },
  { key: "monthly-profit", label: "月度利润表", path: "/finance/monthly-profit" },
  { key: "product-profit", label: "商品利润报表", path: "/finance/product-profit" },
  { key: "reconciliation", label: "对账中心", path: "/finance/reconciliation" },
] as const;

export type FinanceView = typeof financeViews[number]["key"];

type FinancePageProps = {
  user: User;
  view: FinanceView;
};

type FinanceData = {
  orders: TemuOrderRecord[];
  purchases: PurchaseOrder[];
  products: Product[];
  productItems: ProductItem[];
  productSkus: ProductSku[];
};

type FinanceOrderRow = {
  order: TemuOrderRecord;
  sku: ProductSku | null;
  product: Product | null;
  quantity: number;
  productCostRmb: number;
  shippingFeeRmb: number;
  billAmountRmb: number;
  matched: boolean;
  matchLabel: string;
};

type LedgerRow = {
  date: string;
  type: string;
  direction: "收入" | "支出";
  subject: string;
  amountRmb: number;
  remark: string;
};

const emptyData: FinanceData = {
  orders: [],
  purchases: [],
  products: [],
  productItems: [],
  productSkus: [],
};

function normalizeSkuCode(value: string) {
  return value.trim().toLowerCase();
}

function normalizeSalesSpec(value: string) {
  return value.replace(/\s+/g, "").toLowerCase();
}

function formatSkuSalesSpec(sku: ProductSku) {
  const entries = Object.entries(sku.attributes)
    .map(([name, value]) => [name.trim(), String(value).trim()] as const)
    .filter(([name, value]) => name && value);

  return entries.length > 0
    ? entries.map(([name, value]) => `${name}：${value}`).join(" / ")
    : "无规格";
}

function buildSkuLookup(products: Product[], skus: ProductSku[]) {
  const productsById = Object.fromEntries(products.map((product) => [product.id, product]));
  const skusByProductId = skus.reduce<Record<string, ProductSku[]>>((groups, sku) => {
    if (!sku.product_id) return groups;
    groups[sku.product_id] ??= [];
    groups[sku.product_id].push(sku);
    return groups;
  }, {});

  const skuByCode = new Map<string, ProductSku>();
  const skuBySalesSpec = new Map<string, ProductSku>();

  Object.entries(skusByProductId).forEach(([productId, productSkus]) => {
    const product = productsById[productId];
    productSkus.forEach((sku, index) => {
      const salesSpecKey = normalizeSalesSpec(formatSkuSalesSpec(sku));
      if (salesSpecKey && !skuBySalesSpec.has(salesSpecKey)) {
        skuBySalesSpec.set(salesSpecKey, sku);
      }

      [sku.sku_code, product && isLegacyDefaultSkuCode(sku.sku_code)
        ? buildDefaultSkuCode(product.product_code, index)
        : ""].forEach((skuCode) => {
        const key = normalizeSkuCode(skuCode);
        if (key) skuByCode.set(key, sku);
      });
    });
  });

  return { skuByCode, skuBySalesSpec };
}

function getOrderSku(order: TemuOrderRecord, lookup: ReturnType<typeof buildSkuLookup>) {
  return (
    lookup.skuByCode.get(normalizeSkuCode(order.sku_code)) ??
    lookup.skuBySalesSpec.get(normalizeSalesSpec(order.product_attributes)) ??
    null
  );
}

function getOrderQuantity(order: TemuOrderRecord) {
  return Math.max(0, Number(order.fulfillment_quantity || 0));
}

function getSkuUnitCostRmb(sku: ProductSku, productItemsById: Map<string, ProductItem>) {
  return sku.component_links.reduce((total, link) => {
    const item = productItemsById.get(link.item_id);
    if (!item) return total;
    const quantity = Math.max(0, Number(link.quantity || 0));
    return (
      total +
      item.purchase_price_rmb * quantity +
      calculatePurchaseShippingRmb(item, quantity)
    );
  }, 0);
}

function roundMoney(value: number) {
  if (!Number.isFinite(value)) return 0;
  return Number(value.toFixed(2));
}

function getOrderDate(order: TemuOrderRecord) {
  return (
    order.actual_ship_time ||
    order.label_printed_at ||
    order.latest_ship_time ||
    order.created_at ||
    ""
  );
}

function formatDate(value: string) {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value || "--";
  return parsed.toISOString().slice(0, 10);
}

function getMonthKey(value: string) {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return "未定";
  return parsed.toISOString().slice(0, 7);
}

function getOrderSearchText(row: FinanceOrderRow) {
  return [
    row.order.order_no,
    row.order.sub_order_no,
    row.order.sku_code,
    row.order.product_attributes,
    row.order.recipient_name,
    row.order.logistics_tracking_no,
    row.product?.product_code ?? "",
    row.product?.product_name_cn ?? "",
  ].join(" ").toLowerCase();
}

function getCurrentView(view: FinanceView) {
  return financeViews.find((item) => item.key === view) ?? financeViews[0];
}

function getPurchaseTotalRmb(purchase: PurchaseOrder) {
  return Number(purchase.total_cost_rmb || 0);
}

function EmptyPanel({ label }: { label: string }) {
  return (
    <div className="rounded-lg border border-dashed border-slate-200 bg-slate-50/70 p-8 text-center text-sm font-medium text-slate-500">
      {label}
    </div>
  );
}

function FinanceTabs({ activeView }: { activeView: FinanceView }) {
  return (
    <div className="flex flex-wrap gap-2">
      {financeViews.map((item) => (
        <NavLink
          key={item.key}
          to={item.path}
          className={({ isActive }) =>
            `rounded-lg border px-3 py-2 text-sm font-semibold transition ${
              isActive || activeView === item.key
                ? "border-violet-200 bg-violet-50 text-violet-700"
                : "border-slate-200 bg-white text-slate-600 hover:border-slate-300 hover:text-slate-900"
            }`
          }
          end={item.key === "overview"}
        >
          {item.label}
        </NavLink>
      ))}
    </div>
  );
}

function FinanceTable({
  children,
  minWidth = "min-w-[1100px]",
}: {
  children: ReactNode;
  minWidth?: string;
}) {
  return (
    <div className="table-card shadow-none">
      <div className="overflow-x-auto">
        <table className={`data-table ${minWidth}`}>{children}</table>
      </div>
    </div>
  );
}

export function FinancePage({ user, view }: FinancePageProps) {
  const [data, setData] = useState<FinanceData>(emptyData);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [errorMessage, setErrorMessage] = useState("");
  const [search, setSearch] = useState("");

  const currentView = getCurrentView(view);

  async function loadFinanceData() {
    setLoading(true);
    setErrorMessage("");
    try {
      const [orders, purchases, products] = await Promise.all([
        fetchTemuOrders(),
        fetchPurchaseOrders(),
        fetchProducts({ includeNotSelling: true }),
      ]);
      const productIds = products.map((product) => product.id);
      const [productItems, productSkus] = await Promise.all([
        fetchProductItemsByProductIds(productIds),
        fetchProductSkusByProductIds(productIds),
      ]);
      setData({ orders, purchases, products, productItems, productSkus });
    } catch (error) {
      setErrorMessage(getErrorMessage(error, "加载财务数据失败"));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void user.id;
    void loadFinanceData();
  }, [user.id]);

  const productItemsById = useMemo(
    () =>
      new Map(
        data.productItems.flatMap((item) => (item.id ? [[item.id, item] as const] : [])),
      ),
    [data.productItems],
  );

  const productsById = useMemo(
    () => new Map(data.products.map((product) => [product.id, product])),
    [data.products],
  );

  const skuLookup = useMemo(
    () => buildSkuLookup(data.products, data.productSkus),
    [data.products, data.productSkus],
  );

  const orderRows = useMemo<FinanceOrderRow[]>(
    () =>
      data.orders.map((order) => {
        const sku = getOrderSku(order, skuLookup);
        const product = sku?.product_id ? productsById.get(sku.product_id) ?? null : null;
        const quantity = getOrderQuantity(order);
        const unitCost = sku ? getSkuUnitCostRmb(sku, productItemsById) : 0;
        const productCostRmb = roundMoney(unitCost * quantity);
        const shippingFeeRmb = roundMoney(Number(order.actual_shipping_fee_rmb || 0));
        return {
          order,
          sku,
          product,
          quantity,
          productCostRmb,
          shippingFeeRmb,
          billAmountRmb: roundMoney(productCostRmb + shippingFeeRmb),
          matched: Boolean(sku && product),
          matchLabel: sku && product ? "已匹配" : "待匹配",
        };
      }),
    [data.orders, productItemsById, productsById, skuLookup],
  );

  const filteredOrderRows = useMemo(() => {
    const keyword = search.trim().toLowerCase();
    if (!keyword) return orderRows;
    return orderRows.filter((row) => getOrderSearchText(row).includes(keyword));
  }, [orderRows, search]);

  const ledgerRows = useMemo<LedgerRow[]>(() => {
    const orderLedgerRows = orderRows
      .filter((row) => row.billAmountRmb > 0)
      .map((row) => ({
        date: formatDate(getOrderDate(row.order)),
        type: "订单账单",
        direction: "收入" as const,
        subject: row.order.order_no,
        amountRmb: row.billAmountRmb,
        remark: `商品成本 ${formatCurrency(row.productCostRmb)} / 运费 ${formatCurrency(row.shippingFeeRmb)}`,
      }));

    const purchaseLedgerRows = data.purchases.map((purchase) => ({
      date: formatDate(purchase.purchased_at),
      type: "采购付款",
      direction: "支出" as const,
      subject: purchase.order_code,
      amountRmb: -getPurchaseTotalRmb(purchase),
      remark: purchase.warehouse_name,
    }));

    return [...orderLedgerRows, ...purchaseLedgerRows].sort((left, right) =>
      right.date.localeCompare(left.date),
    );
  }, [data.purchases, orderRows]);

  const totals = useMemo(() => {
    const orderBillAmount = orderRows.reduce((sum, row) => sum + row.billAmountRmb, 0);
    const orderShippingFee = orderRows.reduce((sum, row) => sum + row.shippingFeeRmb, 0);
    const orderProductCost = orderRows.reduce((sum, row) => sum + row.productCostRmb, 0);
    const purchasePayment = data.purchases.reduce(
      (sum, purchase) => sum + getPurchaseTotalRmb(purchase),
      0,
    );
    const missingShippingFeeCount = orderRows.filter(
      (row) => row.shippingFeeRmb <= 0 && (row.order.label_printed_at || row.order.actual_ship_time),
    ).length;
    const unmatchedCount = orderRows.filter((row) => !row.matched).length;
    return {
      orderBillAmount: roundMoney(orderBillAmount),
      orderShippingFee: roundMoney(orderShippingFee),
      orderProductCost: roundMoney(orderProductCost),
      purchasePayment: roundMoney(purchasePayment),
      missingShippingFeeCount,
      unmatchedCount,
    };
  }, [data.purchases, orderRows]);

  const monthlyRows = useMemo(() => {
    const groups = new Map<
      string,
      { month: string; income: number; purchase: number; productCost: number; shipping: number }
    >();
    orderRows.forEach((row) => {
      const month = getMonthKey(getOrderDate(row.order));
      const group = groups.get(month) ?? {
        month,
        income: 0,
        purchase: 0,
        productCost: 0,
        shipping: 0,
      };
      group.income += row.billAmountRmb;
      group.productCost += row.productCostRmb;
      group.shipping += row.shippingFeeRmb;
      groups.set(month, group);
    });
    data.purchases.forEach((purchase) => {
      const month = getMonthKey(purchase.purchased_at);
      const group = groups.get(month) ?? {
        month,
        income: 0,
        purchase: 0,
        productCost: 0,
        shipping: 0,
      };
      group.purchase += getPurchaseTotalRmb(purchase);
      groups.set(month, group);
    });
    return Array.from(groups.values())
      .map((row) => ({
        ...row,
        income: roundMoney(row.income),
        purchase: roundMoney(row.purchase),
        productCost: roundMoney(row.productCost),
        shipping: roundMoney(row.shipping),
        balance: roundMoney(row.income - row.purchase),
      }))
      .sort((left, right) => right.month.localeCompare(left.month));
  }, [data.purchases, orderRows]);

  const productRows = useMemo(() => {
    const groups = new Map<
      string,
      {
        productCode: string;
        productName: string;
        quantity: number;
        orderCount: number;
        productCost: number;
        shipping: number;
        billAmount: number;
      }
    >();
    orderRows.forEach((row) => {
      const key = row.product?.id ?? `unmatched:${row.order.sku_code}:${row.order.product_attributes}`;
      const group = groups.get(key) ?? {
        productCode: row.product?.product_code ?? "--",
        productName: row.product?.product_name_cn ?? "未匹配商品",
        quantity: 0,
        orderCount: 0,
        productCost: 0,
        shipping: 0,
        billAmount: 0,
      };
      group.quantity += row.quantity;
      group.orderCount += 1;
      group.productCost += row.productCostRmb;
      group.shipping += row.shippingFeeRmb;
      group.billAmount += row.billAmountRmb;
      groups.set(key, group);
    });
    return Array.from(groups.values())
      .map((row) => ({
        ...row,
        productCost: roundMoney(row.productCost),
        shipping: roundMoney(row.shipping),
        billAmount: roundMoney(row.billAmount),
      }))
      .sort((left, right) => right.billAmount - left.billAmount);
  }, [orderRows]);

  async function handleRefresh() {
    setBusy(true);
    await loadFinanceData();
    setBusy(false);
  }

  async function handleExportOrderBill() {
    const workbook = await createWorkbook();
    addObjectSheet(
      workbook,
      "订单账单",
      filteredOrderRows.map((row) => ({
        订单号: row.order.order_no,
        子订单号: row.order.sub_order_no,
        日期: formatDate(getOrderDate(row.order)),
        订单状态: row.order.order_status,
        SKU货号: row.order.sku_code,
        商品: row.product?.product_name_cn ?? "",
        销售规格: row.order.product_attributes,
        数量: row.quantity,
        商品成本: row.productCostRmb,
        实际运费: row.shippingFeeRmb,
        账单金额: row.billAmountRmb,
        仓库: row.order.warehouse_name,
        发货方式: row.order.logistics_method,
        物流单号: row.order.logistics_tracking_no,
        收件人: row.order.recipient_name,
        电话: row.order.recipient_phone,
        地址: [
          row.order.province,
          row.order.city,
          row.order.district,
          row.order.address_line1,
          row.order.address_line2,
        ].filter(Boolean).join(" "),
      })),
    );
    await downloadWorkbook(workbook, `订单账单-${new Date().toISOString().slice(0, 10)}.xlsx`);
  }

  function renderOverview() {
    return (
      <>
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          <StatCard label="订单账单金额" value={formatCurrency(totals.orderBillAmount)} />
          <StatCard label="实际运费" value={formatCurrency(totals.orderShippingFee)} />
          <StatCard label="商品成本" value={formatCurrency(totals.orderProductCost)} />
          <StatCard label="采购付款" value={formatCurrency(totals.purchasePayment)} />
        </div>
        <section className="surface-card grid gap-4 p-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className="text-base font-semibold text-slate-900">待处理对账</h2>
            <div className="flex flex-wrap gap-2">
              <Badge tone={totals.missingShippingFeeCount > 0 ? "warning" : "success"}>
                缺运费 {totals.missingShippingFeeCount}
              </Badge>
              <Badge tone={totals.unmatchedCount > 0 ? "warning" : "success"}>
                未匹配 {totals.unmatchedCount}
              </Badge>
            </div>
          </div>
          {renderReconciliationTable(orderRows.filter((row) => !row.matched || row.shippingFeeRmb <= 0).slice(0, 10))}
        </section>
      </>
    );
  }

  function renderOrderIncome() {
    return (
      <section className="surface-card grid gap-4 p-4">
        <div className="grid gap-3 xl:grid-cols-[minmax(0,1fr)_auto] xl:items-center">
          <div className="flex flex-wrap items-center gap-2">
            <input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="搜索订单号 / SKU / 收件人 / 物流单号"
              className="h-10 w-full rounded-lg border border-line bg-white px-3 text-sm outline-none focus:border-accent sm:w-96"
            />
            <Badge tone="info">{filteredOrderRows.length} 条</Badge>
          </div>
          <button type="button" className="btn-secondary" onClick={() => void handleExportOrderBill()}>
            <Download size={18} />
            导出账单
          </button>
        </div>
        {renderOrderTable(filteredOrderRows)}
      </section>
    );
  }

  function renderOrderTable(rows: FinanceOrderRow[]) {
    if (rows.length === 0) return <EmptyPanel label="暂无订单账单数据" />;
    return (
      <FinanceTable minWidth="min-w-[1380px]">
        <thead>
          <tr>
            <th>日期</th>
            <th>订单号</th>
            <th>状态</th>
            <th>SKU</th>
            <th>商品</th>
            <th>数量</th>
            <th className="number-cell">商品成本</th>
            <th className="number-cell">实际运费</th>
            <th className="number-cell">账单金额</th>
            <th>发货方式</th>
            <th>匹配</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.order.id}>
              <td>{formatDate(getOrderDate(row.order))}</td>
              <td className="font-semibold text-slate-900">{row.order.order_no}</td>
              <td>{row.order.order_status || "--"}</td>
              <td>{row.order.sku_code || "--"}</td>
              <td>{row.product?.product_name_cn ?? (row.order.product_attributes || "--")}</td>
              <td className="number-cell">{row.quantity}</td>
              <td className="money">{formatCurrency(row.productCostRmb)}</td>
              <td className="money">{formatCurrency(row.shippingFeeRmb)}</td>
              <td className="money">{formatCurrency(row.billAmountRmb)}</td>
              <td>{row.order.logistics_method || "--"}</td>
              <td>
                <Badge tone={row.matched ? "success" : "warning"}>{row.matchLabel}</Badge>
              </td>
            </tr>
          ))}
        </tbody>
      </FinanceTable>
    );
  }

  function renderCashflow() {
    if (ledgerRows.length === 0) return <EmptyPanel label="暂无收支流水" />;
    return (
      <section className="surface-card grid gap-4 p-4">
        <FinanceTable>
          <thead>
            <tr>
              <th>日期</th>
              <th>类型</th>
              <th>方向</th>
              <th>对象</th>
              <th className="number-cell">金额</th>
              <th>备注</th>
            </tr>
          </thead>
          <tbody>
            {ledgerRows.map((row, index) => (
              <tr key={`${row.date}-${row.subject}-${index}`}>
                <td>{row.date}</td>
                <td>{row.type}</td>
                <td>
                  <Badge tone={row.direction === "收入" ? "success" : "danger"}>
                    {row.direction}
                  </Badge>
                </td>
                <td>{row.subject}</td>
                <td className={`money ${row.amountRmb < 0 ? "text-rose-700" : "text-emerald-700"}`}>
                  {formatCurrency(row.amountRmb)}
                </td>
                <td>{row.remark || "--"}</td>
              </tr>
            ))}
          </tbody>
        </FinanceTable>
      </section>
    );
  }

  function renderPurchases() {
    if (data.purchases.length === 0) return <EmptyPanel label="暂无采购付款记录" />;
    return (
      <section className="surface-card grid gap-4 p-4">
        <FinanceTable>
          <thead>
            <tr>
              <th>采购单号</th>
              <th>采购日期</th>
              <th>仓库</th>
              <th>状态</th>
              <th className="number-cell">货款</th>
              <th className="number-cell">总付款</th>
            </tr>
          </thead>
          <tbody>
            {data.purchases.map((purchase) => (
              <tr key={purchase.id}>
                <td className="font-semibold text-slate-900">{purchase.order_code}</td>
                <td>{formatDate(purchase.purchased_at)}</td>
                <td>{purchase.warehouse_name}</td>
                <td>{purchase.status}</td>
                <td className="money">{formatCurrency(Number(purchase.items_total_rmb || 0))}</td>
                <td className="money">{formatCurrency(getPurchaseTotalRmb(purchase))}</td>
              </tr>
            ))}
          </tbody>
        </FinanceTable>
      </section>
    );
  }

  function renderMonthlyProfit() {
    if (monthlyRows.length === 0) return <EmptyPanel label="暂无月度利润数据" />;
    return (
      <section className="surface-card grid gap-4 p-4">
        <FinanceTable>
          <thead>
            <tr>
              <th>月份</th>
              <th className="number-cell">订单账单</th>
              <th className="number-cell">商品成本</th>
              <th className="number-cell">实际运费</th>
              <th className="number-cell">采购付款</th>
              <th className="number-cell">现金差额</th>
            </tr>
          </thead>
          <tbody>
            {monthlyRows.map((row) => (
              <tr key={row.month}>
                <td className="font-semibold text-slate-900">{row.month}</td>
                <td className="money">{formatCurrency(row.income)}</td>
                <td className="money">{formatCurrency(row.productCost)}</td>
                <td className="money">{formatCurrency(row.shipping)}</td>
                <td className="money">{formatCurrency(row.purchase)}</td>
                <td className={`money ${row.balance < 0 ? "text-rose-700" : "text-emerald-700"}`}>
                  {formatCurrency(row.balance)}
                </td>
              </tr>
            ))}
          </tbody>
        </FinanceTable>
      </section>
    );
  }

  function renderProductProfit() {
    if (productRows.length === 0) return <EmptyPanel label="暂无商品利润数据" />;
    return (
      <section className="surface-card grid gap-4 p-4">
        <FinanceTable>
          <thead>
            <tr>
              <th>商品编号</th>
              <th>商品</th>
              <th className="number-cell">订单数</th>
              <th className="number-cell">件数</th>
              <th className="number-cell">商品成本</th>
              <th className="number-cell">实际运费</th>
              <th className="number-cell">账单金额</th>
            </tr>
          </thead>
          <tbody>
            {productRows.map((row) => (
              <tr key={`${row.productCode}-${row.productName}`}>
                <td className="font-semibold text-slate-900">{row.productCode}</td>
                <td>{row.productName}</td>
                <td className="number-cell">{row.orderCount}</td>
                <td className="number-cell">{row.quantity}</td>
                <td className="money">{formatCurrency(row.productCost)}</td>
                <td className="money">{formatCurrency(row.shipping)}</td>
                <td className="money">{formatCurrency(row.billAmount)}</td>
              </tr>
            ))}
          </tbody>
        </FinanceTable>
      </section>
    );
  }

  function renderReconciliationTable(rows: FinanceOrderRow[]) {
    if (rows.length === 0) return <EmptyPanel label="暂无待对账订单" />;
    return (
      <FinanceTable>
        <thead>
          <tr>
            <th>订单号</th>
            <th>SKU</th>
            <th>问题</th>
            <th className="number-cell">实际运费</th>
            <th>收件人</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const issues = [
              !row.matched ? "SKU未匹配" : "",
              row.shippingFeeRmb <= 0 ? "未填运费" : "",
            ].filter(Boolean);
            return (
              <tr key={row.order.id}>
                <td className="font-semibold text-slate-900">{row.order.order_no}</td>
                <td>{row.order.sku_code || "--"}</td>
                <td>{issues.join("、") || "--"}</td>
                <td className="money">{formatCurrency(row.shippingFeeRmb)}</td>
                <td>{row.order.recipient_name || "--"}</td>
              </tr>
            );
          })}
        </tbody>
      </FinanceTable>
    );
  }

  function renderReconciliation() {
    return (
      <section className="surface-card grid gap-4 p-4">
        {renderReconciliationTable(orderRows.filter((row) => !row.matched || row.shippingFeeRmb <= 0))}
      </section>
    );
  }

  function renderExpenses() {
    const shippingTotal = totals.orderShippingFee;
    return (
      <section className="surface-card grid gap-4 p-4">
        <div className="grid gap-4 md:grid-cols-3">
          <StatCard label="订单实际运费" value={formatCurrency(shippingTotal)} />
          <StatCard label="采购付款" value={formatCurrency(totals.purchasePayment)} />
          <StatCard label="其他费用" value={formatCurrency(0)} />
        </div>
      </section>
    );
  }

  function renderCurrentView() {
    if (loading) {
      return (
        <div className="rounded-lg border border-dashed border-slate-200 bg-slate-50/70 p-8 text-center text-sm text-slate-500">
          加载中...
        </div>
      );
    }

    switch (view) {
      case "cashflow":
        return renderCashflow();
      case "orders":
        return renderOrderIncome();
      case "purchases":
        return renderPurchases();
      case "expenses":
        return renderExpenses();
      case "monthly-profit":
        return renderMonthlyProfit();
      case "product-profit":
        return renderProductProfit();
      case "reconciliation":
        return renderReconciliation();
      case "overview":
      default:
        return renderOverview();
    }
  }

  return (
    <section className="grid gap-5">
      <PageHeader
        title={currentView.label}
        description="按订单实际运费、商品成本和采购付款汇总财务数据"
        actions={
          <button
            type="button"
            className="btn-secondary"
            disabled={busy || loading}
            onClick={() => void handleRefresh()}
          >
            <RefreshCw size={18} />
            刷新
          </button>
        }
      />

      {errorMessage && (
        <div className="rounded-md border border-rose-200 bg-rose-50 p-3 text-sm text-rose-700">
          {errorMessage}
        </div>
      )}

      <FinanceTabs activeView={view} />
      {renderCurrentView()}
    </section>
  );
}
