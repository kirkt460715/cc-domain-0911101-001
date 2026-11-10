// 极简 robots.txt 解析：只识别 User-agent: * 分组内的 Allow/Disallow 前缀规则，
// 最长匹配优先，等长时 Allow 优先（与通行做法一致）。
// robots 与业务授权取交集，更严格的一侧生效（见 http.js 的范围核对）。

export function parseRobots(text) {
  const rules = [];
  let inWildcardGroup = false;
  for (const rawLine of String(text).split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, '').trim();
    if (!line) continue;
    const idx = line.indexOf(':');
    if (idx < 0) continue;
    const key = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();
    if (key === 'user-agent') {
      inWildcardGroup = value === '*';
      continue;
    }
    if (!inWildcardGroup) continue;
    if (key === 'allow' && value) rules.push({ type: 'allow', path: value });
    if (key === 'disallow' && value) rules.push({ type: 'disallow', path: value });
  }
  return {
    allows(path) {
      let best = null;
      for (const rule of rules) {
        if (!path.startsWith(rule.path)) continue;
        if (
          !best ||
          rule.path.length > best.path.length ||
          (rule.path.length === best.path.length && rule.type === 'allow')
        ) {
          best = rule;
        }
      }
      return best ? best.type === 'allow' : true;
    },
  };
}

export const ALLOW_ALL = { allows: () => true };
export const DENY_ALL = { allows: () => false };
