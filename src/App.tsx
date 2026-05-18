import { Navigate, Route, Routes } from "react-router-dom";
import { PageShell } from "./components/page-shell";
import { ProtectedRoute } from "./components/protected-route";
import { useAuth } from "./hooks/use-auth";
import { AuthPage } from "./pages/auth-page";
import { DeclarationPricesPage } from "./pages/declaration-prices-page";
import { InventoryPage } from "./pages/inventory-page";
import { ProfitCalculationPage } from "./pages/profit-calculation-page";
import { ProfitCalculationsPage } from "./pages/profit-calculations-page";
import { PricingResultPage } from "./pages/pricing-result-page";
import { ProductCreatePage } from "./pages/product-create-page";
import { ProductEditPage } from "./pages/product-edit-page";
import { ProductsPage } from "./pages/products-page";
import { PurchasesPage } from "./pages/purchases-page";
import { SettingsPage } from "./pages/settings-page";
import { TestShippingPage } from "./pages/test-shipping-page";

export default function App() {
  const { user, loading } = useAuth();

  return (
    <Routes>
      <Route path="/auth" element={<AuthPage user={user} />} />
      <Route
        element={
          <ProtectedRoute user={user} loading={loading}>
            <PageShell />
          </ProtectedRoute>
        }
      >
        <Route index element={<Navigate to="/products" replace />} />
        <Route path="/products" element={user ? <ProductsPage user={user} /> : null} />
        <Route
          path="/products/new"
          element={user ? <ProductCreatePage user={user} /> : null}
        />
        <Route path="/products/:productId/edit" element={<ProductEditPage />} />
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
          element={user ? <ProfitCalculationsPage user={user} /> : null}
        />
        <Route path="/test-shipping" element={user ? <TestShippingPage user={user} /> : null} />
        <Route path="/purchases" element={<Navigate to="/purchases/records" replace />} />
        <Route path="/purchases/new" element={user ? <PurchasesPage user={user} view="create" /> : null} />
        <Route path="/purchases/records" element={user ? <PurchasesPage user={user} view="records" /> : null} />
        <Route path="/inventory" element={user ? <InventoryPage user={user} /> : null} />
        <Route
          path="/products/:productId/profit-calculation"
          element={user ? <ProfitCalculationPage user={user} /> : null}
        />
        <Route path="/settings" element={user ? <SettingsPage user={user} /> : null} />
      </Route>
      <Route path="*" element={<Navigate to="/products" replace />} />
    </Routes>
  );
}
