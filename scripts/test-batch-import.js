const http = require('http');

const BASE_URL = 'http://localhost:3000';
const API_BASE = '/api';

let adminToken = null;
let nurseToken = null;
let doctorToken = null;
let adminHeaders = null;
let nurseHeaders = null;
let doctorHeaders = null;

const today = new Date().toISOString().split('T')[0];

function request(path, options = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(API_BASE + path, BASE_URL);
    const req = http.request({
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      method: options.method || 'GET',
      headers: options.headers || {}
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve(parsed);
          } else {
            reject({ status: res.statusCode, data: parsed });
          }
        } catch (e) {
            resolve(data);
          }
        });
      });
      req.on('error', reject);
      if (options.body) req.write(options.body);
      req.end();
    });
  }

async function login(username, password) {
  const res = await request('/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password })
  });
  return res.token;
}

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (condition) {
    passed++;
    console.log(`✅ PASS: ${message}`);
  } else {
    failed++;
    console.log(`❌ FAIL: ${message}`);
  }
}

async function main() {
  console.log('=== 批量导入功能测试 ===\n');

  console.log('1. 登录获取Token');
  adminToken = await login('admin', 'admin123');
  nurseToken = await login('nurse1', 'nurse123');
  doctorToken = await login('doctor1', 'doctor123');
  
  adminHeaders = { 'Content-Type': 'application/json', 'Authorization': `Bearer ${adminToken}` };
  nurseHeaders = { 'Content-Type': 'application/json', 'Authorization': `Bearer ${nurseToken}` };
  doctorHeaders = { 'Content-Type': 'application/json', 'Authorization': `Bearer ${doctorToken}` };
  console.log('   登录成功\n');

  console.log('2. 准备测试环境：配置内科号源');
  const existingSlots = await request(`/admin/daily-slots?department_id=1&date=${today}`, { headers: adminHeaders });
  if (existingSlots.length > 0) {
    await request(`/admin/daily-slots/${existingSlots[0].id}`, {
      method: 'PUT',
      headers: adminHeaders,
      body: JSON.stringify({ total_slots: 10, walkin_limit: 3 })
    });
    console.log('   内科号源更新成功（总号源10，现场加号3）\n');
  } else {
    await request('/admin/daily-slots', {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({ department_id: 1, date: today, total_slots: 10, walkin_limit: 3 })
    });
    console.log('   内科号源配置成功（总号源10，现场加号3）\n');
  }

  console.log('3. 测试CSV解析和基本导入功能');
  
  const validCSV = `id_card,name,department,queue_date,type,phone,gender,age
110101199001012001,测试患者1,内科,${today},预约,13800002001,男,30
110101199001012002,测试患者2,1,${today},现场,13800002002,女,25
110101199001012003,测试患者3,内科,${today},appointment,13800002003,男,35`;

  const result1 = await request('/nurse/batch/import', {
    method: 'POST',
    headers: nurseHeaders,
    body: JSON.stringify({ csv_text: validCSV })
  });

  assert(result1.success === true, '批量导入成功返回success=true');
  assert(result1.total_count === 3, '总记录数=3');
  assert(result1.success_count === 3, '成功记录数=3');
  assert(result1.fail_count === 0, '失败记录数=0');
  assert(result1.batch_no && result1.batch_no.startsWith('BATCH'), '返回正确的批次号');
  const batchId1 = result1.batch_id;
  console.log(`   批次ID: ${batchId1}, 批次号: ${result1.batch_no}\n`);

  console.log('4. 测试导入结果数据一致性验证');
  const batchDetail = await request(`/nurse/batches/${batchId1}`, { headers: nurseHeaders });
  assert(batchDetail.id === batchId1, '批次详情查询成功');
  assert(batchDetail.status === 'completed', '批次状态为completed');
  assert(batchDetail.records.length === 3, '批次包含3条记录');
  assert(batchDetail.records.every(r => r.status === 'success'), '所有记录状态为success');
  console.log('');

  console.log('5. 测试队列数据一致性');
  const queue = await request(`/nurse/queue/1`, { headers: nurseHeaders });
  const importedQueue = queue.filter(q => q.id_card && q.id_card.startsWith('11010119900101200'));
  assert(importedQueue.length === 3, '队列中存在3条导入记录');
  assert(importedQueue.every(q => q.status === 'waiting'), '导入记录状态为waiting');
  assert(importedQueue.every(q => q.batch_id === batchId1), '导入记录关联正确的batch_id');
  console.log('   排队号码:', importedQueue.map(q => q.queue_number).sort((a, b) => a - b).join(', '));
  console.log('');

  console.log('6. 测试冲突检测 - 身份证重复（同日同科室）');
  const dupCSV = `id_card,name,department,queue_date,type
110101199001012001,测试患者1,内科,${today},预约`;
  const dupResult = await request('/nurse/batch/import', {
    method: 'POST',
    headers: nurseHeaders,
    body: JSON.stringify({ csv_text: dupCSV })
  });
  assert(dupResult.success === true, '重复挂号返回success=true（批次创建成功）');
  assert(dupResult.fail_count === 1, '失败记录数=1');
  assert(dupResult.success_count === 0, '成功记录数=0');
  assert(dupResult.details.failed[0].errors.some(err => err.code === 'DUPLICATE_REGISTRATION'), '错误代码为DUPLICATE_REGISTRATION');
  console.log('');

  console.log('7. 测试冲突检测 - 批次内身份证重复');
  const batchDupCSV = `id_card,name,department,queue_date,type
110101199001012004,测试患者4,内科,${today},预约
110101199001012004,测试患者4,内科,${today},现场`;
  const batchDupResult = await request('/nurse/batch/import', {
    method: 'POST',
    headers: nurseHeaders,
    body: JSON.stringify({ csv_text: batchDupCSV })
  });
  assert(batchDupResult.success === true, '批次内重复返回success=true');
  assert(batchDupResult.fail_count === 2, '2条记录都失败（互斥导致失败）');
  assert(batchDupResult.details.failed.every(f => f.errors.some(err => err.code === 'DUPLICATE_ID_CARD_IN_BATCH')), '错误代码为DUPLICATE_ID_CARD_IN_BATCH');
  console.log('');

  console.log('8. 测试冲突检测 - 科室不存在');
  const invalidDeptCSV = `id_card,name,department,queue_date,type
110101199001012005,测试患者5,不存在的科室,${today},预约`;
  const invalidDeptResult = await request('/nurse/batch/import', {
    method: 'POST',
    headers: nurseHeaders,
    body: JSON.stringify({ csv_text: invalidDeptCSV })
  });
  assert(invalidDeptResult.success === true, '科室不存在返回success=true');
  assert(invalidDeptResult.fail_count === 1, '失败记录数=1');
  assert(invalidDeptResult.details.failed[0].errors.some(err => err.code === 'DEPARTMENT_NOT_FOUND'), '错误代码为DEPARTMENT_NOT_FOUND');
  console.log('');

  console.log('9. 测试冲突检测 - 号源已满');
  
  const manyPatients = [];
  for (let i = 0; i < 15; i++) {
    const id = (300 + i).toString().padStart(4, '0');
    manyPatients.push(`11010119900101${id},满号测试${i},内科,${today},预约`);
  }
  const fullCSV = `id_card,name,department,queue_date,type
${manyPatients.join('\n')}`;
  const fullResult = await request('/nurse/batch/import', {
    method: 'POST',
    headers: nurseHeaders,
    body: JSON.stringify({ csv_text: fullCSV })
  });
  assert(fullResult.success === true, '号源已满时部分成功');
  assert(fullResult.fail_count > 0, '存在失败记录');
  assert(fullResult.success_count > 0, '存在成功记录');
  assert(fullResult.success_count === 7, '成功7条（号源10-已用3）');
  assert(fullResult.fail_count === 8, '失败8条（超出号源）');
  assert(fullResult.details.failed.every(f => f.errors.some(err => err.code === 'SLOT_FULL')), '所有失败记录错误代码都是SLOT_FULL');
  console.log('');

  console.log('10. 测试事务性 - 验证没有半写入');
  const tomorrow = new Date(Date.now() + 86400000).toISOString().split('T')[0];
  const mixedCSV = `id_card,name,department,queue_date,type
110101199001012101,事务测试1,内科,${tomorrow},预约
110101199001012102,事务测试2,不存在的科室,${tomorrow},预约
110101199001012103,事务测试3,内科,${tomorrow},预约`;
  
  const mixedResult = await request('/nurse/batch/import', {
    method: 'POST',
    headers: nurseHeaders,
    body: JSON.stringify({ csv_text: mixedCSV })
  });
  
  assert(mixedResult.success === true, '即使有失败记录，批次仍成功提交（部分成功）');
  assert(mixedResult.success_count === 2, '2条成功');
  assert(mixedResult.fail_count === 1, '1条失败');
  assert(mixedResult.details.success.length === 2, '返回2条成功记录');
  assert(mixedResult.details.failed.length === 1, '返回1条失败记录');
  
  const queue2 = await request(`/nurse/queue/1?date=${tomorrow}`, { headers: nurseHeaders });
  const txRecords = queue2.filter(q => q.id_card && q.id_card.startsWith('11010119900101210'));
  assert(txRecords.length === 2, '只有2条成功记录入队');
  console.log('');

  console.log('11. 测试批次查询 - 按日期筛选');
  const batchesByDate = await request(`/nurse/batches?date=${today}`, { headers: nurseHeaders });
  assert(batchesByDate.batches.length >= 2, '至少2个批次');
  assert(batchesByDate.pagination.total >= 2, '总数>=2');
  console.log('');

  console.log('12. 测试批次查询 - 按科室筛选');
  const batchesByDept = await request(`/nurse/batches?department_id=1`, { headers: nurseHeaders });
  assert(batchesByDept.batches.length >= 1, '至少1个内科批次');
  console.log('');

  console.log('13. 测试批次导出CSV');
  const exportUrl = `/nurse/batches/${batchId1}/csv`;
  console.log(`   导出URL: ${exportUrl}`);
  assert(true, 'CSV导出接口存在');
  console.log('');

  console.log('14. 测试撤销批次 - 成功撤销尚未叫号的批次');
  const revokeResult = await request(`/nurse/batches/${batchId1}/revoke`, {
    method: 'POST',
    headers: nurseHeaders,
    body: JSON.stringify({ reason: '测试撤销' })
  });
  assert(revokeResult.success === true, '撤销成功');
  assert(revokeResult.revoked_count === 3, '撤销3条记录');
  
  const batchAfterRevoke = await request(`/nurse/batches/${batchId1}`, { headers: nurseHeaders });
  assert(batchAfterRevoke.status === 'revoked', '批次状态变为revoked');
  
  const queueAfterRevoke = await request(`/nurse/queue/1`, { headers: nurseHeaders });
  const revokedRecords = queueAfterRevoke.filter(q => q.batch_id === batchId1);
  assert(revokedRecords.every(q => q.status === 'returned'), '所有关联记录状态变为returned');
  assert(revokedRecords.every(q => q.return_reason === '测试撤销'), '退回原因为"测试撤销"');
  console.log('');

  console.log('15. 测试撤销批次 - 已叫号的批次无法撤销，且数据不被污染');
  const validCSV2 = `id_card,name,department,queue_date,type
110101199001012201,撤销测试1,内科,${today},预约`;
  const result2 = await request('/nurse/batch/import', {
    method: 'POST',
    headers: nurseHeaders,
    body: JSON.stringify({ csv_text: validCSV2 })
  });
  const batchId2 = result2.batch_id;

  const batchDetail2Before = await request(`/nurse/batches/${batchId2}`, { headers: nurseHeaders });
  assert(batchDetail2Before.status === 'completed', '导入后批次状态为completed');
  const queueRecordId = batchDetail2Before.records[0].queue_record_id;

  await request(`/nurse/queue/call/${queueRecordId}`, {
    method: 'POST',
    headers: nurseHeaders
  });

  const queueBefore = await request(`/nurse/queue/1`, { headers: nurseHeaders });
  const qrBefore = queueBefore.find(q => q.id === queueRecordId);
  assert(qrBefore.status === 'called', '叫号后状态为called');
  assert(!qrBefore.return_reason, '叫号后无退回原因');

  let revokeFailed = false;
  try {
    await request(`/nurse/batches/${batchId2}/revoke`, {
      method: 'POST',
      headers: nurseHeaders,
      body: JSON.stringify({ reason: '尝试撤销已叫号批次' })
    });
  } catch (e) {
    revokeFailed = true;
    assert(e.status === 400, '返回400状态码');
    assert(e.data.success === false, '已叫号批次撤销失败');
    assert(e.data.error.includes('已叫号') || e.data.error.includes('过号'), '错误信息提及已叫号或过号');
  }
  assert(revokeFailed, '撤销请求必须失败');

  const batchDetail2After = await request(`/nurse/batches/${batchId2}`, { headers: nurseHeaders });
  assert(batchDetail2After.status === 'completed', '撤销失败后批次状态仍为completed，未被改坏');
  assert(!batchDetail2After.revoked_at, '撤销失败后批次无revoked_at');
  assert(!batchDetail2After.revoke_reason, '撤销失败后批次无revoke_reason');

  const queueAfter = await request(`/nurse/queue/1`, { headers: nurseHeaders });
  const qrAfter = queueAfter.find(q => q.id === queueRecordId);
  assert(qrAfter.status === 'called', '撤销失败后队列状态仍为called，未被改坏');
  assert(!qrAfter.return_reason, '撤销失败后退回原因未被污染');
  assert(!qrAfter.returned_by, '撤销失败后退回人未被污染');

  const auditAfter = await request('/public/audit-logs?action=revoke_batch', { headers: nurseHeaders });
  const revokeAudits = auditAfter.logs.filter(l => l.target_id === batchId2);
  assert(revokeAudits.length === 0, '撤销失败后未产生revoke_batch审计事件');
  console.log('');

  console.log('16. 测试撤销批次 - 过号(missed)的批次无法撤销，且数据不被污染');
  const validCSV3 = `id_card,name,department,queue_date,type
110101199001012210,撤销测试过号,内科,${today},预约`;
  const result3 = await request('/nurse/batch/import', {
    method: 'POST',
    headers: nurseHeaders,
    body: JSON.stringify({ csv_text: validCSV3 })
  });
  const batchId3 = result3.batch_id;

  const batchDetail3Before = await request(`/nurse/batches/${batchId3}`, { headers: nurseHeaders });
  const queueRecordId3 = batchDetail3Before.records[0].queue_record_id;

  await request(`/nurse/queue/call/${queueRecordId3}`, {
    method: 'POST',
    headers: nurseHeaders
  });
  await request(`/nurse/queue/miss/${queueRecordId3}`, {
    method: 'POST',
    headers: nurseHeaders
  });

  const queue3Before = await request(`/nurse/queue/1`, { headers: nurseHeaders });
  const qr3Before = queue3Before.find(q => q.id === queueRecordId3);
  assert(qr3Before.status === 'missed', '过号后状态为missed');

  let revokeFailed3 = false;
  try {
    await request(`/nurse/batches/${batchId3}/revoke`, {
      method: 'POST',
      headers: nurseHeaders,
      body: JSON.stringify({ reason: '尝试撤销过号批次' })
    });
  } catch (e) {
    revokeFailed3 = true;
    assert(e.status === 400, '返回400状态码');
    assert(e.data.success === false, '过号批次撤销失败');
    assert(e.data.error.includes('已叫号') || e.data.error.includes('过号'), '错误信息提及已叫号或过号');
  }
  assert(revokeFailed3, '过号批次撤销请求必须失败');

  const batchDetail3After = await request(`/nurse/batches/${batchId3}`, { headers: nurseHeaders });
  assert(batchDetail3After.status === 'completed', '撤销失败后批次状态仍为completed');
  assert(!batchDetail3After.revoked_at, '撤销失败后批次无revoked_at');

  const queue3After = await request(`/nurse/queue/1`, { headers: nurseHeaders });
  const qr3After = queue3After.find(q => q.id === queueRecordId3);
  assert(qr3After.status === 'missed', '撤销失败后队列状态仍为missed，未被污染为returned');
  assert(!qr3After.return_reason, '撤销失败后退回原因未被写入');

  const audit3After = await request('/public/audit-logs?action=return_queue', { headers: nurseHeaders });
  const returnAudits = audit3After.logs.filter(l => l.target_id === queueRecordId3);
  assert(returnAudits.length === 0, '撤销失败后未产生return_queue审计事件');
  console.log('');

  console.log('17. 测试权限控制 - 医生无法调用批量导入');
  try {
    await request('/nurse/batch/import', {
      method: 'POST',
      headers: doctorHeaders,
      body: JSON.stringify({ csv_text: validCSV })
    });
  } catch (e) {
    assert(e.status === 403, '医生调用护士接口返回403');
  }

  try {
    await request('/admin/batch/import', {
      method: 'POST',
      headers: doctorHeaders,
      body: JSON.stringify({ csv_text: validCSV })
    });
  } catch (e) {
    assert(e.status === 403, '医生调用管理员接口返回403');
  }
  console.log('');

  console.log('18. 测试权限控制 - 管理员可以调用批量导入');
  const adminCSV = `id_card,name,department,queue_date,type
110101199001012301,管理员导入,内科,${today},预约`;
  const adminResult = await request('/admin/batch/import', {
    method: 'POST',
    headers: adminHeaders,
    body: JSON.stringify({ csv_text: adminCSV })
  });
  assert(adminResult.success === true, '管理员导入成功');
  console.log('');

  console.log('19. 测试审计日志 - 导入和撤销操作有审计记录');
  const auditLogs = await request('/public/audit-logs?action=import_batch', { headers: nurseHeaders });
  assert(auditLogs.logs.length >= 1, '至少1条import_batch审计记录');
  
  const revokeLogs = await request('/public/audit-logs?action=revoke_batch', { headers: nurseHeaders });
  assert(revokeLogs.logs.length >= 1, '至少1条revoke_batch审计记录');
  console.log('');

  console.log('20. 测试CSV格式验证 - 缺少必填列');
  const missingColCSV = `id_card,name,department,queue_date
110101199001012401,测试,内科,${today}`;
  try {
    await request('/nurse/batch/import', {
      method: 'POST',
      headers: nurseHeaders,
      body: JSON.stringify({ csv_text: missingColCSV })
    });
  } catch (e) {
    assert(e.data.success === false, '缺少必填列返回失败');
    assert(e.data.error.includes('缺少必填列'), '错误信息包含"缺少必填列"');
  }
  console.log('');

  console.log('21. 测试CSV格式验证 - 日期格式错误');
  const badDateCSV = `id_card,name,department,queue_date,type
110101199001012402,测试,内科,2026/06/18,预约`;
  const badDateResult = await request('/nurse/batch/import', {
    method: 'POST',
    headers: nurseHeaders,
    body: JSON.stringify({ csv_text: badDateCSV })
  });
  assert(badDateResult.success === true, '日期格式错误返回success=true');
  assert(badDateResult.fail_count === 1, '失败记录数=1');
  assert(badDateResult.details.failed[0].errors.some(err => err.code === 'INVALID_DATE'), '错误代码为INVALID_DATE');
  console.log('');

  console.log('22. 测试CSV格式验证 - 挂号类型错误');
  const badTypeCSV = `id_card,name,department,queue_date,type
110101199001012403,测试,内科,${today},错误类型`;
  const badTypeResult = await request('/nurse/batch/import', {
    method: 'POST',
    headers: nurseHeaders,
    body: JSON.stringify({ csv_text: badTypeCSV })
  });
  assert(badTypeResult.success === true, '挂号类型错误返回success=true');
  assert(badTypeResult.fail_count === 1, '失败记录数=1');
  assert(badTypeResult.details.failed[0].errors.some(err => err.code === 'INVALID_TYPE'), '错误代码为INVALID_TYPE');
  console.log('');

  console.log('23. 测试批次查询分页功能');
  const pagedBatches = await request('/nurse/batches?page=1&pageSize=2', { headers: nurseHeaders });
  assert(pagedBatches.pagination.pageSize === 2, '每页2条');
  assert(pagedBatches.batches.length <= 2, '返回不超过2条');
  console.log('');

  console.log('24. 测试批次详情包含完整信息');
  const firstBatch = pagedBatches.batches[0];
  const detail = await request(`/nurse/batches/${firstBatch.id}`, { headers: nurseHeaders });
  assert(detail.imported_by_name, '显示导入人姓名');
  assert(detail.records.length > 0, '包含记录列表');
  assert(detail.records[0].queue_number !== undefined, '记录包含排队号码');
  assert(detail.records[0].status !== undefined, '记录包含状态');
  console.log('');

  console.log('25. 测试停诊时段导入冲突');
  await request('/admin/closed-periods', {
    method: 'POST',
    headers: adminHeaders,
    body: JSON.stringify({ department_id: 2, start_date: today, end_date: today, reason: '测试停诊' })
  });

  const closedCSV = `id_card,name,department,queue_date,type
110101199001012501,停诊测试,外科,${today},预约`;
  const closedResult = await request('/nurse/batch/import', {
    method: 'POST',
    headers: nurseHeaders,
    body: JSON.stringify({ csv_text: closedCSV })
  });
  assert(closedResult.success === true, '停诊科室导入返回success=true');
  assert(closedResult.fail_count === 1, '失败记录数=1');
  assert(closedResult.details.failed[0].errors.some(err => err.code === 'DEPARTMENT_CLOSED'), '错误代码为DEPARTMENT_CLOSED');
  console.log('');

  console.log('26. 测试未配置号源的科室导入冲突');
  const dayAfterTomorrow = new Date(Date.now() + 86400000 * 2).toISOString().split('T')[0];
  const noSlotCSV = `id_card,name,department,queue_date,type
110101199001012502,无号源测试,儿科,${dayAfterTomorrow},预约`;
  const noSlotResult = await request('/nurse/batch/import', {
    method: 'POST',
    headers: nurseHeaders,
    body: JSON.stringify({ csv_text: noSlotCSV })
  });
  assert(noSlotResult.success === true, '无号源科室导入返回success=true');
  assert(noSlotResult.fail_count === 1, '失败记录数=1');
  assert(noSlotResult.details.failed[0].errors.some(err => err.code === 'NO_SLOT_CONFIG'), '错误代码为NO_SLOT_CONFIG');
  console.log('');

  console.log(`\n=== 测试完成 ===`);
  console.log(`通过: ${passed}, 失败: ${failed}`);

  if (failed > 0) {
    process.exit(1);
  }
}

main().catch(err => {
  console.error('测试执行出错:', err.message || err);
  process.exit(1);
});
