import { Link, Navigate, Route, Routes } from "react-router-dom";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { PageShell } from "./components/page-shell";
import { ProtectedRoute } from "./components/protected-route";
import { useAuth } from "./hooks/use-auth";
import { PermissionGate, PermissionProvider } from "./hooks/use-permissions";
import { AuthPage } from "./pages/auth-page";
import { DeclarationPricesPage } from "./pages/declaration-prices-page";
import { InventoryPage } from "./pages/inventory-page";
import { InventoryTransferPage } from "./pages/inventory-transfer-page";
import { OrdersPage } from "./pages/orders-page";
import { MultiShipmentProfitPage } from "./pages/multi-shipment-profit-page";
import { MultiShipmentProductsPage } from "./pages/multi-shipment-products-page";
import { ProfitCalculationPage } from "./pages/profit-calculation-page";
import { ProfitCalculationsPage } from "./pages/profit-calculations-page";
import { PromotionRecommendationsPage } from "./pages/promotion-recommendations-page";
import { PricingResultPage } from "./pages/pricing-result-page";
import { ProductCreatePage } from "./pages/product-create-page";
import { ProductEditPage } from "./pages/product-edit-page";
import { ProductsPage } from "./pages/products-page";
import { PurchasesPage } from "./pages/purchases-page";
import { SettingsPage } from "./pages/settings-page";
import { TestShippingPage } from "./pages/test-shipping-page";

function NotFoundPage() {
  return (
    <section className="grid gap-3 rounded-lg bg-white p-6 shadow-panel">
      <h1 className="text-xl font-semibold text-ink">页面不存在</h1>
      <p className="text-sm text-slate-500">请从上方菜单进入需要的功能页面。</p>
      <Link className="text-sm font-medium text-accent" to="/products">
        返回商品管理
      </Link>
    </section>
  );
}

export default function App() {
  const { user, loading } = useAuth();
  const isOrdersSubdomain =
    typeof window !== "undefined" && window.location.hostname.split(".")[0] === "orders";

  return (
    <ErrorBoundary>
      <Routes>
        <Route path="/login" element={<AuthPage user={user} />} />
        <Route
          element={
            <ProtectedRoute user={user} loading={loading}>
              <PermissionProvider user={user}>
                <PageShell />
              </PermissionProvider>
            </ProtectedRoute>
          }
        >
          <Route index element={isOrdersSubdomain ? <Navigate to="/orders" replace /> : <NotFoundPage />} />
          <Route path="/products" element={user ? <ProductsPage user={user} /> : null} />
          <Route
            path="/orders"
            element={
              user ? (
                <ErrorBoundary>
                  <OrdersPage user={user} />
                </ErrorBoundary>
              ) : null
            }
          />
          <Route
            path="/products/new"
            element={
              user ? (
                <PermissionGate action="edit">
                  <ProductCreatePage user={user} />
                </PermissionGate>
              ) : null
            }
          />
          <Route
            path="/products/:productId/edit"
            element={
              <PermissionGate action="edit">
                <ProductEditPage />
              </PermissionGate>
            }
          />
          <Route
            path="/products/:productId/pricing"
            element={user ? <PricingResultPage user={user} /> : null}
          />
          <Route
            path="/declaration-prices"
            element={user ? <DeclarationPricesPage user={user} /> : null}
          />
          <Route
            path="/profit-calculation"
            element={
              user ? (
                <ErrorBoundary>
                  <ProfitCalculationsPage user={user} />
                </ErrorBoundary>
              ) : null
            }
          />
          <Route
            path="/profit-calculation/direct-shipping/:productKey"
            element={user ? <MultiShipmentProfitPage user={user} mode="direct" /> : null}
          />
          <Route
            path="/profit-calculation/direct-shipping"
            element={user ? <MultiShipmentProductsPage user={user} mode="direct" /> : null}
          />
          <Route
            path="/profit-calculation/standard-shipping/:productKey"
            element={user ? <MultiShipmentProfitPage user={user} mode="standard" /> : null}
          />
          <Route
            path="/profit-calculation/standard-shipping"
            element={user ? <MultiShipmentProductsPage user={user} mode="standard" /> : null}
          />
          <Route
            path="/profit-calculation/recommendations"
            element={user ? <PromotionRecommendationsPage user={user} /> : null}
          />
          <Route path="/test-shipping" element={user ? <TestShippingPage user={user} /> : null} />
          <Route
            path="/purchases/new"
            element={
              user ? (
                <PermissionGate action="edit">
                  <PurchasesPage user={user} view="create" />
                </PermissionGate>
              ) : null
            }
          />
          <Route path="/purchases/records" element={user ? <PurchasesPage user={user} view="records" /> : null} />
          <Route
            path="/inventory"
            element={
              user ? (
                <ErrorBoundary>
                  <InventoryPage user={user} />
                </ErrorBoundary>
              ) : null
            }
          />
          <Route
            path="/inventory/transfer"
            element={
              user ? (
                <ErrorBoundary>
                  <InventoryTransferPage user={user} />
                </ErrorBoundary>
              ) : null
            }
          />
          <Route
            path="/inventory/:warehouseSlug"
            element={
              user ? (
                <ErrorBoundary>
                  <InventoryPage user={user} />
                </ErrorBoundary>
              ) : null
            }
          />
          <Route
            path="/products/:productId/profit-calculation"
            element={user ? <ProfitCalculationPage user={user} /> : null}
          />
          <Route path="/parameter-settings" element={user ? <SettingsPage user={user} /> : null} />
          <Route path="*" element={<NotFoundPage />} />
        </Route>
      </Routes>
    </ErrorBoundary>
  );
}
