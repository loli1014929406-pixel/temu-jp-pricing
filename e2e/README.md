# E2E 回归测试

E2E 测试默认只验证登录页，不会写入业务数据。设置测试账号后，会继续验证订单分页、搜索、阶段筛选、采购、库存和结算页面；订单导入仅打开确认框并取消。

```powershell
$env:E2E_USER_EMAIL="测试账号邮箱"
$env:E2E_USER_PASSWORD="测试账号密码"
npm run test:e2e
```

可以通过 `E2E_BASE_URL` 指向已经启动的网站。不要把账号密码写入仓库文件。
