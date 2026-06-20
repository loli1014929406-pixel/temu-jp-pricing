import { Save } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { User } from "@supabase/supabase-js";
import { Link, useParams } from "react-router-dom";
import { Field, TextInput } from "../components/form-controls";
import { BackToParentAction } from "../components/ui";
import { isSameDraft, readDraft, useDraftPersistence } from "../hooks/use-draft-persistence";
import { usePermissions } from "../hooks/use-permissions";
import { useAutoDismiss } from "../hooks/use-auto-dismiss";
import { fetchProfitCalculationsBySkuIds, saveProfitCalculation } from "../lib/profit-calculations";
import {
  fetchProduct,
  fetchProductItems,
  fetchProductSkus,
  getProductRouteKey,
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
import {
  buildProfitCalculationInputFromSaved,
  calculateProfitProjection,
  resolveProfitCalculationResult,
} from "../utils/profit-calculation";
import {
  readProductDiscountDraft,
  writeProductDiscountDraft,
  type ProfitDiscountFields,
} from "../utils/profit-discount-drafts";

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

type ProductDiscountDraft = ProfitDiscountFields;

type ProfitCalculationDraft = {
  productDiscounts: ProductDiscountDraft;
  skuInputs: Record<string, Pick<ProfitCalculationInput, "temuPriceRmb">>;
};

function hasSkuPriceDraft(
  draft: ProfitCalculationDraft | null | undefined,
  baseCalculations: Record<string, SkuCalculationState>,
) {
  if (!draft) return false;

  return Object.entries(draft.skuInputs).some(([skuId, input]) => {
    const baseCalculation = baseCalculations[skuId];
    return baseCalculation ? input.temuPriceRmb !== baseCalculation.input.temuPriceRmb : false;
  });
}

function ReadOnlyValue({ value }: { value: string }) {
  return (
    <div className="flex h-11 items-center rounded-md border border-line bg-slate-50 px-3 text-sm tabular-nums text-slate-700">
      {value}
    </div>
  );
}

function getMultiShipmentProfitPath(
  product: Pick<Product, "id" | "product_code">,
  mode: "direct-shipping" | "standard-shipping",
) {
  return `/profit-calculation/${mode}/${getProductRouteKey(product)}`;
}

export function ProfitCalculationPage({ user }: ProfitCalculationPageProps) {
  const { canEdit } = usePermissions();
  const { productId: productKey = "" } = useParams();
  const draftKey = `profit-calculation-draft:v1:${user.id}:${productKey}`;
  const [product, setProduct] = useState<Product | null>(null);
  const [calculations, setCalculations] = useState<Record<string, SkuCalculationState>>({});
  const [settings, setSettings] = useState<PricingSettings | null>(null);
  const [productDiscounts, setProductDiscounts] = useState({
    trafficDiscountRate: 0,
    activityDiscountRate: 10,
    couponDiscountRate: 0,
    adRoas: 0,
  });
  const [loading, setLoading] = useState(true);
  const [savingSkuId, setSavingSkuId] = useState("");
  const [errorMessage, setErrorMessage] = useState("");
  const [savedSkuId, setSavedSkuId] = useState("");
  const [draftNotice, setDraftNotice] = useState("");
  useAutoDismiss(errorMessage, () => setErrorMessage(""));
  useAutoDismiss(savedSkuId, () => setSavedSkuId(""));
  useAutoDismiss(draftNotice, () => setDraftNotice(""));

  const draftValue = useMemo<ProfitCalculationDraft>(
    () => ({
      productDiscounts,
      skuInputs: Object.fromEntries(
        Object.entries(calculations).map(([skuId, calculation]) => [
          skuId,
          { temuPriceRmb: calculation.input.temuPriceRmb },
        ]),
      ),
    }),
    [calculations, productDiscounts],
  );

  useDraftPersistence(draftKey, draftValue, { enabled: Boolean(product && !loading) });

  useEffect(() => {
    if (!product || loading) return;
    writeProductDiscountDraft(user.id, product.id, productDiscounts);
  }, [loading, product, productDiscounts, user.id]);

  useEffect(() => {
    let active = true;

    async function load() {
      setLoading(true);
      setErrorMessage("");

      try {
        const [nextProduct, settings] = await Promise.all([
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
            const input = buildProfitCalculationInputFromSaved(
              saved,
              pricing.temuDeclarationPriceRmb,
            );

            return [
              [
                sku.id,
                {
                  sku,
                  items: skuItems,
                  pricing,
                  input,
                  result: resolveProfitCalculationResult(
                    pricing,
                    settings,
                    input,
                    saved?.result_json,
                  ),
                },
              ],
            ];
          }),
        );

        if (active) {
          const firstCalculation = Object.values(nextCalculations)[0];
          const latestDraft = readDraft<ProfitCalculationDraft>(draftKey);
          const baseProductDiscounts = {
            trafficDiscountRate: firstCalculation?.input.trafficDiscountRate ?? 0,
            activityDiscountRate: firstCalculation?.input.activityDiscountRate ?? 10,
            couponDiscountRate: firstCalculation?.input.couponDiscountRate ?? 0,
            adRoas: firstCalculation?.input.adRoas ?? 0,
          };
          const sharedProductDiscounts = readProductDiscountDraft(user.id, nextProduct.id);
          const legacyProductDiscounts =
            latestDraft && !isSameDraft(latestDraft.productDiscounts, baseProductDiscounts)
              ? latestDraft.productDiscounts
              : null;
          const nextProductDiscounts =
            sharedProductDiscounts ?? legacyProductDiscounts ?? baseProductDiscounts;
          const shouldRestoreDraft =
            Boolean(
              sharedProductDiscounts &&
                !isSameDraft(sharedProductDiscounts, baseProductDiscounts),
            ) ||
            Boolean(legacyProductDiscounts) ||
            hasSkuPriceDraft(latestDraft, nextCalculations);
          const mergedCalculations = Object.fromEntries(
            Object.entries(nextCalculations).map(([skuId, calculation]) => {
              const draftSkuInput = latestDraft?.skuInputs[skuId];
              const input = {
                ...calculation.input,
                ...(draftSkuInput ? { temuPriceRmb: draftSkuInput.temuPriceRmb } : {}),
                ...nextProductDiscounts,
              };

              return [
                skuId,
                {
                  ...calculation,
                  input,
                  result: calculateProfitProjection(calculation.pricing, settings, input),
                },
              ];
            }),
          );
          setProduct(nextProduct);
          setSettings(settings);
          setProductDiscounts(nextProductDiscounts);
          setCalculations(mergedCalculations);
          setDraftNotice(shouldRestoreDraft ? "已恢复上次未保存的利润测算草稿。" : "");
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
  }, [draftKey, productKey, user.id]);

  const productPrice = useMemo(() => {
    const prices = Object.values(calculations).map(
      (calculation) => calculation.input.temuPriceRmb,
    );
    const firstPrice = prices[0] ?? 0;
    const isConsistent =
      prices.length > 0 && prices.every((price) => price === firstPrice);

    return {
      hasPrices: prices.length > 0,
      isConsistent,
      value: isConsistent ? firstPrice : "",
    };
  }, [calculations]);

  function updateProductPrice(value: number) {
    if (!settings) return;

    setCalculations((state) =>
      Object.fromEntries(
        Object.entries(state).map(([skuId, current]) => {
          const input = { ...current.input, temuPriceRmb: value };

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
    field: "trafficDiscountRate" | "activityDiscountRate" | "couponDiscountRate" | "adRoas",
    value: number,
  ) {
    if (!settings || value < 0 || (field === "activityDiscountRate" && value > 10)) return;

    const nextProductDiscounts = { ...productDiscounts, [field]: value };
    setProductDiscounts(nextProductDiscounts);
    if (product) {
      writeProductDiscountDraft(user.id, product.id, nextProductDiscounts);
    }
    setCalculations((state) =>
      Object.fromEntries(
        Object.entries(state).map(([skuId, current]) => {
          const input = {
            ...current.input,
            trafficDiscountRate: nextProductDiscounts.trafficDiscountRate,
            activityDiscountRate: nextProductDiscounts.activityDiscountRate,
            couponDiscountRate: nextProductDiscounts.couponDiscountRate,
            adRoas: nextProductDiscounts.adRoas,
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
    if (!canEdit) {
      setErrorMessage("当前账号没有编辑权限，不能保存利润测算。");
      return;
    }

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
    <section className="flex flex-col gap-6 p-4 sm:p-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
        <h1 className="text-2xl font-semibold text-ink">利润分析</h1>
          <p className="mt-1 text-sm text-slate-500">
            {product.product_code} · {product.product_name_cn}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Link className="btn-secondary" to={getMultiShipmentProfitPath(product, "direct-shipping")}>
            多件直发
          </Link>
          <Link className="btn-secondary" to={getMultiShipmentProfitPath(product, "standard-shipping")}>
            多件正常
          </Link>
          <BackToParentAction fallbackTo="/profit-calculation" />
        </div>
      </div>

      {errorMessage && (
        <div className="rounded-md border border-rose-200 bg-rose-50 p-3 text-sm text-rose-700">
          {errorMessage}
        </div>
      )}
      {draftNotice && (
        <div className="rounded-md border border-sky-200 bg-sky-50 p-3 text-sm text-sky-700">
          {draftNotice}
        </div>
      )}

      <section className="grid gap-4 rounded-lg bg-panel p-5 shadow-soft">
        <div className="grid gap-4 md:grid-cols-5">
          <Field label="核价">
            <TextInput
              min="0"
              disabled={!canEdit || !productPrice.isConsistent}
              placeholder={productPrice.hasPrices ? "各 SKU 不同" : "暂无 SKU"}
              step="0.01"
              title={productPrice.isConsistent ? "修改全部 SKU 核价" : "SKU 核价不一致时不可批量修改"}
              type="number"
              value={productPrice.value}
              onChange={(event) =>
                updateProductPrice(Number(event.target.value || 0))
              }
            />
          </Field>
          <Field label="流量加速">
            <TextInput
              min="0"
              disabled={!canEdit}
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
          <Field label="活动折扣">
            <TextInput
              min="0.01"
              max="10"
              disabled={!canEdit}
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
          <Field label="优惠券价">
            <TextInput
              min="0"
              disabled={!canEdit}
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
          <Field label="ROAS">
            <TextInput
              min="0"
              disabled={!canEdit}
              step="0.01"
              type="number"
              value={productDiscounts.adRoas}
              onChange={(event) =>
                updateProductDiscount("adRoas", Number(event.target.value || 0))
              }
            />
          </Field>
        </div>
      </section>

      <div className="grid gap-6">
        <div className="grid gap-5">
          {Object.values(calculations).map(({ sku, input, result }) => {
                  const skuId = sku.id as string;
                  return (
                    <section key={skuId} className="grid gap-4 rounded-lg bg-panel p-5 shadow-soft">
                      <div className="flex flex-wrap items-start justify-between gap-3">
                        <div>
                          <h3 className="text-base font-semibold text-ink">{sku.sku_code}</h3>
                          <p className="mt-1 text-sm text-slate-500">
                            {Object.entries(sku.attributes)
                              .map(([name, value]) => `${name}：${value}`)
                              .join(" / ") || "未填写规格"}
                          </p>
                        </div>
                        {canEdit && (
                          <button
                            type="button"
                            onClick={() => void handleSave(product.id, skuId)}
                            disabled={savingSkuId === skuId}
                            className="inline-flex h-10 items-center gap-2 rounded-md bg-ink px-4 text-sm font-medium text-white disabled:opacity-60"
                          >
                            <Save size={16} />
                            {savingSkuId === skuId ? "保存中..." : "保存"}
                          </button>
                        )}
                      </div>

                      <div className="grid gap-4 md:grid-cols-3">
                        <Field label="核价">
                          <TextInput
                            min="0"
                            disabled={!canEdit}
                            step="0.01"
                            type="number"
                            value={input.temuPriceRmb}
                            onChange={(event) =>
                              updateSkuPrice(skuId, Number(event.target.value || 0))
                            }
                          />
                        </Field>
                        <Field label="最终售价">
                          <ReadOnlyValue value={result.discountedSalePriceRmb.toFixed(2)} />
                        </Field>
                        <Field label="广告费">
                          <ReadOnlyValue value={result.adFeeRmb.toFixed(2)} />
                        </Field>
                      </div>

                      {!result.isValid && (
                        <div className="rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
                          请填写大于 0 的核价；流量加速、优惠券价和 ROAS 不能小于 0，活动折扣必须大于 0 且不超过 10
                        </div>
                      )}

                      {savedSkuId === skuId && (
                        <p className="text-sm text-emerald-700">已保存</p>
                      )}

                      <div className="max-h-[72vh] overflow-auto">
                        <table className="data-table">
                          <thead>
                            <tr>
                              <th className="px-3 py-3 font-medium">物流方案</th>
                              <th className="px-3 py-3 font-medium">运费补贴</th>
                              <th className="px-3 py-3 font-medium">物流成本</th>
                              <th className="px-3 py-3 font-medium">总成本</th>
                              <th className="px-3 py-3 font-medium">实收收入</th>
                              <th className="px-3 py-3 font-medium">广告费</th>
                              <th className="px-3 py-3 font-medium">利润</th>
                              <th className="px-3 py-3 font-medium">利润率</th>
                              <th className="px-3 py-3 font-medium">失补状态</th>
                              <th className="px-3 py-3 font-medium">免邮件数</th>
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
                                  {result.isValid ? formatCurrency(plan.adFeeRmb) : "--"}
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
