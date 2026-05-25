import {
  BarChart3,
  Calculator,
  ClipboardList,
  Database,
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
  { to: "/test-shipping", label: "测试发货", module: "物流测算", icon: Truck },
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
    <div className="erp-shell min-h-screen bg-slate-100 text-slate-900">
      <header className="erp-topbar">
        <div className="mx-auto flex h-full max-w-[1480px] items-center justify-between gap-4 px-4 sm:px-6">
          <NavLink to="/orders" className="flex min-w-0 items-center gap-3">
            <span className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-slate-900 text-white shadow-soft">
              <Database size={20} />
            </span>
            <span className="min-w-0">
              <span className="block truncate text-sm font-bold text-slate-950 sm:text-base">
                Temu日本站运营核算系统
              </span>
              <span className="block truncate text-xs font-medium text-slate-500">
                ERP Operations Console
              </span>
            </span>
          </NavLink>

          <div className="hidden min-w-0 flex-1 justify-center lg:flex">
            <div className="erp-command-bar">
              <BarChart3 size={16} />
              <span className="truncate">
                当前模块：{activeModule.module} / {activeModule.label}
              </span>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <span className="hidden rounded-full border border-emerald-200 bg-emerald-50 px-3 py-1 text-xs font-semibold text-emerald-700 sm:inline-flex">
              Online
            </span>
            <button
              type="button"
              aria-label="退出"
              onClick={() => void handleSignOut()}
              className="erp-icon-action"
            >
              <LogOut size={17} />
              <span className="hidden sm:inline">退出</span>
            </button>
          </div>
        </div>
      </header>

      <nav className="erp-module-nav">
        <div className="mx-auto flex max-w-[1480px] gap-2 overflow-x-auto px-4 py-2 sm:px-6">
          {navItems.map((item) => {
            const Icon = item.icon;
            return (
              <NavLink
                key={item.to}
                to={item.to}
                className={({ isActive }) =>
                  `erp-nav-item ${isActive ? "erp-nav-item-active" : ""}`
                }
              >
                <Icon size={16} />
                <span>{item.label}</span>
              </NavLink>
            );
          })}
        </div>
      </nav>

      <section className="erp-page-context">
        <div className="mx-auto flex max-w-[1480px] flex-col gap-3 px-4 py-4 sm:px-6 lg:flex-row lg:items-center lg:justify-between">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.2em] text-slate-500">
              {activeModule.module}
            </p>
            <h1 className="mt-1 text-2xl font-semibold tracking-normal text-slate-950">
              {activeModule.label}
            </h1>
          </div>
          <div className="grid grid-cols-3 gap-2 text-xs sm:w-auto sm:min-w-[360px]">
            <div className="erp-context-metric">
              <span>业务流</span>
              <strong>订单 → 库存</strong>
            </div>
            <div className="erp-context-metric">
              <span>分析层</span>
              <strong>利润 / 风险</strong>
            </div>
            <div className="erp-context-metric">
              <span>数据源</span>
              <strong>Supabase</strong>
            </div>
          </div>
        </div>
      </section>

      <main className="mx-auto w-full max-w-[1480px] px-4 py-5 sm:px-6 lg:py-6">
        <Outlet />
      </main>

      <footer className="border-t border-slate-200 bg-white px-4 py-4 sm:px-6">
        <div className="mx-auto flex max-w-[1480px] flex-col gap-2 text-xs text-slate-500 sm:flex-row sm:items-center sm:justify-between">
          <span>Temu日本站运营核算系统</span>
          <span>企业级运营数据控制台 · 商品 / 订单 / 采购 / 库存 / 利润</span>
        </div>
      </footer>
    </div>
  );
}
