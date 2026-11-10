# 源站协议

服务仅绑定 127.0.0.1，端口启动时随机分配。此处所有人物和联系方式都是合成标记。

GET /catalog/manifest 返回 generation、grantVersion、purpose、allowedFields、revoked、entry、expectedPages 和 activeIds。用途固定为 rental-index；授权版本与数据代次独立。清单不可缓存，revoked 为当前撤回编号列表；列表移除撤回编号后，以更高授权版本再次公布可表示重新开放。

GET /catalog/list?page=1 及 page=2 提供 HTML 导航，两页共享一条房源。详情的 article 带稳定编号、版本和代次，字段由 data-field 标识。详情 ETag 跟随房源版本；授权变化不一定改变 ETag。页面中的联系方式是接入方可能接收到的多余字段。

GET /robots.txt 禁止内部路径。/catalog/redirect 默认跳转至 /outside/contact；控制项 redirectTo 可以指定另一个本地站点，用于不同 origin 的联调。

POST /__control/state 接受 JSON，可设置 generation、grantVersion、fields、revoked、listings、limited、repeatPage、redirectTo。前两个版本值不能倒退；listings 替换整份合成房源。limited 是随后返回 429 的业务请求数，Retry-After 为 2 秒；repeatPage 使末页导航回到第一页。

详情 URL 加上 hold=1 时保留响应开始时的内容和代次。GET /__control/held 可查看挂起编号；POST /__control/release 携带 id 可释放，适用于在途响应与代次切换的联调。GET /__control/requests 只返回方法、路径、顺序和代次，不保存请求查询参数或原始内容。

接入方读取授权清单建立本地已知版本；源站不会主动推送变化。数据代次用于完整遍历边界，授权版本用于已观察到的许可变更。
