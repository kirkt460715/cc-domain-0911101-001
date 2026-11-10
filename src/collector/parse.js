// 源站 HTML 的定向提取。源站页面结构稳定（见 src/source.js），
// 这里只提取链接与 article 字段，不保留、不传递原始 HTML。
// 解析结果中的联系方式等多余字段只存在于内存，提交前会被允许清单裁掉。

function unescapeEntities(text) {
  return String(text)
    .replaceAll('&quot;', '"')
    .replaceAll('&lt;', '<')
    .replaceAll('&amp;', '&');
}

function parseAttrs(tagText) {
  const attrs = {};
  const re = /([\w-]+)="([^"]*)"/g;
  let m;
  while ((m = re.exec(tagText))) attrs[m[1]] = unescapeEntities(m[2]);
  return attrs;
}

function coerceValue(text) {
  const value = unescapeEntities(text).trim();
  return /^-?\d+(\.\d+)?$/.test(value) ? Number(value) : value;
}

// 列表页：data-listing-id 的详情链接（同页去重）与 rel="next" 的下一页。
// 其他链接（内部页面、合作导航等）一律不提取，自然不会跟随。
export function parseListPage(html) {
  const details = [];
  const seen = new Set();
  let next = null;
  const re = /<a\b([^>]*)>/g;
  let m;
  while ((m = re.exec(html))) {
    const attrs = parseAttrs(m[1]);
    if (!attrs.href) continue;
    if (attrs['data-listing-id']) {
      if (!seen.has(attrs['data-listing-id'])) {
        seen.add(attrs['data-listing-id']);
        details.push({ id: attrs['data-listing-id'], href: attrs.href });
      }
    } else if (attrs.rel === 'next' && next === null) {
      next = attrs.href;
    }
  }
  return { details, next };
}

// 详情页：article 上的稳定编号、版本、代次，以及 data-field 字段。
export function parseDetailPage(html) {
  const m = /<article\b([^>]*)>([\s\S]*?)<\/article>/.exec(html);
  if (!m) return null;
  const attrs = parseAttrs(m[1]);
  const fields = {};
  const re = /<span\b([^>]*)>([\s\S]*?)<\/span>/g;
  let sm;
  while ((sm = re.exec(m[2]))) {
    const spanAttrs = parseAttrs(sm[1]);
    if (spanAttrs['data-field']) fields[spanAttrs['data-field']] = coerceValue(sm[2]);
  }
  return {
    id: attrs['data-listing-id'],
    version: Number(attrs['data-version']),
    generation: Number(attrs['data-generation']),
    fields,
  };
}
