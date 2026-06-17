const BASE = process.env.BASE || 'http://localhost:3000/api';
async function req(p,o={},t){const h={'Content-Type':'application/json',...(o.headers||{})}; if(t)h.Authorization=`Bearer ${t}`; const r=await fetch(BASE+p,{...o,headers:h}); return r.json();}
(async()=>{
  const r=await req('/auth/login',{method:'POST',body:JSON.stringify({username:'nurse1',password:'nurse123'})});
  console.log(JSON.stringify(r));
})();
