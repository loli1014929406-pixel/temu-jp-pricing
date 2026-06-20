import type { User } from "@supabase/supabase-js";
import { ArrowRight } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { BackToParentAction, Badge, PageHeader, StatCard, StandardTable } from "../components/ui";
import { fetchProducts, getProductRouteKey } from "../lib/products";
import { getPaginatedRows } from "./finance/shared";
import type { Product } from "../types";
import { getErrorMessage } from "../utils/errors";
import { useAutoDismiss } from "../hooks/use-auto-dismiss";
import {
  getProductThreeCmUnavailableReason,
  type MultiShipmentMode,
} from "../utils/multi-shipment-profit";

type MultiShipmentProductsPageProps = {
  user: User;
  mode: MultiShipmentMode;
};

const modeContent = {
  direct: {
    title: "多件直发测算",
    description: "选择商品后查看每个 SKU 多件直发时的利润和亏损停止点。",
    detailLabel: "直发详情",
    fallbackTo: "/test-shipping",
    routeSegment: "direct-shipping",
  },
  standard: {
    title: "多件正常发货测算",
    description: "选择商品后查看每个 SKU 多件正常发货时的利润和亏损停止点；3cm 内引用利润页物流成本。",
    detailLabel: "正常发货详情",
    fallbackTo: "/profit-calculation",
    routeSegment: "standard-shipping",
  },
} as const;

function getDetailPath(product: Pick<Product, "id" | "product_code">, mode: MultiShipmentMode) {
  return `/profit-calculation/${modeContent[mode].routeSegment}/${getProductRouteKey(product)}`;
}

export function MultiShipmentProductsPage({
  user,
  mode,
}: MultiShipmentProductsPageProps) {
  const [products, setProducts] = useState<Product[]>([]);
  const [loading, setLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState("");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const content = modeContent[mode];
  useAutoDismiss(errorMessage, () => setErrorMessage(""));

  useEffect(() => {
    setPage(1);
  }, [pageSize]);

  useEffect(() => {
    let active = true;

    async function load() {
      setLoading(true);
      setErrorMessage("");

      try {
        const nextProducts = await fetchProducts();
        if (active) setProducts(nextProducts);
      } catch (error) {
        if (active) {
          setErrorMessage(getErrorMessage(error, "加载多件测算商品失败"));
        }
      } finally {
        if (active) setLoading(false);
      }
    }

    void load();
    return () => {
      active = false;
    };
  }, [user.id]);

  const threeCmProducts = useMemo(
    () =>
      products.filter((product) => !getProductThreeCmUnavailableReason(product))
        .length,
    [products],
  );

  const paginatedProducts = useMemo(() => {
    return getPaginatedRows("multi-shipment-products", products, page, pageSize);
  }, [products, page, pageSize]);

  return (
    <section className="flex flex-col gap-6 p-4 sm:p-6">
      <PageHeader
        title={content.title}
        description={content.description}
        actions={<BackToParentAction fallbackTo={content.fallbackTo} />}
      />

      {errorMessage && (
        <div className="rounded-md border border-rose-200 bg-rose-50 p-3 text-sm text-rose-700">
          {errorMessage}
        </div>
      )}

      <section className="grid gap-3 sm:grid-cols-3 rounded-lg bg-panel p-5 shadow-soft">
        <StatCard label="商品数" value={String(products.length)} />
        <StatCard label="3cm 可用商品" value={String(threeCmProducts)} />
        <StatCard
          label="需用小包商品"
          value={String(Math.max(products.length - threeCmProducts, 0))}
        />
      </section>

      <div className="grid gap-3 md:hidden">
        {loading ? (
          <div className="empty-state">加载中...</div>
        ) : products.length === 0 ? (
          <div className="empty-state">暂无商品</div>
        ) : (
          products.map((product) => (
            <article key={product.id} className="mobile-summary-card">
              <div className="flex items-start justify-between gap-2">
                <div>
                  <p className="mobile-summary-title">{product.product_code}</p>
                  <p className="mobile-summary-subtitle">{product.product_name_cn}</p>
                </div>
                {getProductThreeCmUnavailableReason(product) ? (
                  <Badge tone="warning">需小包</Badge>
                ) : (
                  <Badge tone="success">3cm 可用</Badge>
                )}
              </div>
              <div className="mobile-summary-grid">
                <div className="mobile-summary-cell">
                  重量：{product.package_weight_g}g
                </div>
                <div className="mobile-summary-cell">
                  3cm 每包：{product.max_units_per_parcel}
                </div>
              </div>
              <div className="mobile-summary-actions">
                <Link className="text-action" to={getDetailPath(product, mode)}>
                  {content.detailLabel}
                </Link>
              </div>
            </article>
          ))
        )}
      </div>

      <div className="table-card hidden md:block rounded-lg shadow-soft overflow-hidden bg-panel">
        <div className="overflow-x-auto">
          <StandardTable
            page={paginatedProducts.page}
            pageSize={pageSize}
            totalPages={paginatedProducts.totalPages}
            totalRecordCount={paginatedProducts.total}
            onPageChange={setPage}
            onPageSizeChange={setPageSize}
          >
            <thead>
              <tr>
                <th className="bg-slate-50 px-4 py-3 font-medium">商品编号</th>
                <th className="bg-slate-50 px-4 py-3 text-left font-medium text-slate-500">产品名称</th>
                <th className="bg-slate-50 px-4 py-3 font-medium">包装尺寸</th>
                <th className="bg-slate-50 px-4 py-3 font-medium">重量</th>
                <th className="bg-slate-50 px-4 py-3 font-medium">3cm 每包</th>
                <th className="bg-slate-50 px-4 py-3 font-medium">3cm状态</th>
                <th className="bg-slate-50 px-4 py-3 font-medium">操作</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line bg-white">
              {paginatedProducts.rows.map((product) => (
                  <tr key={product.id}>
                    <td className="px-4 py-3">{product.product_code}</td>
                    <td className="product-name-col px-4 py-3">{product.product_name_cn}</td>
                    <td className="px-4 py-3">
                      {product.package_length_cm} × {product.package_width_cm} × {product.package_height_cm} cm
                    </td>
                    <td className="number-cell">{product.package_weight_g}g</td>
                    <td className="number-cell">{product.max_units_per_parcel}</td>
                    <td className="px-4 py-3">
                      {getProductThreeCmUnavailableReason(product) ? (
                        <Badge tone="warning">
                          {getProductThreeCmUnavailableReason(product)}
                        </Badge>
                      ) : (
                        <Badge tone="success">3cm 可用</Badge>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <Link
                        className="inline-flex items-center gap-1 whitespace-nowrap text-sm font-semibold text-sky-700 transition hover:text-sky-900 hover:underline"
                        to={getDetailPath(product, mode)}
                      >
                        {content.detailLabel}
                        <ArrowRight size={14} />
                      </Link>
                    </td>
                  </tr>
                ))}
            </tbody>
          </StandardTable>
        </div>
      </div>
    </section>
  );
}
