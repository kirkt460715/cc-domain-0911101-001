const origin=process.argv[2];
if(!origin){console.error('用法：npm run probe -- http://127.0.0.1:端口');process.exit(2);}
const res=await fetch(new URL('/catalog/manifest',origin));if(!res.ok)throw new Error('站点清单读取失败');
const data=await res.json();console.log(JSON.stringify({generation:data.generation,activeCount:data.activeIds.length}));
