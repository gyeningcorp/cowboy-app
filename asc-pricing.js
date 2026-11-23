#!/usr/bin/env node
const https = require('https'), crypto = require('crypto'), fs = require('fs');
const KEY_ID=process.env.ASC_KEY_ID, ISSUER_ID=process.env.ASC_ISSUER_ID, KEY_PATH=process.env.ASC_KEY_PATH;
const APP_ID='6789995023'; const APPLY = process.env.MODE === 'apply';
function jwt(){const k=fs.readFileSync(KEY_PATH,'utf8');const n=Math.floor(Date.now()/1000);
 const h=Buffer.from(JSON.stringify({alg:'ES256',kid:KEY_ID,typ:'JWT'})).toString('base64url');
 const p=Buffer.from(JSON.stringify({iss:ISSUER_ID,iat:n,exp:n+1200,aud:'appstoreconnect-v1'})).toString('base64url');
 const s=crypto.createSign('SHA256');s.update(h+'.'+p);return h+'.'+p+'.'+s.sign({key:k,dsaEncoding:'ieee-p1363'}).toString('base64url');}
function api(method,path,body){return new Promise((res,rej)=>{const d=body?JSON.stringify(body):null;
 const r=https.request({hostname:'api.appstoreconnect.apple.com',path,method,headers:{Authorization:'Bearer '+jwt(),'Content-Type':'application/json',...(d?{'Content-Length':Buffer.byteLength(d)}:{})}},
 x=>{let b='';x.on('data',c=>b+=c);x.on('end',()=>{try{res({status:x.statusCode,body:JSON.parse(b)})}catch{res({status:x.statusCode,body:b})}})});
 r.on('error',rej);if(d)r.write(d);r.end();});}
(async()=>{
 const a=await api('GET','/v1/apps/'+APP_ID+'?fields[apps]=name,bundleId');console.log('APP',JSON.stringify(a.body.data?.attributes));
 const s=await api('GET','/v1/apps/'+APP_ID+'/appPriceSchedule?include=baseTerritory,manualPrices');
 console.log('SCHEDULE',s.status,JSON.stringify(s.body).slice(0,600));
 const mp=await api('GET','/v1/appPriceSchedules/'+(s.body.data?.id||'x')+'/manualPrices?include=appPricePoint&limit=10');
 for(const p of (mp.body.included||[])) console.log('CURRENT PRICE POINT',p.id,JSON.stringify(p.attributes));
 const iap=await api('GET','/v1/apps/'+APP_ID+'/inAppPurchasesV2?limit=20');
 console.log('IAP',iap.status,JSON.stringify((iap.body.data||[]).map(i=>({id:i.id,name:i.attributes.name,type:i.attributes.inAppPurchaseType,state:i.attributes.state}))));
 const pts=await api('GET','/v1/apps/'+APP_ID+'/appPricePoints?filter[territory]=USA&limit=200');
 const free=(pts.body.data||[]).find(p=>parseFloat(p.attributes.customerPrice)===0);
 console.log('FREE POINT',free?free.id:'NOT FOUND');
 if(!APPLY||!free) return;
 const body={data:{type:'appPriceSchedules',relationships:{app:{data:{type:'apps',id:APP_ID}},baseTerritory:{data:{type:'territories',id:'USA'}},manualPrices:{data:[{type:'appPrices',id:'${p0}'}]}}},
  included:[{type:'appPrices',id:'${p0}',attributes:{startDate:null},relationships:{appPricePoint:{data:{type:'appPricePoints',id:free.id}}}}]};
 const r=await api('POST','/v1/appPriceSchedules',body);
 console.log('APPLY',r.status,r.status<400?'OK':JSON.stringify(r.body).slice(0,800));
 if(r.status>=400) process.exit(1);
})().catch(e=>{console.error(e.message);process.exit(1)});
