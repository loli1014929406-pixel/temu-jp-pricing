import type { User } from "@supabase/supabase-js";
import { Link, useParams } from "react-router-dom";
import { useEffect, useMemo, useState } from "react";
import { Field, TextInput } from "../components/form-controls";
import { BackToParentAction, Badge, PageHeader, StatCard } from "../components/ui";
import { fetchProfitCalculationsBySkuIds } from "../lib/profit-calculations";
import { fetchProduct, fetchProductItems, fetchProductSkus } from "../lib/products";
import { fetchSettings } from "../lib/settings";
import type {
  PricingSettings,
  Product,
  ProductItem,
  ProductSku,
  ProfitCalculationInput,
  SavedProfitCalculation,
} from "../types";
import { getErrorMessage } from "../utils/errors";
import {
  calculateMultiShipmentProfitRows,
  type MultiShipmentMode,
  type MultiShipmentProfitRow,
} from "../utils/multi-shipment-profit";
import { useAutoDismiss } from "../hooks/use-auto-dismiss";
import { PROFIT_CALCULATION_VERSION } from "../utils/profit-calculation";
import { calculatePricing, formatCurrency, formatPercent } from "../utils/pricing";

type MultiShipmentProfitPageProps = {
  user: User;
  mode: MultiShipmentMode;
};

type SkuShipmentBase = {
  sku: ProductSku;
  skuItems: ProductItem[];
  input: ProfitCalculationInput;
  hasSavedCalculation: boolean;
};

type SkuShipmentCalculation = SkuShipmentBase & {
  rows: MultiShipmentProfitRow[];
};

const defaultInput: ProfitCalculationInput = {
  temuPriceRmb: 0,
  trafficDiscountRate: 0,
  activityDiscountRate: 10,
  couponDiscountRate: 0,
  adRoas: 0,
};

const modeContent = {
  direct: {
    title: "多件直发利润测算",
    description: "按 SKU 和件数自动选择 OCS 3cm 或 OCS 小包，亏损后停止继续测算。",
    otherModeLabel: "查看正常发货",
    otherMode: "standard-shipping",
  },
  standard: {
    title: "多件正常发货利润测算",
    description: "3cm 内引用利润分析里的物流成本，超过 3cm 时按 OCS 小包测算，亏损后停止继续测算。",
    otherModeLabel: "查看直发",
    otherMode: "direct-shipping",
  },
} as const;

function getSavedCalculationVersion(
  calculation: { result_json?: { calculationVersion?: number } } | undefined,
) {
  return calculation?.result_json?.calculationVersion ?? 0;
}

function buildInputFromSavedCalculation(
  saved: SavedProfitCalculation | undefined,
  fallbackTemuPriceRmb: number,
): ProfitCalculationInput {
  if (!saved) {
    return {
      ...defaultInput,
      temuPriceRmb: fallbackTemuPriceRmb,
    };
  }

  const savedVersion = getSavedCalculationVersion(saved);
  const usesDiscountFormula = savedVersion >= 4;
  const usesAdFormula = savedVersion >= PROFIT_CALCULATION_VERSION;

  return {
    temuPriceRmb: saved.temu_price_rmb,
    trafficDiscountRate: usesDiscountFormula ? saved.traffic_discount_rate : 0,
    activityDiscountRate: saved.activity_discount_rate,
    couponDiscountRate: usesDiscountFormula ? saved.coupon_discount_rate ?? 0 : 0,
    adRoas: usesAdFormula ? saved.result_json?.adRoas ?? 0 : 0,
  };
}

function formatOptionalCurrency(value: number | null | undefined) {
  return typeof value === "number" ? formatCurrency(value) : "--";
}

function formatOptionalPercent(value: number | null | undefined) {
  return typeof value === "number" ? formatPercent(value) : "--";
}

function getSkuAttributesLabel(sku: ProductSku) {
  return (
    Object.entries(sku.attributes)
      .map(([name, value]) => `${name}：${value}`)
      .join(" / ") || "未填写规格"
  );
}

function getLastProfitableQuantity(rows: MultiShipmentProfitRow[]) {
  const profitableRows = rows.filter((row) => row.isValid && row.profitRmb >= 0);
  return profitableRows.at(-1)?.quantity ?? null;
}

function getResultTone(row: MultiShipmentProfitRow | undefined) {
  if (!row || !row.isValid) return "neutral";
  return row.profitRmb >= 0 ? "success" : "danger";
}

function buildProductProfitPath(product: Product, suffix: string) {
  return `/profit-calculation/${suffix}/${encodeURIComponent(
    product.product_code.trim() || product.id,
  )}`;
}

