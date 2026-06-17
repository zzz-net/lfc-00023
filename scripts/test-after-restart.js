const BASE = process.env.BASE || 'http://localhost:3000/api';
let f=0,c=0; const ok=(cond,msg)=>{c++; if(!cond){f++; console.log(`  ✗ FAIL: ${msg}`);} else console.log(`  ✓ ok: ${msg}`);};
async function req(p,o={},t){const h={'Content-Type':'application/json',...(o.headers||{})}; if(t)h.Authorization=`Bearer ${t}`; const r=await fetch(BASE+p,{...o,headers:h}); const tx=await r.text(); let j; try{j=JSON.parse(tx);}catch{j={_raw:tx};} return{ok:r.ok,status:r.status,json:j};}
async function login(u,p){const r=await req('/auth/login',{method:'POST',body:JSON.stringify({username:u,password:p})}); return r.json.token;}
(async()=>{
  console.log('=== 重启后API复测 ===');
  const t=await login('nurse1','nurse123');
  console.log('--- 队列与过号结果一致性 ---');
  const q=(await req('/nurse/queue/3',{},t)).json;
  const r1=q.find(x=>x.id===1);
  ok(r1&&r1.status==='missed', `queueId=1 重启后仍为 missed，实际 ${r1&&r1.status}`);
  ok(r1&&r1.return_reason==null, `queueId=1 退回原因为空，实际 ${r1&&r1.return_reason}`);
  console.log('--- 过号幂等性(重启后) ---');
  const m=await req('/nurse/queue/miss/1',{method:'POST',body:'{}'},t);
  ok(m.ok&&m.json.status==='missed', `重启后再次过号仍幂等成功，实际 http=${m.status} status=${m.json&&m.json.status}`);
  console.log('--- 日志筛选一致性 ---');
  for(const qz of ['?action=miss_patient','?user_id=2','?start_date=2020-01-01&end_date=2030-12-31','?action=miss_patient&user_id=2&page=1&pageSize=5']){
    const r=await req('/public/audit-logs'+qz,{},t);
    ok(r.ok, `筛选 ${qz} 返回200，实际 ${r.status}`);
  }
  const ml=(await req('/public/audit-logs?action=miss_patient&pageSize=200',{},t)).json;
  const mine=ml.logs.filter(l=>l.target_id===1&&l.action==='miss_patient');
  ok(mine.length===1, `重启后多次过号审计仍仅1条，实际 ${mine.length}`);
  console.log(`\n=== 重启后复测: ${c-f}/${c} 通过 ===`);
  if(f>0)process.exit(1);
})().catch(e=>{console.error('异常:',e);process.exit(1);});
