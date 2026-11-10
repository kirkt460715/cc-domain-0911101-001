import http from 'node:http';
import { readFile } from 'node:fs/promises';
const original=JSON.parse(await readFile(new URL('../fixtures/listings.json',import.meta.url),'utf8'));
const escape=s=>String(s).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('"','&quot;');
export function createSource(){
 let generation=1, grantVersion=1, fields=['district','area','rent'], revoked=[];
 let listings=structuredClone(original), limited=0, repeatPage=false, redirectTo='';
 let requests=[], sequence=0; const holds=new Map();
 const json=(res,status,value,headers={})=>{res.writeHead(status,{'content-type':'application/json; charset=utf-8',...headers});res.end(JSON.stringify(value));};
 const send=(req,res,body,etag,capturedGeneration)=>{
  const headers={'content-type':'text/html; charset=utf-8','x-data-generation':String(capturedGeneration),'etag':etag};
  if(req.headers['if-none-match']===etag){res.writeHead(304,headers);res.end();return;}
  res.writeHead(200,headers);res.end(body);
 };
 const server=http.createServer(async(req,res)=>{
  try{
   const url=new URL(req.url,'http://local');
   if(url.pathname.startsWith('/__control/')){
    if(req.method==='GET'&&url.pathname==='/__control/requests'){json(res,200,requests);return;}
    if(req.method==='GET'&&url.pathname==='/__control/held'){json(res,200,[...holds.keys()]);return;}
    if(req.method!=='POST'){json(res,405,{error:'需要 POST'});return;}
    let raw='';for await(const part of req){raw+=part;if(raw.length>16384)throw new Error('控制数据过大');}
    const data=raw?JSON.parse(raw):{};
    if(url.pathname==='/__control/state'){
     if(data.generation!==undefined){if(!Number.isInteger(data.generation)||data.generation<generation)throw new Error('代次只能递增');generation=data.generation;}
     if(data.grantVersion!==undefined){if(!Number.isInteger(data.grantVersion)||data.grantVersion<grantVersion)throw new Error('授权版本只能递增');grantVersion=data.grantVersion;}
     if(data.fields)fields=[...data.fields];if(data.revoked)revoked=[...data.revoked];
     if(data.listings)listings=structuredClone(data.listings);
     if(data.limited!==undefined)limited=data.limited;
     if(data.repeatPage!==undefined)repeatPage=data.repeatPage;
     if(data.redirectTo!==undefined)redirectTo=data.redirectTo;
     json(res,200,{generation,grantVersion});return;
    }
    if(url.pathname==='/__control/release'){
     const release=holds.get(data.id);if(!release){json(res,404,{error:'没有挂起响应'});return;}
     holds.delete(data.id);release();json(res,200,{released:data.id});return;
    }
    json(res,404,{error:'未知控制地址'});return;
   }
   requests.push({sequence:++sequence,method:req.method,path:url.pathname,generation});
   if(url.pathname==='/robots.txt'){res.writeHead(200,{'content-type':'text/plain'});res.end('User-agent: *\nAllow: /catalog/\nDisallow: /catalog/private/\nDisallow: /outside/\n');return;}
   if(url.pathname==='/catalog/manifest'){
    json(res,200,{generation,grantVersion,purpose:'rental-index',allowedFields:fields,revoked,entry:'/catalog/list?page=1',expectedPages:2,activeIds:listings.filter(x=>!revoked.includes(x.id)).map(x=>x.id)}, {'cache-control':'no-store'});return;
   }
   if(limited>0&&url.pathname.startsWith('/catalog/')){limited--;json(res,429,{error:'源站限流'},{'retry-after':'2'});return;}
   if(url.pathname==='/catalog/redirect'){res.writeHead(302,{location:redirectTo||'/outside/contact'});res.end();return;}
   if(url.pathname==='/outside/contact'||url.pathname.startsWith('/catalog/private/')){json(res,200,{marker:'范围之外的合成联系人'});return;}
   if(url.pathname==='/catalog/list'){
    const page=Number(url.searchParams.get('page')||1);if(![1,2].includes(page)){json(res,404,{error:'没有此页'});return;}
    const active=listings.filter(x=>!revoked.includes(x.id));const rows=page===1?active.slice(0,2):active.slice(1);
    const next=page===1?'<a rel="next" href="?page=2">下一页</a>':repeatPage?'<a rel="next" href="?page=1">循环导航</a>':'';
    const body='<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>合作房源</title><main data-generation="'+generation+'" data-page="'+page+'" data-pages="2">'+rows.map(x=>'<a data-listing-id="'+escape(x.id)+'" href="/catalog/detail/'+escape(x.id)+'">'+escape(x.district)+'</a>').join('')+next+'<a href="/catalog/private/contact">内部页面</a><a href="/catalog/redirect">合作导航</a></main></html>';
    send(req,res,body,'"list-'+generation+'-'+page+'-'+repeatPage+'"',generation);return;
   }
   const id=url.pathname.startsWith('/catalog/detail/')?decodeURIComponent(url.pathname.slice('/catalog/detail/'.length)):null;
   if(id){
    const row=listings.find(x=>x.id===id);if(!row||revoked.includes(id)){json(res,404,{error:'房源不存在'});return;}
    const capturedGeneration=generation;
    const body='<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>房源资料</title><article data-listing-id="'+escape(row.id)+'" data-version="'+row.version+'" data-generation="'+generation+'">'+Object.entries(row).filter(([k])=>!['id','version'].includes(k)).map(([k,v])=>'<span data-field="'+escape(k)+'">'+escape(v)+'</span>').join('')+'</article></html>';
    const etag='"detail-'+row.id+'-'+row.version+'"';
    if(url.searchParams.get('hold')==='1'){
     const key='held-'+sequence;holds.set(key,()=>send(req,res,body,etag,capturedGeneration));
     res.on('close',()=>holds.delete(key));return;
    }
    send(req,res,body,etag,capturedGeneration);return;
   }
   json(res,404,{error:'地址不存在'});
  }catch{if(!res.headersSent)json(res,400,{error:'请求参数无效'});else res.end();}
 });
 return {server,async listen(){await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));return 'http://127.0.0.1:'+server.address().port;},async close(){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}};
}
