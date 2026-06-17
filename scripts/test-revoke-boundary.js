const http = require('http');

const BASE_URL = 'http://localhost:3000';
const API_BASE = '/api';

let passed = 0;
let failed = 0;
function assert(cond, msg) {
  if (cond) {
    passed++;
    console.log(`✅PASS: ${msg}`);
  } else {
    failed++;
    console.log(`❌FAIL: ${msg}`);
  }
}

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
        } catch (e) { resolve(data); }
      });
    });
    req.on('error', reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

async function main() {
  const today = new Date().toISOString().split('T')[0];
  console.log(`=== 批量撤销边界回归测试（日期: ${today}）===\n`);

  console.log('0. 登录获取Token');
  const login = await request('/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'nurse1', password: 'nurse123' })
  });
  const nurseHeaders = { 'Authorization': 'Bearer ' + login.token, 'Content-Type': 'application/json' };

  const adminLogin = await request('/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin123' })
  });
  const adminHeaders = { 'Authorization': 'Bearer ' + adminLogin.token, 'Content-Type': 'application/json' };

  console.log('   登录成功');
  console.log(`   配置内科${today}号源: 总号源100, 现场加号50`);
  try {
    await request('/admin/daily-slots', {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({ department_id: 1, date: today, total_slots: 100, walkin_limit: 50 })
    });
  } catch (e) {
    const existing = await request(`/admin/daily-slots?department_id=1&date=${today}`, { headers: adminHeaders });
    if (existing.length > 0) {
      await request(`/admin/daily-slots/${existing[0].id}`, {
        method: 'PUT',
        headers: adminHeaders,
        body: JSON.stringify({ total_slots: 100, walkin_limit: 50 })
      });
    }
  }
  console.log('   号源配置完成\n');

  console.log('=== 用例A: 整批均为 waiting → 可撤销成功 ===');
  const csvA = `id_card,name,department,queue_date,type\n110101199001017001,撤销A1,内科,${today},预约\n110101199001017002,撤销A2,内科,${today},预约\n110101199001017003,撤销A3,内科,${today},预约`;
  const impA = await request('/nurse/batch/import', {
    method: 'POST', headers: nurseHeaders, body: JSON.stringify({ csv_text: csvA })
  });
  assert(impA.success === true, 'A批次导入成功');
  assert(impA.success_count === 3, 'A批次3条全部成功');

  const queueBeforeA = await request(`/nurse/queue/1`, { headers: nurseHeaders });
  const recsA = queueBeforeA.filter(q => q.batch_id === impA.batch_id);
  assert(recsA.length === 3, 'A批次队列有3条记录');
  assert(recsA.every(q => q.status === 'waiting'), 'A批次3条均为waiting');

  const revA = await request(`/nurse/batches/${impA.batch_id}/revoke`, {
    method: 'POST', headers: nurseHeaders, body: JSON.stringify({ reason: '用例A撤销' })
  });
  assert(revA.success === true, 'A批次撤销成功');
  assert(revA.revoked_count === 3, 'A批次撤销3条');

  const batchAfterA = await request(`/nurse/batches/${impA.batch_id}`, { headers: nurseHeaders });
  assert(batchAfterA.status === 'revoked', 'A批次状态变为revoked');
  assert(batchAfterA.revoke_reason === '用例A撤销', 'A批次撤销原因正确');

  const queueAfterA = await request(`/nurse/queue/1`, { headers: nurseHeaders });
  const recsAfterA = queueAfterA.filter(q => q.batch_id === impA.batch_id);
  assert(recsAfterA.every(q => q.status === 'returned'), 'A批次所有记录变为returned');
  assert(recsAfterA.every(q => q.return_reason === '用例A撤销'), 'A批次退回原因正确');
  console.log('');

  console.log('=== 用例B: 有1条已叫号(called) → 撤销失败，数据不被污染 ===');
  const csvB = `id_card,name,department,queue_date,type\n110101199001017101,撤销B1,内科,${today},预约\n110101199001017102,撤销B2,内科,${today},预约`;
  const impB = await request('/nurse/batch/import', {
    method: 'POST', headers: nurseHeaders, body: JSON.stringify({ csv_text: csvB })
  });
  const batchB = await request(`/nurse/batches/${impB.batch_id}`, { headers: nurseHeaders });
  const calledId = batchB.records[0].queue_record_id;
  const waitingId = batchB.records[1].queue_record_id;

  await request(`/nurse/queue/call/${calledId}`, { method: 'POST', headers: nurseHeaders });

  const qBeforeB = await request(`/nurse/queue/1`, { headers: nurseHeaders });
  const qCalled = qBeforeB.find(q => q.id === calledId);
  const qWaiting = qBeforeB.find(q => q.id === waitingId);
  assert(qCalled.status === 'called', 'B1状态为called');
  assert(qWaiting.status === 'waiting', 'B2状态为waiting');
  assert(!qCalled.return_reason, 'B1无return_reason');

  let bFailed = false;
  try {
    await request(`/nurse/batches/${impB.batch_id}/revoke`, {
      method: 'POST', headers: nurseHeaders, body: JSON.stringify({ reason: '尝试撤销已叫号批次' })
    });
  } catch (e) {
    bFailed = true;
    assert(e.status === 400, 'B返回400状态码');
    assert(e.data.success === false, 'B撤销接口返回success=false');
    assert(/已叫号|过号|就诊/.test(e.data.error), 'B错误信息提及已叫号/过号/就诊');
  }
  assert(bFailed, 'B撤销必须失败');

  const batchAfterB = await request(`/nurse/batches/${impB.batch_id}`, { headers: nurseHeaders });
  assert(batchAfterB.status === 'completed', 'B批次状态仍为completed，未被改坏');
  assert(!batchAfterB.revoked_at, 'B批次无revoked_at');
  assert(!batchAfterB.revoke_reason, 'B批次无revoke_reason');

  const qAfterB = await request(`/nurse/queue/1`, { headers: nurseHeaders });
  const qCalledAfter = qAfterB.find(q => q.id === calledId);
  const qWaitingAfter = qAfterB.find(q => q.id === waitingId);
  assert(qCalledAfter.status === 'called', 'B1(called)状态未被污染，仍为called');
  assert(qWaitingAfter.status === 'waiting', 'B2(waiting)状态未被污染，仍为waiting');
  assert(!qCalledAfter.return_reason, 'B1无return_reason，未被污染');
  assert(!qCalledAfter.returned_by, 'B1无returned_by，未被污染');
  assert(!qWaitingAfter.return_reason, 'B2无return_reason，未被污染');

  const auditRevB = await request('/public/audit-logs?action=revoke_batch', { headers: nurseHeaders });
  const bRevokeAudits = auditRevB.logs.filter(l => l.target_id === impB.batch_id);
  assert(bRevokeAudits.length === 0, 'B未产生revoke_batch审计事件');

  const auditRetB = await request('/public/audit-logs?action=return_queue', { headers: nurseHeaders });
  const bReturnAudits = auditRetB.logs.filter(l => [calledId, waitingId].includes(l.target_id));
  assert(bReturnAudits.length === 0, 'B未产生return_queue审计事件');
  console.log('');

  console.log('=== 用例C: 有1条已过号(missed) → 撤销失败，数据不被污染 ===');
  const csvC = `id_card,name,department,queue_date,type\n110101199001017201,撤销C1,内科,${today},预约\n110101199001017202,撤销C2,内科,${today},预约`;
  const impC = await request('/nurse/batch/import', {
    method: 'POST', headers: nurseHeaders, body: JSON.stringify({ csv_text: csvC })
  });
  const batchC = await request(`/nurse/batches/${impC.batch_id}`, { headers: nurseHeaders });
  const missedId = batchC.records[0].queue_record_id;

  await request(`/nurse/queue/call/${missedId}`, { method: 'POST', headers: nurseHeaders });
  await request(`/nurse/queue/miss/${missedId}`, { method: 'POST', headers: nurseHeaders });

  const qBeforeC = await request(`/nurse/queue/1`, { headers: nurseHeaders });
  const qMissed = qBeforeC.find(q => q.id === missedId);
  assert(qMissed.status === 'missed', 'C1状态为missed');

  let cFailed = false;
  try {
    await request(`/nurse/batches/${impC.batch_id}/revoke`, {
      method: 'POST', headers: nurseHeaders, body: JSON.stringify({ reason: '尝试撤销过号批次' })
    });
  } catch (e) {
    cFailed = true;
    assert(e.status === 400, 'C返回400状态码');
    assert(e.data.success === false, 'C撤销接口返回success=false');
    assert(/已叫号|过号|就诊/.test(e.data.error), 'C错误信息提及已叫号/过号/就诊');
  }
  assert(cFailed, 'C撤销必须失败');

  const qAfterC = await request(`/nurse/queue/1`, { headers: nurseHeaders });
  const qMissedAfter = qAfterC.find(q => q.id === missedId);
  assert(qMissedAfter.status === 'missed', 'C1(missed)未被污染为returned，仍为missed');
  assert(!qMissedAfter.return_reason, 'C1退回原因未被写入，数据干净');

  const batchAfterC = await request(`/nurse/batches/${impC.batch_id}`, { headers: nurseHeaders });
  assert(batchAfterC.status === 'completed', 'C批次状态仍为completed');
  console.log('');

  console.log('=== 用例D: 重复撤销已revoked的批次 → 失败 ===');
  let dFailed = false;
  try {
    await request(`/nurse/batches/${impA.batch_id}/revoke`, {
      method: 'POST', headers: nurseHeaders, body: JSON.stringify({ reason: '重复撤销' })
    });
  } catch (e) {
    dFailed = true;
    assert(e.status === 400, 'D返回400');
    assert(e.data.error === '该批次已撤销', 'D提示"该批次已撤销"');
  }
  assert(dFailed, 'D重复撤销必须失败');
  console.log('');

  console.log(`\n=== 测试完成 ===`);
  console.log(`通过: ${passed}, 失败: ${failed}`);
  if (failed > 0) process.exit(1);
}

main().catch(err => { console.error('测试执行出错:', err.message || err); process.exit(1); });
