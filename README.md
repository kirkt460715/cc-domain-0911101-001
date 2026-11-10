# 合作房源源站

这个 Node.js 项目提供本地合作站点和合成房源，便于接入工程师验证 HTTP 协议及数据格式。现有程序负责提供页面、授权清单和单页探测。使用 Node.js 22 或更新版本，不需要第三方依赖。

    npm ci
    npm run build
    npm test
    npm start

启动会输出随机本地 origin。另一个终端可以运行 npm run probe -- http://127.0.0.1:端口，仅打印当前代次与房源数量。

src/source.js 是源站，fixtures/listings.json 是完全合成的页面数据，docs/protocol.md 说明接口。模块可创建多个互不共享状态的站点。控制接口仅供本地开发使用。

npm test 核对源站分页、缓存、授权变化与错误响应；npm run build 检查项目源码语法。数据接入组件可以按自己的模块划分扩展。

## 采集器

src/collector/ 是可恢复的租赁数据采集模块，多个获准站点共用：跟随分页与详情链接，遵守 robots 与业务授权的交集，按授权清单落实撤回与字段收窄，增量维护每编号一份的当前记录，限流/中断/进程退出后从持久化游标继续。设计说明见 docs/collector.md。

    npm run demo                 # 演示：完整同步、SIGKILL 后续接、撤回后旧响应不复活
    npm run collect -- start  --config <配置.json> [--state <目录>]   # 启动（自动续传）
    npm run collect -- resume --config <配置.json> [--state <目录>]   # 中断后恢复
    npm run collect -- status --state <目录>                          # 状态查询

代码内使用：

    import { createCollector } from './src/collector/index.js';
    const collector = createCollector({ sites, stateDir });
    await collector.runOnce();            // 一轮完整扫描（断点续传）
    await collector.refreshGrants();      // 立即确认最新授权清单
    const records = await collector.records('site-a');

