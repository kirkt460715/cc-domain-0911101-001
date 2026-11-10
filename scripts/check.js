import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
function* walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(path);
    else if (entry.name.endsWith('.js')) yield path;
  }
}
for (const dir of ['src','test','scripts']) for (const file of walk(dir)) { const r=spawnSync(process.execPath,['--check',file],{stdio:'inherit'}); if(r.status!==0)process.exit(r.status??1); }
console.log('源码语法检查完成');
