const fs = require('fs');
const content = fs.readFileSync('src/pages/purchases-page.tsx', 'utf8');
const lines = content.split(/\r?\n/);
const goodLines = lines.slice(0, 1973);
const suffix = `
      {receiveConfirmOrder && (() => {
        const remainingItems = getRemainingSourceItems(
          receiveConfirmOrder.items,
          getReceivedQuantityByOrderItem(receiveConfirmOrder),
        );
        return (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4 backdrop-blur-sm">
            <div className="grid w-full max-w-4xl max-h-[90vh] grid-rows-[auto_minmax(0,1fr)_auto] gap-4 rounded-2xl bg-white p-6 shadow-xl">
              <div>
                <h2 className="text-xl font-bold text-ink">确认签收入库</h2>
                <p className="mt-1 text-sm text-slate-500">
                  采购单 {receiveConfirmOrder.order_code} 的剩余未签收明细如下，请核对并填写本次实到的数量（如果缺货请改为 0）：
                </p>
              </div>
              
              <div className="overflow-y-auto rounded-xl border border-line bg-white">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>商品</th>
                      <th>配件</th>
                      <th>规格</th>
                      <th className="number-cell">未收数量</th>
                      <th className="number-cell w-32">本次签收</th>
                    </tr>
                  </thead>
                  <tbody>
                    {remainingItems.map((item) => (
                      <tr key={item.id}>
                        <td>
                          <div className="font-semibold text-ink">{item.product_code}</div>
                          <div className="mt-0.5 text-xs text-slate-500">{item.product_name_cn}</div>
                        </td>
                        <td>{item.item_name}</td>
                        <td>{item.item_spec || "--"}</td>
                        <td className="number-cell font-bold text-slate-500">{item.quantity}</td>
                        <td className="p-2 align-middle text-right">
                          <TextInput
                            type="number"
                            min="0"
                            max={item.quantity}
                            value={receiveQuantities[item.id] ?? ""}
                            onChange={(e) => {
                              const val = e.target.value;
                              setReceiveQuantities(prev => ({ ...prev, [item.id]: val }));
                            }}
                            className="text-right h-9 w-24 ml-auto"
                          />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <div className="flex items-center justify-end gap-3 pt-2">
                <button
                  type="button"
                  onClick={() => setReceiveConfirmOrder(null)}
                  className="btn-secondary h-11 px-6"
                >
                  取消
                </button>
                <button
                  type="button"
                  disabled={busyKey === \`receive-order-\${receiveConfirmOrder.id}\`}
                  onClick={() => void handleReceiveCustomOrder(receiveConfirmOrder)}
                  className="btn-primary h-11 px-6 bg-emerald-600 hover:bg-emerald-700"
                >
                  <CheckCircle2 size={18} />
                  {busyKey === \`receive-order-\${receiveConfirmOrder.id}\` ? "处理中..." : "确认无误，提交签收"}
                </button>
              </div>
            </div>
          </div>
        );
      })()}
    </section>
  );
}
`;
fs.writeFileSync('src/pages/purchases-page.tsx', goodLines.join('\n') + suffix);
