import { Suspense, lazy } from "react";
import { Link, Navigate, Route, Routes } from "react-router-dom";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { PageShell } from "./components/page-shell";
import { ProtectedRoute } from "./components/protected-route";
import { DataTableCellFullText } from "./components/ui/DataTableCellFullText";
import { NotificationCenter } from "./components/ui/notification-center";
import { useAuth } from "./hooks/use-auth";
import { PermissionGate, PermissionProvider } from "./hooks/use-permissions";
import { AuthPage } from "./pages/auth-page";
const DeclarationPricesPage = lazy(() => import('./pages/declaration-prices-page').then(module => ({ default: module.DeclarationPricesPage })));
const FinanceOverviewPage = lazy(() => import('./pages/finance/finance-overview-page').then(module => ({ default: module.FinanceOverviewPage })));
const FinanceLedgerPage = lazy(() => import('./pages/finance/finance-ledger-page').then(module => ({ default: module.FinanceLedgerPage })));
const FinanceExpensesPage = lazy(() => import('./pages/finance/finance-expenses-page').then(module => ({ default: module.FinanceExpensesPage })));
const FinanceProfitPage = lazy(() => import('./pages/finance/finance-profit-page').then(module => ({ default: module.FinanceProfitPage })));
const FinanceSettlementPage = lazy(() => import('./pages/finance/finance-settlement-page').then(module => ({ default: module.FinanceSettlementPage })));
const InventoryPage = lazy(() => import('./pages/inventory-page').then(module => ({ default: module.InventoryPage })));
const InventoryTransferPage = lazy(() => import('./pages/inventory-transfer-page').then(module => ({ default: module.InventoryTransferPage })));
const OrdersPage = lazy(() => import('./pages/orders-page').then(module => ({ default: module.OrdersPage })));
const MultiShipmentProfitPage = lazy(() => import('./pages/multi-shipment-profit-page').then(module => ({ default: module.MultiShipmentProfitPage })));
const MultiShipmentProductsPage = lazy(() => import('./pages/multi-shipment-products-page').then(module => ({ default: module.MultiShipmentProductsPage })));
const ProfitCalculationPage = lazy(() => import('./pages/profit-calculation-page').then(module => ({ default: module.ProfitCalculationPage })));
const ProfitCalculationsPage = lazy(() => import('./pages/profit-calculations-page').then(module => ({ default: module.ProfitCalculationsPage })));
const PromotionRecommendationsPage = lazy(() => import('./pages/promotion-recommendations-page').then(module => ({ default: module.PromotionRecommendationsPage })));
const PricingResultPage = lazy(() => import('./pages/pricing-result-page').then(module => ({ default: module.PricingResultPage })));
const ProductCreatePage = lazy(() => import('./pages/product-create-page').then(module => ({ default: module.ProductCreatePage })));
const ProductEditPage = lazy(() => import('./pages/product-edit-page').then(module => ({ default: module.ProductEditPage })));
const ProductsPage = lazy(() => import('./pages/products-page').then(module => ({ default: module.ProductsPage })));
const PurchasesPage = lazy(() => import('./pages/purchases-page').then(module => ({ default: module.PurchasesPage })));
const SettingsPage = lazy(() => import('./pages/settings-page').then(module => ({ default: module.SettingsPage })));
const TestShippingPage = lazy(() => import('./pages/test-shipping-page').then(module => ({ default: module.TestShippingPage })));
const UserPage = lazy(() => import('./pages/user-page').then(module => ({ default: module.UserPage })));

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

  return (
    <ErrorBoundary>
      <DataTableCellFullText />
      <NotificationCenter />
      <Suspense
        fallback={
          <div className="flex h-screen items-center justify-center">
            <div className="flex flex-col items-center gap-3">
              <div className="h-8 w-8 animate-spin rounded-full border-4 border-slate-200 border-t-accent" />
              <span className="text-sm font-medium text-slate-400">加载中…</span>
            </div>
          </div>
        }
      >
        <Routes>
        <Route path="/login" element={<AuthPage user={user} />} />
        <Route
          element={
            <ProtectedRoute user={user} loading={loading}>
              <PermissionProvider user={user}>
                <PageShell user={user} />
              </PermissionProvider>
            </ProtectedRoute>
          }
        >
          <Route index element={<Navigate to="/orders" replace />} />
          <Route path="/user" element={user ? <UserPage /> : null} />
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
          <Route path="/finance" element={user ? <FinanceOverviewPage user={user} /> : null} />
          <Route path="/finance/ledger" element={user ? <FinanceLedgerPage user={user} /> : null} />
          <Route path="/finance/books" element={<Navigate to="/finance/ledger" replace />} />
          <Route path="/finance/cashflow" element={<Navigate to="/finance/ledger" replace />} />
          <Route path="/finance/reconciliation" element={<Navigate to="/finance/settlement" replace />} />
          <Route path="/finance/expenses" element={user ? <FinanceExpensesPage user={user} /> : null} />
          <Route path="/finance/profit" element={user ? <FinanceProfitPage user={user} /> : null} />
          <Route path="/finance/settlement" element={user ? <FinanceSettlementPage user={user} /> : null} />
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
      </Suspense>
    </ErrorBoundary>
  );
}
