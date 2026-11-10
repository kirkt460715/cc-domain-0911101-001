import { createSource } from './source.js';
const source=createSource();console.log(JSON.stringify({origin:await source.listen()}));
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,async()=>{await source.close();process.exit(0);});
