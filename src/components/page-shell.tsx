import {
  Calculator,
  ClipboardList,
  LogOut,
  Warehouse,
  PackageSearch,
  Settings,
  ShoppingCart,
  Truck,
} from "lucide-react";
import { NavLink, Outlet } from "react-router-dom";
import { getSupabaseClient } from "../lib/supabase";
import { suppressAutoLogin } from "../lib/auto-login";

export function PageShell() {
  async function handleSignOut() {
    suppressAutoLogin();
    await getSupabaseClient().auth.signOut();
  }

  return (
    <div className="min-h-screen bg-mist">
      <header className="border-b border-line bg-white">
        <div className="mx-auto flex max-w-[1360px] flex-col gap-4 px-4 py-4 sm:px-6 lg:flex-row lg:items-center lg:justify-between lg:gap-5">
          <div className="min-w-0">
            <p className="text-base font-semibold text-ink sm:text-lg">Temu日本站运营核算系统</p>
            <p className="text-xs text-slate-500 sm:text-sm">日本站商品、采购、仓储与利润分析一体化运营核算平台</p>
          </div>
          <nav className="-mx-1 flex w-full items-center gap-2 overflow-x-auto px-1 pb-1 lg:mx-0 lg:w-auto lg:justify-end lg:overflow-visible lg:px-0 lg:pb-0">
            <NavLink
              to="/products"
              className={({ isActive }) =>
                `inline-flex h-10 shrink-0 items-center gap-2 whitespace-nowrap rounded-full px-3 text-sm transition ${
                  isActive ? "bg-accent text-white shadow-sm" : "text-slate-600 hover:bg-slate-100"
                }`
              }
            >
              <PackageSearch size={18} />
              商品管理
            </NavLink>
            <NavLink
              to="/declaration-prices"
              className={({ isActive }) =>
                `inline-flex h-10 shrink-0 items-center gap-2 whitespace-nowrap rounded-full px-3 text-sm transition ${
                  isActive ? "bg-accent text-white shadow-sm" : "text-slate-600 hover:bg-slate-100"
                }`
              }
            >
              <ClipboardList size={18} />
              核算定价
            </NavLink>
            <NavLink
              to="/profit-calculation"
              className={({ isActive }) =>
                `inline-flex h-10 shrink-0 items-center gap-2 whitespace-nowrap rounded-full px-3 text-sm transition ${
                  isActive ? "bg-accent text-white shadow-sm" : "text-slate-600 hover:bg-slate-100"
                }`
              }
            >
              <Calculator size={18} />
              利润数据分析
            </NavLink>
            <NavLink
              to="/test-shipping"
              className={({ isActive }) =>
                `inline-flex h-10 shrink-0 items-center gap-2 whitespace-nowrap rounded-full px-3 text-sm transition ${
                  isActive ? "bg-accent text-white shadow-sm" : "text-slate-600 hover:bg-slate-100"
                }`
              }
            >
              <Truck size={18} />
              测试发货
            </NavLink>
            <NavLink
              to="/purchases/records"
              className={({ isActive }) =>
                `inline-flex h-10 shrink-0 items-center gap-2 whitespace-nowrap rounded-full px-3 text-sm transition ${
                  isActive ? "bg-accent text-white shadow-sm" : "text-slate-600 hover:bg-slate-100"
                }`
              }
            >
              <ShoppingCart size={18} />
              采购管理
            </NavLink>
            <NavLink
              to="/inventory"
              className={({ isActive }) =>
                `inline-flex h-10 shrink-0 items-center gap-2 whitespace-nowrap rounded-full px-3 text-sm transition ${
                  isActive ? "bg-accent text-white shadow-sm" : "text-slate-600 hover:bg-slate-100"
                }`
              }
            >
              <Warehouse size={18} />
              仓储库存
            </NavLink>
            <NavLink
              to="/parameter-settings"
              className={({ isActive }) =>
                `inline-flex h-10 shrink-0 items-center gap-2 whitespace-nowrap rounded-full px-3 text-sm transition ${
                  isActive ? "bg-accent text-white shadow-sm" : "text-slate-600 hover:bg-slate-100"
                }`
              }
            >
              <Settings size={18} />
              参数设置
            </NavLink>
            <button
              type="button"
              onClick={() => void handleSignOut()}
              className="inline-flex h-10 shrink-0 items-center gap-2 whitespace-nowrap rounded-full px-3 text-sm text-slate-600 transition hover:bg-slate-100"
            >
              <LogOut size={18} />
              退出
            </button>
          </nav>
        </div>
      </header>
      <main className="mx-auto max-w-[1360px] px-4 py-7 sm:px-6">
        <Outlet />
      </main>
    </div>
  );
}
