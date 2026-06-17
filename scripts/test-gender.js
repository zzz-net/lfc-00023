const BASE = process.env.BASE || 'http://localhost:3000/api';
async function req(p,o={},t){const h={'Content-Type':'application/json',...(o.headers||{})}; if(t)h.Authorization=`Bearer ${t}`; const r=await fetch(BASE+p,{...o,headers:h}); const tx=await r.text(); let j; try{j=JSON.parse(tx);}catch{j={_raw:tx};} return{ok:r.ok,status:r.status,json:j};}
(async()=>{
  const lr=await req('/auth/login',{method:'POST',body:JSON.stringify({username:'nurse1',password:'nurse123'})});
  const token=lr.json.token;
  const testGenderValues = ['男','女','male','female','M','F','1','0','男性','女性',' ','unknown', ' 男 ', '\uFEFF男'];
  let rn=Math.floor(Math.random()*99999);
  for (const g of testGenderValues) {
    const idCard = `33010119900${100000+rn++}`;
    const body = { name: `测试${rn}`, id_card: idCard, phone: '13900000000', gender: g, age: 30 };
    const r = await req('/nurse/patients', { method: 'POST', body: JSON.stringify(body) }, token);
    const status = r.ok ? 'OK' : 'FAIL';
    const repr = g === ' ' ? '[space]' : g === '' ? '[empty]' : g.replace(/\s/g,'_');
    console.log(`gender=${repr.padEnd(12)} -> ${status} http=${r.status} ${r.ok?`id=${r.json.id}`:`err=${r.json.error}`}`);
  }
})();
