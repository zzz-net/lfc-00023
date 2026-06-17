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
    } catch (e) {
      const existing = await request(`/admin/daily-slots?department_id=${deptId}&date=${today}`, { headers: adminHeaders });
      if (existing.length > 0) {
        await request(`/admin/daily-slots/${existing[0].id}`, {
          method: 'PUT', headers: adminHeaders,
          body: JSON.stringify({ total_slots: 200, walkin_limit: 100 })
        });
      }
    }
  }
}

async function main() {
  const today = new Date().toISOString().split('T')[0];
  const runId = Date.now().toString().slice(-4);
  const idPrefix = `1101011988${runId}`;
  function idc(base) { return idPrefix + String(base).padStart(4, '0').slice(-4); }

  console.log(`=== 批量导入权限控制回归测试 (${today}, runId=${runId}) ===\n`);

  const nurse1Login = await request('/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'nurse1', password: 'nurse123' })
  });
  const nurse1H = { 'Authorization': 'Bearer ' + nurse1Login.token, 'Content-Type': 'application/json' };
  const nurse1UserId = nurse1Login.user.id;

  const nurse2Login = await request('/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'nurse2', password: 'nurse123' })
  });
  const nurse2H = { 'Authorization': 'Bearer ' + nurse2Login.token, 'Content-Type': 'application/json' };
  const nurse2UserId = nurse2Login.user.id;

  const adminLogin = await request('/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin123' })
  });
  const adminH = { 'Authorization': 'Bearer ' + adminLogin.token, 'Content-Type': 'application/json' };

  const doctorLogin = await request('/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'doctor1', password: 'doctor123' })
  });
  const doctorH = { 'Authorization': 'Bearer ' + doctorLogin.token, 'Content-Type': 'application/json' };

  await ensureSlots(adminH, today);

  try {
    const periods = await request('/admin/closed-periods', { headers: adminH });
    for (const p of periods) {
      if (p.start_date <= today && p.end_date >= today) {
        await request(`/admin/closed-periods/${p.id}`, { method: 'DELETE', headers: adminH });
      }
    }
  } catch (_) {}

  console.log('登录 & 号源配置完成\n');

  // ==========================================
  // 用例 1: 护士创建草稿和正式批次
  // ==========================================
  console.log('=== 用例1: 护士创建草稿和正式批次 ===');

  const csvN1 = `id_card,name,department,queue_date,type\n${idc(101)},权限A1,内科,${today},预约\n${idc(102)},权限A2,内科,${today},预约`;
  const preN1 = await request('/nurse/batch/precheck', {
    method: 'POST', headers: nurse1H, body: JSON.stringify({ csv_text: csvN1 })
  });
  assert(preN1.success === true, '1 nurse1 预检成功');

  const csvN2 = `id_card,name,department,queue_date,type\n${idc(201)},权限B1,内科,${today},预约`;
  const preN2 = await request('/nurse/batch/precheck', {
    method: 'POST', headers: nurse2H, body: JSON.stringify({ csv_text: csvN2 })
  });
  const confN2 = await request('/nurse/batch/confirm', {
    method: 'POST', headers: nurse2H, body: JSON.stringify({ batch_id: preN2.batch_id })
  });
  assert(confN2.success === true, '1 nurse2 创建正式批次成功');

  console.log('用例1 通过 ✅\n');

  // ==========================================
  // 用例 2: 护士只能看到自己发起的批次
  // ==========================================
  console.log('=== 用例2: 护士只能看到自己发起的批次 ===');

  const nurse1Batches = await request('/nurse/batches?pageSize=1000', { headers: nurse1H });
  const nurse2Batches = await request('/nurse/batches?pageSize=1000', { headers: nurse2H });

  const nurse1BatchIds = new Set(nurse1Batches.batches.map(b => b.id));
  const nurse2BatchIds = new Set(nurse2Batches.batches.map(b => b.id));

  assert(nurse1BatchIds.has(preN1.batch_id), '2 nurse1 能看到自己的草稿');
  assert(!nurse1BatchIds.has(preN2.batch_id), '2 nurse1 不能看到 nurse2 的批次');

  assert(nurse2BatchIds.has(preN2.batch_id), '2 nurse2 能看到自己的正式批次');
  assert(!nurse2BatchIds.has(preN1.batch_id), '2 nurse2 不能看到 nurse1 的批次');

  for (const b of nurse1Batches.batches) {
    assert(b.imported_by === nurse1UserId, `2 nurse1 列表中所有批次的 imported_by 都是 nurse1 (${b.id})`);
  }
  for (const b of nurse2Batches.batches) {
    assert(b.imported_by === nurse2UserId, `2 nurse2 列表中所有批次的 imported_by 都是 nurse2 (${b.id})`);
  }

  console.log('用例2 通过 ✅ 护士只能看到自己发起的批次\n');

  // ==========================================
  // 用例 3: 护士不能查看别人的批次详情
  // ==========================================
  console.log('=== 用例3: 护士不能查看别人的批次详情 ===');

  let caught3a = false;
  try {
    await request(`/nurse/batches/${preN2.batch_id}`, { headers: nurse1H });
  } catch (e) {
    caught3a = true;
    assert(e.status === 403, '3 nurse1 查看 nurse2 的批次返回 403');
  }
  assert(caught3a === true, '3 nurse1 不能查看 nurse2 的批次详情');

  let caught3b = false;
  try {
    await request(`/nurse/batches/${preN1.batch_id}`, { headers: nurse2H });
  } catch (e) {
    caught3b = true;
    assert(e.status === 403, '3 nurse2 查看 nurse1 的批次返回 403');
  }
  assert(caught3b === true, '3 nurse2 不能查看 nurse1 的批次详情');

  const selfDetail = await request(`/nurse/batches/${preN1.batch_id}`, { headers: nurse1H });
  assert(selfDetail.id === preN1.batch_id, '3 护士可以查看自己的批次详情');

  console.log('用例3 通过 ✅ 护士不能查看别人的批次详情\n');

  // ==========================================
  // 用例 4: 护士不能确认别人的草稿
  // ==========================================
  console.log('=== 用例4: 护士不能确认别人的草稿 ===');

  let caught4 = false;
  try {
    await request('/nurse/batch/confirm', {
      method: 'POST', headers: nurse2H,
      body: JSON.stringify({ batch_id: preN1.batch_id })
    });
  } catch (e) {
    caught4 = true;
    assert(e.status === 403, '4 nurse2 确认 nurse1 的草稿返回 403');
  }
  assert(caught4 === true, '4 护士不能确认别人的草稿');

  const batch1After4 = await request(`/nurse/batches/${preN1.batch_id}`, { headers: nurse1H });
  assert(batch1After4.status === 'draft', '4 被尝试越权确认后仍为草稿状态');

  console.log('用例4 通过 ✅ 护士不能确认别人的草稿\n');

  // ==========================================
  // 用例 5: 护士不能撤销别人的批次
  // ==========================================
  console.log('=== 用例5: 护士不能撤销别人的批次 ===');

  let caught5 = false;
  try {
    await request(`/nurse/batches/${preN2.batch_id}/revoke`, {
      method: 'POST', headers: nurse1H,
      body: JSON.stringify({ reason: '越权撤销' })
    });
  } catch (e) {
    caught5 = true;
    assert(e.status === 403, '5 nurse1 撤销 nurse2 的批次返回 403');
  }
  assert(caught5 === true, '5 护士不能撤销别人的批次');

  const batch2After5 = await request(`/nurse/batches/${preN2.batch_id}`, { headers: nurse2H });
  assert(batch2After5.status === 'completed', '5 被尝试越权撤销后仍为已完成状态');

  console.log('用例5 通过 ✅ 护士不能撤销别人的批次\n');

  // ==========================================
  // 用例 6: 护士不能导出别人的批次
  // ==========================================
  console.log('=== 用例6: 护士不能导出别人的批次 ===');

  let caught6 = false;
  try {
    await request(`/nurse/batches/${preN2.batch_id}/csv`, { headers: nurse1H });
  } catch (e) {
    caught6 = true;
    assert(e.status === 403, '6 nurse1 导出 nurse2 的批次返回 403');
  }
  assert(caught6 === true, '6 护士不能导出别人的批次');

  const selfExport = await request(`/nurse/batches/${preN1.batch_id}/csv`, { headers: nurse1H });
  assert(typeof selfExport === 'string' && selfExport.includes('身份证号'), '6 护士可以导出自己的批次');

  console.log('用例6 通过 ✅ 护士不能导出别人的批次\n');

  // ==========================================
  // 用例 7: 管理员能看到所有批次（包括草稿和正式）
  // ==========================================
  console.log('=== 用例7: 管理员能看到所有批次（包括草稿和正式）===');

  const adminBatches = await request('/admin/batches?pageSize=1000', { headers: adminH });
  const adminBatchIds = new Set(adminBatches.batches.map(b => b.id));

  assert(adminBatchIds.has(preN1.batch_id), '7 管理员能看到 nurse1 的草稿');
  assert(adminBatchIds.has(preN2.batch_id), '7 管理员能看到 nurse2 的正式批次');

  const hasDraft = adminBatches.batches.some(b => b.status === 'draft');
  assert(hasDraft === true, '7 管理员列表中包含 draft 状态的批次');

  const hasCompleted = adminBatches.batches.some(b => b.status === 'completed');
  assert(hasCompleted === true, '7 管理员列表中包含 completed 状态的批次');

  console.log('用例7 通过 ✅ 管理员能看到所有批次\n');

  // ==========================================
  // 用例 8: 管理员能查看所有批次详情
  // ==========================================
  console.log('=== 用例8: 管理员能查看所有批次详情 ===');

  const adminDetail1 = await request(`/admin/batches/${preN1.batch_id}`, { headers: adminH });
  assert(adminDetail1.id === preN1.batch_id, '8 管理员能查看 nurse1 的草稿详情');
  assert(adminDetail1.status === 'draft', '8 草稿详情状态正确');

  const adminDetail2 = await request(`/admin/batches/${preN2.batch_id}`, { headers: adminH });
  assert(adminDetail2.id === preN2.batch_id, '8 管理员能查看 nurse2 的正式批次详情');
  assert(adminDetail2.status === 'completed', '8 正式批次详情状态正确');

  console.log('用例8 通过 ✅ 管理员能查看所有批次详情\n');

  // ==========================================
  // 用例 9: 管理员能确认和撤销任何草稿
  // ==========================================
  console.log('=== 用例9: 管理员能撤销任何草稿 ===');

  const csv9 = `id_card,name,department,queue_date,type\n${idc(901)},权限C1,内科,${today},预约`;
  const pre9 = await request('/nurse/batch/precheck', {
    method: 'POST', headers: nurse1H, body: JSON.stringify({ csv_text: csv9 })
  });

  const rvk9 = await request(`/admin/batches/${pre9.batch_id}/revoke`, {
    method: 'POST', headers: adminH,
    body: JSON.stringify({ reason: '管理员撤销' })
  });
  assert(rvk9.success === true, '9 管理员撤销 nurse1 的草稿成功');

  const batch9After = await request(`/admin/batches/${pre9.batch_id}`, { headers: adminH });
  assert(batch9After.status === 'revoked', '9 撤销后状态为 revoked');

  console.log('用例9 通过 ✅ 管理员能撤销任何草稿\n');

  // ==========================================
  // 用例 10: 医生没有批量导入相关接口的访问权限
  // ==========================================
  console.log('=== 用例10: 医生没有批量导入相关接口的访问权限 ===');

  const batchEndpoints = [
    { method: 'POST', path: '/doctor/batch/precheck', body: JSON.stringify({ csv_text: '' }) },
    { method: 'POST', path: '/doctor/batch/confirm', body: JSON.stringify({ batch_id: 1 }) },
    { method: 'POST', path: '/doctor/batch/import', body: JSON.stringify({ csv_text: '' }) },
    { method: 'GET', path: '/doctor/batches' },
    { method: 'GET', path: '/doctor/batches/1' },
    { method: 'GET', path: '/doctor/batches/1/csv' },
    { method: 'POST', path: '/doctor/batches/1/revoke', body: JSON.stringify({ reason: '' }) }
  ];

  for (const ep of batchEndpoints) {
    let caught = false;
    try {
      await request(ep.path, {
        method: ep.method,
        headers: doctorH,
        body: ep.body
      });
    } catch (e) {
      caught = true;
      assert(e.status === 401 || e.status === 403 || e.status === 404,
        `10 医生访问 ${ep.method} ${ep.path} 返回 ${e.status}（非200）`);
    }
    assert(caught === true, `10 医生不能访问 ${ep.method} ${ep.path}`);
  }

  console.log('用例10 通过 ✅ 医生没有批量导入相关接口的访问权限\n');

  // ==========================================
  // 用例 11: 未登录用户不能访问任何批量导入接口
  // ==========================================
  console.log('=== 用例11: 未登录用户不能访问任何批量导入接口 ===');

  const noAuthHeaders = { 'Content-Type': 'application/json' };
  const noAuthEndpoints = [
    { method: 'POST', path: '/nurse/batch/precheck', body: JSON.stringify({ csv_text: '' }) },
    { method: 'POST', path: '/nurse/batch/confirm', body: JSON.stringify({ batch_id: 1 }) },
    { method: 'POST', path: '/nurse/batch/import', body: JSON.stringify({ csv_text: '' }) },
    { method: 'GET', path: '/nurse/batches' },
    { method: 'GET', path: '/admin/batches' }
  ];

  for (const ep of noAuthEndpoints) {
    let caught = false;
    try {
      await request(ep.path, {
        method: ep.method,
        headers: noAuthHeaders,
        body: ep.body
      });
    } catch (e) {
      caught = true;
      assert(e.status === 401, `11 未登录访问 ${ep.method} ${ep.path} 返回 401`);
    }
    assert(caught === true, `11 未登录用户不能访问 ${ep.method} ${ep.path}`);
  }

  console.log('用例11 通过 ✅ 未登录用户不能访问任何批量导入接口\n');

  console.log('=== 测试完成 ===');
  console.log(`通过: ${passed}, 失败: ${failed}`);
  if (failed > 0) process.exit(1);
}

main().catch(e => { console.error('测试执行出错:', e.path || '', e.status ? JSON.stringify(e.data || e) : (e.message || e)); process.exit(1); });
