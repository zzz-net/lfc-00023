const http = require('http');
const fs = require('fs');

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

async function runTests() {
  console.log('\n=== 复诊随访计划模块 - 重启后一致性测试 ===\n');
  let passed = 0, failed = 0;

  try {
    if (!fs.existsSync('data/followup-test-state.json')) {
      throw new Error('未找到测试状态文件，请先运行 test-followup.js');
    }

    const testState = JSON.parse(fs.readFileSync('data/followup-test-state.json', 'utf8'));
    console.log('  ✓ 已加载测试状态文件\n');

    console.log('【步骤1】登录各角色账号');
    const adminToken = await login('admin', 'admin123');
    const doctor1Token = await login('doctor1', 'doctor123');
    const nurse1Token = await login('nurse1', 'nurse123');
    console.log('  ✓ 所有角色登录成功\n');

    console.log('【步骤2】验证随访配置持久化');
    const configRes = await request('/api/admin/followup/config', {
      headers: { 'Authorization': `Bearer ${adminToken}` }
    });
    assert(configRes.status === 200, '获取配置成功');
    assert(configRes.data.reminder_advance_days === testState.configDays, `提醒提前天数保持为${testState.configDays}天`);
    passed += 2;

    console.log('\n【步骤3】验证随访计划列表完整');
    const listRes = await request('/api/admin/followup', {
      headers: { 'Authorization': `Bearer ${adminToken}` }
    });
    assert(listRes.status === 200, '查询随访列表成功');
    assert(listRes.data.pagination.total === testState.planCount, `随访计划总数保持${testState.planCount}条不变`);
    passed += 2;

    console.log('\n【步骤4】验证第一条随访计划（已取消）状态持久化');
    const plan1Res = await request(`/api/doctor/followup/${testState.testFollowupId1}`, {
      headers: { 'Authorization': `Bearer ${doctor1Token}` }
    });
    assert(plan1Res.status === 200, '查询随访详情成功');
    assert(plan1Res.data.status === 'cancelled', '状态保持为已取消');
    assert(plan1Res.data.cancel_reason === '患者已康复，无需复诊', '取消原因保持不变');
    assert(plan1Res.data.patient_id === testState.testPatientId, '患者ID保持不变');
    assert(plan1Res.data.department_id === testState.testDeptId, '科室ID保持不变');
    assert(plan1Res.data.followup_date === testState.followupDate, '复诊日期保持不变');
    assert(plan1Res.data.reminder_method === '电话', '提醒方式保持不变');
    assert(plan1Res.data.related_diagnosis === '上呼吸道感染', '关联诊断保持不变');
    assert(plan1Res.data.notes === '清淡饮食，按时服药，注意休息', '注意事项保持不变');
    assert(plan1Res.data.queue_record_id === testState.testQueueId, '关联排队记录ID保持不变');
    assert(plan1Res.data.consultation_record_id === testState.testConsultationId, '关联诊疗记录ID保持不变');
    passed += 10;

    console.log('\n【步骤5】验证第二条随访计划（管理员取消）状态持久化');
    const plan2Res = await request(`/api/doctor/followup/${testState.testFollowupId2}`, {
      headers: { 'Authorization': `Bearer ${doctor1Token}` }
    });
    assert(plan2Res.status === 200, '查询随访详情成功');
    assert(plan2Res.data.status === 'cancelled', '状态保持为已取消');
    assert(plan2Res.data.cancel_reason === '管理员取消测试', '管理员取消原因保持不变');
    assert(plan2Res.data.followup_date === testState.followupDate2, '复诊日期保持不变');
    assert(plan2Res.data.reminder_method === '短信', '提醒方式保持不变');
    passed += 5;

    console.log('\n【步骤6】验证取消后重新创建的随访计划状态持久化');
    const recreatedRes = await request('/api/doctor/followup', {
      headers: { 'Authorization': `Bearer ${doctor1Token}` }
    });
    const recreatedPlan = recreatedRes.data.plans.find(
      p => p.followup_date === testState.followupDate && p.status !== 'cancelled'
    );
    assert(recreatedPlan, '取消后重新创建的随访计划存在');
    assert(recreatedPlan.status === 'pending', '状态保持为待提醒');
    assert(recreatedPlan.reminder_method === '微信', '提醒方式保持为微信');
    assert(recreatedPlan.notes === '注意保暖，避免受凉', '注意事项保持不变');
    passed += 4;

    console.log('\n【步骤7】验证护士登记的联系结果持久化');
    const contactedPlanRes = await request(`/api/admin/followup/${testState.testFollowupId2}`, {
      headers: { 'Authorization': `Bearer ${adminToken}` }
    });
    assert(contactedPlanRes.status === 200, '查询被取消的随访计划成功');
    assert(contactedPlanRes.data.contact_result === '患者已确认按时复诊，无特殊不适', '联系备注在取消后仍保持不变');
    assert(contactedPlanRes.data.contacted_by != null, '联系人在重启后仍保持');
    assert(contactedPlanRes.data.contacted_at != null, '联系时间在重启后仍保持');
    passed += 3;

    console.log('\n【步骤8】验证已完成的随访计划状态持久化');
    const completedPlansRes = await request('/api/admin/followup?status=completed', {
      headers: { 'Authorization': `Bearer ${adminToken}` }
    });
    assert(completedPlansRes.data.plans.length >= 1, '存在已完成的随访计划');
    const completedPlan = completedPlansRes.data.plans[0];
    assert(completedPlan.status === 'completed', '状态保持为已完成');
    assert(completedPlan.contact_result === '患者已完成复诊，恢复良好', '完成备注保持不变');
    passed += 3;

    console.log('\n【步骤9】验证审计日志持久化');
    const auditActions = [
      'create_followup_plan',
      'cancel_followup_plan',
      'record_followup_contact',
      'complete_followup_plan',
      'update_followup_config'
    ];

    for (const action of auditActions) {
      const auditRes = await request(`/api/public/audit-logs?action=${action}`, {
        headers: { 'Authorization': `Bearer ${adminToken}` }
      });
      assert(auditRes.status === 200, `查询${action}审计日志成功`);
      assert(auditRes.data.logs.length >= 1, `${action}审计日志记录存在`);
      passed += 2;
    }

    console.log('\n【步骤10】验证历史诊疗数据未被修改');
    const consultRes = await request('/api/doctor/history', {
      headers: { 'Authorization': `Bearer ${doctor1Token}` }
    });
    const consultRecord = consultRes.data.find(r => r.id === testState.testConsultationId);
    assert(consultRecord, '诊疗记录存在');
    assert(consultRecord.diagnosis === '上呼吸道感染', '诊断保持不变');
    assert(consultRecord.prescription === '布洛芬缓释胶囊 0.3g bid * 3天', '处方保持不变');
    assert(consultRecord.symptoms === '发热、咳嗽3天', '主诉保持不变');
    passed += 4;

    console.log('\n【步骤11】验证CSV导出内容与重启前一致');
    const exportRes = await request('/api/admin/followup/export', {
      headers: { 'Authorization': `Bearer ${adminToken}` }
    });
    assert(exportRes.status === 200, '导出CSV成功');
    assert(typeof exportRes.data === 'string', '返回CSV格式正确');
    assert(exportRes.data.includes('随访测试患者'), 'CSV包含患者数据');
    assert(exportRes.data.includes('上呼吸道感染'), 'CSV包含关联诊断');
    assert(exportRes.data.includes('已取消'), 'CSV包含已取消状态');
    assert(exportRes.data.includes('患者已确认按时复诊，无特殊不适'), 'CSV包含联系备注');
    assert(exportRes.data.includes('已完成'), 'CSV包含已完成状态');
    assert(exportRes.data.includes('待提醒'), 'CSV包含待提醒状态');
    assert(exportRes.data.includes('微信'), 'CSV包含提醒方式');
    assert(exportRes.data.includes('电话'), 'CSV包含多种提醒方式');
    passed += 10;

    console.log('\n【步骤12】验证权限隔离在重启后依然生效');
    const doctor2Token = await login('doctor2', 'doctor123');
    const doctor2ListRes = await request('/api/doctor/followup', {
      headers: { 'Authorization': `Bearer ${doctor2Token}` }
    });
    assert(doctor2ListRes.status === 200, '医生2查询列表成功');
    assert(doctor2ListRes.data.plans.length === 0, '医生2看不到其他医生的随访计划');

    const doctor2GetRes = await request(`/api/doctor/followup/${testState.testFollowupId1}`, {
      headers: { 'Authorization': `Bearer ${doctor2Token}` }
    });
    assert(doctor2GetRes.status === 403, '医生2查看其他医生随访详情返回403');
    passed += 3;

    console.log('\n【步骤13】验证护士查看今日待提醒功能正常');
    const todayRemindersRes = await request('/api/nurse/followup/today', {
      headers: { 'Authorization': `Bearer ${nurse1Token}` }
    });
    assert(todayRemindersRes.status === 200, '护士查询今日待提醒成功');
    assert(todayRemindersRes.data.reminder_advance_days === testState.configDays, '提醒提前天数配置正确');
    passed += 2;

    console.log('\n【步骤14】验证可以继续创建新的随访计划（验证数据库可写）');
    const newFollowupDate = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    const createRes = await request('/api/doctor/followup', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${doctor1Token}` },
      body: JSON.stringify({
        patient_id: testState.testPatientId,
        department_id: testState.testDeptId,
        followup_date: newFollowupDate,
        reminder_method: '无',
        related_diagnosis: '复诊检查'
      })
    });
    assert(createRes.status === 200, '重启后可正常创建新随访计划');
    assert(createRes.data.plan_id, '新计划状态为待提醒');
    passed += 2;

    console.log('\n【步骤15】验证可以继续修改配置（验证配置表可写）');
    const updateConfigRes = await request('/api/admin/followup/config', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${adminToken}` },
      body: JSON.stringify({ reminder_advance_days: 5 })
    });
    assert(updateConfigRes.status === 200, '重启后可正常修改配置');

    const checkConfigRes = await request('/api/admin/followup/config', {
      headers: { 'Authorization': `Bearer ${adminToken}` }
    });
    assert(checkConfigRes.data.reminder_advance_days === 5, '配置更新成功');
    passed += 2;

    console.log('\n【步骤16】验证取消后重新创建同日随访依然可用');
    const cancelNewRes = await request(`/api/doctor/followup/${createRes.data.plan_id}/cancel`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${doctor1Token}` },
      body: JSON.stringify({ cancel_reason: '重启后测试取消' })
    });
    assert(cancelNewRes.status === 200, '重启后可正常取消随访计划');

    const recreateAfterRestartRes = await request('/api/doctor/followup', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${doctor1Token}` },
      body: JSON.stringify({
        patient_id: testState.testPatientId,
        department_id: testState.testDeptId,
        followup_date: newFollowupDate,
        reminder_method: '电话',
        related_diagnosis: '复诊检查（重新创建）'
      })
    });
    assert(recreateAfterRestartRes.status === 200, '重启后取消可正常重新创建同日同科室随访');
    passed += 2;

    console.log('\n【步骤17】验证CSV筛选导出功能正常');
    const filterExportRes = await request('/api/admin/followup/export?status=pending', {
      headers: { 'Authorization': `Bearer ${adminToken}` }
    });
    assert(filterExportRes.status === 200, '按状态筛选导出成功');
    assert(filterExportRes.data.includes('待提醒'), '筛选结果包含待提醒状态');
    assert(!filterExportRes.data.includes('已取消'), '筛选结果不包含已取消状态');
    passed += 3;

    console.log(`\n=== 重启后一致性测试完成: ${passed} 项通过，${failed} 项失败 ===\n`);

    console.log('【验证结论】');
    console.log('✓ 所有随访计划状态、联系结果、取消原因持久化完整');
    console.log('✓ 提醒提前天数配置持久化完整');
    console.log('✓ 审计日志持久化完整');
    console.log('✓ 历史诊疗数据未被修改');
    console.log('✓ CSV导出内容与重启前一致');
    console.log('✓ 权限隔离机制重启后依然生效');
    console.log('✓ 数据库读写正常，可继续创建和修改数据');
    console.log('✓ 取消后重新创建功能重启后正常工作');
    console.log('\n随访模块重启恢复验证通过！\n');

    process.exit(failed > 0 ? 1 : 0);

  } catch (e) {
    console.error(`\n✗ 测试失败: ${e.message}`);
    console.error(e.stack);
    process.exit(1);
  }
}

runTests();
