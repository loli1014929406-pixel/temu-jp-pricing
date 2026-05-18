import { Save } from "lucide-react";
import { useEffect, useState } from "react";
import type { User } from "@supabase/supabase-js";
import { Link, useParams } from "react-router-dom";
import { Field, TextInput } from "../components/form-controls";
import { fetchProfitCalculationsBySkuIds, saveProfitCalculation } from "../lib/profit-calculations";
import {
  fetchProduct,
  fetchProductItems,
  fetchProductSkus,
} from "../lib/products";
import { fetchSettings } from "../lib/settings";
import type {
  PricingResult,
  PricingSettings,
  Product,
  ProductItem,
  ProductSku,
  ProfitCalculationInput,
  ProfitCalculationResult,
} from "../types";
import { getErrorMessage } from "../utils/errors";
import { calculatePricing, formatCurrency, formatPercent } from "../utils/pricing";
import { calculateProfitProjection } from "../utils/profit-calculation";

type ProfitCalculationPageProps = {
  user: User;
};

type SkuCalculationState = {
  sku: ProductSku;
  items: ProductItem[];
  pricing: PricingResult;
  input: ProfitCalculationInput;
  result: ProfitCalculationResult;
};

const defaultInput: ProfitCalculationInput = {
  temuPriceRmb: 0,
  trafficDiscountRate: 10,
  activityDiscountRate: 10,
  couponDiscountRate: 10,
};

const formatRoas = (value: number | null, fallback: string) =>
  value === null ? fallback : value.toFixed(2);

