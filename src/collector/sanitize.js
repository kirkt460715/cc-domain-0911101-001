// 数据最小化工具：任何要落盘、进日志或进异常文本的地址与字段都先经过这里。
//
// 规则：
// - 持久化材料中的列表页键只保留 pathname 与 page 参数（分页所必需）；
//   详情页键只保留 pathname。其余查询参数（可能携带敏感值）一律丢弃。
// - 日志与异常文本只保留 pathname，不带任何查询参数。
// - 记录字段按允许清单裁剪，联系方式等多余字段永远不会进入持久化层。

export function normalizePath(input, { keepPage = true } = {}) {
  const url = new URL(input, 'http://local.invalid');
  if (keepPage && url.searchParams.has('page')) {
    return url.pathname + '?page=' + encodeURIComponent(url.searchParams.get('page'));
  }
  return url.pathname;
}

export function sanitizeUrlForLog(input) {
  try {
    return new URL(input, 'http://local.invalid').pathname;
  } catch {
    return '(无法解析的地址)';
  }
}

// 异常文本兜底清洗：完整 URL 只保留路径部分，查询参数整体移除。
export function sanitizeMessage(message) {
  return String(message ?? '').replace(/https?:\/\/[^\s)"']+/g, match => {
    try {
      return new URL(match).pathname;
    } catch {
      return '(地址已省略)';
    }
  });
}

export function pickAllowed(fields, allowed) {
  const out = {};
  for (const key of allowed) {
    if (Object.hasOwn(fields, key)) out[key] = fields[key];
  }
  return out;
}
