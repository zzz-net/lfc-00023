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

  console.log(`=== 批量导入预检-确认流程回归测试 (${today}, runId=${runId}) ===\n`);

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
  // 用例 1: 预检创建草稿，不写入 queue_records，不占用号源
  // ==========================================
  console.log('=== 用例1: 预检创建草稿，不写入 queue_records，不占用号源 ===');

  const queueCountBefore = await request(`/public/queue/status/1?date=${today}`);
  const totalBefore = queueCountBefore.total;

  const csv1 = `id_card,name,department,queue_date,type\n${idc(101)},预检A1,内科,${today},预约\n${idc(102)},预检A2,内科,${today},预约`;
  const pre1 = await request('/nurse/batch/precheck', {
    method: 'POST', headers: nurse1H, body: JSON.stringify({ csv_text: csv1 })
  });
  assert(pre1.success === true, '1 预检成功');
  assert(pre1.status === 'draft', '1 批次状态为 draft');
  assert(pre1.success_count === 2, '1 预检成功 2 条');
  assert(pre1.fail_count === 0, '1 预检失败 0 条');
  assert(pre1.batch_id != null, '1 返回了 batch_id');

  const batch1 = await request(`/nurse/batches/${pre1.batch_id}`, { headers: nurse1H });
  assert(batch1.status === 'draft', '1 批次详情中 status=draft');
  assert(batch1.imported_by === nurse1UserId, '1 imported_by 正确');

  for (const r of batch1.records) {
    assert(r.status === 'draft_success', `1 记录${r.row_index} 状态为 draft_success`);
    assert(r.queue_record_id == null, `1 记录${r.row_index} queue_record_id 为 null（不落库）`);
    assert(r.patient_id == null, `1 记录${r.row_index} patient_id 为 null（不落库）`);
    assert(r.is_overwrite === 0, `1 记录${r.row_index} is_overwrite=0`);
  }

  const queueCountAfterPrecheck = await request(`/public/queue/status/1?date=${today}`);
  assert(queueCountAfterPrecheck.total === totalBefore, '1 预检后号源未被占用（total 不变）');

  const recordsInQueue = await request(`/nurse/queue/1?date=${today}`, { headers: nurse1H });
  const hasBatchRecords = recordsInQueue.some(r => r.batch_id === pre1.batch_id);
  assert(hasBatchRecords === false, '1 预检后 queue_records 中没有该批次的记录');

  console.log('用例1 通过 ✅ 预检只创建草稿，不写入 queue_records，不占用号源\n');

  // ==========================================
  // 用例 2: 预检包含冲突场景（重复身份证、科室不存在、日期格式错误）
  // ==========================================
  console.log('=== 用例2: 预检包含冲突场景（重复身份证、科室不存在、日期格式错误）===');

  const csv2 = `id_card,name,department,queue_date,type\n${idc(201)},预检B1,不存在的科室,${today},预约\n${idc(202)},预检B2,内科,2026/06/18,预约\n${idc(203)},预检B3,内科,${today},预约\n${idc(203)},预检B4,内科,${today},预约`;
  const pre2 = await request('/nurse/batch/precheck', {
    method: 'POST', headers: nurse1H, body: JSON.stringify({ csv_text: csv2 })
  });
  assert(pre2.success === true, '2 预检执行完成');
  assert(pre2.success_count === 1, '2 预检成功 1 条');
  assert(pre2.fail_count === 3, '2 预检失败 3 条');

  const batch2 = await request(`/nurse/batches/${pre2.batch_id}`, { headers: nurse1H });
  const failedRecords = batch2.records.filter(r => r.status === 'draft_failed');
  assert(failedRecords.length === 3, '2 有 3 条 draft_failed 记录');

  const deptNotFound = failedRecords.find(r => r.row_index === 1);
  assert(deptNotFound.error_message.includes('科室') && deptNotFound.error_message.includes('不存在'), 
    '2 row1 错误信息包含"科室不存在"');
  assert(deptNotFound.error_code === 'DEPARTMENT_NOT_FOUND', '2 row1 错误代码 DEPARTMENT_NOT_FOUND');

  const badDate = failedRecords.find(r => r.row_index === 2);
  assert(badDate.error_message.includes('日期'), '2 row2 错误信息包含"日期"');
  assert(badDate.error_code === 'INVALID_DATE', '2 row2 错误代码 INVALID_DATE');

  const duplicate = failedRecords.find(r => r.row_index === 4);
  assert(duplicate.error_message.includes('重复'), '2 row4 错误信息包含"重复"');
  assert(duplicate.error_code === 'DUPLICATE_ID_CARD_IN_BATCH', '2 row4 错误代码 DUPLICATE_ID_CARD_IN_BATCH');

  const successRec = batch2.records.find(r => r.status === 'draft_success');
  assert(successRec.row_index === 3, '2 row3 预检成功');
  console.log('用例2 通过 ✅ 预检正确识别重复身份证、科室不存在、日期格式错误\n');

  // ==========================================
  // 用例 3: 预检包含覆盖提示（已存在同一患者同日同科室挂号）
  // ==========================================
  console.log('=== 用例3: 预检包含覆盖提示（已存在同一患者同日同科室挂号）===');

  const csv3a = `id_card,name,department,queue_date,type\n${idc(301)},预检C1,内科,${today},预约`;
  const imp3a = await request('/nurse/batch/precheck', {
    method: 'POST', headers: nurse1H, body: JSON.stringify({ csv_text: csv3a })
  });
  const conf3a = await request('/nurse/batch/confirm', {
    method: 'POST', headers: nurse1H, body: JSON.stringify({ batch_id: imp3a.batch_id })
  });
  assert(conf3a.success === true, '3 先导入一条记录成功');

  const csv3b = `id_card,name,department,queue_date,type\n${idc(301)},预检C1,内科,${today},预约`;
  const pre3 = await request('/nurse/batch/precheck', {
    method: 'POST', headers: nurse1H, body: JSON.stringify({ csv_text: csv3b })
  });
  assert(pre3.success === true, '3 预检执行完成');
  assert(pre3.success_count === 0, '3 预检成功 0 条（因已存在）');
  assert(pre3.fail_count === 1, '3 预检失败 1 条');

  const batch3 = await request(`/nurse/batches/${pre3.batch_id}`, { headers: nurse1H });
  const overwriteRec = batch3.records[0];
  assert(overwriteRec.status === 'draft_failed', '3 记录状态为 draft_failed');
  assert(overwriteRec.is_overwrite === 1, '3 is_overwrite=1');
  assert(overwriteRec.overwrite_hint != null, '3 overwrite_hint 不为空');
  assert(overwriteRec.overwrite_hint.includes('已在此科室挂号'), '3 overwrite_hint 包含"已在此科室挂号"');
  assert(overwriteRec.error_code === 'DUPLICATE_REGISTRATION', '3 错误代码 DUPLICATE_REGISTRATION');

  console.log('用例3 通过 ✅ 预检正确识别重复挂号并生成覆盖提示\n');

  // ==========================================
  // 用例 4: 预检号源已满场景
  // ==========================================
  console.log('=== 用例4: 预检号源已满场景 ===');

  const slot = await request(`/admin/daily-slots?department_id=1&date=${today}`, { headers: adminH });
  const slotId = slot[0].id;
  await request(`/admin/daily-slots/${slotId}`, {
    method: 'PUT', headers: adminH,
    body: JSON.stringify({ total_slots: 1, walkin_limit: 1 })
  });

  const csv4a = `id_card,name,department,queue_date,type\n${idc(401)},预检D1,内科,${today},预约`;
  const imp4a = await request('/nurse/batch/precheck', {
    method: 'POST', headers: nurse1H, body: JSON.stringify({ csv_text: csv4a })
  });
  await request('/nurse/batch/confirm', {
    method: 'POST', headers: nurse1H, body: JSON.stringify({ batch_id: imp4a.batch_id })
  });

  const csv4b = `id_card,name,department,queue_date,type\n${idc(402)},预检D2,内科,${today},预约`;
  const pre4 = await request('/nurse/batch/precheck', {
    method: 'POST', headers: nurse1H, body: JSON.stringify({ csv_text: csv4b })
  });
  assert(pre4.success_count === 0, '4 号源已满时预检成功 0 条');
  assert(pre4.fail_count === 1, '4 号源已满时预检失败 1 条');

  const batch4 = await request(`/nurse/batches/${pre4.batch_id}`, { headers: nurse1H });
  assert(batch4.records[0].error_code === 'SLOT_FULL', '4 错误代码 SLOT_FULL');
  assert(batch4.records[0].error_message.includes('号源已满'), '4 错误信息包含"号源已满"');

  await request(`/admin/daily-slots/${slotId}`, {
    method: 'PUT', headers: adminH,
    body: JSON.stringify({ total_slots: 200, walkin_limit: 100 })
  });

  console.log('用例4 通过 ✅ 预检正确识别号源已满\n');

  // ==========================================
  // 用例 5: 确认导入将草稿转为正式批次，写入 queue_records
  // ==========================================
  console.log('=== 用例5: 确认导入将草稿转为正式批次，写入 queue_records ===');

  const csv5 = `id_card,name,department,queue_date,type\n${idc(501)},预检E1,内科,${today},预约\n${idc(502)},预检E2,内科,${today},预约`;
  const pre5 = await request('/nurse/batch/precheck', {
    method: 'POST', headers: nurse1H, body: JSON.stringify({ csv_text: csv5 })
  });
  const batchId5 = pre5.batch_id;

  const conf5 = await request('/nurse/batch/confirm', {
    method: 'POST', headers: nurse1H, body: JSON.stringify({ batch_id: batchId5 })
  });
  assert(conf5.success === true, '5 确认导入成功');
  assert(conf5.status === 'completed', '5 批次状态为 completed');
  assert(conf5.success_count === 2, '5 成功 2 条');
  assert(conf5.fail_count === 0, '5 失败 0 条');

  const batch5 = await request(`/nurse/batches/${batchId5}`, { headers: nurse1H });
  assert(batch5.status === 'completed', '5 详情中 status=completed');
  assert(batch5.confirmed_by === nurse1UserId, '5 confirmed_by 正确');
  assert(batch5.confirmed_at != null, '5 confirmed_at 有值');

  for (const r of batch5.records) {
    assert(r.status === 'enqueued', `5 记录${r.row_index} 状态为 enqueued`);
    assert(r.queue_record_id != null, `5 记录${r.row_index} queue_record_id 已生成`);
    assert(r.patient_id != null, `5 记录${r.row_index} patient_id 已生成`);
  }

  const queueRecords5 = await request(`/nurse/queue/1?date=${today}`, { headers: nurse1H });
  const batch5Records = queueRecords5.filter(r => r.batch_id === batchId5);
  assert(batch5Records.length === 2, '5 queue_records 中有 2 条该批次记录');

  const auditResponse = await request(`/public/audit-logs?resource_type=import_batch&resource_id=${batchId5}`, { headers: adminH });
  const auditLogs = auditResponse.logs;
  const precheckAudit = auditLogs.find(l => l.action === 'precheck_batch');
  const confirmAudit = auditLogs.find(l => l.action === 'confirm_batch');
  assert(precheckAudit != null, '5 存在 precheck_batch 审计日志');
  assert(confirmAudit != null, '5 存在 confirm_batch 审计日志');
  assert(precheckAudit.user_id === nurse1UserId, '5 预检审计日志 user_id 正确');
  assert(confirmAudit.user_id === nurse1UserId, '5 确认审计日志 user_id 正确');

  console.log('用例5 通过 ✅ 确认导入生成正式批次，写入 queue_records，有审计日志\n');

  // ==========================================
  // 用例 6: 确认后批次详情区分"预检失败"和"已入队"
  // ==========================================
  console.log('=== 用例6: 确认后批次详情区分"预检失败"和"已入队" ===');

  const csv6 = `id_card,name,department,queue_date,type\n${idc(601)},预检F1,内科,${today},预约\n${idc(602)},预检F2,不存在的科室,${today},预约\n${idc(603)},预检F3,内科,${today},预约`;
  const pre6 = await request('/nurse/batch/precheck', {
    method: 'POST', headers: nurse1H, body: JSON.stringify({ csv_text: csv6 })
  });
  assert(pre6.success_count === 2, '6 预检成功 2 条');
  assert(pre6.fail_count === 1, '6 预检失败 1 条');

  const conf6 = await request('/nurse/batch/confirm', {
    method: 'POST', headers: nurse1H, body: JSON.stringify({ batch_id: pre6.batch_id })
  });
  assert(conf6.success_count === 2, '6 确认成功 2 条');
  assert(conf6.fail_count === 1, '6 确认失败 1 条');

  const batch6 = await request(`/nurse/batches/${pre6.batch_id}`, { headers: nurse1H });
  const enqueued = batch6.records.filter(r => r.status === 'enqueued');
  const precheckFailed = batch6.records.filter(r => r.status === 'precheck_failed');
  assert(enqueued.length === 2, '6 有 2 条"已入队"记录');
  assert(precheckFailed.length === 1, '6 有 1 条"预检失败"记录');
  assert(enqueued[0].queue_record_id != null, '6 已入队记录有 queue_record_id');
  assert(precheckFailed[0].queue_record_id == null, '6 预检失败记录无 queue_record_id');

  console.log('用例6 通过 ✅ 确认后正确区分"预检失败"和"已入队"\n');

  // ==========================================
  // 用例 7: 草稿批次可以撤销
  // ==========================================
  console.log('=== 用例7: 草稿批次可以撤销 ===');

  const csv7 = `id_card,name,department,queue_date,type\n${idc(701)},预检G1,内科,${today},预约`;
  const pre7 = await request('/nurse/batch/precheck', {
    method: 'POST', headers: nurse1H, body: JSON.stringify({ csv_text: csv7 })
  });

  const rvk7 = await request(`/nurse/batches/${pre7.batch_id}/revoke`, {
    method: 'POST', headers: nurse1H, body: JSON.stringify({ reason: '测试撤销草稿' })
  });
  assert(rvk7.success === true, '7 草稿撤销成功');

  const batch7 = await request(`/nurse/batches/${pre7.batch_id}`, { headers: nurse1H });
  assert(batch7.status === 'revoked', '7 批次状态为 revoked');
  assert(batch7.records[0].status === 'precheck_failed', '7 记录状态为 precheck_failed');
  assert(batch7.records[0].error_code === 'BATCH_REVOKED', '7 错误代码 BATCH_REVOKED');

  const audit7 = await request(`/public/audit-logs?resource_type=import_batch&resource_id=${pre7.batch_id}`, { headers: adminH });
  const revokeAudit = audit7.logs.find(l => l.action === 'revoke_batch');
  assert(revokeAudit != null, '7 存在 revoke_batch 审计日志');
  assert(revokeAudit.details.was_draft === true, '7 撤销审计日志标记 was_draft=true');

  console.log('用例7 通过 ✅ 草稿可以撤销，有审计日志\n');

  console.log('=== 测试完成 ===');
  console.log(`通过: ${passed}, 失败: ${failed}`);
  if (failed > 0) process.exit(1);
}

main().catch(e => { console.error('测试执行出错:', e.path || '', e.status ? JSON.stringify(e.data || e) : (e.message || e)); process.exit(1); });
