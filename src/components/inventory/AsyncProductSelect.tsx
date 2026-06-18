import { useState, useEffect, useRef } from "react";
import type { Product } from "../../types";
import { searchProducts } from "../../lib/products";

type AsyncProductSelectProps = {
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
};

export function AsyncProductSelect({ value, onChange, disabled }: AsyncProductSelectProps) {
  const [keyword, setKeyword] = useState("");
  const [options, setOptions] = useState<Product[]>([]);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleOutsideClick = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handleOutsideClick);
    return () => document.removeEventListener("mousedown", handleOutsideClick);
  }, []);

  useEffect(() => {
    if (!keyword.trim()) {
      setOptions([]);
      return;
    }

    let active = true;
    const timer = setTimeout(async () => {
      setLoading(true);
      try {
        const results = await searchProducts(keyword, 20);
        if (active) setOptions(results);
      } catch (err) {
        console.error("搜索商品失败", err);
      } finally {
        if (active) setLoading(false);
      }
    }, 300);

    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [keyword]);


  useEffect(() => {
    let active = true;
    if (value && !options.find((o) => o.id === value)) {
      import("../../lib/products").then(({ fetchProductsByIds }) => {
        fetchProductsByIds([value]).then((products) => {
          if (active && products.length > 0) {
            setOptions((curr) => [...curr, products[0]]);
          }
        }).catch(() => {
          // ignore error gracefully
        });
      });
    }
    return () => { active = false; };
  }, [value, options]);

  const selectedProduct = options.find((o) => o.id === value);
  const displayValue = selectedProduct
    ? `${selectedProduct.product_code} · ${selectedProduct.product_name_cn}`
    : value ? "已选择商品" : "";

  return (
    <div className="relative" ref={containerRef}>
      <input
        type="text"
        placeholder="输入商品编号或名称搜索..."
        disabled={disabled}
        value={open ? keyword : displayValue}
        onChange={(e) => {
          setKeyword(e.target.value);
          setOpen(true);
          onChange(""); // clear selection when typing
        }}
        onFocus={() => setOpen(true)}
        className="h-11 w-full rounded-xl border border-line bg-white px-3 text-sm outline-none transition focus:border-accent focus:ring-2 focus:ring-accent/20"
      />
      {loading && (
        <div className="absolute right-3 top-3 text-xs text-slate-400">搜索中...</div>
      )}
      {open && keyword.trim() && !loading && (
        <ul className="absolute z-10 mt-1 max-h-60 w-full overflow-auto rounded-md border border-line bg-white py-1 shadow-lg">
          {options.length === 0 ? (
            <li className="px-3 py-2 text-sm text-slate-500">无匹配商品</li>
          ) : (
            options.map((product) => (
              <li
                key={product.id}
                onClick={() => {
                  onChange(product.id);
                  setKeyword("");
                  setOpen(false);
                }}
                className="cursor-pointer px-3 py-2 text-sm hover:bg-slate-50"
              >
                {product.product_code} · {product.product_name_cn}
              </li>
            ))
          )}
        </ul>
      )}
    </div>
  );
}
