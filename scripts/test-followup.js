const http = require('http');

const BASE_URL = 'http://localhost:3000';

function request(path, options = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, BASE_URL);
    const req = http.request({
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      method: options.method || 'GET',
      headers: {
        'Content-Type': 'application/json',
        ...options.headers
      }
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, data: JSON.parse(data) });
        } catch {
          resolve({ status: res.statusCode, data });
        }
      });
    });
    req.on('error', reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

async function login(username, password) {
  const res = await request('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ username, password })
  });
  if (res.status !== 200) throw new Error(`登录失败: ${username}`);
  return res.data.token;
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(`断言失败: ${message}`);
  }
  console.log(`  ✓ ${message}`);
}

let adminToken, doctor1Token, doctor2Token, nurse1Token;
let testPatientId, testDeptId = 1;
let testFollowupId1, testFollowupId2;
let testQueueId, testConsultationId;

async function runTests() {
  console.log('\n=== 复诊随访计划模块回归测试 ===\n');
  let passed = 0, failed = 0;

  try {
    console.log('【步骤1】登录各角色账号');
    adminToken = await login('admin', 'admin123');
    doctor1Token = await login('doctor1', 'doctor123');
    doctor2Token = await login('doctor2', 'doctor123');
    nurse1Token = await login('nurse1', 'nurse123');
    console.log('  ✓ 所有角色登录成功\n');

    console.log('【步骤2】管理员配置号源');
    const today = new Date().toISOString().split('T')[0];
    const existingSlotsRes = await request(`/api/admin/daily-slots?department_id=${testDeptId}&date=${today}`, {
      headers: { 'Authorization': `Bearer ${adminToken}` }
    });
    
    let slotRes;
    if (existingSlotsRes.data && existingSlotsRes.data.length > 0) {
      const slotId = existingSlotsRes.data[0].id;
      slotRes = await request(`/api/admin/daily-slots/${slotId}`, {
        method: 'PUT',
        headers: { 'Authorization': `Bearer ${adminToken}` },
        body: JSON.stringify({
          total_slots: 20,
          walkin_limit: 5
        })
      });
    } else {
      slotRes = await request('/api/admin/daily-slots', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${adminToken}` },
        body: JSON.stringify({
          department_id: testDeptId,
          date: today,
          total_slots: 20,
          walkin_limit: 5
        })
      });
    }
    assert(slotRes.status === 200, '配置内科今日号源成功');
    passed++;

    console.log('\n【步骤3】护士登记患者并挂号');
    const testIdCard = '110101199909098888';
    const patientRes = await request('/api/nurse/patients', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${nurse1Token}` },
      body: JSON.stringify({
        id_card: testIdCard,
        name: '随访测试患者',
        phone: '13900008888',
        gender: '男',
        age: 35
      })
    });
    assert(patientRes.status === 200, '患者登记成功');
    testPatientId = patientRes.data.id;

    const registerRes = await request('/api/nurse/queue/register', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${nurse1Token}` },
      body: JSON.stringify({
        patient_id: testPatientId,
        department_id: testDeptId,
        type: 'appointment'
      })
    });
    if (registerRes.status !== 200) {
      console.log('挂号失败详情:', JSON.stringify(registerRes.data, null, 2));
    }
    assert(registerRes.status === 200, '挂号成功');
    testQueueId = registerRes.data.id;
    passed += 2;

    console.log('\n【步骤4】护士叫号');
    const callRes = await request(`/api/nurse/queue/call/${testQueueId}`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${nurse1Token}` }
    });
    assert(callRes.status === 200, '叫号成功');
    passed++;

    console.log('\n【步骤5】医生开始接诊并完成接诊');
    const startRes = await request(`/api/doctor/consult/start/${testQueueId}`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${doctor1Token}` }
    });
    assert(startRes.status === 200, '开始接诊成功');

    const followupDate = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    const completeRes = await request(`/api/doctor/consult/complete/${testQueueId}`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${doctor1Token}` },
      body: JSON.stringify({
        symptoms: '发热、咳嗽3天',
        diagnosis: '上呼吸道感染',
        prescription: '布洛芬缓释胶囊 0.3g bid * 3天'
      })
    });
    assert(completeRes.status === 200, '完成接诊成功');
    testConsultationId = completeRes.data.consultation_id;
    passed += 2;

    console.log('\n【步骤6】验证历史诊疗数据未被修改');
    const consultCheckRes = await request('/api/doctor/history', {
      headers: { 'Authorization': `Bearer ${doctor1Token}` }
    });
    const consultRecord = consultCheckRes.data.find(r => r.id === testConsultationId);
    assert(consultRecord && consultRecord.diagnosis === '上呼吸道感染', '历史诊疗数据完整未修改');
    passed++;

    console.log('\n【步骤7】医生创建随访计划');
    const createRes1 = await request('/api/doctor/followup', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${doctor1Token}` },
      body: JSON.stringify({
        patient_id: testPatientId,
        department_id: testDeptId,
        queue_record_id: testQueueId,
        consultation_record_id: testConsultationId,
        followup_date: followupDate,
        reminder_method: '电话',
        notes: '清淡饮食，按时服药，注意休息',
        related_diagnosis: '上呼吸道感染'
      })
    });
    assert(createRes1.status === 200, '创建第一条随访计划成功');
    testFollowupId1 = createRes1.data.plan_id;
    
    const plan1DetailRes = await request(`/api/doctor/followup/${testFollowupId1}`, {
      headers: { 'Authorization': `Bearer ${doctor1Token}` }
    });
    assert(plan1DetailRes.data.status === 'pending', '随访计划状态为待提醒');
    passed += 2;

    console.log('\n【步骤8】测试重复计划冲突检测');
    const createRes2 = await request('/api/doctor/followup', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${doctor1Token}` },
      body: JSON.stringify({
        patient_id: testPatientId,
        department_id: testDeptId,
        followup_date: followupDate,
        reminder_method: '短信',
        related_diagnosis: '上呼吸道感染'
      })
    });
    assert(createRes2.status === 400, '重复创建随访计划返回400错误');
    const errorMsg = createRes2.data.message || createRes2.data.error;
    assert(errorMsg && errorMsg.includes('已有未取消的随访计划'), '错误信息包含重复计划提示');
    passed += 2;

    console.log('\n【步骤9】测试权限隔离 - 医生2不能查看医生1的随访');
    const doctor2ListRes = await request('/api/doctor/followup', {
      headers: { 'Authorization': `Bearer ${doctor2Token}` }
    });
    assert(doctor2ListRes.status === 200, '医生2查询随访列表成功');
    assert(doctor2ListRes.data.plans.length === 0, '医生2看不到医生1创建的随访计划');
    passed += 2;

    console.log('\n【步骤10】测试医生2尝试操作医生1的随访');
    const doctor2GetRes = await request(`/api/doctor/followup/${testFollowupId1}`, {
      headers: { 'Authorization': `Bearer ${doctor2Token}` }
    });
    assert(doctor2GetRes.status === 403, '医生2查看医生1随访详情返回403');

    const doctor2CancelRes = await request(`/api/doctor/followup/${testFollowupId1}/cancel`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${doctor2Token}` },
      body: JSON.stringify({ cancel_reason: '测试越权取消' })
    });
    assert(doctor2CancelRes.status === 403, '医生2取消医生1随访返回403');
    passed += 2;

    console.log('\n【步骤11】护士查看今日待提醒列表');
    const todayRemindersRes = await request('/api/nurse/followup/today', {
      headers: { 'Authorization': `Bearer ${nurse1Token}` }
    });
    assert(todayRemindersRes.status === 200, '护士查询今日待提醒成功');
    assert(todayRemindersRes.data.reminder_advance_days === 1, '默认提醒提前天数为1天');
    passed += 2;

    console.log('\n【步骤12】管理员修改提醒提前天数配置');
    const updateConfigRes = await request('/api/admin/followup/config', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${adminToken}` },
      body: JSON.stringify({ reminder_advance_days: 3 })
    });
    assert(updateConfigRes.status === 200, '管理员更新配置成功');

    const getConfigRes = await request('/api/admin/followup/config', {
      headers: { 'Authorization': `Bearer ${adminToken}` }
    });
    assert(getConfigRes.data.reminder_advance_days === 3, '配置已更新为3天');
    passed += 2;

    console.log('\n【步骤13】创建第二条随访（用于测试不同状态）');
    const followupDate2 = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    const createRes3 = await request('/api/doctor/followup', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${doctor1Token}` },
      body: JSON.stringify({
        patient_id: testPatientId,
        department_id: testDeptId,
        followup_date: followupDate2,
        reminder_method: '短信',
        related_diagnosis: '上呼吸道感染'
      })
    });
    assert(createRes3.status === 200, '创建第二条随访计划成功');
    testFollowupId2 = createRes3.data.plan_id;
    passed++;

    console.log('\n【步骤14】护士登记联系结果 - 已联系');
    const contactRes = await request(`/api/nurse/followup/${testFollowupId2}/contact`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${nurse1Token}` },
      body: JSON.stringify({
        status: 'contacted',
        contact_result: '患者已确认按时复诊，无特殊不适'
      })
    });
    assert(contactRes.status === 200, '登记联系结果成功');

    const checkContactRes = await request(`/api/nurse/followup/${testFollowupId2}`, {
      headers: { 'Authorization': `Bearer ${nurse1Token}` }
    });
    assert(checkContactRes.data.status === 'contacted', '随访状态已更新为已联系');
    assert(checkContactRes.data.contact_result === '患者已确认按时复诊，无特殊不适', '联系备注正确保存');
    passed += 3;

    console.log('\n【步骤15】医生取消第一条随访计划');
    const cancelRes = await request(`/api/doctor/followup/${testFollowupId1}/cancel`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${doctor1Token}` },
      body: JSON.stringify({ cancel_reason: '患者已康复，无需复诊' })
    });
    assert(cancelRes.status === 200, '取消随访计划成功');

    const checkCancelRes = await request(`/api/doctor/followup/${testFollowupId1}`, {
      headers: { 'Authorization': `Bearer ${doctor1Token}` }
    });
    assert(checkCancelRes.data.status === 'cancelled', '随访状态已更新为已取消');
    assert(checkCancelRes.data.cancel_reason === '患者已康复，无需复诊', '取消原因正确保存');
    passed += 3;

    console.log('\n【步骤16】测试取消后可重新创建同日同科室随访');
    const recreateRes = await request('/api/doctor/followup', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${doctor1Token}` },
      body: JSON.stringify({
        patient_id: testPatientId,
        department_id: testDeptId,
        followup_date: followupDate,
        reminder_method: '微信',
        notes: '注意保暖，避免受凉',
        related_diagnosis: '上呼吸道感染'
      })
    });
    assert(recreateRes.status === 200, '取消后重新创建随访计划成功');
    passed++;

    console.log('\n【步骤17】测试护士尝试修改配置（权限控制）');
    const nurseUpdateConfigRes = await request('/api/admin/followup/config', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${nurse1Token}` },
      body: JSON.stringify({ reminder_advance_days: 5 })
    });
    assert(nurseUpdateConfigRes.status === 403, '护士修改配置返回403无权限');
    passed++;

    console.log('\n【步骤18】测试医生尝试修改配置（权限控制）');
    const doctorUpdateConfigRes = await request('/api/admin/followup/config', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${doctor1Token}` },
      body: JSON.stringify({ reminder_advance_days: 5 })
    });
    assert(doctorUpdateConfigRes.status === 403, '医生修改配置返回403无权限');
    passed++;

    console.log('\n【步骤19】管理员导出随访CSV');
    const exportRes = await request('/api/admin/followup/export', {
      headers: { 'Authorization': `Bearer ${adminToken}` }
    });
    assert(exportRes.status === 200, '导出CSV成功');
    assert(typeof exportRes.data === 'string' && exportRes.data.includes('随访ID,患者姓名'), 'CSV格式正确');
    assert(exportRes.data.includes('随访测试患者'), 'CSV包含患者数据');
    assert(exportRes.data.includes('上呼吸道感染'), 'CSV包含关联诊断');
    assert(exportRes.data.includes('已取消'), 'CSV包含状态信息');
    passed += 4;

    console.log('\n【步骤20】验证审计日志完整性');
    const auditRes = await request('/api/public/audit-logs?action=create_followup_plan', {
      headers: { 'Authorization': `Bearer ${adminToken}` }
    });
    assert(auditRes.status === 200, '查询审计日志成功');
    assert(auditRes.data.logs.length >= 3, '审计日志记录了所有创建随访操作');

    const cancelAuditRes = await request('/api/public/audit-logs?action=cancel_followup_plan', {
      headers: { 'Authorization': `Bearer ${adminToken}` }
    });
    assert(cancelAuditRes.data.logs.length >= 1, '审计日志记录了取消随访操作');

    const contactAuditRes = await request('/api/public/audit-logs?action=record_followup_contact', {
      headers: { 'Authorization': `Bearer ${adminToken}` }
    });
    assert(contactAuditRes.data.logs.length >= 1, '审计日志记录了登记联系结果操作');

    const configAuditRes = await request('/api/public/audit-logs?action=update_followup_config', {
      headers: { 'Authorization': `Bearer ${adminToken}` }
    });
    assert(configAuditRes.data.logs.length >= 1, '审计日志记录了更新随访配置操作');
    passed += 4;

    console.log('\n【步骤21】测试接口参数校验');
    const invalidDateRes = await request('/api/doctor/followup', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${doctor1Token}` },
      body: JSON.stringify({
        patient_id: testPatientId,
        department_id: testDeptId,
        followup_date: 'invalid-date',
        reminder_method: '电话',
        related_diagnosis: '测试'
      })
    });
    assert(invalidDateRes.status === 400, '无效日期参数返回400');

    const invalidMethodRes = await request('/api/doctor/followup', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${doctor1Token}` },
      body: JSON.stringify({
        patient_id: testPatientId,
        department_id: testDeptId,
        followup_date: followupDate,
        reminder_method: '无效方式',
        related_diagnosis: '测试'
      })
    });
    assert(invalidMethodRes.status === 400, '无效提醒方式返回400');

    const missingFieldRes = await request('/api/doctor/followup', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${doctor1Token}` },
      body: JSON.stringify({
        patient_id: testPatientId,
        followup_date: followupDate,
        reminder_method: '电话'
      })
    });
    assert(missingFieldRes.status === 400, '缺少必填字段返回400');
    passed += 3;

    console.log('\n【步骤22】测试管理员取消随访');
    const adminCancelRes = await request(`/api/admin/followup/${testFollowupId2}/cancel`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${adminToken}` },
      body: JSON.stringify({ cancel_reason: '管理员取消测试' })
    });
    assert(adminCancelRes.status === 200, '管理员取消随访成功');
    passed++;

    console.log('\n【步骤23】测试CSV导出筛选功能');
    const filterExportRes = await request('/api/admin/followup/export?status=cancelled', {
      headers: { 'Authorization': `Bearer ${adminToken}` }
    });
    assert(filterExportRes.status === 200, '按状态筛选导出成功');
    assert(!filterExportRes.data.includes('已联系'), '筛选结果不包含已联系状态');
    assert(filterExportRes.data.includes('已取消'), '筛选结果包含已取消状态');
    passed += 2;

    console.log('\n【步骤24】测试未登录访问（401）');
    const noAuthRes = await request('/api/doctor/followup');
    assert(noAuthRes.status === 401, '未登录访问返回401未认证');
    passed++;

    console.log('\n【步骤25】测试随访计划列表分页');
    const pageRes = await request('/api/admin/followup?page=1&pageSize=2', {
      headers: { 'Authorization': `Bearer ${adminToken}` }
    });
    assert(pageRes.status === 200, '分页查询成功');
    assert(pageRes.data.pagination.page === 1, '页码正确');
    assert(pageRes.data.pagination.pageSize === 2, '每页条数正确');
    assert(pageRes.data.pagination.total >= 3, '总条数正确');
    passed += 3;

    console.log('\n【步骤26】验证随访计划关联的接诊记录未被修改');
    const consultAfterFollowupRes = await request(`/api/doctor/history`, {
      headers: { 'Authorization': `Bearer ${doctor1Token}` }
    });
    const recordAfter = consultAfterFollowupRes.data.find(r => r.id === testConsultationId);
    assert(recordAfter && recordAfter.diagnosis === '上呼吸道感染', '随访操作未修改历史诊疗记录');
    assert(recordAfter && recordAfter.prescription === '布洛芬缓释胶囊 0.3g bid * 3天', '处方信息完整');
    passed += 2;

    console.log('\n【步骤27】测试护士登记已完成复诊');
    const followupDate3 = new Date(Date.now() + 21 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    const createRes4 = await request('/api/doctor/followup', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${doctor1Token}` },
      body: JSON.stringify({
        patient_id: testPatientId,
        department_id: testDeptId,
        followup_date: followupDate3,
        reminder_method: '电话',
        related_diagnosis: '上呼吸道感染'
      })
    });
    const testFollowupId3 = createRes4.data.plan_id;

    const completeContactRes = await request(`/api/nurse/followup/${testFollowupId3}/contact`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${nurse1Token}` },
      body: JSON.stringify({
        status: 'completed',
        contact_result: '患者已完成复诊，恢复良好'
      })
    });
    assert(completeContactRes.status === 200, '登记已完成复诊成功');

    const completeAuditRes = await request('/api/public/audit-logs?action=complete_followup_plan', {
      headers: { 'Authorization': `Bearer ${adminToken}` }
    });
    assert(completeAuditRes.data.logs.length >= 1, '审计日志记录了完成随访操作');
    passed += 2;

    console.log('\n【步骤28】测试管理员随访列表多条件筛选');
    const multiFilterRes = await request(`/api/admin/followup?department_id=${testDeptId}&status=pending`, {
      headers: { 'Authorization': `Bearer ${adminToken}` }
    });
    assert(multiFilterRes.status === 200, '多条件筛选成功');
    const allPending = multiFilterRes.data.plans.every(p => p.status === 'pending' && p.department_id === testDeptId);
    assert(allPending, '筛选结果符合条件');
    passed += 2;

    console.log('\n【步骤29】保存测试数据供重启后验证');
    const fs = require('fs');
    const testState = {
      testPatientId,
      testDeptId,
      testQueueId,
      testConsultationId,
      testFollowupId1,
      testFollowupId2,
      followupDate,
      followupDate2,
      configDays: 3,
      planCount: (await request('/api/admin/followup', {
        headers: { 'Authorization': `Bearer ${adminToken}` }
      })).data.pagination.total
    };
    fs.writeFileSync('data/followup-test-state.json', JSON.stringify(testState, null, 2));
    console.log('  ✓ 测试状态已保存到 data/followup-test-state.json');
    passed++;

    console.log(`\n=== 测试完成: ${passed} 项通过，${failed} 项失败 ===\n`);

    console.log('【后续步骤】');
    console.log('1. 停止服务（记下 3000 端口的 node PID，Stop-Process -Id <PID>）');
    console.log('2. 重新启动: npm start');
    console.log('3. 运行重启后一致性测试: node scripts/test-followup-restart.js\n');

    process.exit(failed > 0 ? 1 : 0);

  } catch (e) {
    console.error(`\n✗ 测试失败: ${e.message}`);
    console.error(e.stack);
    process.exit(1);
  }
}

runTests();
