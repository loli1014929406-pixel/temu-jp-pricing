const fs = require('fs');
let code = fs.readFileSync('src/App.tsx', 'utf8');

// 1. Add lazy, Suspense imports
code = code.replace(
  /import \{ Link, Navigate, Route, Routes \} from "react-router-dom";/g,
  `import { Suspense, lazy } from "react";\nimport { Link, Navigate, Route, Routes } from "react-router-dom";`
);

// 2. Extract import statements to replace with lazy
const importRegex = /import \{ ([A-Za-z0-9_]+) \} from "\.\/pages\/([^"]+)";/g;
let match;
const importsToReplace = [];

// Skip AuthPage
const skipPages = ['AuthPage'];

while ((match = importRegex.exec(code)) !== null) {
  const compName = match[1];
  const path = match[2];
  if (!skipPages.includes(compName)) {
    importsToReplace.push({ fullMatch: match[0], compName, path });
  }
}

for (const { fullMatch, compName, path } of importsToReplace) {
  code = code.replace(
    fullMatch,
    `const ${compName} = lazy(() => import('./pages/${path}').then(module => ({ default: module.${compName} })));`
  );
}

// 3. Wrap routes inside PageShell with Suspense.
const fallback = `<Suspense fallback={<div className="flex h-full items-center justify-center"><div className="text-sm text-slate-500">加载中...</div></div>}>`;

code = code.replace(
  /<Route index element=\{isOrdersSubdomain \? <Navigate to="\/orders" replace \/> : <NotFoundPage \/>\} \/>/g,
  fallback + "\n          <Route index element={isOrdersSubdomain ? <Navigate to=\"/orders\" replace /> : <NotFoundPage />} />"
);

// Close Suspense right before the closing </Route> of PageShell
code = code.replace(
  /        <\/Route>\n      <\/Routes>/g,
  `        </Suspense>\n        </Route>\n      </Routes>`
);

fs.writeFileSync('src/App.tsx', code, 'utf8');
console.log('App.tsx updated');