export function MultiShipmentProfitPage({
  user,
  mode,
}: MultiShipmentProfitPageProps) {
  const { productKey = "" } = useParams();
  const [product, setProduct] = useState<Product | null>(null);
  const [settings, setSettings] = useState<PricingSettings | null>(null);
  const [skuBases, setSkuBases] = useState<SkuShipmentBase[]>([]);
  const [maxQuantity, setMaxQuantity] = useState(10);
  const [loading, setLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState("");
  useAutoDismiss(errorMessage, () => setErrorMessage(""));

  useEffect(() => {
    let active = true;

    async function load() {
      setLoading(true);
      setErrorMessage("");

      try {
        const [nextProduct, nextSettings] = await Promise.all([
          fetchProduct(productKey),
          fetchSettings(user.id),
        ]);
        const [items, skus] = await Promise.all([
          fetchProductItems(nextProduct.id),
          fetchProductSkus(nextProduct.id),
        ]);
        const savedCalculations = await fetchProfitCalculationsBySkuIds(
          skus.flatMap((sku) => (sku.id ? [sku.id] : [])),
        );
        const savedBySkuId = Object.fromEntries(
          savedCalculations.map((calculation) => [calculation.sku_id, calculation]),
        );
        const itemsById = Object.fromEntries(
          items.flatMap((item) => (item.id ? [[item.id, item]] : [])),
        );
        const nextSkuBases = skus.flatMap((sku) => {
          if (!sku.id) return [];

          const skuItems = sku.component_links.flatMap((link) => {
            const item = itemsById[link.item_id];
            return item ? [{ ...item, quantity: link.quantity }] : [];
          });
          if (skuItems.length === 0) return [];

          const pricing = calculatePricing(
            nextProduct.package_weight_g,
            skuItems,
            nextSettings,
          );
          const saved = savedBySkuId[sku.id];
          const input = buildInputFromSavedCalculation(
            saved,
            pricing.temuDeclarationPriceRmb,
          );

          return [
            {
              sku,
              skuItems,
              input,
              hasSavedCalculation: Boolean(saved),
            },
          ];
        });

        if (active) {
          setProduct(nextProduct);
          setSettings(nextSettings);
          setSkuBases(nextSkuBases);
        }
      } catch (error) {
        if (active) {
          setErrorMessage(getErrorMessage(error, "加载多件利润测算失败"));
        }
      } finally {
        if (active) {
          setLoading(false);
        }
      }
    }

    void load();
    return () => {
      active = false;
    };
  }, [productKey, user.id]);

  const calculations = useMemo<SkuShipmentCalculation[]>(() => {
    if (!product || !settings) return [];

    return skuBases.map((base) => ({
      ...base,
      rows: calculateMultiShipmentProfitRows(
        mode,
        product,
        base.skuItems,
        settings,
        base.input,
        maxQuantity,
      ),
    }));
  }, [maxQuantity, mode, product, settings, skuBases]);

  const highestProfitableQuantity = useMemo(() => {
    const quantities = calculations.flatMap((calculation) => {
      const quantity = getLastProfitableQuantity(calculation.rows);
      return quantity === null ? [] : [quantity];
    });
    return quantities.length > 0 ? Math.max(...quantities) : null;
  }, [calculations]);

  const lossStoppedSkuCount = useMemo(
    () =>
      calculations.filter((calculation) => {
        const lastRow = calculation.rows.at(-1);
        return lastRow?.isValid && lastRow.profitRmb < 0;
      }).length,
    [calculations],
  );
  const content = modeContent[mode];
  const otherModePath = product
    ? buildProductProfitPath(product, content.otherMode)
    : "/profit-calculation";

  function updateMaxQuantity(value: number) {
    if (Number.isNaN(value)) return;
    setMaxQuantity(Math.max(1, Math.trunc(value || 1)));
  }

  if (loading) {
    return <div className="text-sm text-slate-500">加载中...</div>;
  }

  if (!product) {
    return null;
  }

  return (
    <section className="grid gap-5">
      <PageHeader
        title={content.title}
        description={`${product.product_code} · ${product.product_name_cn}。${content.description}`}
        actions={
          <>
            <Link className="btn-secondary" to={otherModePath}>
              {content.otherModeLabel}
            </Link>
            <BackToParentAction fallbackTo="/profit-calculation" />
          </>
        }
      />

      {errorMessage && (
        <div className="rounded-md border border-rose-200 bg-rose-50 p-3 text-sm text-rose-700">
          {errorMessage}
        </div>
      )}

      <section className="grid gap-4 rounded-lg border border-line bg-white p-4 shadow-soft">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <StatCard label="SKU 数" value={String(calculations.length)} />
          <StatCard
            label="最高盈利件数"
            value={highestProfitableQuantity === null ? "--" : `${highestProfitableQuantity} 件`}
            tone={highestProfitableQuantity === null ? "danger" : "success"}
          />
          <StatCard label="亏损停止 SKU" value={String(lossStoppedSkuCount)} />
          <div className="erp-kpi-card">
            <p className="text-xs font-bold uppercase tracking-wide text-slate-500">
              3cm 每包件数
            </p>
            <p className="mt-3 text-3xl font-semibold tabular-nums text-slate-950">
              {product.max_units_per_parcel}
            </p>
          </div>
        </div>

        <div className="grid gap-3 md:grid-cols-[180px_minmax(0,1fr)] md:items-end">
          <Field label="测算最大件数">
            <TextInput
              min="1"
              step="1"
              type="number"
              value={maxQuantity}
              onChange={(event) => updateMaxQuantity(Number(event.target.value))}
            />
          </Field>
          <div className="rounded-md border border-line bg-slate-50 px-3 py-2 text-sm text-slate-600">
            核价、流量加速、活动折扣、优惠券和 ROAS 来自已保存的利润分析；3cm
            每包件数来自商品编辑页，刷新后按最新商品数据计算。
          </div>
        </div>
      </section>

      {calculations.length === 0 ? (
        <div className="empty-state">当前商品没有可测算的 SKU</div>
      ) : (
        <div className="grid gap-5">
          {calculations.map((calculation) => {
            const lastRow = calculation.rows.at(-1);
            const lastProfitableQuantity = getLastProfitableQuantity(calculation.rows);

            return (
              <section
                key={calculation.sku.id ?? calculation.sku.sku_code}
                className="grid gap-4 rounded-lg border border-line bg-white p-4 shadow-soft"
              >
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <div className="flex flex-wrap items-center gap-2">
                      <h2 className="text-base font-semibold text-slate-950">
                        {calculation.sku.sku_code}
                      </h2>
                      <Badge tone={calculation.hasSavedCalculation ? "info" : "warning"}>
                        {calculation.hasSavedCalculation ? "引用已保存利润数据" : "使用建议核价"}
                      </Badge>
                      {lastRow ? (
                        <Badge tone={getResultTone(lastRow)}>
                          {lastRow.profitRmb < 0 ? "已亏损停止" : "当前范围盈利"}
                        </Badge>
                      ) : null}
                    </div>
                    <p className="mt-1 text-sm text-slate-500">
                      {getSkuAttributesLabel(calculation.sku)}
                    </p>
                  </div>
                  <div className="rounded-md border border-line bg-slate-50 px-3 py-2 text-sm text-slate-600">
                    最多盈利：
                    <span className="ml-1 font-semibold text-slate-950">
                      {lastProfitableQuantity === null ? "--" : `${lastProfitableQuantity} 件`}
                    </span>
                  </div>
                </div>

                <div className="grid gap-2 text-sm sm:grid-cols-2 lg:grid-cols-5">
                  <div className="rounded-md bg-slate-50 px-3 py-2">
                    核价：{formatCurrency(calculation.input.temuPriceRmb)}
                  </div>
                  <div className="rounded-md bg-slate-50 px-3 py-2">
                    流量加速：{formatCurrency(calculation.input.trafficDiscountRate)}
                  </div>
                  <div className="rounded-md bg-slate-50 px-3 py-2">
                    活动折扣：{calculation.input.activityDiscountRate.toFixed(2)}
                  </div>
                  <div className="rounded-md bg-slate-50 px-3 py-2">
                    优惠券：{formatCurrency(calculation.input.couponDiscountRate)}
                  </div>
                  <div className="rounded-md bg-slate-50 px-3 py-2">
                    ROAS：{(calculation.input.adRoas ?? 0).toFixed(2)}
                  </div>
                </div>

                <div className="grid gap-3 md:hidden">
                  {calculation.rows.map((row) => (
                    <article key={row.quantity} className="mobile-summary-card">
                      <div className="flex items-start justify-between gap-2">
                        <div>
                          <p className="mobile-summary-title">{row.quantity} 件</p>
                          <p className="mobile-summary-subtitle">
                            {row.selectedMethodName} · {row.selectedPackageCount ?? "--"} 包
                          </p>
                        </div>
                        <Badge tone={row.isValid && row.profitRmb >= 0 ? "success" : "danger"}>
                          {row.isValid && row.profitRmb >= 0 ? "盈利" : "亏损"}
                        </Badge>
                      </div>
                      <div className="mobile-summary-grid">
                        <div className="mobile-summary-cell">
                          订单售价：{formatCurrency(row.orderSalePriceRmb)}
                        </div>
                        <div className="mobile-summary-cell">
                          发货运费：{formatCurrency(row.logisticsCostRmb)}
                        </div>
                        <div className="mobile-summary-cell">
                          总成本：{formatCurrency(row.totalCostRmb)}
                        </div>
                        <div className="mobile-summary-cell">
                          利润：
                          <span
                            className={
                              row.profitRmb >= 0
                                ? "money text-emerald-700"
                                : "money text-rose-700"
                            }
                          >
                            {" "}
                            {formatCurrency(row.profitRmb)}
                          </span>
                        </div>
                      </div>
                    </article>
                  ))}
                </div>

                <div className="table-card hidden md:block">
                  <div className="overflow-x-auto">
                    <table className="data-table is-fixed-table multi-shipment-profit-table w-full min-w-[1400px]">
                      <colgroup>
                        <col className="w-16" />
                        <col className="w-24" />
                        <col className="w-20" />
                        <col className="w-32" />
                        <col className="w-20" />
                        <col className="w-24" />
                        <col className="w-24" />
                        {mode === "direct" && <col className="w-24" />}
                        <col className="w-20" />
                        <col className="w-24" />
                        <col className="w-24" />
                        <col className="w-20" />
                        <col className="w-20" />
                        <col className="w-[22rem]" />
                      </colgroup>
                      <thead>
                        <tr>
                          <th className="px-4 py-3 font-medium">件数</th>
                          <th className="px-4 py-3 font-medium">订单售价</th>
                          <th className="px-4 py-3 font-medium">补贴</th>
                          <th className="px-4 py-3 font-medium">发货方式</th>
                          <th className="px-4 py-3 font-medium">包裹数</th>
                          <th className="px-4 py-3 font-medium">发货运费</th>
                          <th className="px-4 py-3 font-medium">采购成本</th>
                          {mode === "direct" && (
                            <th className="px-4 py-3 font-medium">入仓顺丰</th>
                          )}
                          <th className="px-4 py-3 font-medium">广告费</th>
                          <th className="px-4 py-3 font-medium">总成本</th>
                          <th className="px-4 py-3 font-medium">利润</th>
                          <th className="px-4 py-3 font-medium">利润率</th>
                          <th className="px-4 py-3 font-medium">失补</th>
                          <th className="px-4 py-3 font-medium">候选成本</th>
                        </tr>
                      </thead>
                      <tbody>
                        {calculation.rows.map((row) => (
                          <tr key={row.quantity}>
                            <td className="number-cell">{row.quantity}</td>
                            <td className="money">{formatCurrency(row.orderSalePriceRmb)}</td>
                            <td className="money">{formatCurrency(row.subsidyRmb)}</td>
                            <td className="px-4 py-3">
                              <Badge tone="info">{row.selectedMethodName}</Badge>
                            </td>
                            <td className="number-cell">
                              {row.selectedPackageCount ?? "--"}
                            </td>
                            <td className="money">{formatCurrency(row.logisticsCostRmb)}</td>
                            <td className="money">
                              {formatCurrency(row.purchaseCostRmb + row.purchaseShippingRmb)}
                            </td>
                            {mode === "direct" && (
                              <td className="money">{formatCurrency(row.inboundSfCostRmb)}</td>
                            )}
                            <td className="money">{formatCurrency(row.adFeeRmb)}</td>
                            <td className="money">{formatCurrency(row.totalCostRmb)}</td>
                            <td className="px-4 py-3">
                              <span
                                className={`money ${
                                  row.profitRmb >= 0
                                    ? "text-emerald-700"
                                    : "text-rose-700"
                                }`}
                              >
                                {formatCurrency(row.profitRmb)}
                              </span>
                            </td>
                            <td className="number-cell">
                              {formatOptionalPercent(row.profitRate)}
                            </td>
                            <td className="px-4 py-3">
                              {row.losesShippingSubsidy ? (
                                <Badge tone="danger">是</Badge>
                              ) : (
                                <Badge tone="success">否</Badge>
                              )}
                            </td>
                            <td className="multi-shipment-candidates-cell px-4 py-3 text-xs leading-5 text-slate-500">
                              {row.candidates
                                .map((candidate) =>
                                  candidate.available
                                    ? `${candidate.name} ${formatOptionalCurrency(candidate.logisticsCostRmb)}`
                                    : `${candidate.name} 不可用：${candidate.unavailableReason}`,
                                )
                                .join(" / ")}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              </section>
            );
          })}
        </div>
      )}
    </section>
  );
}
