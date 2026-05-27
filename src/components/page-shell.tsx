import {
  Calculator,
  ClipboardList,
  LogOut,
  PackageSearch,
  Settings,
  ShoppingCart,
  Truck,
  Warehouse,
  ListOrdered,
} from "lucide-react";
import { NavLink, Outlet, useLocation } from "react-router-dom";
import { suppressAutoLogin } from "../lib/auto-login";
import { getSupabaseClient } from "../lib/supabase";

const navItems = [
  { to: "/orders", label: "订单管理", module: "销售履约", icon: ListOrdered },
  { to: "/products", label: "商品管理", module: "商品资料", icon: PackageSearch },
  { to: "/declaration-prices", label: "核算定价", module: "定价中心", icon: ClipboardList },
  { to: "/profit-calculation", label: "利润数据分析", module: "经营分析", icon: Calculator },
  { to: "/test-shipping", label: "直发测算", module: "物流测算", icon: Truck },
  { to: "/purchases/records", label: "采购管理", module: "采购入库", icon: ShoppingCart },
  { to: "/inventory", label: "仓储库存", module: "库存管理", icon: Warehouse },
  { to: "/parameter-settings", label: "参数设置", module: "系统配置", icon: Settings },
] as const;

function getActiveModule(pathname: string) {
  return (
    navItems.find((item) => pathname === item.to || pathname.startsWith(`${item.to}/`)) ??
    navItems[0]
  );
}

export function PageShell() {
  const location = useLocation();
  const activeModule = getActiveModule(location.pathname);

  async function handleSignOut() {
    suppressAutoLogin();
    await getSupabaseClient().auth.signOut();
  }

  return (
    <div className="erp-shell min-h-screen bg-white text-slate-900">
      <aside className="erp-sidebar">
        <NavLink to="/orders" className="erp-sidebar-brand">
          <span className="erp-brand-mark">JP</span>
          <span>Temu JP 运营</span>
        </NavLink>

        <nav className="erp-side-nav" aria-label="主导航">
          <div className="erp-side-section">
            <p className="erp-side-section-title">概览</p>
            {navItems.slice(0, 1).map((item) => {
              const Icon = item.icon;
              return (
                <NavLink
                  key={item.to}
                  to={item.to}
                  className={({ isActive }) =>
                    `erp-side-nav-item ${isActive ? "erp-side-nav-item-active" : ""}`
                  }
                >
                  <Icon size={16} />
                  <span>{item.label}</span>
                </NavLink>
              );
            })}
          </div>

          <div className="erp-side-section">
            <p className="erp-side-section-title">仓库</p>
            {navItems.slice(1, 7).map((item) => {
              const Icon = item.icon;
              return (
                <NavLink
                  key={item.to}
                  to={item.to}
                  className={({ isActive }) =>
                    `erp-side-nav-item ${isActive ? "erp-side-nav-item-active" : ""}`
                  }
                >
                  <Icon size={16} />
                  <span>{item.label}</span>
                </NavLink>
              );
            })}
          </div>

          <div className="erp-side-section">
            <p className="erp-side-section-title">系统</p>
            {navItems.slice(7).map((item) => {
              const Icon = item.icon;
              return (
                <NavLink
                  key={item.to}
                  to={item.to}
                  className={({ isActive }) =>
                    `erp-side-nav-item ${isActive ? "erp-side-nav-item-active" : ""}`
                  }
                >
                  <Icon size={16} />
                  <span>{item.label}</span>
                </NavLink>
              );
            })}
            <button
              type="button"
              aria-label="退出"
              onClick={() => void handleSignOut()}
              className="erp-side-nav-item w-full"
            >
              <LogOut size={16} />
              <span>退出登录</span>
            </button>
          </div>
        </nav>
      </aside>

      <div className="erp-workspace">
        <header className="erp-workspace-topbar">
          <div className="text-sm font-semibold text-slate-950">{activeModule.label}</div>
        </header>

        <main className="erp-main">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
