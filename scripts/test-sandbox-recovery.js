const http = require('http');
const fs = require('fs');
const path = require('path');

const BASE_URL = 'http://localhost:3000';
const API_BASE = '/api';
const STATE_FILE = path.join(__dirname, '.sandbox-recovery-state.json');

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
      try {
        const existing = await request(`/admin/daily-slots?department_id=${deptId}&date=${today}`, { headers: adminHeaders });
        if (existing.length > 0) {
          await request(`/admin/daily-slots/${existing[0].id}`, {
            method: 'PUT', headers: adminHeaders,
            body: JSON.stringify({ total_slots: 200, walkin_limit: 100 })
          });
        }
      } catch (_) {}
    }
  }
}

let savedTaskId = null;
let savedTaskNo = null;
let savedTaskName = null;
let savedCounts = null;
let savedRecordCount = 0;
let savedConfirmationCount = 0;

async function main() {
  let today = new Date().toISOString().split('T')[0];
  let runId = Date.now().toString().slice(-4);
  let idPrefix = `1101011988${runId}`;

  if (process.argv.includes('--after-restart')) {
    try {
      const savedState = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
      if (savedState.idPrefix) idPrefix = savedState.idPrefix;
      if (savedState.today) today = savedState.today;
      runId = idPrefix.slice(-4);
      console.log(`=== 恢复模式：使用保存的 idPrefix=${idPrefix}, today=${today} ===\n`);
    } catch (e) {
      // 文件不存在时，继续使用新生成的
    }
  }

  function idc(base) { return idPrefix + String(base).padStart(4, '0').slice(-4); }

  console.log(`=== 沙箱模块 - 跨重启恢复回归测试 (${today}, runId=${runId}) ===\n`);

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
  console.log('登录 & 号源配置完成\n');

  const uniqueName = '沙箱恢复测试-' + runId;
  savedTaskName = uniqueName;
  const csv = `id_card,name,department,queue_date,type\n${idc(1)},沙箱恢复A,内科,${today},预约\n${idc(2)},沙箱恢复B,内科,${today},预约\n${idc(3)},沙箱恢复C,外科,${today},现场`;

  if (!process.argv.includes('--after-restart')) {
    console.log('=== 阶段1: 创建沙箱任务并执行完整流程 ===');

    const created = await request('/sandbox/tasks', {
      method: 'POST', headers: nurseH,
      body: JSON.stringify({ task_name: uniqueName, template_version: 'v1', target_dataset: 'queue_records', scope_type: 'department' })
    });
    assert(created.success === true, '1.1 创建沙箱任务成功');
    assert(!!created.task_id, '1.2 返回 task_id');
    assert(!!created.task_no, '1.3 返回 task_no');
    savedTaskId = created.task_id;
    savedTaskNo = created.task_no;

    const precheck = await request(`/sandbox/tasks/${savedTaskId}/precheck`, {
      method: 'POST', headers: nurseH, body: JSON.stringify({ csv_text: csv })
    });
    assert(precheck.success === true, '1.4 预检成功');
    assert(precheck.total_count === 3, '1.5 预检总计3条');
    assert(precheck.new_count === 3, '1.6 预检3条均为新增');
    savedCounts = { total: precheck.total_count, new: precheck.new_count, overwrite: precheck.overwrite_count, skip: precheck.skip_count, fail: precheck.fail_count };

    const practice = await request(`/sandbox/tasks/${savedTaskId}/practice`, {
      method: 'POST', headers: nurseH
    });
    assert(practice.success === true, '1.7 演练成功');
    assert(practice.success_count === 3, '1.8 演练3条成功');

    const detailBefore = await request(`/sandbox/tasks/${savedTaskId}`, { headers: nurseH });
    assert(detailBefore.task_no === savedTaskNo, '1.9 详情 task_no 正确');
    assert(detailBefore.task_name === uniqueName, '1.10 详情 task_name 正确');
    assert(detailBefore.status === 'practiced', '1.11 状态为 practiced');
    assert(detailBefore.records.length === 3, '1.12 详情有3条记录');
    assert(Array.isArray(detailBefore.confirmations), '1.13 有确认痕迹数组');
    assert(detailBefore.confirmations.length >= 3, '1.14 至少3条确认痕迹（创建/预检/演练）');
    assert(detailBefore.field_mappings.length > 0, '1.15 有字段映射');
    savedRecordCount = detailBefore.records.length;
    savedConfirmationCount = detailBefore.confirmations.length;

    console.log('\n=== 阶段2: 验证正式数据未被污染 ===');

    const queueAfterPractice = await request(`/nurse/queue/1?date=${today}`, { headers: nurseH });
    const matchPatients = queueAfterPractice.filter(q => q.patient_name && q.patient_name.startsWith('沙箱恢复'));
    assert(matchPatients.length === 0, '2.1 演练未写入正式 queue_records（沙箱数据隔离）');

    console.log('\n=== 阶段3: 记录状态以备重启后验证 ===');
    console.log(`   task_id=${savedTaskId}, task_no=${savedTaskNo}`);
    console.log(`   records=${savedRecordCount}, confirmations=${savedConfirmationCount}`);
    console.log(`   counts=${JSON.stringify(savedCounts)}`);

    fs.writeFileSync(STATE_FILE, JSON.stringify({
      taskId: savedTaskId,
      taskNo: savedTaskNo,
      taskName: savedTaskName,
      counts: savedCounts,
      recordCount: savedRecordCount,
      confirmationCount: savedConfirmationCount,
      idPrefix: idPrefix,
      today: today
    }, null, 2));
    console.log(`   ✅ 状态已保存到 ${STATE_FILE}`);

    console.log('\n=== 阶段4: 请重启服务后再次运行本脚本，测试将自动验证恢复情况 ===');
    console.log('   重启命令：记下 3000 端口 node PID -> Stop-Process -Id <PID> -> npm start');
    console.log('   重启后运行：node scripts/test-sandbox-recovery.js --after-restart\n');
  }

  if (process.argv.includes('--after-restart')) {
    let savedState = null;
    try {
      savedState = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
      savedTaskId = savedState.taskId;
      savedTaskNo = savedState.taskNo;
      savedTaskName = savedState.taskName;
      savedCounts = savedState.counts;
      savedRecordCount = savedState.recordCount;
      savedConfirmationCount = savedState.confirmationCount;
      console.log(`=== 从 ${STATE_FILE} 读取已保存状态，task_id=${savedTaskId} ===\n`);
      console.log('=== 检测到 --after-restart 参数，执行重启后验证 ===\n');
    } catch (e) {
      console.log(`❌ 无法读取状态文件：${e.message}`);
      console.log('请先运行第一阶段（不带 --after-restart 参数）');
      process.exit(1);
    }

    const list = await request('/sandbox/tasks', { headers: nurseH });
    assert(list.success === true, 'R1 列表接口可用');
    assert(Array.isArray(list.tasks), 'R2 返回任务数组');
    const found = list.tasks.find(t => t.id === savedTaskId);
    assert(!!found, 'R3 重启后任务列表中能找到原任务');
    assert(found.status === 'practiced', 'R4 重启后状态仍为 practiced');
    assert(found.task_name === savedTaskName, 'R5 任务名称恢复正确');
    assert(found.total_count === savedCounts.total, 'R6 total_count 恢复正确');
    assert(found.new_count === savedCounts.new, 'R7 new_count 恢复正确');

    const detail = await request(`/sandbox/tasks/${savedTaskId}`, { headers: nurseH });
    assert(detail.task_no === savedTaskNo, 'R8 task_no 恢复正确');
    assert(detail.status === 'practiced', 'R9 status 恢复正确');
    assert(detail.records.length === savedRecordCount, 'R10 records 数量恢复正确');
    assert(detail.confirmations.length >= savedConfirmationCount, 'R11 confirmations 数量恢复正确');
    assert(detail.field_mappings.length > 0, 'R12 字段映射恢复正确');

    const rec0 = detail.records.find(r => r.row_index === 1);
    assert(!!rec0, 'R13 能找到第1条记录');
    assert(rec0.id_card === idc(1), 'R14 第1条记录身份证号恢复正确');
    assert(rec0.sandbox_status === 'practice_success' || rec0.sandbox_status === 'practice_overwrite', 'R15 第1条记录演练状态恢复正确');
    assert(rec0.practice_queue_number != null, 'R16 演练排队号已持久化');

    console.log('\n=== 重启后验证通过：沙箱任务完整跨重启恢复 ✅ ===');

    try { fs.unlinkSync(STATE_FILE); console.log(`✅ 已清理临时状态文件 ${STATE_FILE}`); } catch (_) {}
  }

  console.log(`\n=== 测试完成（当前阶段）：通过 ${passed}, 失败 ${failed} ===`);
  if (failed > 0) process.exit(1);
}

main().catch(e => { console.error('测试执行出错:', e.path || '', e.status ? JSON.stringify(e.data || e) : (e.message || e)); process.exit(1); });
