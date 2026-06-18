import { createClient } from "@supabase/supabase-js";

const supabaseUrl = process.env.VITE_SUPABASE_URL;
const supabaseKey = process.env.VITE_SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.error("缺少 VITE_SUPABASE_URL 或 VITE_SUPABASE_ANON_KEY 环境变量");
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);

async function signIn() {
  const email = process.env.VITE_AUTO_LOGIN_EMAIL;
  const password = process.env.VITE_AUTO_LOGIN_PASSWORD;
  if (!email || !password) {
    throw new Error("缺少测试账号的环境变量");
  }
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) throw error;
  console.log("✅ 测试账号登录成功");
  return data.session;
}

async function runConcurrencyTest() {
  await signIn();

  console.log("\n--- 准备隔离的测试数据 ---");

  let tempWarehouseId = null;
  let tempProductId = null;

  try {
    // 1. 插入独立的测试用例（虚拟仓库、产品、配件）避免污染真实数据
    console.log("⏳ 正在创建虚拟仓库和虚拟配件...");
    const { data: warehouseData, error: wError } = await supabase
      .from("warehouses")
      .insert({ name: "并发测试专用临时仓库" })
      .select("id")
      .single();
    if (wError) throw new Error("创建测试仓库失败: " + wError.message);
    tempWarehouseId = warehouseData.id;

    const { data: productData, error: pError } = await supabase
      .from("products")
      .insert({
        product_code: `TEST-RPC-${Date.now()}`,
        product_name_cn: "RPC并发测试专用产品",
        combo_name: "测试规格",
        combo_description: "测试",
        title_jp: "Test Product",
      })
      .select("id")
      .single();
    if (pError) throw new Error("创建测试产品失败: " + pError.message);
    tempProductId = productData.id;

    const { data: itemData, error: iError } = await supabase
      .from("product_items")
      .insert({
        product_id: tempProductId,
        item_name: "并发测试虚拟配件",
      })
      .select("id")
      .single();
    if (iError) throw new Error("创建测试配件失败: " + iError.message);

    // 2. 初始化测试库存为 5 件
    const TEST_STOCK = 5;
    const { data: stockData, error: sError } = await supabase
      .from("warehouse_item_stocks")
      .insert({
        warehouse_id: tempWarehouseId,
        item_id: itemData.id,
        stock_quantity: TEST_STOCK,
      })
      .select("id")
      .single();
    if (sError) throw new Error("初始化测试库存失败: " + sError.message);

    const stockId = stockData.id;
    console.log(`📌 虚拟库存记录已就绪 (ID: ${stockId})`);
    console.log(`📌 初始测试库存数量: ${TEST_STOCK}`);

    console.log("\n🚀 触发 3 个并发请求：分别尝试扣减 2件、3件、4件");
    
    // 3. 构造 3 个并发请求
    const req1 = supabase.rpc("deduct_inventory_atomic", {
      order_groups: [
        {
          groupId: "test-order-2",
          deductions: [{ stockId, quantity: 2, reason: "并发测试-尝试扣2件" }],
        },
      ],
    });

    const req2 = supabase.rpc("deduct_inventory_atomic", {
      order_groups: [
        {
          groupId: "test-order-3",
          deductions: [{ stockId, quantity: 3, reason: "并发测试-尝试扣3件" }],
        },
      ],
    });

    const req3 = supabase.rpc("deduct_inventory_atomic", {
      order_groups: [
        {
          groupId: "test-order-4",
          deductions: [{ stockId, quantity: 4, reason: "并发测试-尝试扣4件" }],
        },
      ],
    });

    // 4. 并发执行并捕获结果
    const results = await Promise.allSettled([req1, req2, req3]);
    
    let successTotal = 0;
    console.log("\n📊 并发请求返回结果：");
    results.forEach((res, index) => {
      const qty = [2, 3, 4][index];
      if (res.status === "fulfilled" && !res.value.error) {
        const data = res.value.data;
        if (data && data.failures && data.failures.length > 0) {
          console.log(`❌ 请求扣 ${qty} 件：被明确拒绝 (原因: ${data.failures[0].detail.message})`);
        } else {
          console.log(`✅ 请求扣 ${qty} 件：成功扣减！`);
          successTotal += qty;
        }
      } else {
        const err = res.status === "rejected" ? res.reason : res.value.error;
        console.log(`❌ 请求扣 ${qty} 件：抛出外层异常 (${err?.message || err})`);
      }
    });

    // 5. 校验最终库存
    const { data: finalStockData } = await supabase
      .from("warehouse_item_stocks")
      .select("stock_quantity")
      .eq("id", stockId)
      .single();

    const finalQuantity = finalStockData?.stock_quantity;
    console.log("\n=== 最终核对 ===");
    console.log(`最初测试库存: ${TEST_STOCK}`);
    console.log(`实际成功扣除: ${successTotal}`);
    console.log(`数据库最终余量: ${finalQuantity}`);
    console.log(`理论剩余预期: ${TEST_STOCK - successTotal}`);

    if (finalQuantity !== TEST_STOCK - successTotal) {
      console.error("💣 警告：数据一致性被破坏！存在超扣或漏扣现象！");
    } else if (finalQuantity < 0) {
      console.error("💣 警告：库存变成负数，防超扣机制失效！");
    } else if (successTotal === 0) {
      console.error("💣 警告：所有请求均失败，这不合理！");
    } else {
      console.log("🎉 并发测试完美通过！数据一致，未出现负库存，未出现静默失败！");
    }

  } finally {
    // 6. 清理虚拟测试数据（无论中途是否报错都会执行）
    console.log("\n🧹 正在清理隔离的虚拟测试数据...");
    if (tempWarehouseId) {
      await supabase.from("warehouses").delete().eq("id", tempWarehouseId);
      console.log("   已清理虚拟仓库及级联关联数据");
    }
    if (tempProductId) {
      await supabase.from("products").delete().eq("id", tempProductId);
      console.log("   已清理虚拟产品及级联关联数据");
    }
    console.log("✨ 退出清理阶段！");
  }
}

runConcurrencyTest().catch(console.error);
