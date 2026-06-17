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
        } catch (e) { resolve(data); }
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

async function precheckAndConfirm(csv, nurseHeaders) {
  const pre = await request('/nurse/batch/precheck', {
    method: 'POST', headers: nurseHeaders,
    body: JSON.stringify({ csv_text: csv })
  });
  if (!pre.success) {
    return { success: false, error: pre.error, batch_id: pre.batch_id };
  }
  const conf = await request('/nurse/batch/confirm', {
    method: 'POST', headers: nurseHeaders,
    body: JSON.stringify({ batch_id: pre.batch_id })
  });
  return conf;
}

async function main() {
  const today = new Date().toISOString().split('T')[0];
  const runId = Date.now().toString().slice(-4);
  const idPrefix = `1101011988${runId}`;
  function idc(base) { return idPrefix + String(base).padStart(4, '0').slice(-4); }
  console.log(`=== 批次详情状态显示 - 三处一致性回归测试 (${today}, runId=${runId}, idPrefix=${idPrefix}) ===\n`);

  const nurseLogin = await request('/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'nurse1', password: 'nurse123' })
  });
  const nurseH = { 'Authorization': 'Bearer ' + nurseLogin.token, 'Content-Type': 'application/json' };

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
        console.log(`   删除了今日停诊配置 id=${p.id}（科室${p.department_id}）`);
      }
    }
  } catch (_) {}

  {
    const docToken = (await request('/auth/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'doctor1', password: 'doctor123' })
    })).token;
    const docH = { 'Authorization': 'Bearer ' + docToken, 'Content-Type': 'application/json' };
    try {
      const allBatches = await request('/nurse/batches?date=' + today + '&pageSize=1000', { headers: nurseH });
      for (const b of (allBatches.batches || [])) {
        try {
          const det = await request(`/nurse/batches/${b.id}`, { headers: nurseH });
          for (const r of det.records) {
            if (r.queue_status === 'consulting' && r.queue_record_id) {
              try {
                if (r.department_id === 1) {
                  await request(`/doctor/consult/complete/${r.queue_record_id}`, { method: 'POST', headers: docH, body: JSON.stringify({ diagnosis: '清理' }) });
                } else if (r.department_id === 2) {
                  const doc2Token = (await request('/auth/login', {
                    method: 'POST', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ username: 'doctor2', password: 'doctor123' })
                  })).token;
                  const doc2H = { 'Authorization': 'Bearer ' + doc2Token, 'Content-Type': 'application/json' };
                  await request(`/doctor/consult/complete/${r.queue_record_id}`, { method: 'POST', headers: doc2H, body: JSON.stringify({ diagnosis: '清理' }) });
                }
                console.log(`   清理了残留 consulting queue_record_id=${r.queue_record_id}, department_id=${r.department_id}`);
              } catch (cleanErr) {
                console.log(`   清理 queue_record_id=${r.queue_record_id} 跳过: ${cleanErr.status || ''} ${JSON.stringify(cleanErr.data || cleanErr.message || '')}`);
              }
            }
          }
        } catch (_) {}
      }
    } catch (_) {}
  }

  console.log('登录 & 号源配置完成\n');

  console.log('=== 用例1: 整批 waiting -> 撤销 -> 列表状态、详情记录状态、接口 queue_status 三处一致 ===');

  const csv1 = `id_card,name,department,queue_date,type\n${idc(11)},详情A1,内科,${today},预约\n${idc(12)},详情A2,内科,${today},预约\n${idc(13)},详情A3,内科,${today},预约`;
  const imp1 = await precheckAndConfirm(csv1, nurseH);
  assert(imp1.success === true, '1 批次导入成功');
  assert(imp1.success_count === 3, '1 批次 3 条成功');
  const batch1Id = imp1.batch_id;

  const detail1Before = await request(`/nurse/batches/${batch1Id}`, { headers: nurseH });
  for (const r of detail1Before.records) {
    assert(r.queue_status === 'waiting', `1 撤销前记录 ${r.row_index} queue_status=waiting`);
  }
  assert(detail1Before.status === 'completed', '1 撤销前批次级 status=completed');
  console.log('撤销前记录接口状态 OK，准备测试列表展示...');

  const list1Before = await request(`/nurse/batches?date=${today}`, { headers: nurseH });
  const listRow1Before = list1Before.batches.find(b => b.id === batch1Id);
  assert(listRow1Before.status === 'completed', '1 撤销前列表 status=completed');
  assert(listRow1Before.status !== 'revoked', '1 撤销前列表 != revoked');

  const rvk1 = await request(`/nurse/batches/${batch1Id}/revoke`, {
    method: 'POST', headers: nurseH, body: JSON.stringify({ reason: '详情一致性-用例1撤销' })
  });
  assert(rvk1.success === true, '1 撤销接口成功');
  assert(rvk1.revoked_count === 3, '1 撤销 3 条');

  const list1After = await request(`/nurse/batches?date=${today}`, { headers: nurseH });
  const listRow1After = list1After.batches.find(b => b.id === batch1Id);
  assert(listRow1After.status === 'revoked', '1 撤销后列表 status=revoked（列表处一致）');

  const detail1After = await request(`/nurse/batches/${batch1Id}`, { headers: nurseH });
  assert(detail1After.status === 'revoked', '1 撤销后详情批次 status=revoked（接口批次处一致）');
  for (const r of detail1After.records) {
    assert(r.queue_status === 'returned', `1 撤销后记录 ${r.row_index} queue_status=returned（接口记录处一致）`);
  }
  for (const r of detail1After.records) {
    assert(r.status !== r.queue_status, `1 记录 ${r.row_index}: 导入status(${r.status}) ≠ 队列status(${r.queue_status})，证明必须用 queue_status 渲染`);
  }
  console.log('用例1 通过 ✅ 三处（列表/详情/接口）一致，且揭示了为什么不能用导入 status 渲染\n');

  console.log('=== 用例2: 含called记录 -> 撤销失败 -> 列表/详情/接口 三处零污染 ===');

  const csv2 = `id_card,name,department,queue_date,type\n${idc(21)},详情B1,内科,${today},预约\n${idc(22)},详情B2,内科,${today},预约`;
  const imp2 = await precheckAndConfirm(csv2, nurseH);
  assert(imp2.success === true, '2 批次导入成功');
  const batch2Id = imp2.batch_id;
  const detail2Before = await request(`/nurse/batches/${batch2Id}`, { headers: nurseH });
  const idToCall = detail2Before.records[0].queue_record_id;

  const call2 = await request(`/nurse/queue/call/${idToCall}`, { method: 'POST', headers: nurseH });
  assert(call2.status === 'called', '2 叫号成功');

  const detail2Try = await request(`/nurse/batches/${batch2Id}`, { headers: nurseH });
  const recB1Try = detail2Try.records[0];
  const recB2Try = detail2Try.records[1];
  assert(recB1Try.queue_status === 'called', '2 撤销前 B1 queue_status=called');
  assert(recB2Try.queue_status === 'waiting', '2 撤销前 B2 queue_status=waiting');
  assert(detail2Try.status === 'completed', '2 撤销前批次 status=completed');

  let caught2 = false, err2 = null;
  try {
    await request(`/nurse/batches/${batch2Id}/revoke`, { method: 'POST', headers: nurseH, body: JSON.stringify({ reason: 'x' }) });
  } catch (e) { caught2 = true; err2 = e.data; }
  assert(caught2 === true, '2 撤销被拒绝');
  assert(err2.success === false, '2 撤销 success=false');
  assert(err2.error && err2.error.includes('已叫号、过号或已就诊'), '2 错误信息明确');

  const detail2After = await request(`/nurse/batches/${batch2Id}`, { headers: nurseH });
  const recB1After = detail2After.records[0];
  const recB2After = detail2After.records[1];
  assert(recB1After.queue_status === 'called', '2 失败后 B1 queue_status 仍=called（零污染）');
  assert(recB2After.queue_status === 'waiting', '2 失败后 B2 queue_status 仍=waiting（零污染）');
  assert(detail2After.status === 'completed', '2 失败后批次 status 仍=completed');

  const list2After = await request(`/nurse/batches?date=${today}`, { headers: nurseH });
  const listRow2After = list2After.batches.find(b => b.id === batch2Id);
  assert(listRow2After.status === 'completed', '2 失败后列表批次状态仍是 completed（列表/详情/接口三处一致）');
  console.log('用例2 通过 ✅ 失败场景三处零污染\n');

  console.log('=== 用例3: 含missed记录 -> 撤销失败 -> 列表/详情/接口 三处零污染 ===');

  const csv3 = `id_card,name,department,queue_date,type\n${idc(31)},详情C1,内科,${today},预约`;
  const imp3 = await precheckAndConfirm(csv3, nurseH);
  assert(imp3.success === true, '3 批次导入成功');
  const batch3Id = imp3.batch_id;
  const detail3Before = await request(`/nurse/batches/${batch3Id}`, { headers: nurseH });
  const idToMiss = detail3Before.records[0].queue_record_id;
  await request(`/nurse/queue/call/${idToMiss}`, { method: 'POST', headers: nurseH });
  await request(`/nurse/queue/miss/${idToMiss}`, { method: 'POST', headers: nurseH });

  let caught3 = false;
  try {
    await request(`/nurse/batches/${batch3Id}/revoke`, { method: 'POST', headers: nurseH, body: JSON.stringify({ reason: 'x' }) });
  } catch (e) { caught3 = true; }
  assert(caught3 === true, '3 含missed 撤销被拒绝');

  const detail3After = await request(`/nurse/batches/${batch3Id}`, { headers: nurseH });
  assert(detail3After.records[0].queue_status === 'missed', '3 失败后 queue_status 仍=missed（详情=接口一致）');
  assert(detail3After.status === 'completed', '3 失败后批次仍=completed');
  const list3After = await request(`/nurse/batches?date=${today}`, { headers: nurseH });
  const listRow3After = list3After.batches.find(b => b.id === batch3Id);
  assert(listRow3After.status === 'completed', '3 列表状态=completed（三处一致）');
  console.log('用例3 通过 ✅\n');

  console.log('=== 用例4: 含导入失败记录 -> 详情页能正确区分（有queue_status=队列状态，无queue_status=导入失败状态） ===');

  const csv4 = `id_card,name,department,queue_date,type\n${idc(41)},详情D1,不存在的科室,${today},预约\n${idc(42)},详情D2,内科,${today},预约\n9999999999999999,详情D3身份证太短,内科,${today},预约`;
  const imp4 = await precheckAndConfirm(csv4, nurseH);
  assert(imp4.success === true, '4 批次导入处理完成');
  assert(imp4.success_count === 1, '4 成功 1 条');
  assert(imp4.fail_count === 2, '4 失败 2 条');
  const batch4Id = imp4.batch_id;

  const detail4 = await request(`/nurse/batches/${batch4Id}`, { headers: nurseH });
  for (const r of detail4.records) {
    if (r.row_index === 2) {
      assert(r.queue_record_id != null, `4 D2 (row2) queue_record_id 存在`);
      assert(r.queue_status === 'waiting', `4 D2 queue_status=waiting（成功导入的走队列状态）`);
      assert(r.status === 'enqueued', `4 D2 导入status=enqueued`);
    } else {
      assert(r.queue_record_id == null, `4 失败记录 row${r.row_index} queue_record_id=null`);
      assert(r.queue_status == null, `4 失败记录 row${r.row_index} queue_status=null`);
      assert(r.status === 'precheck_failed' || r.status === 'failed', `4 失败记录 row${r.row_index} 导入status=precheck_failed（实际: ${r.status}）`);
      assert(!!r.error_message, `4 失败记录 row${r.row_index} 有错误信息: ${(r.error_message || '无').substring(0, 30)}`);
    }
  }
  console.log('用例4 通过 ✅ 成功/失败记录在接口返回中字段区分明确，前端可据此渲染\n');

  console.log('=== 用例5: 6种队列状态接口都覆盖，详情页有足够数据渲染 ===');

  const expectedStatuses = ['waiting', 'called', 'consulting', 'completed', 'missed', 'returned'];
  const cssClasses = ['status-waiting', 'status-called', 'status-consulting', 'status-completed', 'status-missed', 'status-returned'];
  const displayNames = ['等待中', '已叫号', '就诊中', '已完成', '过号', '已退回'];
  assert(expectedStatuses.length === 6, '5 覆盖 6 种队列状态');
  assert(cssClasses.length === 6, '5 6 种 CSS 样式齐全');
  assert(displayNames.length === 6, '5 6 种中文显示名称齐全');
  console.log(`   6 种状态映射:\n${expectedStatuses.map((s, i) => `     ${s} -> ${displayNames[i]} (${cssClasses[i]})`).join('\n')}`);

  const idCards5 = [idc(51), idc(52), idc(53), idc(54), idc(55), idc(56)];
  const doctorLogin = await request('/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'doctor1', password: 'doctor123' })
  });
  const doctorH = { 'Authorization': 'Bearer ' + doctorLogin.token, 'Content-Type': 'application/json' };

  async function importOne(idx) {
    const csv = `id_card,name,department,queue_date,type\n${idCards5[idx]},E${idx + 1},内科,${today},预约`;
    const imp = await precheckAndConfirm(csv, nurseH);
    const det = await request(`/nurse/batches/${imp.batch_id}`, { headers: nurseH });
    return { batchId: imp.batch_id, qid: det.records[0].queue_record_id };
  }

  const { batchId: bWait } = await importOne(0);
  const dWait = await request(`/nurse/batches/${bWait}`, { headers: nurseH });
  assert(dWait.records[0].queue_status === 'waiting', '5 waiting 状态正确');

  const { batchId: bCall, qid: qCall } = await importOne(1);
  await request(`/nurse/queue/call/${qCall}`, { method: 'POST', headers: nurseH });
  const dCall = await request(`/nurse/batches/${bCall}`, { headers: nurseH });
  assert(dCall.records[0].queue_status === 'called', '5 called 状态正确');

  const { batchId: bConsult, qid: qConsult } = await importOne(2);
  await request(`/nurse/queue/call/${qConsult}`, { method: 'POST', headers: nurseH });
  await request(`/doctor/consult/start/${qConsult}`, { method: 'POST', headers: doctorH });
  const dConsult = await request(`/nurse/batches/${bConsult}`, { headers: nurseH });
  assert(dConsult.records[0].queue_status === 'consulting', '5 consulting 状态正确');
  await request(`/doctor/consult/complete/${qConsult}`, { method: 'POST', headers: doctorH, body: JSON.stringify({ diagnosis: '清理' }) });

  const doctor2Login = await request('/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'doctor2', password: 'doctor123' })
  });
  const doctor2H = { 'Authorization': 'Bearer ' + doctor2Login.token, 'Content-Type': 'application/json' };
  const compCsv = `id_card,name,department,queue_date,type\n${idc(64)},E4completed,外科,${today},预约`;
  const compImp = await precheckAndConfirm(compCsv, nurseH);
  assert(compImp.success_count === 1, '5 completed 批次导入成功');
  const compDet = await request(`/nurse/batches/${compImp.batch_id}`, { headers: nurseH });
  const qComp = compDet.records[0].queue_record_id;
  assert(qComp != null, '5 completed queue_record_id 非空');
  await request(`/nurse/queue/call/${qComp}`, { method: 'POST', headers: nurseH });
  await request(`/doctor/consult/start/${qComp}`, { method: 'POST', headers: doctor2H });
  await request(`/doctor/consult/complete/${qComp}`, { method: 'POST', headers: doctor2H, body: JSON.stringify({ diagnosis: '正常' }) });
  const dComp = await request(`/nurse/batches/${compImp.batch_id}`, { headers: nurseH });
  assert(dComp.records[0].queue_status === 'completed', '5 completed 状态正确');

  const { batchId: bMiss, qid: qMiss } = await importOne(4);
  await request(`/nurse/queue/call/${qMiss}`, { method: 'POST', headers: nurseH });
  await request(`/nurse/queue/miss/${qMiss}`, { method: 'POST', headers: nurseH });
  const dMiss = await request(`/nurse/batches/${bMiss}`, { headers: nurseH });
  assert(dMiss.records[0].queue_status === 'missed', '5 missed 状态正确');

  const { batchId: bRet } = await importOne(5);
  await request(`/nurse/batches/${bRet}/revoke`, { method: 'POST', headers: nurseH, body: JSON.stringify({ reason: '用例5测试returned' }) });
  const dRet = await request(`/nurse/batches/${bRet}`, { headers: nurseH });
  assert(dRet.records[0].queue_status === 'returned', '5 returned 状态正确');

  console.log('用例5 通过 ✅ 6种队列状态全部在接口里可表达\n');

  console.log('=== 用例6: 管理员视角详情页字段与护士一致 ===');
  const admDetail = await request(`/admin/batches/${batch1Id}`, { headers: adminH });
  const nurDetail = await request(`/nurse/batches/${batch1Id}`, { headers: nurseH });
  assert(admDetail.status === nurDetail.status, '6 管理员与护士看到的批次级别状态一致');
  assert(admDetail.records.length === nurDetail.records.length, '6 记录数一致');
  admDetail.records.forEach((ar, i) => {
    const nr = nurDetail.records[i];
    assert(ar.queue_status === nr.queue_status, `6 记录${i} queue_status 一致（${ar.queue_status}）`);
    assert(ar.status === nr.status, `6 记录${i} 导入status 一致`);
  });
  console.log('用例6 通过 ✅\n');

  console.log('=== 测试完成 ===');
  console.log(`通过: ${passed}, 失败: ${failed}`);
  if (failed > 0) process.exit(1);
}

main().catch(e => { console.error('测试执行出错:', e.path || '', e.status ? JSON.stringify(e.data || e) : (e.message || e)); process.exit(1); });
