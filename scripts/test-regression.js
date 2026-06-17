const BASE = process.env.BASE || 'http://localhost:3000/api';

let failures = 0;
let checks = 0;
function assert(cond, msg) {
  checks++;
  if (!cond) { failures++; console.log(`  ✗ FAIL: ${msg}`); }
  else { console.log(`  ✓ ok: ${msg}`); }
}

async function req(path, opts = {}, token) {
  const headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const res = await fetch(`${BASE}${path}`, { ...opts, headers });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { _raw: text }; }
  return { ok: res.ok, status: res.status, json };
}

async function login(u, p) {
  const r = await req('/auth/login', { method: 'POST', body: JSON.stringify({ username: u, password: p }) });
  if (!r.ok) throw new Error(`login failed: ${r.json.error}`);
  return r.json;
}

(async () => {
  console.log('=== 回归测试: 叫号 → 过号 → 日志查询 ===\n');
  const nurse = await login('nurse1', 'nurse123');
  const token = nurse.token;
  const H = (body) => ({ method: 'POST', body: JSON.stringify(body) });

  const depts = (await req('/public/departments', {}, token)).json;
  const deptId = depts[2].id;

  const rn = Math.floor(Math.random() * 999999);
  const idCard = `33010119900101${String(rn).padStart(6, '0')}`;
  const pat = (await req('/nurse/patients', H({ name: `回归${rn}`, id_card: idCard, phone: '13900000000', gender: '男', age: 30 }), token)).json;
  const q = (await req('/nurse/queue/register', H({ patient_id: pat.id, department_id: deptId, type: 'appointment' }), token)).json;
  const qrId = q.id;
  console.log(`[setup] queueId=${qrId} number=${q.queue_number}`);

  const c1 = (await req(`/nurse/queue/call/${qrId}`, H({}), token)).json;
  assert(c1.status === 'called', `叫号后状态应为 called，实际 ${c1.status}`);

  console.log('\n--- 测试A: 重复过号幂等性 ---');
  const m1 = await req(`/nurse/queue/miss/${qrId}`, H({}), token);
  assert(m1.ok && m1.json.status === 'missed', `第1次过号应成功且状态 missed，实际 http=${m1.status} status=${m1.json && m1.json.status}`);

  const m2 = await req(`/nurse/queue/miss/${qrId}`, H({}), token);
  assert(m2.ok, `第2次过号应幂等成功(2xx)，实际 http=${m2.status} body=${JSON.stringify(m2.json)}`);
  assert(m2.json && m2.json.status === 'missed', `第2次过号后状态应仍为 missed，实际 ${m2.json && m2.json.status}`);

  const m3 = await req(`/nurse/queue/miss/${qrId}`, H({}), token);
  assert(m3.ok && m3.json.status === 'missed', `第3次过号仍应幂等成功`);

  const queueList = (await req(`/nurse/queue/${deptId}`, {}, token)).json;
  const finalRec = queueList.find(x => x.id === qrId);
  assert(finalRec && finalRec.status === 'missed', `队列中最终状态应为 missed，实际 ${finalRec && finalRec.status}`);
  assert(finalRec && finalRec.return_reason == null, `过号不应写入退回原因，实际 ${finalRec && finalRec.return_reason}`);

  console.log('\n--- 测试B: 审计日志筛选组合 ---');
  const cases = [
    { name: 'action筛选', q: '?action=miss_patient' },
    { name: 'user_id筛选', q: '?user_id=2' },
    { name: 'date范围', q: '?start_date=2020-01-01&end_date=2030-12-31' },
    { name: 'action+user组合', q: '?action=miss_patient&user_id=2' },
    { name: 'action+分页组合', q: '?action=miss_patient&page=1&pageSize=5' },
    { name: '全组合', q: '?action=miss_patient&user_id=2&start_date=2020-01-01&end_date=2030-12-31&page=1&pageSize=10' },
    { name: '纯分页', q: '?page=1&pageSize=10' },
    { name: '翻页page2', q: '?page=2&pageSize=3' },
  ];
  for (const c of cases) {
    const r = await req(`/public/audit-logs${c.q}`, {}, token);
    assert(r.ok, `${c.name} 应返回200，实际 http=${r.status}`);
    assert(r.json && typeof r.json.pagination.total === 'number', `${c.name} 应含 pagination.total，实际 ${r.json && r.json.pagination}`);
  }

  console.log('\n--- 测试C: 过号审计事件唯一性 ---');
  const logs = (await req('/public/audit-logs?action=miss_patient&pageSize=200', {}, token)).json;
  const myMissLogs = (logs.logs || []).filter(l => l.target_id === qrId && l.action === 'miss_patient');
  assert(myMissLogs.length === 1, `queueId=${qrId} 过号审计事件应仅1条，实际 ${myMissLogs.length}`);
  assert(myMissLogs.length <= 1, `重复过号不应产生重复审计`);

  console.log('\n--- 测试D: 筛选结果正确性 ---');
  const onlyMiss = (await req('/public/audit-logs?action=miss_patient&pageSize=200', {}, token)).json;
  const allMiss = (onlyMiss.logs || []).every(l => l.action === 'miss_patient');
  assert(allMiss, 'action=miss_patient 筛选结果应全部为 miss_patient');

  console.log(`\n=== 结果: ${checks - failures}/${checks} 通过，失败 ${failures} ===`);
  if (failures > 0) { process.exit(1); }
})().catch(e => { console.error('测试异常:', e); process.exit(1); });
