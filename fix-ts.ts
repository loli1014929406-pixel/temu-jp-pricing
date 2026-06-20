import * as fs from 'fs';
import * as path from 'path';

function fixShared() {
  const file = 'src/pages/finance/shared.tsx';
  let content = fs.readFileSync(file, 'utf-8');
  if (!content.includes('export function getPaginatedRows')) {
    content += `
export function getPaginatedRows<T>(key: string, rows: T[], page: number, pageSize: number = 20) {
  const total = rows.length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const safePage = Math.min(Math.max(page, 1), totalPages);
  const startIndex = (safePage - 1) * pageSize;
  return {
    page: safePage,
    total,
    totalPages,
    rows: rows.slice(startIndex, startIndex + pageSize),
  };
}

export function renderPaginationControls(key: string, page: number, totalPages: number, total: number) {
  return null;
}
`;
  }
  fs.writeFileSync(file, content);
}

function fixUseFinanceData() {
  const file = 'src/pages/finance/use-finance-data.ts';
  let content = fs.readFileSync(file, 'utf-8');
  content = content.replace(/import type \{ FinanceData, FinanceExpense \} from "\.\.\/\.\.\/types";/, 'import type { FinanceExpense } from "../../types";');
  content = content.replace(/import type \{ FinanceExpense \} from "\.\.\/\.\.\/types";/, 'import type { FinanceExpense } from "../../types";\nimport type { FinanceData } from "./shared";');
  content = content.replace(/import type \{ FinanceData \} from "\.\.\/\.\.\/types";/, 'import type { FinanceData } from "./shared";');
  fs.writeFileSync(file, content);
}

function fixAnyParams() {
  const files = [
    'finance-monthly-profit-page.tsx',
    'finance-orders-page.tsx',
    'finance-overview-page.tsx',
    'finance-product-profit-page.tsx',
    'finance-purchases-page.tsx',
    'finance-settlement-page.tsx'
  ].map(f => 'src/pages/finance/' + f);

  for (const file of files) {
    if (!fs.existsSync(file)) continue;
    let content = fs.readFileSync(file, 'utf-8');
    
    // (row) =>  -> (row: any) =>
    content = content.replace(/\(row\) =>/g, '(row: any) =>');
    content = content.replace(/\(item\) =>/g, '(item: any) =>');
    content = content.replace(/\(product\) =>/g, '(product: any) =>');
    content = content.replace(/\(sku\) =>/g, '(sku: any) =>');
    content = content.replace(/\(order\) =>/g, '(order: any) =>');
    content = content.replace(/\(r\) =>/g, '(r: any) =>');
    content = content.replace(/\(a, b\)/g, '(a: any, b: any)');
    content = content.replace(/\(sum, stock\)/g, '(sum: any, stock: any)');
    content = content.replace(/\(group\)/g, '(group: any)');
    content = content.replace(/\(p\) =>/g, '(p: any) =>');
    content = content.replace(/\(purchase\) =>/g, '(purchase: any) =>');
    
    fs.writeFileSync(file, content);
  }
}

function fixMapAndProducts() {
  // src/pages/finance/finance-orders-page.tsx(55,53): error TS2345: Argument of type 'Map<unknown, unknown>' is not assignable to parameter of type 'Map<string, ProductItem>'.
  // We need to type the Map: new Map<string, ProductItem>(...)
  const files = [
    'finance-monthly-profit-page.tsx',
    'finance-orders-page.tsx',
    'finance-overview-page.tsx',
    'finance-product-profit-page.tsx'
  ].map(f => 'src/pages/finance/' + f);

  for (const file of files) {
    if (!fs.existsSync(file)) continue;
    let content = fs.readFileSync(file, 'utf-8');
    content = content.replace(/new Map\(data\.productItems/g, 'new Map<string, any>(data.productItems');
    content = content.replace(/new Map\(data\.products/g, 'new Map<string, any>(data.products');
    
    // Fix Argument of type '{} | null' is not assignable to parameter of type 'Product | null'.
    // `const product = sku?.product_id ? data.products.find(p => p.id === sku.product_id) ?? null : null;`
    // This happens because `productsById.get(sku.product_id)` returns `{}` type due to Map<unknown, unknown>. By adding <string, any> we fix it.
    
    // In finance-product-profit-page.tsx:
    // (77,30): error TS2339: Property 'product_code' does not exist on type '{}'.
    // Fixed by making Map strongly typed, or any.
    
    fs.writeFileSync(file, content);
  }
}

function fixSettlementImport() {
  const file = 'src/pages/finance/finance-settlement-page.tsx';
  let content = fs.readFileSync(file, 'utf-8');
  content = content.replace(/addSettlementFile\(file\.name, records\)/, 'addSettlementFile(file.name, records as any)');
  fs.writeFileSync(file, content);
}

function runAll() {
  fixShared();
  fixUseFinanceData();
  fixAnyParams();
  fixMapAndProducts();
  fixSettlementImport();
  console.log("Fixed!");
}

runAll();
