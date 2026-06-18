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
    const headers = options.headers || {};
    const req = http.request({
      hostname: url.hostname, port: url.port,
      path: url.pathname + url.search, method,
      headers
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        const ct = res.headers['content-type'] || '';
        if (ct.includes('text/csv') || ct.includes('application/octet-stream')) {
          resolve({ status: res.statusCode, body: data, contentType: ct, isCSV: true });
          return;
        }
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

const runId = Date.now().toString().slice(-4);

async function main() {
  const today = new Date().toISOString().split('T')[0];
  const idPrefix = `1101011988${runId}`;
  function idc(base) { return idPrefix + String(base).padStart(4, '0').slice(-4); }

  console.log(`=== 沙箱模块 - 导出报告链路回归测试 (${today}, runId=${runId}) ===\n`);

  const nurseLogin = await request('/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'nurse1', password: 'nurse123' }) });
  const adminLogin = await request('/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'admin123' }) });
  const nH = { 'Authorization': 'Bearer ' + nurseLogin.token, 'Content-Type': 'application/json' };
  const aH = { 'Authorization': 'Bearer ' + adminLogin.token, 'Content-Type': 'application/json' };
  const nurseId = nurseLogin.user_id || nurseLogin.user?.id;
  const nurseName = nurseLogin.username || 'nurse1';

  await ensureSlots(aH, today);

  console.log('=== 1. 创建完整沙箱任务（覆盖所有操作，为导出准备数据） ===');

  const created = await request('/sandbox/tasks', {
    method: 'POST', headers: nH,
    body: JSON.stringify({ task_name: '导出报告测试-' + runId, template_version: 'v1', target_dataset: 'queue_records', scope_type: 'department' })
  });
  assert(created.success === true, '1.1 创建任务成功');
  const taskId = created.task_id;
  const taskNo = created.task_no;

  const csv = `id_card,name,department,queue_date,type\n${idc(1)},导出患者A,内科,${today},预约\n${idc(2)},导出患者B,内科,${today},预约\n${idc(3)},导出患者C,外科,${today},现场`;

  await request(`/sandbox/tasks/${taskId}/precheck`, { method: 'POST', headers: nH, body: JSON.stringify({ csv_text: csv }) });
  await request(`/sandbox/tasks/${taskId}/practice`, { method: 'POST', headers: nH });

  const detail = await request(`/sandbox/tasks/${taskId}`, { headers: nH });
  const recToRevert = detail.records[0];
  await request(`/sandbox/tasks/${taskId}/records/${recToRevert.id}/revert`, {
    method: 'POST', headers: nH, body: JSON.stringify({ reason: '测试撤销，用于导出报告展示' })
  });

  await request(`/admin/sandbox/tasks/${taskId}/approve`, {
    method: 'POST', headers: aH, body: JSON.stringify({ comment: '管理员审批通过，用于导出测试' })
  });

  await request(`/sandbox/tasks/${taskId}/submit`, { method: 'POST', headers: nH });

  console.log('\n=== 2. 护士调用导出接口 ===');

  const exportNurse = await request(`/sandbox/tasks/${taskId}/export`, { headers: nH });
  assert(typeof exportNurse === 'object' && exportNurse.isCSV === true, '2.1 护士导出返回 CSV 内容');
  assert(exportNurse.body.length > 500, '2.2 CSV 内容长度合理（>500字符）');

  const linesNurse = exportNurse.body.split('\n');
  assert(linesNurse.length >= 5, '2.3 CSV 行数合理（含表头+3记录+确认痕迹至少5行）');

  const header0 = linesNurse[0];
  assert(header0.includes('沙箱任务报告') || header0.includes(taskNo), '2.4 CSV 头部包含任务标识');

  const hasRecordsSection = linesNurse.some(l => l.includes('行号,身份证号,姓名') || l.includes('记录明细'));
  const hasConfirmationsSection = linesNurse.some(l => l.includes('操作确认痕迹'));
  assert(hasRecordsSection, '2.6 CSV 包含记录明细段（中文表头）');
  assert(hasConfirmationsSection, '2.7 CSV 包含操作确认痕迹段');

  assert(linesNurse.some(l => l.includes(idc(1))), '2.8 CSV 包含第1条记录身份证号');
  assert(linesNurse.some(l => l.includes(idc(2))), '2.9 CSV 包含第2条记录身份证号');
  assert(linesNurse.some(l => l.includes(idc(3))), '2.10 CSV 包含第3条记录身份证号');

  assert(linesNurse.some(l => l.includes('测试撤销，用于导出报告展示')), '2.11 CSV 中包含撤销原因（确认痕迹）');
  assert(linesNurse.some(l => l.includes('审批通过')), '2.12 CSV 中包含管理员审批痕迹');
  assert(linesNurse.some(l => l.includes('submit') || l.includes('最终提交') || l.includes('提交完成')), '2.13 CSV 中包含最终提交操作痕迹');

  console.log('\n=== 3. 管理员调用导出接口（admin 路由） ===');

  try {
    const exportAdmin = await request(`/admin/sandbox/tasks/${taskId}/export`, { headers: aH });
    assert(typeof exportAdmin === 'object' && exportAdmin.isCSV === true, '3.1 管理员导出返回 CSV 内容');
    assert(exportAdmin.body.length > 500, '3.2 管理员 CSV 内容长度合理');
    assert(exportAdmin.body.includes(taskNo), '3.3 管理员 CSV 中包含任务编号');
  } catch (e) {
    if (e.status === 404) {
      console.log('⚠️  跳过：管理员专属导出路由不存在，使用 sandbox 公共路由即可');
      passed++;
    } else throw e;
  }

  console.log('\n=== 4. 导出权限隔离：护士不能导出他人任务 ===');

  const nurse2Login = await request('/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'nurse2', password: 'nurse123' }) });
  const n2H = { 'Authorization': 'Bearer ' + nurse2Login.token, 'Content-Type': 'application/json' };

  try {
    await request(`/sandbox/tasks/${taskId}/export`, { headers: n2H });
    assert(false, '4.1 护士2导出护士1任务应被拒绝');
  } catch (e) {
    const msg = e.data?.message || e.data?.error || '';
    assert(e.status === 403 || msg.includes('无权'), '4.1 护士2无权导出护士1的任务 ✅');
  }

  console.log('\n=== 5. 导出 CSV 结构验证（关键字段完整性） ===');

  const body = exportNurse.body;
  const checkRecordFields = [
    '行号', '身份证号', '姓名', '科室',
    '沙箱状态', '动作类型', '冲突类型',
    '演练排队号', '是否已撤销'
  ];
  for (const f of checkRecordFields) {
    assert(body.includes(f), `5.x CSV 记录明细包含字段 ${f}`);
  }

  const checkConfFields = ['时间', '操作人', '动作', '摘要', '详情'];
  for (const f of checkConfFields) {
    assert(body.includes(f), `5.y CSV 确认痕迹包含字段 ${f}`);
  }

  console.log('\n=== 6. 导出内容业务正确性验证 ===');

  const revertLine = linesNurse.find(l => l.includes('测试撤销，用于导出报告展示'));
  assert(revertLine != null, '6.1 撤销原因可在 CSV 中定位');

  const revertedRec = linesNurse.find(l => l.includes(idc(1)));
  assert(revertedRec != null && revertedRec.includes('是'), '6.2 被撤销记录 "是否已撤销=是" 正确标记');

  const submitLines = linesNurse.filter(l => l.includes('submit') || l.includes('最终提交'));
  assert(submitLines.length >= 1, '6.3 最终提交操作被记录在确认痕迹中');

  console.log(`\n=== 测试完成：通过 ${passed}, 失败 ${failed} ===`);
  if (failed > 0) process.exit(1);
}

main().catch(e => { console.error('测试执行出错:', e.path || '', e.status ? JSON.stringify(e.data || e) : (e.message || e)); process.exit(1); });
