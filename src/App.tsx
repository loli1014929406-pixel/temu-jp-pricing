import { Navigate, Route, Routes } from "react-router-dom";
import { PageShell } from "./components/page-shell";
import { ProtectedRoute } from "./components/protected-route";
import { useAuth } from "./hooks/use-auth";
import { AuthPage } from "./pages/auth-page";
import { PricingResultPage } from "./pages/pricing-result-page";
import { ProductCreatePage } from "./pages/product-create-page";
import { ProductEditPage } from "./pages/product-edit-page";
import { ProductsPage } from "./pages/products-page";
import { SettingsPage } from "./pages/settings-page";

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
        <Route path="/settings" element={user ? <SettingsPage user={user} /> : null} />
      </Route>
      <Route path="*" element={<Navigate to="/products" replace />} />
    </Routes>
  );
}
