import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
for (const dir of ['src','test','scripts']) for (const file of readdirSync(dir)) if (file.endsWith('.js')) { const r=spawnSync(process.execPath,['--check',dir+'/'+file],{stdio:'inherit'}); if(r.status!==0)process.exit(r.status??1); }
console.log('源码语法检查完成');