export function ProfitCalculationPage({ user }: ProfitCalculationPageProps) {
  const { productId = "" } = useParams();
  const [product, setProduct] = useState<Product | null>(null);
  const [calculations, setCalculations] = useState<Record<string, SkuCalculationState>>({});
  const [settings, setSettings] = useState<PricingSettings | null>(null);
  const [productDiscounts, setProductDiscounts] = useState({
    trafficDiscountRate: 10,
    activityDiscountRate: 10,
    couponDiscountRate: 10,
  });
  const [loading, setLoading] = useState(true);
  const [savingSkuId, setSavingSkuId] = useState("");
  const [errorMessage, setErrorMessage] = useState("");
  const [savedSkuId, setSavedSkuId] = useState("");

  useEffect(() => {
    let active = true;

    async function load() {
      setLoading(true);
      setErrorMessage("");

      try {
        const [nextProduct, items, skus, settings] = await Promise.all([
          fetchProduct(productId),
          fetchProductItems(productId),
          fetchProductSkus(productId),
          fetchSettings(user.id),
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
        const nextCalculations = Object.fromEntries(
          skus.flatMap((sku) => {
            if (!sku.id || !sku.product_id) return [];

            const skuItems = sku.component_links.flatMap((link) => {
              const item = itemsById[link.item_id];
              return item ? [{ ...item, quantity: link.quantity }] : [];
            });
            if (skuItems.length === 0) return [];

            const pricing = calculatePricing(nextProduct.package_weight_g, skuItems, settings);
            const saved = savedBySkuId[sku.id];
            const input = saved
              ? {
                  temuPriceRmb: saved.temu_price_rmb,
                  trafficDiscountRate: saved.traffic_discount_rate,
                  activityDiscountRate: saved.activity_discount_rate,
                  couponDiscountRate: saved.coupon_discount_rate ?? 10,
                }
              : {
                  ...defaultInput,
                  temuPriceRmb: pricing.temuDeclarationPriceRmb,
                };

            return [
              [
                sku.id,
                {
                  sku,
                  items: skuItems,
                  pricing,
                  input,
                  result:
                    saved?.result_json &&
                    Object.keys(saved.result_json).length > 0 &&
                    saved.result_json.calculationVersion === 3 &&
                    typeof saved.result_json.isValid === "boolean"
                      ? saved.result_json
                      : calculateProfitProjection(pricing, settings, input),
                },
              ],
            ];
          }),
        );

        if (active) {
          const firstCalculation = Object.values(nextCalculations)[0];
          setProduct(nextProduct);
          setSettings(settings);
          setProductDiscounts({
            trafficDiscountRate: firstCalculation?.input.trafficDiscountRate ?? 10,
            activityDiscountRate: firstCalculation?.input.activityDiscountRate ?? 10,
            couponDiscountRate: firstCalculation?.input.couponDiscountRate ?? 10,
          });
          setCalculations(nextCalculations);
        }
      } catch (error) {
        if (active) {
          setErrorMessage(getErrorMessage(error, "加载利润测算失败"));
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
  }, [productId, user.id]);

  function updateSkuPrice(skuId: string, value: number) {
    const current = calculations[skuId];
    if (!current || !settings) return;

    const input = { ...current.input, temuPriceRmb: value };
    setCalculations((state) => ({
      ...state,
      [skuId]: {
        ...current,
        input,
        result: calculateProfitProjection(current.pricing, settings, input),
      },
    }));
  }

  function updateProductDiscount(
    field: "trafficDiscountRate" | "activityDiscountRate" | "couponDiscountRate",
    value: number,
  ) {
    if (!settings || value > 10) return;

    const nextProductDiscounts = { ...productDiscounts, [field]: value };
    setProductDiscounts(nextProductDiscounts);
    setCalculations((state) =>
      Object.fromEntries(
        Object.entries(state).map(([skuId, current]) => {
          const input = {
            ...current.input,
            trafficDiscountRate: nextProductDiscounts.trafficDiscountRate,
            activityDiscountRate: nextProductDiscounts.activityDiscountRate,
            couponDiscountRate: nextProductDiscounts.couponDiscountRate,
          };

          return [
            skuId,
            {
              ...current,
              input,
              result: calculateProfitProjection(current.pricing, settings, input),
            },
          ];
        }),
      ),
    );
  }

  async function handleSave(productId: string, skuId: string) {
    const current = calculations[skuId];
    if (!current) return;

    setSavingSkuId(skuId);
    setSavedSkuId("");
    setErrorMessage("");

    try {
      await saveProfitCalculation(productId, skuId, current.input, current.result);
      setSavedSkuId(skuId);
    } catch (error) {
      setErrorMessage(getErrorMessage(error, "保存利润测算失败"));
    } finally {
      setSavingSkuId("");
    }
  }

  if (loading) {
    return <div className="text-sm text-slate-500">加载中...</div>;
  }

  if (!product) {
    return null;
  }

  return (
    <section className="grid gap-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
        <h1 className="text-2xl font-semibold text-ink">利润数据分析</h1>
          <p className="mt-1 text-sm text-slate-500">
            {product.product_code} · {product.product_name_cn}
          </p>
        </div>
        <Link to="/profit-calculation" className="text-sm text-accent">
          返回利润数据分析
        </Link>
      </div>

      {errorMessage && (
        <div className="rounded-md border border-rose-200 bg-rose-50 p-3 text-sm text-rose-700">
          {errorMessage}
        </div>
      )}

      <section className="grid gap-4 rounded-lg bg-white p-5 shadow-panel">
        <div className="grid gap-4 md:grid-cols-4">
          <Field label="流量曝光折扣">
            <TextInput
              min="0.01"
              max="10"
              step="0.01"
              type="number"
              value={productDiscounts.trafficDiscountRate}
              onChange={(event) =>
                updateProductDiscount(
                  "trafficDiscountRate",
                  Number(event.target.value || 0),
                )
              }
            />
          </Field>
          <Field label="活动促销折扣">
            <TextInput
              min="0.01"
              max="10"
              step="0.01"
              type="number"
              value={productDiscounts.activityDiscountRate}
              onChange={(event) =>
                updateProductDiscount(
                  "activityDiscountRate",
                  Number(event.target.value || 0),
                )
              }
            />
          </Field>
          <Field label="优惠券折扣">
            <TextInput
              min="0.01"
              max="10"
              step="0.01"
              type="number"
              value={productDiscounts.couponDiscountRate}
              onChange={(event) =>
                updateProductDiscount(
                  "couponDiscountRate",
                  Number(event.target.value || 0),
                )
              }
            />
          </Field>
          <Field label="综合折扣系数">
            <TextInput
              readOnly
              value={(
                (productDiscounts.trafficDiscountRate *
                  productDiscounts.activityDiscountRate *
                  productDiscounts.couponDiscountRate) /
                100
              ).toFixed(4)}
            />
          </Field>
        </div>
      </section>

      <div className="grid gap-6">
        <div className="grid gap-5">
          {Object.values(calculations).map(({ sku, input, result }) => {
                  const skuId = sku.id as string;
                  return (
                    <section key={skuId} className="grid gap-4 rounded-lg bg-white p-5 shadow-panel">
                      <div className="flex flex-wrap items-start justify-between gap-3">
                        <div>
                          <h3 className="text-base font-semibold text-ink">{sku.sku_code}</h3>
                          <p className="mt-1 text-sm text-slate-500">
                            {Object.entries(sku.attributes)
                              .map(([name, value]) => `${name}：${value}`)
                              .join(" / ") || "未填写规格"}
                          </p>
                        </div>
                        <button
                          type="button"
                          onClick={() => void handleSave(product.id, skuId)}
                          disabled={savingSkuId === skuId}
                          className="inline-flex h-10 items-center gap-2 rounded-md bg-ink px-4 text-sm font-medium text-white disabled:opacity-60"
                        >
                          <Save size={16} />
                          {savingSkuId === skuId ? "保存中..." : "保存"}
                        </button>
                      </div>

                      <div className="grid gap-4 md:grid-cols-2">
                        <Field label="核定供货价 (RMB)">
                          <TextInput
                            min="0"
                            step="0.01"
                            type="number"
                            value={input.temuPriceRmb}
                            onChange={(event) =>
                              updateSkuPrice(skuId, Number(event.target.value || 0))
                            }
                          />
                        </Field>
                        <Field label="折后结算价 (RMB)">
                          <TextInput readOnly value={result.discountedSalePriceRmb.toFixed(2)} />
                        </Field>
                      </div>

                      {!result.isValid && (
                        <div className="rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
                          请填写大于 0 的 Temu 核价，且折扣必须大于 0 并且不超过 10
                        </div>
                      )}

                      {savedSkuId === skuId && (
                        <p className="text-sm text-emerald-700">已保存</p>
                      )}

                      <div className="overflow-x-auto">
                        <table className="min-w-full text-left text-sm">
                          <thead className="bg-slate-50 text-slate-500">
                            <tr>
                              <th className="px-3 py-3 font-medium">物流方案</th>
                              <th className="px-3 py-3 font-medium">有效运费补贴 RMB</th>
                              <th className="px-3 py-3 font-medium">物流成本 RMB</th>
                              <th className="px-3 py-3 font-medium">总成本 RMB</th>
                              <th className="px-3 py-3 font-medium">实收收入 RMB</th>
                              <th className="px-3 py-3 font-medium">利润 RMB</th>
                              <th className="px-3 py-3 font-medium">利润率</th>
                              <th className="px-3 py-3 font-medium">广告最高可承受金额 RMB</th>
                              <th className="px-3 py-3 font-medium">建议最低 ROAS</th>
                              <th className="px-3 py-3 font-medium">保本 ROAS</th>
                              <th className="px-3 py-3 font-medium">单件是否失去补贴</th>
                              <th className="px-3 py-3 font-medium">免邮起送件数 (3500円)</th>
                            </tr>
                          </thead>
                          <tbody>
                            {result.plans.map((plan) => (
                              <tr key={plan.planKey} className="border-t border-line">
                                <td className="px-3 py-3">{plan.planName}</td>
                                <td className="px-3 py-3">{formatCurrency(plan.effectiveSubsidyRmb)}</td>
                                <td className="px-3 py-3">{formatCurrency(plan.logisticsCostRmb)}</td>
                                <td className="px-3 py-3">{formatCurrency(plan.totalCostRmb)}</td>
                                <td className="px-3 py-3">
                                  {result.isValid ? formatCurrency(plan.realizedRevenueRmb) : "--"}
                                </td>
                                <td className="px-3 py-3">
                                  {result.isValid ? formatCurrency(plan.profitRmb) : "--"}
                                </td>
                                <td className="px-3 py-3">
                                  {!result.isValid || plan.profitRate === null
                                    ? "--"
                                    : formatPercent(plan.profitRate)}
                                </td>
                                <td className="px-3 py-3">
                                  {result.isValid ? formatCurrency(plan.maxAdSpendRmb) : "--"}
                                </td>
                                <td className="px-3 py-3">
                                  {result.isValid
                                    ? formatRoas(plan.recommendedMinRoas, "不建议投放")
                                    : "--"}
                                </td>
                                <td className="px-3 py-3">
                                  {result.isValid
                                    ? formatRoas(plan.breakEvenRoas, "订单不保本")
                                    : "--"}
                                </td>
                                <td className="px-3 py-3">
                                  {result.isValid
                                    ? result.singleUnitLosesShippingSubsidy
                                      ? "是"
                                      : "否"
                                    : "--"}
                                </td>
                                <td className="px-3 py-3">
                                  {result.freeShippingThresholdQty ?? "--"}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </section>
                  );
                })}
        </div>
      </div>
    </section>
  );
}
