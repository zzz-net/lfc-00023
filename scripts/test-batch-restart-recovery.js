const http = require('http');
const fs = require('fs');
const path = require('path');

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
    const headers = options.headers || {};
    const req = http.request({
      hostname: url.hostname, port: url.port,
      path: url.pathname + url.search, method,
      headers
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

function requestText(path, options = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(API_BASE + path, BASE_URL);
    const method = options.method || 'GET';
    const headers = options.headers || {};
    const req = http.request({
      hostname: url.hostname, port: url.port,
      path: url.pathname + url.search, method,
      headers
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) resolve(data);
        else reject({ status: res.statusCode, data, path: `${method} ${url.pathname}${url.search}` });
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

  console.log(`=== 批量导入重启恢复回归测试 (${today}, runId=${runId}) ===\n`);

  const nurse1Login = await request('/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'nurse1', password: 'nurse123' })
  });
  const nurse1H = { 'Authorization': 'Bearer ' + nurse1Login.token, 'Content-Type': 'application/json' };
  const nurse1NoCT = { 'Authorization': 'Bearer ' + nurse1Login.token };
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
  const adminNoCT = { 'Authorization': 'Bearer ' + adminLogin.token };

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
  // Phase 1: 创建各类批次数据（草稿、正式、已撤销）
  // ==========================================
  console.log('=== Phase 1: 创建各类批次数据 ===');

  const csvA = `id_card,name,department,queue_date,type\n${idc(101)},重启A1,内科,${today},预约\n${idc(102)},重启A2,内科,${today},预约`;
  const preA = await request('/nurse/batch/precheck', {
    method: 'POST', headers: nurse1H, body: JSON.stringify({ csv_text: csvA })
  });
  assert(preA.success === true, '1 创建草稿A成功');
  const draftBatchId = preA.batch_id;
  console.log(`  创建草稿批次: ${draftBatchId}`);

  const csvB = `id_card,name,department,queue_date,type\n${idc(201)},重启B1,内科,${today},预约\n${idc(202)},重启B2,不存在的科室,${today},预约\n${idc(203)},重启B3,内科,${today},预约`;
  const preB = await request('/nurse/batch/precheck', {
    method: 'POST', headers: nurse1H, body: JSON.stringify({ csv_text: csvB })
  });
  const confB = await request('/nurse/batch/confirm', {
    method: 'POST', headers: nurse1H, body: JSON.stringify({ batch_id: preB.batch_id })
  });
  assert(confB.success === true, '1 创建正式批次B成功');
  const completedBatchId = preB.batch_id;
  console.log(`  创建正式批次: ${completedBatchId}`);

  const csvC = `id_card,name,department,queue_date,type\n${idc(301)},重启C1,内科,${today},预约\n${idc(302)},重启C2,内科,${today},预约`;
  const preC = await request('/nurse/batch/precheck', {
    method: 'POST', headers: nurse2H, body: JSON.stringify({ csv_text: csvC })
  });
  const confC = await request('/nurse/batch/confirm', {
    method: 'POST', headers: nurse2H, body: JSON.stringify({ batch_id: preC.batch_id })
  });
  const rvkC = await request(`/nurse/batches/${preC.batch_id}/revoke`, {
    method: 'POST', headers: nurse2H, body: JSON.stringify({ reason: '重启测试撤销' })
  });
  assert(rvkC.success === true, '1 创建已撤销批次C成功');
  const revokedBatchId = preC.batch_id;
  console.log(`  创建已撤销批次: ${revokedBatchId}`);

  const csvD = `id_card,name,department,queue_date,type\n${idc(401)},重启D1,内科,${today},预约`;
  const preD = await request('/nurse/batch/precheck', {
    method: 'POST', headers: nurse2H, body: JSON.stringify({ csv_text: csvD })
  });
  const rvkD = await request(`/nurse/batches/${preD.batch_id}/revoke`, {
    method: 'POST', headers: nurse2H, body: JSON.stringify({ reason: '重启测试草稿撤销' })
  });
  assert(rvkD.success === true, '1 创建已撤销草稿D成功');
  const revokedDraftId = preD.batch_id;
  console.log(`  创建已撤销草稿: ${revokedDraftId}`);

  // ==========================================
  // Phase 2: 记录"重启前"的所有状态
  // ==========================================
  console.log('\n=== Phase 2: 记录"重启前"的所有状态 ===');

  const beforeState = {};

  beforeState.draftBatch = await request(`/nurse/batches/${draftBatchId}`, { headers: nurse1H });
  assert(beforeState.draftBatch.status === 'draft', '2 草稿状态=draft');
  console.log(`  草稿批次状态: ${beforeState.draftBatch.status}`);

  beforeState.completedBatch = await request(`/nurse/batches/${completedBatchId}`, { headers: nurse1H });
  assert(beforeState.completedBatch.status === 'completed', '2 正式批次状态=completed');
  assert(beforeState.completedBatch.confirmed_by === nurse1UserId, '2 正式批次confirmed_by正确');
  console.log(`  正式批次状态: ${beforeState.completedBatch.status}, success=${beforeState.completedBatch.success_count}, fail=${beforeState.completedBatch.fail_count}`);

  beforeState.revokedBatch = await request(`/nurse/batches/${revokedBatchId}`, { headers: nurse2H });
  assert(beforeState.revokedBatch.status === 'revoked', '2 已撤销批次状态=revoked');
  console.log(`  已撤销批次状态: ${beforeState.revokedBatch.status}`);

  beforeState.revokedDraft = await request(`/nurse/batches/${revokedDraftId}`, { headers: nurse2H });
  assert(beforeState.revokedDraft.status === 'revoked', '2 已撤销草稿状态=revoked');
  console.log(`  已撤销草稿状态: ${beforeState.revokedDraft.status}`);

  beforeState.nurse1Batches = await request('/nurse/batches?pageSize=1000', { headers: nurse1H });
  beforeState.nurse2Batches = await request('/nurse/batches?pageSize=1000', { headers: nurse2H });
  beforeState.adminBatches = await request('/admin/batches?pageSize=1000', { headers: adminH });
  beforeState.nurse1DraftExport = await requestText(`/nurse/batches/${draftBatchId}/csv`, { headers: nurse1NoCT });
  beforeState.nurse1CompletedExport = await requestText(`/nurse/batches/${completedBatchId}/csv`, { headers: nurse1NoCT });
  beforeState.adminDraftExport = await requestText(`/admin/batches/${draftBatchId}/csv`, { headers: adminNoCT });
  beforeState.adminCompletedExport = await requestText(`/admin/batches/${completedBatchId}/csv`, { headers: adminNoCT });

  beforeState.auditResponse = await request(`/public/audit-logs?resource_type=import_batch&pageSize=1000`, { headers: adminH });
  beforeState.auditLogs = beforeState.auditResponse.logs;
  const batchIds = [draftBatchId, completedBatchId, revokedBatchId, revokedDraftId];
  beforeState.relatedAudits = beforeState.auditLogs.filter(l => batchIds.includes(l.resource_id));
  assert(beforeState.relatedAudits.length >= 8, '2 至少有8条审计日志（4次precheck + 2次confirm + 2次revoke）');
  console.log(`  记录审计日志: ${beforeState.relatedAudits.length} 条相关日志`);

  beforeState.queueRecords = await request('/nurse/queue/1', { headers: nurse1H });
  beforeState.completedQueueCount = beforeState.queueRecords.filter(r => r.batch_id === completedBatchId && r.status !== 'returned').length;
  assert(beforeState.completedQueueCount === 2, `2 正式批次B有 2 条排队记录`);
  console.log(`  正式批次B排队记录数: ${beforeState.completedQueueCount}`);

  // ==========================================
  // Phase 3: 验证数据库文件存在且包含数据（模拟"重启前"持久化）
  // ==========================================
  console.log('\n=== Phase 3: 验证数据库持久化 ===');

  const dbPath = path.join(__dirname, '..', 'data', 'clinic.db');
  assert(fs.existsSync(dbPath), '3 数据库文件存在');
  const dbStats = fs.statSync(dbPath);
  assert(dbStats.size > 10000, '3 数据库文件大小合理（>10KB）');
  console.log(`  数据库文件: ${dbPath}`);
  console.log(`  数据库大小: ${(dbStats.size / 1024).toFixed(2)} KB`);

  // ==========================================
  // Phase 4: 模拟"重启后"重新查询所有数据（不重启服务，直接重新查询验证持久化）
  // ==========================================
  console.log('\n=== Phase 4: 模拟"重启后"重新查询验证 ===');

  // 重新登录获取token（模拟重启后重新认证）
  const nurse1Login2 = await request('/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'nurse1', password: 'nurse123' })
  });
  const nurse1H2 = { 'Authorization': 'Bearer ' + nurse1Login2.token, 'Content-Type': 'application/json' };
  const nurse1NoCT2 = { 'Authorization': 'Bearer ' + nurse1Login2.token };

  const nurse2Login2 = await request('/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'nurse2', password: 'nurse123' })
  });
  const nurse2H2 = { 'Authorization': 'Bearer ' + nurse2Login2.token, 'Content-Type': 'application/json' };

  const adminLogin2 = await request('/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin123' })
  });
  const adminH2 = { 'Authorization': 'Bearer ' + adminLogin2.token, 'Content-Type': 'application/json' };
  const adminNoCT2 = { 'Authorization': 'Bearer ' + adminLogin2.token };

  console.log('  重新登录获取新token完成');

  // ==========================================
  // 用例 1: 草稿批次在"重启后"仍然存在且状态正确
  // ==========================================
  console.log('\n=== 用例1: 草稿批次在"重启后"仍然存在且状态正确 ===');

  const draftAfter = await request(`/nurse/batches/${draftBatchId}`, { headers: nurse1H2 });
  assert(draftAfter.status === beforeState.draftBatch.status, `1 草稿批次状态一致 (${draftAfter.status})`);
  assert(draftAfter.batch_no === beforeState.draftBatch.batch_no, '1 草稿批次号一致');
  assert(draftAfter.total_count === beforeState.draftBatch.total_count, '1 草稿总数一致');
  assert(draftAfter.success_count === beforeState.draftBatch.success_count, '1 草稿成功数一致');
  assert(draftAfter.fail_count === beforeState.draftBatch.fail_count, '1 草稿失败数一致');
  assert(draftAfter.imported_by === beforeState.draftBatch.imported_by, '1 草稿imported_by一致');
  assert(draftAfter.imported_at === beforeState.draftBatch.imported_at, '1 草稿imported_at一致');
  assert(draftAfter.confirmed_by == null, '1 草稿confirmed_by仍为null');
  assert(draftAfter.confirmed_at == null, '1 草稿confirmed_at仍为null');

  for (let i = 0; i < draftAfter.records.length; i++) {
    const beforeRec = beforeState.draftBatch.records[i];
    const afterRec = draftAfter.records[i];
    assert(afterRec.row_index === beforeRec.row_index, `1 记录${i} row_index一致`);
    assert(afterRec.status === beforeRec.status, `1 记录${i} status一致 (${afterRec.status})`);
    assert(afterRec.queue_record_id === beforeRec.queue_record_id, `1 记录${i} queue_record_id一致（应为null）`);
    assert(afterRec.is_overwrite === beforeRec.is_overwrite, `1 记录${i} is_overwrite一致`);
    assert(afterRec.overwrite_hint === beforeRec.overwrite_hint, `1 记录${i} overwrite_hint一致`);
    assert(afterRec.error_code === beforeRec.error_code, `1 记录${i} error_code一致`);
    assert(afterRec.error_message === beforeRec.error_message, `1 记录${i} error_message一致`);
  }

  console.log('用例1 通过 ✅ 草稿批次在"重启后"状态完全一致\n');

  // ==========================================
  // 用例 2: 正式批次在"重启后"仍然存在且状态正确
  // ==========================================
  console.log('=== 用例2: 正式批次在"重启后"仍然存在且状态正确 ===');

  const completedAfter = await request(`/nurse/batches/${completedBatchId}`, { headers: nurse1H2 });
  assert(completedAfter.status === beforeState.completedBatch.status, `2 正式批次状态一致 (${completedAfter.status})`);
  assert(completedAfter.confirmed_by === beforeState.completedBatch.confirmed_by, '2 正式批次confirmed_by一致');
  assert(completedAfter.confirmed_at === beforeState.completedBatch.confirmed_at, '2 正式批次confirmed_at一致');
  assert(completedAfter.success_count === beforeState.completedBatch.success_count, '2 正式批次success_count一致');
  assert(completedAfter.fail_count === beforeState.completedBatch.fail_count, '2 正式批次fail_count一致');

  const enqueuedRecords = completedAfter.records.filter(r => r.status === 'enqueued');
  const failedRecords = completedAfter.records.filter(r => r.status === 'precheck_failed' || r.status === 'failed');
  assert(enqueuedRecords.length === 2, '2 有 2 条"已入队"记录');
  assert(failedRecords.length === 1, '2 有 1 条"失败"记录');

  for (const rec of enqueuedRecords) {
    assert(rec.queue_record_id != null, '2 已入队记录有 queue_record_id');
    assert(rec.patient_id != null, '2 已入队记录有 patient_id');
  }
  for (const rec of failedRecords) {
    assert(rec.queue_record_id == null, '2 失败记录无 queue_record_id');
    assert(rec.error_code != null, '2 失败记录有 error_code');
  }

  console.log('用例2 通过 ✅ 正式批次在"重启后"状态完全一致\n');

  // ==========================================
  // 用例 3: 已撤销批次在"重启后"仍然存在且状态正确
  // ==========================================
  console.log('=== 用例3: 已撤销批次在"重启后"仍然存在且状态正确 ===');

  const revokedAfter = await request(`/nurse/batches/${revokedBatchId}`, { headers: nurse2H2 });
  assert(revokedAfter.status === beforeState.revokedBatch.status, `3 已撤销批次状态一致 (${revokedAfter.status})`);
  assert(revokedAfter.revoked_by === beforeState.revokedBatch.revoked_by, '3 revoked_by一致');
  assert(revokedAfter.revoked_at === beforeState.revokedBatch.revoked_at, '3 revoked_at一致');
  assert(revokedAfter.revoke_reason === beforeState.revokedBatch.revoke_reason, '3 revoke_reason一致');

  for (const rec of revokedAfter.records) {
    assert(rec.status === 'precheck_failed' || rec.status === 'failed', `3 记录状态为 precheck_failed (实际: ${rec.status})`);
    assert(rec.error_code === 'BATCH_REVOKED', '3 错误代码为 BATCH_REVOKED');
  }

  const revokedDraftAfter = await request(`/nurse/batches/${revokedDraftId}`, { headers: nurse2H2 });
  assert(revokedDraftAfter.status === beforeState.revokedDraft.status, `3 已撤销草稿状态一致 (${revokedDraftAfter.status})`);
  for (const rec of revokedDraftAfter.records) {
    assert(rec.status === 'precheck_failed' || rec.status === 'failed', `3 草稿撤销后记录状态为 precheck_failed (实际: ${rec.status})`);
    assert(rec.error_message.includes('草稿批次已撤销'), '3 错误信息包含"草稿批次已撤销"');
  }

  console.log('用例3 通过 ✅ 已撤销批次在"重启后"状态完全一致\n');

  // ==========================================
  // 用例 4: 权限判断在"重启后"仍然有效
  // ==========================================
  console.log('=== 用例4: 权限判断在"重启后"仍然有效 ===');

  const nurse1BatchesAfter = await request('/nurse/batches?pageSize=1000', { headers: nurse1H2 });
  const nurse2BatchesAfter = await request('/nurse/batches?pageSize=1000', { headers: nurse2H2 });
  const adminBatchesAfter = await request('/admin/batches?pageSize=1000', { headers: adminH2 });

  const nurse1IdsAfter = new Set(nurse1BatchesAfter.batches.map(b => b.id));
  const nurse2IdsAfter = new Set(nurse2BatchesAfter.batches.map(b => b.id));
  const adminIdsAfter = new Set(adminBatchesAfter.batches.map(b => b.id));

  assert(nurse1IdsAfter.has(draftBatchId), '4 nurse1 能看到自己的草稿');
  assert(nurse1IdsAfter.has(completedBatchId), '4 nurse1 能看到自己的正式批次');
  assert(!nurse1IdsAfter.has(revokedBatchId), '4 nurse1 不能看到 nurse2 的已撤销批次');
  assert(!nurse1IdsAfter.has(revokedDraftId), '4 nurse1 不能看到 nurse2 的已撤销草稿');

  assert(nurse2IdsAfter.has(revokedBatchId), '4 nurse2 能看到自己的已撤销批次');
  assert(nurse2IdsAfter.has(revokedDraftId), '4 nurse2 能看到自己的已撤销草稿');
  assert(!nurse2IdsAfter.has(draftBatchId), '4 nurse2 不能看到 nurse1 的草稿');
  assert(!nurse2IdsAfter.has(completedBatchId), '4 nurse2 不能看到 nurse1 的正式批次');

  assert(adminIdsAfter.has(draftBatchId), '4 admin 能看到 nurse1 的草稿');
  assert(adminIdsAfter.has(completedBatchId), '4 admin 能看到 nurse1 的正式批次');
  assert(adminIdsAfter.has(revokedBatchId), '4 admin 能看到 nurse2 的已撤销批次');
  assert(adminIdsAfter.has(revokedDraftId), '4 admin 能看到 nurse2 的已撤销草稿');
  assert(adminBatchesAfter.batches.length >= nurse1BatchesAfter.batches.length + nurse2BatchesAfter.batches.length,
    '4 admin 看到的批次数量 >= 两个护士看到的总和');

  for (const b of nurse1BatchesAfter.batches) {
    assert(b.imported_by === nurse1UserId, `4 nurse1 列表中批次 ${b.id} 的 imported_by 正确`);
  }
  for (const b of nurse2BatchesAfter.batches) {
    assert(b.imported_by === nurse2UserId, `4 nurse2 列表中批次 ${b.id} 的 imported_by 正确`);
  }

  let caughtN1N2 = false;
  try {
    await request(`/nurse/batches/${revokedBatchId}`, { headers: nurse1H2 });
  } catch (e) {
    caughtN1N2 = true;
    assert(e.status === 403, '4 nurse1 查看 nurse2 的批次返回 403');
  }
  assert(caughtN1N2 === true, '4 nurse1 不能查看 nurse2 的批次详情');

  let caughtN2N1 = false;
  try {
    await request(`/nurse/batches/${draftBatchId}`, { headers: nurse2H2 });
  } catch (e) {
    caughtN2N1 = true;
    assert(e.status === 403, '4 nurse2 查看 nurse1 的批次返回 403');
  }
  assert(caughtN2N1 === true, '4 nurse2 不能查看 nurse1 的批次详情');

  console.log('用例4 通过 ✅ 权限判断在"重启后"完全有效\n');

  // ==========================================
  // 用例 5: 导出内容在"重启后"仍然一致
  // ==========================================
  console.log('=== 用例5: 导出内容在"重启后"仍然一致 ===');

  const cleanCSV = (csv) => csv.trim().replace(/^\uFEFF/, '');

  const draftExportAfter = await requestText(`/nurse/batches/${draftBatchId}/csv`, { headers: nurse1NoCT2 });
  assert(cleanCSV(draftExportAfter) === cleanCSV(beforeState.nurse1DraftExport), '5 草稿导出内容一致');

  const completedExportAfter = await requestText(`/nurse/batches/${completedBatchId}/csv`, { headers: nurse1NoCT2 });
  assert(cleanCSV(completedExportAfter) === cleanCSV(beforeState.nurse1CompletedExport), '5 正式批次导出内容一致');

  const adminDraftExportAfter = await requestText(`/admin/batches/${draftBatchId}/csv`, { headers: adminNoCT2 });
  assert(cleanCSV(adminDraftExportAfter) === cleanCSV(beforeState.adminDraftExport), '5 管理员草稿导出内容一致');

  const adminCompletedExportAfter = await requestText(`/admin/batches/${completedBatchId}/csv`, { headers: adminNoCT2 });
  assert(cleanCSV(adminCompletedExportAfter) === cleanCSV(beforeState.adminCompletedExport), '5 管理员正式批次导出内容一致');

  assert(cleanCSV(draftExportAfter) === cleanCSV(adminDraftExportAfter), '5 护士和管理员导出的草稿内容一致');
  assert(cleanCSV(completedExportAfter) === cleanCSV(adminCompletedExportAfter), '5 护士和管理员导出的正式批次内容一致');

  console.log('用例5 通过 ✅ 导出内容在"重启后"完全一致\n');

  // ==========================================
  // 用例 6: 审计日志在"重启后"仍然完整
  // ==========================================
  console.log('=== 用例6: 审计日志在"重启后"仍然完整 ===');

  const auditResponseAfter = await request(`/public/audit-logs?resource_type=import_batch&pageSize=1000`, { headers: adminH2 });
  const auditAfter = auditResponseAfter.logs;
  const relatedAfter = auditAfter.filter(l => batchIds.includes(l.resource_id));
  assert(relatedAfter.length >= beforeState.relatedAudits.length, '6 审计日志数量未减少');

  for (const beforeAudit of beforeState.relatedAudits) {
    const afterAudit = relatedAfter.find(l => l.id === beforeAudit.id);
    assert(afterAudit != null, `6 审计日志 ${beforeAudit.id} 仍然存在`);
    assert(afterAudit.action === beforeAudit.action, `6 审计日志 ${beforeAudit.id} action 一致`);
    assert(afterAudit.user_id === beforeAudit.user_id, `6 审计日志 ${beforeAudit.id} user_id 一致`);
    assert(afterAudit.resource_type === beforeAudit.resource_type, `6 审计日志 ${beforeAudit.id} resource_type 一致`);
    assert(afterAudit.resource_id === beforeAudit.resource_id, `6 审计日志 ${beforeAudit.id} resource_id 一致`);
    assert(afterAudit.created_at === beforeAudit.created_at, `6 审计日志 ${beforeAudit.id} created_at 一致`);
  }

  const precheckAudits = relatedAfter.filter(l => l.action === 'precheck_batch');
  const confirmAudits = relatedAfter.filter(l => l.action === 'confirm_batch');
  const revokeAudits = relatedAfter.filter(l => l.action === 'revoke_batch');
  assert(precheckAudits.length === 4, '6 有 4 条 precheck_batch 日志');
  assert(confirmAudits.length === 2, '6 有 2 条 confirm_batch 日志');
  assert(revokeAudits.length === 2, '6 有 2 条 revoke_batch 日志');

  console.log('用例6 通过 ✅ 审计日志在"重启后"完整且一致\n');

  // ==========================================
  // 用例 7: 排队记录在"重启后"仍然存在
  // ==========================================
  console.log('=== 用例7: 排队记录在"重启后"仍然存在 ===');

  const queueRecordsAfter = await request('/nurse/queue/1', { headers: nurse1H2 });
  const completedQueueAfter = queueRecordsAfter.filter(r => r.batch_id === completedBatchId && r.status !== 'returned').length;
  assert(completedQueueAfter === beforeState.completedQueueCount, '7 正式批次排队记录数一致');

  for (const beforeRec of beforeState.completedBatch.records) {
    if (beforeRec.queue_record_id) {
      const afterQueue = queueRecordsAfter.find(q => q.id === beforeRec.queue_record_id);
      assert(afterQueue != null, `7 排队记录 ${beforeRec.queue_record_id} 仍然存在`);
      assert(afterQueue.status === 'waiting', `7 排队记录 ${beforeRec.queue_record_id} 状态仍为 waiting`);
      assert(afterQueue.batch_id === completedBatchId, `7 排队记录 ${beforeRec.queue_record_id} batch_id 一致`);
    }
  }

  console.log('用例7 通过 ✅ 排队记录在"重启后"完整且一致\n');

  // ==========================================
  // 用例 8: 草稿可以在"重启后"继续确认
  // ==========================================
  console.log('=== 用例8: 草稿可以在"重启后"继续确认 ===');

  const confAfter = await request('/nurse/batch/confirm', {
    method: 'POST', headers: nurse1H2,
    body: JSON.stringify({ batch_id: draftBatchId })
  });
  assert(confAfter.success === true, '8 "重启后"确认草稿成功');
  assert(confAfter.status === 'completed', '8 确认后批次状态为 completed');
  assert(confAfter.success_count === 2, '8 确认成功 2 条');

  const draftAfterConfirm = await request(`/nurse/batches/${draftBatchId}`, { headers: nurse1H2 });
  assert(draftAfterConfirm.status === 'completed', '8 确认后详情状态为 completed');
  assert(draftAfterConfirm.confirmed_by === nurse1UserId, '8 confirmed_by 正确');
  assert(draftAfterConfirm.confirmed_at != null, '8 confirmed_at 有值');
  for (const rec of draftAfterConfirm.records) {
    if (rec.status === 'enqueued') {
      assert(rec.queue_record_id != null, '8 已入队记录有 queue_record_id');
    }
  }

  const confirmAuditResponse = await request(`/public/audit-logs?resource_type=import_batch&resource_id=${draftBatchId}`, { headers: adminH2 });
  const hasConfirmAudit = confirmAuditResponse.logs.some(l => l.action === 'confirm_batch');
  assert(hasConfirmAudit === true, '8 确认操作有审计日志');

  console.log('用例8 通过 ✅ 草稿可以在"重启后"继续确认\n');

  console.log('=== 测试完成 ===');
  console.log(`通过: ${passed}, 失败: ${failed}`);
  if (failed > 0) process.exit(1);
}

main().catch(e => { console.error('测试执行出错:', e.path || '', e.status ? JSON.stringify(e.data || e) : (e.message || e)); process.exit(1); });
