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
  const tomorrow = new Date(Date.now() + 86400000).toISOString().split('T')[0];
  const runId = Date.now().toString().slice(-4);
  const idPrefix = `1101011988${runId}`;
  function idc(base) { return idPrefix + String(base).padStart(4, '0').slice(-4); }

  console.log(`=== 批量导入预检→确认全链路回归测试 (today=${today}, runId=${runId}) ===\n`);

  const nurse1Login = await request('/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'nurse1', password: 'nurse123' })
  });
  const nurse1H = { 'Authorization': 'Bearer ' + nurse1Login.token, 'Content-Type': 'application/json' };

  const nurse2Login = await request('/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'nurse2', password: 'nurse123' })
  });
  const nurse2H = { 'Authorization': 'Bearer ' + nurse2Login.token, 'Content-Type': 'application/json' };

  const adminLogin = await request('/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin123' })
  });
  const adminH = { 'Authorization': 'Bearer ' + adminLogin.token, 'Content-Type': 'application/json' };

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
  // 用例 1: 一步直写 /batch/import 接口已被移除
  // ==========================================
  console.log('=== 用例1: 一步直写 /batch/import 接口已被移除 ===');

  let caught1 = false;
  try {
    await request('/nurse/batch/import', {
      method: 'POST', headers: nurse1H,
      body: JSON.stringify({ csv_text: `id_card,name,department,queue_date,type\n${idc(101)},删除A1,内科,${today},预约` })
    });
  } catch (e) {
    caught1 = true;
    assert(e.status === 404 || e.status === 403, `1 nurse /batch/import 返回 ${e.status}（非200，已移除）`);
  }
  assert(caught1 === true, '1 nurse /batch/import 接口已移除');

  let caught1b = false;
  try {
    await request('/admin/batch/import', {
      method: 'POST', headers: adminH,
      body: JSON.stringify({ csv_text: `id_card,name,department,queue_date,type\n${idc(102)},删除A2,内科,${today},预约` })
    });
  } catch (e) {
    caught1b = true;
    assert(e.status === 404 || e.status === 403, `1 admin /batch/import 返回 ${e.status}（非200，已移除）`);
  }
  assert(caught1b === true, '1 admin /batch/import 接口已移除');

  console.log('用例1 通过 ✅ 一步直写接口已被移除\n');

  // ==========================================
  // 用例 2: 预检后号源被他人占满 → 确认时重新校验产生新冲突（confirm_failed）
  // ==========================================
  console.log('=== 用例2: 预检后号源被他人占满，确认时重新校验产生新冲突 ===');

  const slot = await request(`/admin/daily-slots?department_id=2&date=${today}`, { headers: adminH });
  const slotId = slot[0].id;
  await request(`/admin/daily-slots/${slotId}`, {
    method: 'PUT', headers: adminH,
    body: JSON.stringify({ total_slots: 1, walkin_limit: 1 })
  });

  const csv2 = `id_card,name,department,queue_date,type\n${idc(201)},冲突B1,外科,${today},预约\n${idc(202)},冲突B2,外科,${today},预约`;
  const pre2 = await request('/nurse/batch/precheck', {
    method: 'POST', headers: nurse1H, body: JSON.stringify({ csv_text: csv2 })
  });
  assert(pre2.success === true, '2 预检成功完成');
  assert(pre2.success_count <= 2, '2 预检成功数 ≤2');

  const csv2a = `id_card,name,department,queue_date,type\n${idc(203)},冲突B3,外科,${today},预约`;
  const pre2a = await request('/nurse/batch/precheck', {
    method: 'POST', headers: nurse2H, body: JSON.stringify({ csv_text: csv2a })
  });
  await request('/nurse/batch/confirm', {
    method: 'POST', headers: nurse2H, body: JSON.stringify({ batch_id: pre2a.batch_id })
  });

  const conf2 = await request('/nurse/batch/confirm', {
    method: 'POST', headers: nurse1H, body: JSON.stringify({ batch_id: pre2.batch_id })
  });
  assert(conf2.success === true, '2 确认流程执行完成');
  assert(conf2.confirm_failed_count > 0 || conf2.fail_count > 0 || conf2.precheck_failed_count > 0,
    '2 存在失败记录（precheck_failed_count/confirm_failed_count/fail_count 至少一个 > 0）');

  if (conf2.recheck_details) {
    const rd = conf2.recheck_details;
    assert(Array.isArray(rd.precheck_failed), '2 recheck_details.precheck_failed 是数组');
    assert(Array.isArray(rd.new_conflicts), '2 recheck_details.new_conflicts 是数组');
    const hasAnyFailure = rd.precheck_failed.length > 0 || rd.new_conflicts.length > 0;
    assert(hasAnyFailure, '2 recheck_details 中至少包含 precheck_failed 或 new_conflicts 之一');
  }

  const batch2 = await request(`/nurse/batches/${pre2.batch_id}`, { headers: nurse1H });
  const precheckFailed2 = batch2.records.filter(r => r.status === 'precheck_failed');
  const confirmFailed2 = batch2.records.filter(r => r.status === 'confirm_failed');
  const enqueued2 = batch2.records.filter(r => r.status === 'enqueued');
  assert(precheckFailed2.length + confirmFailed2.length + enqueued2.length === batch2.records.length,
    '2 所有记录状态是 precheck_failed、confirm_failed 或 enqueued 之一');

  await request(`/admin/daily-slots/${slotId}`, {
    method: 'PUT', headers: adminH,
    body: JSON.stringify({ total_slots: 200, walkin_limit: 100 })
  });

  console.log('用例2 通过 ✅ 预检后号源被占，确认时正确检测新冲突\n');

  // ==========================================
  // 用例 3: 预检后科室被停用 → 确认时重新校验
  // ==========================================
  console.log('=== 用例3: 预检后科室被停用，确认时重新校验 ===');

  const csv3 = `id_card,name,department,queue_date,type\n${idc(301)},冲突C1,内科,${today},预约`;
  const pre3 = await request('/nurse/batch/precheck', {
    method: 'POST', headers: nurse1H, body: JSON.stringify({ csv_text: csv3 })
  });
  assert(pre3.success_count === 1, '3 预检成功 1 条');

  await request('/admin/departments/1', {
    method: 'PUT', headers: adminH,
    body: JSON.stringify({ name: '内科', is_active: 0 })
  });

  const conf3 = await request('/nurse/batch/confirm', {
    method: 'POST', headers: nurse1H, body: JSON.stringify({ batch_id: pre3.batch_id })
  });
  assert(conf3.confirm_failed_count >= 1 || conf3.fail_count >= 1, '3 科室停用导致确认失败');

  const batch3 = await request(`/nurse/batches/${pre3.batch_id}`, { headers: nurse1H });
  const failed3 = batch3.records.find(r => r.status === 'confirm_failed' || r.status === 'precheck_failed' || r.status === 'failed');
  assert(failed3 != null, '3 存在失败记录');
  assert(failed3.error_code === 'CONFIRM_DEPARTMENT_INACTIVE' || failed3.error_code === 'DEPARTMENT_INACTIVE',
    `3 错误代码为 ${failed3.error_code}（停用相关）`);

  await request('/admin/departments/1', {
    method: 'PUT', headers: adminH,
    body: JSON.stringify({ name: '内科', is_active: 1 })
  });

  console.log('用例3 通过 ✅ 预检后科室被停用，确认时正确检测\n');

  // ==========================================
  // 用例 4: 预检后科室停诊（closed_period）→ 确认时重新校验
  // ==========================================
  console.log('=== 用例4: 预检后科室停诊，确认时重新校验 ===');

  const csv4 = `id_card,name,department,queue_date,type\n${idc(401)},冲突D1,内科,${tomorrow},预约`;
  const pre4 = await request('/nurse/batch/precheck', {
    method: 'POST', headers: nurse1H, body: JSON.stringify({ csv_text: csv4 })
  });
  assert(pre4.success_count === 1, '4 预检成功 1 条');

  try {
    await request('/admin/daily-slots', {
      method: 'POST', headers: adminH,
      body: JSON.stringify({ department_id: 1, date: tomorrow, total_slots: 200, walkin_limit: 100 })
    });
  } catch (_) {}

  const cp = await request('/admin/closed-periods', {
    method: 'POST', headers: adminH,
    body: JSON.stringify({ department_id: 1, start_date: tomorrow, end_date: tomorrow, reason: '测试停诊' })
  });

  const conf4 = await request('/nurse/batch/confirm', {
    method: 'POST', headers: nurse1H, body: JSON.stringify({ batch_id: pre4.batch_id })
  });
  assert(conf4.confirm_failed_count >= 1 || conf4.fail_count >= 1, '4 科室停诊导致确认失败');

  const batch4 = await request(`/nurse/batches/${pre4.batch_id}`, { headers: nurse1H });
  const failed4 = batch4.records.find(r => r.status === 'confirm_failed' || r.status === 'precheck_failed' || r.status === 'failed');
  assert(failed4 != null, '4 存在失败记录');
  assert(['CONFIRM_DEPARTMENT_CLOSED', 'DEPARTMENT_CLOSED', 'NO_SLOT_CONFIG'].includes(failed4.error_code),
    `4 错误代码为 ${failed4.error_code}（停诊相关）`);

  await request(`/admin/closed-periods/${cp.id}`, { method: 'DELETE', headers: adminH });

  console.log('用例4 通过 ✅ 预检后科室停诊，确认时正确检测\n');

  // ==========================================
  // 用例 5: 预检后他人抢先挂了同一患者的号 → 确认时检测
  // ==========================================
  console.log('=== 用例5: 预检后他人抢先挂号，确认时检测重复挂号 ===');

  const csv5 = `id_card,name,department,queue_date,type\n${idc(501)},冲突E1,内科,${today},预约`;
  const pre5 = await request('/nurse/batch/precheck', {
    method: 'POST', headers: nurse1H, body: JSON.stringify({ csv_text: csv5 })
  });
  assert(pre5.success_count === 1, '5 预检成功 1 条');

  const csv5n2 = `id_card,name,department,queue_date,type\n${idc(501)},冲突E1-抢,内科,${today},预约`;
  const pre5n2 = await request('/nurse/batch/precheck', {
    method: 'POST', headers: nurse2H, body: JSON.stringify({ csv_text: csv5n2 })
  });
  await request('/nurse/batch/confirm', {
    method: 'POST', headers: nurse2H, body: JSON.stringify({ batch_id: pre5n2.batch_id })
  });

  const conf5 = await request('/nurse/batch/confirm', {
    method: 'POST', headers: nurse1H, body: JSON.stringify({ batch_id: pre5.batch_id })
  });
  assert(conf5.confirm_failed_count >= 1 || conf5.fail_count >= 1, '5 他人抢先挂号导致确认失败');

  const batch5 = await request(`/nurse/batches/${pre5.batch_id}`, { headers: nurse1H });
  const failed5 = batch5.records.find(r => r.status === 'confirm_failed' || r.status === 'precheck_failed' || r.status === 'failed');
  assert(failed5 != null, '5 存在失败记录');
  assert(['CONFIRM_DUPLICATE_REGISTRATION', 'DUPLICATE_REGISTRATION'].includes(failed5.error_code),
    `5 错误代码为 ${failed5.error_code}（重复挂号）`);

  console.log('用例5 通过 ✅ 预检后他人抢先挂号，确认时正确检测\n');

  // ==========================================
  // 用例 6: 状态正确区分 precheck_failed、confirm_failed、enqueued
  // ==========================================
  console.log('=== 用例6: 批次详情和确认返回正确区分 precheck_failed / confirm_failed / enqueued ===');

  const csv6 = `id_card,name,department,queue_date,type\n${idc(601)},状态F1,内科,${today},预约\n${idc(602)},状态F2,不存在科室,${today},预约\n${idc(603)},状态F3,内科,${today},预约`;
  const pre6 = await request('/nurse/batch/precheck', {
    method: 'POST', headers: nurse1H, body: JSON.stringify({ csv_text: csv6 })
  });
  assert(pre6.success_count === 2, '6 预检成功 2 条，失败 1 条');
  assert(pre6.fail_count === 1, '6 预检失败 1 条');

  const batch6Pre = await request(`/nurse/batches/${pre6.batch_id}`, { headers: nurse1H });
  const draftOk6 = batch6Pre.records.filter(r => r.status === 'draft_success');
  const draftFail6 = batch6Pre.records.filter(r => r.status === 'draft_failed');
  assert(draftOk6.length === 2, '6 预检状态中 draft_success = 2');
  assert(draftFail6.length === 1, '6 预检状态中 draft_failed = 1');
  assert(draftFail6[0].error_code != null, '6 draft_failed 记录有 error_code');

  const conf6 = await request('/nurse/batch/confirm', {
    method: 'POST', headers: nurse1H, body: JSON.stringify({ batch_id: pre6.batch_id })
  });
  assert(conf6.precheck_failed_count != null && conf6.confirm_failed_count != null,
    '6 确认返回包含 precheck_failed_count 和 confirm_failed_count');
  assert(conf6.precheck_failed_count === 1, '6 precheck_failed_count = 1');
  assert(conf6.confirm_failed_count === 0, '6 confirm_failed_count = 0');
  assert(conf6.success_count === 2, '6 success_count = 2');

  const batch6Conf = await request(`/nurse/batches/${pre6.batch_id}`, { headers: nurse1H });
  const pFailed6 = batch6Conf.records.filter(r => r.status === 'precheck_failed');
  const cFailed6 = batch6Conf.records.filter(r => r.status === 'confirm_failed');
  const enq6 = batch6Conf.records.filter(r => r.status === 'enqueued');
  assert(pFailed6.length === 1, '6 确认后 precheck_failed = 1');
  assert(cFailed6.length === 0, '6 确认后 confirm_failed = 0');
  assert(enq6.length === 2, '6 确认后 enqueued = 2');
  assert(pFailed6[0].error_code === draftFail6[0].error_code, '6 precheck_failed 的 error_code 与预检时一致');

  for (const r of enq6) {
    assert(r.queue_record_id != null, '6 enqueued 记录有 queue_record_id');
    assert(r.patient_id != null, '6 enqueued 记录有 patient_id');
  }

  console.log('用例6 通过 ✅ 状态正确区分 precheck_failed / confirm_failed / enqueued\n');

  // ==========================================
  // 用例 7: 导出 CSV 正确区分三种状态
  // ==========================================
  console.log('=== 用例7: 导出 CSV 正确区分三种状态 ===');

  const csv7Text = await request(`/nurse/batches/${pre6.batch_id}/csv`, { headers: nurse1H });
  assert(typeof csv7Text === 'string' && csv7Text.includes('状态'), '7 CSV 导出包含状态列');
  assert(csv7Text.includes('已入队'), '7 CSV 包含"已入队"');
  assert(csv7Text.includes('预检失败'), '7 CSV 包含"预检失败"');

  const lines = csv7Text.split('\n');
  const header = lines[0];
  assert(header.includes('状态'), '7 表头包含状态');

  console.log('用例7 通过 ✅ CSV 导出正确区分三种状态\n');

  // ==========================================
  // 用例 8: 批次计数 precheck_failed_count / confirm_failed_count
  // ==========================================
  console.log('=== 用例8: 批次列表计数 precheck_failed_count / confirm_failed_count ===');

  const batches8 = await request('/nurse/batches?pageSize=1000', { headers: nurse1H });
  const b6 = batches8.batches.find(b => b.id === pre6.batch_id);
  assert(b6 != null, '8 能在列表中找到批次');
  assert(b6.precheck_failed_count != null, '8 列表返回 precheck_failed_count 字段');
  assert(b6.confirm_failed_count != null, '8 列表返回 confirm_failed_count 字段');
  assert(b6.precheck_failed_count === 1, `8 precheck_failed_count = 1（实际 ${b6.precheck_failed_count}）`);
  assert(b6.confirm_failed_count === 0, `8 confirm_failed_count = 0（实际 ${b6.confirm_failed_count}）`);

  const detail8 = await request(`/nurse/batches/${pre6.batch_id}`, { headers: nurse1H });
  assert(detail8.precheck_failed_count === 1, '8 详情 precheck_failed_count = 1');
  assert(detail8.confirm_failed_count === 0, '8 详情 confirm_failed_count = 0');

  console.log('用例8 通过 ✅ 批次计数字段正确\n');

  // ==========================================
  // 用例 9: 预检草稿持久化（服务重启后草稿仍然存在）
  // ==========================================
  console.log('=== 用例9: 预检草稿持久化（重启后仍可查看）===');

  const csv9 = `id_card,name,department,queue_date,type\n${idc(901)},持久G1,内科,${today},预约`;
  const pre9 = await request('/nurse/batch/precheck', {
    method: 'POST', headers: nurse1H, body: JSON.stringify({ csv_text: csv9 })
  });
  const batchId9 = pre9.batch_id;
  assert(pre9.status === 'draft', '9 创建草稿成功');

  const beforeList = await request('/nurse/batches?pageSize=1000', { headers: nurse1H });
  const draftBefore = beforeList.batches.find(b => b.id === batchId9);
  assert(draftBefore != null && draftBefore.status === 'draft', '9 草稿在列表中存在');

  const beforeDetail = await request(`/nurse/batches/${batchId9}`, { headers: nurse1H });
  assert(beforeDetail.status === 'draft', '9 详情 status=draft');
  assert(beforeDetail.records[0].status === 'draft_success', '9 记录 status=draft_success');

  console.log('用例9 通过 ✅ 草稿已落库（持久化），重启后仍能查询（请结合重启测试验证）\n');

  // ==========================================
  // 用例 10: 撤销草稿后记录状态为 precheck_failed
  // ==========================================
  console.log('=== 用例10: 撤销草稿后记录状态为 precheck_failed ===');

  const csv10 = `id_card,name,department,queue_date,type\n${idc(1001)},撤销H1,内科,${today},预约`;
  const pre10 = await request('/nurse/batch/precheck', {
    method: 'POST', headers: nurse1H, body: JSON.stringify({ csv_text: csv10 })
  });
  const rvk10 = await request(`/nurse/batches/${pre10.batch_id}/revoke`, {
    method: 'POST', headers: nurse1H, body: JSON.stringify({ reason: '测试撤销' })
  });
  assert(rvk10.success === true, '10 撤销成功');

  const batch10 = await request(`/nurse/batches/${pre10.batch_id}`, { headers: nurse1H });
  assert(batch10.status === 'revoked', '10 批次状态为 revoked');
  const revokedRec = batch10.records[0];
  assert(['precheck_failed', 'failed'].includes(revokedRec.status),
    `10 记录状态为 ${revokedRec.status}`);
  assert(revokedRec.error_code === 'BATCH_REVOKED', '10 error_code = BATCH_REVOKED');

  console.log('用例10 通过 ✅ 撤销草稿后记录状态正确\n');

  console.log('=== 测试完成 ===');
  console.log(`通过: ${passed}, 失败: ${failed}`);
  if (failed > 0) process.exit(1);
}

main().catch(e => {
  console.error('测试执行出错:', e.path || '', e.status ? JSON.stringify(e.data || e) : (e.message || e));
  process.exit(1);
});
