import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import type { User } from "@supabase/supabase-js";
import {
  fetchProduct,
  fetchProductItems,
  fetchProductSkus,
  getProductRoutePath,
} from "../lib/products";
import { savePricingResult } from "../lib/pricing-results";
import { fetchSettings } from "../lib/settings";
import { calculatePricing, formatCurrency, formatPercent } from "../utils/pricing";
import type { PricingResult, Product, ProductSku } from "../types";
import { getErrorMessage } from "../utils/errors";

type PricingResultPageProps = {
  user: User;
};

export function PricingResultPage({ user }: PricingResultPageProps) {
  const { productId: productKey = "" } = useParams();
  const navigate = useNavigate();
  const [product, setProduct] = useState<Product | null>(null);
  const [skuResults, setSkuResults] = useState<
    Array<{ sku: ProductSku; result: PricingResult }>
  >([]);
  const [loading, setLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState("");
  const [emptyItems, setEmptyItems] = useState(false);

  useEffect(() => {
    let active = true;

    async function load() {
      setLoading(true);
      setErrorMessage("");
      setEmptyItems(false);

      try {
        const [nextProduct, settings] = await Promise.all([
          fetchProduct(productKey),
          fetchSettings(user.id),
        ]);
        const routeKey = nextProduct.product_code.trim() || nextProduct.id;
        if (productKey !== routeKey) {
          navigate(getProductRoutePath(nextProduct, "/pricing"), { replace: true });
          return;
        }

        const [nextItems, nextSkus] = await Promise.all([
          fetchProductItems(nextProduct.id),
          fetchProductSkus(nextProduct.id),
        ]);
        const itemsById = Object.fromEntries(
          nextItems.flatMap((item) => (item.id ? [[item.id, item]] : [])),
        );

        const pricedSkus = nextSkus
          .map((sku) => ({
            sku,
            items: sku.component_links.flatMap((link) => {
              const item = itemsById[link.item_id];
              return item ? [{ ...item, quantity: link.quantity }] : [];
            }),
          }))
          .filter(({ items }) => items.length > 0);

        if (pricedSkus.length === 0) {
          if (active) {
            setProduct(nextProduct);
            setEmptyItems(true);
          }
          return;
        }

        const nextSkuResults = pricedSkus.map(({ sku, items }) => ({
          sku,
          result: calculatePricing(nextProduct.package_weight_g, items, settings),
        }));

        if (active) {
          setProduct(nextProduct);
          setSkuResults(nextSkuResults);
        }

        await Promise.all(
          nextSkuResults
            .filter(({ sku }) => sku.id)
            .map(({ sku, result }) =>
              savePricingResult(nextProduct.id, sku.id as string, result),
            ),
        );
      } catch (error) {
        if (active) {
          setErrorMessage(getErrorMessage(error, "加载申报价结果失败"));
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
  }, [navigate, productKey, user.id]);

  if (loading) {
    return <div className="text-sm text-slate-500">加载中...</div>;
  }

  if (errorMessage) {
    return (
      <div className="rounded-md border border-rose-200 bg-rose-50 p-3 text-sm text-rose-700">
        {errorMessage}
      </div>
    );
  }

  if (emptyItems) {
    return (
      <section className="grid gap-4">
        <h1 className="text-2xl font-semibold text-ink">核算定价结果</h1>
        <div className="rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
          暂无组合明细，无法计算核算定价
        </div>
      </section>
    );
  }

  if (!product || skuResults.length === 0) {
    return null;
  }

  return (
    <section className="grid gap-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-ink">核算定价结果</h1>
          <p className="mt-1 text-sm text-slate-500">
            {product.product_code} · {product.product_name_cn}
          </p>
          <p className="mt-1 text-sm text-slate-500">
            在满足目标利润率的前提下，计算核算定价
          </p>
        </div>
        <Link to={getProductRoutePath(product, "/edit")} className="text-sm text-accent">
          编辑商品
        </Link>
      </div>

      <div className="grid gap-5">
        {skuResults.map(({ sku, result }) => {
          const metrics = [
            ["组合采购成本", formatCurrency(result.purchaseCostRmb)],
            ["采购运费", formatCurrency(result.purchaseShippingRmb)],
            ["包装成本", formatCurrency(result.packagingCostRmb)],
            ["顺丰成本", formatCurrency(result.sfCostRmb)],
            ["方案 A：淮安空运 + 大阪海外仓", formatCurrency(result.planA)],
            ["方案 B：淮安空运 + 福冈海外仓", formatCurrency(result.planB)],
            ["方案 C：OCS + 大阪海外仓", formatCurrency(result.planC)],
            ["方案 D：OCS + 福冈海外仓", formatCurrency(result.planD)],
            ["物流成本", formatCurrency(result.logisticsCostRmb)],
            ["总成本", formatCurrency(result.totalCostRmb)],
            ["运费补贴", formatCurrency(result.subsidyRmb)],
            ["核算定价 (RMB)", formatCurrency(result.temuDeclarationPriceRmb)],
            ["利润", formatCurrency(result.profitRmb)],
            ["利润率", formatPercent(result.profitRate)],
          ];

          return (
            <article key={sku.id ?? sku.sku_code} className="grid gap-4">
              <div>
                <h2 className="text-lg font-semibold text-ink">{sku.sku_code}</h2>
                <p className="mt-1 text-sm text-slate-500">
                  {Object.entries(sku.attributes)
                    .map(([name, value]) => `${name}：${value}`)
                    .join(" / ") || "未填写规格"}
                </p>
              </div>
              <div className="grid gap-4 md:grid-cols-3">
                <div className="rounded-lg bg-white p-5 shadow-panel">
                  <p className="text-sm text-slate-500">核算定价 (RMB)</p>
                  <p className="mt-2 text-3xl font-semibold text-ink">
                    {formatCurrency(result.temuDeclarationPriceRmb)}
                  </p>
                </div>
                <div className="rounded-lg bg-white p-5 shadow-panel">
                  <p className="text-sm text-slate-500">利润</p>
                  <p className="mt-2 text-3xl font-semibold text-ink">
                    {formatCurrency(result.profitRmb)}
                  </p>
                </div>
                <div className="rounded-lg bg-white p-5 shadow-panel">
                  <p className="text-sm text-slate-500">利润率</p>
                  <p className="mt-2 text-3xl font-semibold text-ink">
                    {formatPercent(result.profitRate)}
                  </p>
                </div>
              </div>
              <div className="grid gap-4 rounded-lg bg-white p-5 shadow-panel sm:grid-cols-2 xl:grid-cols-3">
                {metrics.map(([label, value]) => (
                  <div key={label} className="rounded-md border border-line p-4">
                    <p className="text-sm text-slate-500">{label}</p>
                    <p className="mt-2 text-lg font-semibold text-ink">{value}</p>
                  </div>
                ))}
              </div>
            </article>
          );
        })}
      </div>
    </section>
  );
}
