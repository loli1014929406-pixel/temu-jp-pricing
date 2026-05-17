import {
  Calculator,
  ClipboardList,
  LogOut,
  PackageSearch,
  Settings,
  Truck,
} from "lucide-react";
import { NavLink, Outlet } from "react-router-dom";
import { getSupabaseClient } from "../lib/supabase";

export function PageShell() {
  return (
    <div className="min-h-screen bg-mist">
      <header className="border-b border-line bg-white">
        <div className="mx-auto flex max-w-7xl items-center justify-between gap-4 px-4 py-4 sm:px-6">
          <div>
            <p className="text-lg font-semibold text-ink">Temu日本站申报核算</p>
            <p className="text-sm text-slate-500">登记商品采购成本与申报价格预估</p>
          </div>
          <nav className="flex items-center gap-2">
            <NavLink
              to="/products"
              className={({ isActive }) =>
                `inline-flex h-10 items-center gap-2 rounded-md px-3 text-sm ${
                  isActive ? "bg-accent text-white" : "text-slate-600 hover:bg-slate-100"
                }`
              }
            >
              <PackageSearch size={18} />
              商品
            </NavLink>
            <NavLink
              to="/declaration-prices"
              className={({ isActive }) =>
                `inline-flex h-10 items-center gap-2 rounded-md px-3 text-sm ${
                  isActive ? "bg-accent text-white" : "text-slate-600 hover:bg-slate-100"
                }`
              }
            >
              <ClipboardList size={18} />
              申报价格
            </NavLink>
            <NavLink
              to="/profit-calculation"
              className={({ isActive }) =>
                `inline-flex h-10 items-center gap-2 rounded-md px-3 text-sm ${
                  isActive ? "bg-accent text-white" : "text-slate-600 hover:bg-slate-100"
                }`
              }
            >
              <Calculator size={18} />
              利润测算
            </NavLink>
            <NavLink
              to="/test-shipping"
              className={({ isActive }) =>
                `inline-flex h-10 items-center gap-2 rounded-md px-3 text-sm ${
                  isActive ? "bg-accent text-white" : "text-slate-600 hover:bg-slate-100"
                }`
              }
            >
              <Truck size={18} />
              测试阶段发货
            </NavLink>
            <NavLink
              to="/settings"
              className={({ isActive }) =>
                `inline-flex h-10 items-center gap-2 rounded-md px-3 text-sm ${
                  isActive ? "bg-accent text-white" : "text-slate-600 hover:bg-slate-100"
                }`
              }
            >
              <Settings size={18} />
              参数
            </NavLink>
            <button
              type="button"
              onClick={() => void getSupabaseClient().auth.signOut()}
              className="inline-flex h-10 items-center gap-2 rounded-md px-3 text-sm text-slate-600 hover:bg-slate-100"
            >
              <LogOut size={18} />
              退出
            </button>
          </nav>
        </div>
      </header>
      <main className="mx-auto max-w-7xl px-4 py-6 sm:px-6">
        <Outlet />
      </main>
    </div>
  );
}
