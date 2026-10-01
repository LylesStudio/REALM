/**
 * Web 进程环境卫生兜底（M5 收口）：owner/provision 专用变量绝不属于
 * Web/Vinext 进程。主防线在 spawn 层（scripts/web-child-env.mjs；
 * launcher + dev-server + GUI runner 共用），这里兜住 vinext 对
 * .env.local 的自动加载与历史遗留文件——register() 在首个请求处理前
 * 于服务进程内执行一次。
 *
 * 应用代码不读这两个变量（数据库访问只经 REALM_RUNTIME_DATABASE_URL /
 * REALM_TRANSFER_DATABASE_URL）；删除不影响任何生产路径。测试子进程不经
 * vinext 启动，不受此影响。
 */
export function register(): void {
  delete process.env.DATABASE_URL;
  delete process.env.REALM_PROVISION_SECRET_DIR;
}
