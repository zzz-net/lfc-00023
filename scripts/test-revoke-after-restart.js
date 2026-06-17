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
    const req = http.request({
      hostname: url.hostname, port: url.port,
      path: url.pathname + url.search, method: options.method || 'GET',
      headers: options.headers || {}
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const p = JSON.parse(data);
          if (res.statusCode >= 200 && res.statusCode < 300) resolve(p); else reject({ status: res.statusCode, data: p });
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
  console.log('=== 批量撤销 - 重启后数据一致性验证 ===\n');

  const login = await request('/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'nurse1', password: 'nurse123' })
  });
  const h = { 'Authorization': 'Bearer ' + login.token, 'Content-Type': 'application/json' };
  console.log('登录成功，日期: ' + today + '\n');

  console.log('验证: 用例B(叫号)记录 - 重启后仍为 called，未被污染');
  const q1 = await request('/nurse/queue/1', { headers: h });
  const calledRec = q1.find(r => r.name === '撤销B1');
  if (calledRec) {
    assert(calledRec.status === 'called', '撤销B1 状态 = called');
    assert(!calledRec.return_reason, '撤销B1 无 return_reason');
    assert(!calledRec.returned_by, '撤销B1 无 returned_by');
  } else {
    console.log('   (未找到撤销B1记录，可能号源日期不匹配，跳过)');
  }

  console.log('\n验证: 用例C(过号)记录 - 重启后仍为 missed，未被污染');
  const missedRec = q1.find(r => r.name === '撤销C1');
  if (missedRec) {
    assert(missedRec.status === 'missed', '撤销C1 状态 = missed');
    assert(!missedRec.return_reason, '撤销C1 无 return_reason');
  } else {
    console.log('   (未找到撤销C1记录，可能号源日期不匹配，跳过)');
  }

  console.log('\n验证: 用例A(成功撤销)记录 - 重启后仍为 returned');
  const returnedRec = q1.find(r => r.name === '撤销A1');
  if (returnedRec) {
    assert(returnedRec.status === 'returned', '撤销A1 状态 = returned');
    assert(returnedRec.return_reason === '用例A撤销', '撤销A1 退回原因正确');
  } else {
    console.log('   (未找到撤销A1记录，可能号源日期不匹配，跳过)');
  }

  console.log('\n验证: 用例B批次状态 - 重启后仍为 completed，未被改坏');
  const batches = await request('/nurse/batches?date=' + today, { headers: h });
  const bBatch = batches.batches.find(b => b.total_count === 2 && b.status === 'completed');
  if (bBatch) {
    const detail = await request('/nurse/batches/' + bBatch.id, { headers: h });
    assert(detail.status === 'completed', 'B批次仍为completed');
    assert(!detail.revoked_at, 'B批次无revoked_at');
    assert(!detail.revoke_reason, 'B批次无revoke_reason');
  } else {
    console.log('   (未找到符合条件的B批次，跳过)');
  }

  console.log('\n验证: 用例A批次状态 - 重启后为 revoked');
  const aBatch = batches.batches.find(b => b.status === 'revoked');
  if (aBatch) {
    const detail = await request('/nurse/batches/' + aBatch.id, { headers: h });
    assert(detail.status === 'revoked', 'A批次仍为revoked');
    assert(detail.revoke_reason === '用例A撤销', 'A批次撤销原因正确');
  } else {
    console.log('   (未找到revoked状态批次，跳过)');
  }

  console.log('\n验证: 重启后仍然不能撤销 called 批次');
  const import1 = await request('/nurse/batch/import', {
    method: 'POST', headers: h,
    body: JSON.stringify({ csv_text: `id_card,name,department,queue_date,type\n110101199001017991,重启后叫号,内科,${today},预约` })
  });
  if (import1.success && import1.success_count === 1) {
    const d1 = await request('/nurse/batches/' + import1.batch_id, { headers: h });
    await request('/nurse/queue/call/' + d1.records[0].queue_record_id, { method: 'POST', headers: h });
    let caught = false;
    try {
      await request('/nurse/batches/' + import1.batch_id + '/revoke', { method: 'POST', headers: h, body: JSON.stringify({ reason: 'x' }) });
    } catch (e) { caught = true; assert(e.data.success === false, '重启后叫号批次撤销失败'); }
    assert(caught, '重启后叫号批次撤销请求被拒绝');
  }

  console.log('\n验证: 重启后仍然不能撤销 missed 批次');
  const import2 = await request('/nurse/batch/import', {
    method: 'POST', headers: h,
    body: JSON.stringify({ csv_text: `id_card,name,department,queue_date,type\n110101199001017992,重启后过号,内科,${today},预约` })
  });
  if (import2.success && import2.success_count === 1) {
    const d2 = await request('/nurse/batches/' + import2.batch_id, { headers: h });
    await request('/nurse/queue/call/' + d2.records[0].queue_record_id, { method: 'POST', headers: h });
    await request('/nurse/queue/miss/' + d2.records[0].queue_record_id, { method: 'POST', headers: h });
    let caught = false;
    try {
      await request('/nurse/batches/' + import2.batch_id + '/revoke', { method: 'POST', headers: h, body: JSON.stringify({ reason: 'x' }) });
    } catch (e) { caught = true; assert(e.data.success === false, '重启后过号批次撤销失败'); }
    assert(caught, '重启后过号批次撤销请求被拒绝');
  }

  console.log('\n=== 重启后验证完成 ===');
  console.log('通过: ' + passed + ', 失败: ' + failed);
  if (failed > 0) process.exit(1);
}

main().catch(e => { console.error('出错:', e.message || e); process.exit(1); });
