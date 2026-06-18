const http = require('http');

const BASE_URL = 'http://localhost:3000';
const API_BASE = '/api';

let passed = 0, failed = 0;
function assert(cond, msg) {
  if (cond) { passed++; console.log('✅PASS: ' + msg); }
  else { failed++; console.log('❌FAIL: ' + msg); }
}

function request(path, options = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(API_BASE + path, BASE_URL);
    const method = options.method || 'GET';
    const req = http.request({
      hostname: url.hostname, port: url.port,
      path: url.pathname + url.search, method,
      headers: options.headers || {}
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const p = JSON.parse(data);
          if (res.statusCode >= 200 && res.statusCode < 300) resolve(p);
          else reject({ status: res.statusCode, data: p, path: `${method} ${url.pathname}${url.search}` });
        } catch (e) {
          if (res.statusCode >= 200 && res.statusCode < 300) resolve(data);
          else reject({ status: res.statusCode, data, path: `${method} ${url.pathname}${url.search}` });
        }
      });
    });
    req.on('error', reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

async function ensureSlots(adminHeaders, today) {
  for (const deptId of [1, 2]) {
    try {
      await request('/admin/daily-slots', {
        method: 'POST', headers: adminHeaders,
        body: JSON.stringify({ department_id: deptId, date: today, total_slots: 200, walkin_limit: 100 })
      });
    } catch (e) {}
  }
}

let nurse1TaskId = null;
let nurse2TaskId = null;
const runId = Date.now().toString().slice(-4);

async function main() {
  const today = new Date().toISOString().split('T')[0];
  const idPrefix = `1101011988${runId}`;
  function idc(base) { return idPrefix + String(base).padStart(4, '0').slice(-4); }

  console.log(`=== 沙箱模块 - 权限隔离回归测试 (${today}, runId=${runId}) ===\n`);

  const [nurse1Login, nurse2Login, doctorLogin, adminLogin] = await Promise.all([
    request('/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'nurse1', password: 'nurse123' }) }),
    request('/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'nurse2', password: 'nurse123' }) }),
    request('/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'doctor1', password: 'doctor123' }) }),
    request('/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'admin123' }) })
  ]);
  const n1H = { 'Authorization': 'Bearer ' + nurse1Login.token, 'Content-Type': 'application/json' };
  const n2H = { 'Authorization': 'Bearer ' + nurse2Login.token, 'Content-Type': 'application/json' };
  const drH = { 'Authorization': 'Bearer ' + doctorLogin.token, 'Content-Type': 'application/json' };
  const adH = { 'Authorization': 'Bearer ' + adminLogin.token, 'Content-Type': 'application/json' };

  await ensureSlots(adH, today);

  console.log('=== 1. 角色路由层权限：医生角色访问沙箱被拒绝 ===');
  try {
    await request('/sandbox/tasks', { headers: drH });
    assert(false, '1.1 医生访问沙箱列表应被 403 拒绝');
  } catch (e) {
    assert(e.status === 403, '1.1 医生访问沙箱列表返回 403 Forbidden');
  }

  try {
    await request('/sandbox/tasks', {
      method: 'POST', headers: drH,
      body: JSON.stringify({ task_name: '医生越权测试' + runId, template_version: 'v1', target_dataset: 'queue_records', scope_type: 'all' })
    });
    assert(false, '1.2 医生创建任务应被拒绝');
  } catch (e) {
    assert(e.status === 403, '1.2 医生创建沙箱任务返回 403 Forbidden');
  }

  console.log('\n=== 2. 护士1和护士2各创建一个任务 ===');
  const t1 = await request('/sandbox/tasks', {
    method: 'POST', headers: n1H,
    body: JSON.stringify({ task_name: '护士1的任务-' + runId, template_version: 'v1', target_dataset: 'queue_records', scope_type: 'all' })
  });
  assert(t1.success === true, '2.1 护士1创建任务成功');
  nurse1TaskId = t1.task_id;

  const t2 = await request('/sandbox/tasks', {
    method: 'POST', headers: n2H,
    body: JSON.stringify({ task_name: '护士2的任务-' + runId, template_version: 'v1', target_dataset: 'queue_records', scope_type: 'all' })
  });
  assert(t2.success === true, '2.2 护士2创建任务成功');
  nurse2TaskId = t2.task_id;

  const n1csv = `id_card,name,department,queue_date,type\n${idc(1)},护士1-A,内科,${today},预约`;
  await request(`/sandbox/tasks/${nurse1TaskId}/precheck`, { method: 'POST', headers: n1H, body: JSON.stringify({ csv_text: n1csv }) });
  await request(`/sandbox/tasks/${nurse1TaskId}/practice`, { method: 'POST', headers: n1H });

  const n2csv = `id_card,name,department,queue_date,type\n${idc(2)},护士2-X,外科,${today},预约`;
  await request(`/sandbox/tasks/${nurse2TaskId}/precheck`, { method: 'POST', headers: n2H, body: JSON.stringify({ csv_text: n2csv }) });
  await request(`/sandbox/tasks/${nurse2TaskId}/practice`, { method: 'POST', headers: n2H });

  console.log('\n=== 3. 列表权限隔离 ===');
  const listN1 = await request('/sandbox/tasks', { headers: n1H });
  assert(Array.isArray(listN1.tasks), '3.1 护士1拿到任务列表');
  assert(listN1.tasks.some(t => t.id === nurse1TaskId), '3.2 护士1能看到自己的任务');
  assert(!listN1.tasks.some(t => t.id === nurse2TaskId), '3.3 护士1看不到护士2创建的任务 ✅');

  const listN2 = await request('/sandbox/tasks', { headers: n2H });
  assert(listN2.tasks.some(t => t.id === nurse2TaskId), '3.4 护士2能看到自己的任务');
  assert(!listN2.tasks.some(t => t.id === nurse1TaskId), '3.5 护士2看不到护士1创建的任务 ✅');

  const listAd = await request('/sandbox/tasks', { headers: adH });
  assert(listAd.tasks.some(t => t.id === nurse1TaskId), '3.6 管理员能看到护士1的任务');
  assert(listAd.tasks.some(t => t.id === nurse2TaskId), '3.7 管理员能看到护士2的任务');

  console.log('\n=== 4. 详情权限隔离 ===');
  try {
    await request(`/sandbox/tasks/${nurse2TaskId}`, { headers: n1H });
    assert(false, '4.1 护士1访问护士2任务详情应被拒绝');
  } catch (e) {
    const msg = e.data?.message || e.data?.error || '';
    assert(e.status === 403 || msg.includes('无权'), '4.1 护士1无权查看护士2的任务详情 ✅');
  }

  const dAd = await request(`/sandbox/tasks/${nurse2TaskId}`, { headers: adH });
  assert(dAd.task_no != null, '4.2 管理员可以查看护士2任务详情');

  console.log('\n=== 5. 操作权限隔离：护士1不能操作护士2的任务 ===');
  try {
    await request(`/sandbox/tasks/${nurse2TaskId}/records/1/revert`, {
      method: 'POST', headers: n1H, body: JSON.stringify({ reason: '恶意撤销测试' })
    });
    assert(false, '5.1 护士1撤销护士2任务记录应被拒绝');
  } catch (e) {
    const msg = e.data?.message || e.data?.error || '';
    assert(e.status === 403 || msg.includes('无权'), '5.1 护士1无权撤销护士2任务记录 ✅');
  }

  try {
    await request(`/sandbox/tasks/${nurse2TaskId}/void`, {
      method: 'POST', headers: n1H, body: JSON.stringify({ reason: '恶意作废测试' })
    });
    assert(false, '5.2 护士1作废护士2任务应被拒绝');
  } catch (e) {
    const msg = e.data?.message || e.data?.error || '';
    assert(e.status === 403 || msg.includes('无权'), '5.2 护士1无权作废护士2任务 ✅');
  }

  try {
    await request(`/sandbox/tasks/${nurse2TaskId}/submit`, {
      method: 'POST', headers: n1H
    });
    assert(false, '5.3 护士1提交护士2任务应被拒绝');
  } catch (e) {
    const msg = e.data?.message || e.data?.error || '';
    assert(e.status === 403 || msg.includes('无权'), '5.3 护士1无权提交护士2任务 ✅');
  }

  console.log('\n=== 6. 审批权限：护士不能审批，管理员可以 ===');
  try {
    await request(`/admin/sandbox/tasks/${nurse1TaskId}/approve`, {
      method: 'POST', headers: n1H, body: JSON.stringify({ comment: '越权审批' })
    });
    assert(false, '6.1 护士审批自己任务应被拒绝（需 admin 角色）');
  } catch (e) {
    assert(e.status === 403, '6.1 普通护士不能审批，必须管理员 ✅');
  }

  const approveRes = await request(`/admin/sandbox/tasks/${nurse1TaskId}/approve`, {
    method: 'POST', headers: adH, body: JSON.stringify({ comment: '管理员审批通过' })
  });
  assert(approveRes.success === true, '6.2 管理员审批通过成功');

  const detailAfter = await request(`/sandbox/tasks/${nurse1TaskId}`, { headers: adH });
  assert(detailAfter.status === 'approved', '6.3 审批后任务状态为 approved');

  console.log('\n=== 7. 同名任务冲突处理 ===');
  try {
    await request('/sandbox/tasks', {
      method: 'POST', headers: n1H,
      body: JSON.stringify({ task_name: '护士1的任务-' + runId, template_version: 'v1', target_dataset: 'queue_records', scope_type: 'all' })
    });
    assert(false, '7.1 创建同名任务应被拒绝');
  } catch (e) {
    const msg = e.data?.message || e.data?.error || '';
    assert(msg.includes('已存在') || msg.includes('exist'), '7.1 同名未作废任务不允许创建 ✅');
  }

  await request(`/sandbox/tasks/${nurse1TaskId}/void`, {
    method: 'POST', headers: n1H, body: JSON.stringify({ reason: '作废以便创建同名测试' })
  });
  const recreate = await request('/sandbox/tasks', {
    method: 'POST', headers: n1H,
    body: JSON.stringify({ task_name: '护士1的任务-' + runId, template_version: 'v1', target_dataset: 'queue_records', scope_type: 'all' })
  });
  assert(recreate.success === true, '7.2 原任务作废后，可以创建同名新任务 ✅');

  console.log(`\n=== 测试完成：通过 ${passed}, 失败 ${failed} ===`);
  if (failed > 0) process.exit(1);
}

main().catch(e => { console.error('测试执行出错:', e.path || '', e.status ? JSON.stringify(e.data || e) : (e.message || e)); process.exit(1); });
