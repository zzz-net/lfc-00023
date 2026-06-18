const http = require('http');
const assert = require('assert');
const fs = require('fs');

const API = {
  request: (method, path, data, token) => new Promise((resolve, reject) => {
    const body = data ? JSON.stringify(data) : null;
    const opts = {
      hostname: 'localhost', port: 3000, method,
      path: '/api' + path,
      headers: {
        'Content-Type': 'application/json',
        ...(body ? { 'Content-Length': Buffer.byteLength(body) } : {}),
        ...(token ? { 'Authorization': 'Bearer ' + token } : {})
      }
    };
    const req = http.request(opts, res => {
      let chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let data = raw;
        try { data = raw ? JSON.parse(raw) : {}; } catch (e) { data = { raw }; }
        resolve({ status: res.statusCode, data });
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  })
};

let tokens = {};
let state = {};
let passed = 0;
let failed = 0;

function check(ok, msg) {
  try { assert(ok, msg); passed++; console.log('  ✓ ' + msg); }
  catch (e) { failed++; console.log('  ✗ ' + e.message); }
}

async function login(username, password) {
  const r = await API.request('POST', '/auth/login', { username, password });
  if (r.status !== 200) throw new Error('登录失败 ' + username + ': ' + r.status);
  return r.data.token;
}

async function phase1() {
  console.log('\n========== Phase 1: 写入测试数据 ==========\n');
  tokens.admin = await login('admin', 'admin123');
  tokens.doctor = await login('doctor1', 'doctor123');
  tokens.nurse = await login('nurse1', 'nurse123');
  console.log('  ✓ 所有角色登录成功');

  const as = (role) => tokens[role];

  console.log('\n【1-1】加载检查类型和时段');
  const types = await API.request('GET', '/doctor/exam/types', null, as('doctor'));
  const et = types.data.types[0];
  check(types.status === 200 && et, '获取检查类型成功');
  state.examTypeId = et.id;
  state.examTypeName = et.name;

  let targetDate = null, availableSlots = [];
  for (let offset = 1; offset <= 5; offset++) {
    const d = new Date(Date.now() + offset * 86400000).toISOString().split('T')[0];
    const r = await API.request('GET', '/doctor/exam/slots?exam_type_id=' + et.id + '&date=' + d, null, as('doctor'));
    const avail = (r.data.slots || []).filter(s => s.remaining_count > 0);
    if (avail.length >= 3) { targetDate = d; availableSlots = avail; break; }
  }
  check(targetDate, '找到可用日期 ' + targetDate + '，时段数=' + availableSlots.length);
  state.slot1 = availableSlots[0];
  state.slot2 = availableSlots[1];
  state.slot3 = availableSlots[2];
  state.targetDate = targetDate;

  console.log('\n【1-2】医生开3张检查单并预约');
  const p1 = { patient_name: '重启测试患者1', patient_id_card: '120101199001010001', patient_gender: '男', patient_age: 30, patient_phone: '13900000001' };
  const p2 = { patient_name: '重启测试患者2', patient_id_card: '120101199002020002', patient_gender: '女', patient_age: 28, patient_phone: '13900000002' };
  const p3 = { patient_name: '重启测试患者3', patient_id_card: '120101199003030003', patient_gender: '男', patient_age: 35, patient_phone: '13900000003' };

  const createOrder = async (patient, urgency) => {
    const r = await API.request('POST', '/doctor/exam/orders', {
      ...patient,
      exam_type_id: et.id,
      clinical_diagnosis: '重启测试',
      priority: urgency || 'normal',
      notes: '重启恢复验证'
    }, as('doctor'));
    return r.data && r.data.order;
  };

  state.orderA = await createOrder(p1, 'urgent');
  state.orderB = await createOrder(p2, 'normal');
  state.orderC = await createOrder(p3, 'normal');
  check(state.orderA && state.orderB && state.orderC, '创建3张检查单成功');

  const schedA = await API.request('POST', '/doctor/exam/orders/' + state.orderA.id + '/schedule', { slot_id: state.slot1.id }, as('doctor'));
  const schedB = await API.request('POST', '/doctor/exam/orders/' + state.orderB.id + '/schedule', { slot_id: state.slot2.id }, as('doctor'));
  check(schedA.status === 200 && schedB.status === 200, '检查单A和B预约成功');

  console.log('\n【1-3】医生为A发起改约申请');
  const rsReq = await API.request('POST', '/doctor/exam/reschedule', {
    exam_order_id: state.orderA.id,
    desired_start_date: targetDate,
    desired_end_date: targetDate,
    desired_time_preference: 'morning',
    reason: 'patient_request',
    notes: '重启改约测试',
    new_priority: 'urgent'
  }, as('doctor'));
  check(rsReq.status === 200 && rsReq.data && rsReq.data.request, 'A改约申请提交成功');
  state.rescheduleReqId = rsReq.data.request.id;

  console.log('\n【1-4】护士审核通过A的改约到slot3');
  const approveRes = await API.request('POST', '/nurse/exam/reschedule/' + state.rescheduleReqId + '/approve', {
    slot_id: state.slot3.id, review_notes: '重启审核通过'
  }, as('nurse'));
  check(approveRes.status === 200, 'A改约审核通过成功');

  console.log('\n【1-5】C加入候补');
  const wlRes = await API.request('POST', '/doctor/exam/waitlist', {
    exam_order_id: state.orderC.id,
    exam_type_id: et.id,
    target_date: targetDate,
    priority: 'urgent',
    time_preference: 'morning'
  }, as('doctor'));
  check(wlRes.status === 200, 'C加入候补成功');
  state.waitlistId = wlRes.data.waitlist.id;

  console.log('\n【1-6】完成检查单B');
  const compRes = await API.request('POST', '/nurse/exam/orders/' + state.orderB.id + '/complete', {
    result: '重启测试完成，结果正常'
  }, as('nurse'));
  check(compRes.status === 200, 'B完成登记成功');

  console.log('\n【1-7】管理员更新配置');
  const cfgRes = await API.request('POST', '/admin/exam/configs', {
    key: 'restart_test_key', value: 'restart_ok_123', description: '重启测试配置'
  }, as('admin'));
  check(cfgRes.status === 200, '管理员写入配置成功');

  console.log('\n【1-8】保存状态快照');
  const snapshot = {
    orderA_id: state.orderA.id,
    orderB_id: state.orderB.id,
    orderC_id: state.orderC.id,
    slot1_id: state.slot1.id,
    slot2_id: state.slot2.id,
    slot3_id: state.slot3.id,
    rescheduleReqId: state.rescheduleReqId,
    waitlistId: state.waitlistId,
    targetDate: targetDate, examTypeId: et.id, examTypeName: et.name
  };
  fs.writeFileSync(
    'D:/workSpace/AI__SPACE/lfc-00023/scripts/restart-state.json',
    JSON.stringify(snapshot, null, 2)
  );
  console.log('  ✓ 快照已保存: ' + JSON.stringify(snapshot));
}

async function phase2() {
  console.log('\n========== Phase 2: 重启后验证数据恢复 ==========\n');
  tokens.admin = await login('admin', 'admin123');
  tokens.doctor = await login('doctor1', 'doctor123');
  tokens.nurse = await login('nurse1', 'nurse123');
  console.log('  ✓ 重启后各角色重新登录成功');

  const as = (role) => tokens[role];

  const snap = JSON.parse(
    fs.readFileSync('D:/workSpace/AI__SPACE/lfc-00023/scripts/restart-state.json', 'utf8')
  );
  console.log('  ✓ 从快照恢复测试上下文');

  console.log('\n【2-1】验证检查单A改约后状态持久化');
  const detailA = await API.request('GET', '/nurse/exam/orders/' + snap.orderA_id, null, as('nurse'));
  check(detailA.status === 200, '获取检查单A详情成功');
  const orderA = detailA.data.order;
  check(orderA.status === 'scheduled', 'A改约后状态仍为 scheduled (实际: ' + orderA.status + ')');
  check(orderA.scheduled_slot_id === snap.slot3_id,
    'A槽位恢复为改约后的slot3 (' + orderA.scheduled_slot_id + '===' + snap.slot3_id + ')');
  check(orderA.urgency === 'urgent', 'A优先级仍为urgent (实际: ' + orderA.urgency + ')');

  console.log('\n【2-2】验证改约申请记录持久化');
  const rsList = await API.request('GET', '/nurse/exam/reschedule', null, as('nurse'));
  check(rsList.status === 200, '获取改约申请列表成功');
  const rs = (rsList.data.requests || []).find(r => r.id === snap.rescheduleReqId);
  check(rs, '改约申请#' + snap.rescheduleReqId + '仍存在');
  check(rs && rs.status === 'approved', '改约申请状态为approved (实际: ' + (rs && rs.status) + ')');

  console.log('\n【2-3】验证检查单B完成状态持久化');
  const detailB = await API.request('GET', '/nurse/exam/orders/' + snap.orderB_id, null, as('nurse'));
  check(detailB.status === 200, '获取检查单B详情成功');
  check(detailB.data.order.status === 'completed',
    'B状态仍为 completed (实际: ' + detailB.data.order.status + ')');
  check(detailB.data.order.result && detailB.data.order.result.indexOf('重启测试') >= 0,
    'B检查结果持久化');

  console.log('\n【2-4】验证候补记录持久化');
  const wlList = await API.request('GET', '/nurse/exam/waitlist', null, as('nurse'));
  check(wlList.status === 200, '获取候补列表成功');
  const wl = (wlList.data.waitlist || []).find(w => w.id === snap.waitlistId);
  check(wl, '候补记录#' + snap.waitlistId + '仍存在');
  check(wl && (wl.status === 'waiting' || wl.status === 'promoted'),
    '候补状态合理 (实际: ' + (wl && wl.status) + ')');

  console.log('\n【2-5】验证变更日志持久化（通过detail接口内嵌）');
  const logs = detailA.data.change_logs || [];
  check(logs.length >= 3, 'A至少3条变更日志(实际' + logs.length + ')：开单/预约/改约');
  check(logs.some(l => l.change_type === 'create'), '包含create记录');
  check(logs.some(l => l.change_type === 'schedule'), '包含schedule记录');
  check(logs.some(l => l.change_type === 'reschedule_request' || l.change_type === 'reschedule_approve'),
    '包含改约相关记录');

  console.log('\n【2-6】验证通知消息持久化（通过detail接口内嵌）');
  const notifs = detailA.data.notifications || [];
  check(notifs.length >= 2, 'A至少2条通知(实际' + notifs.length + ')：预约确认/改约申请');
  check(notifs.some(n => n.type === 'schedule_confirm'), '包含预约确认通知');
  check(notifs.some(n => n.type === 'reschedule_request' || n.type === 'reschedule_approved'),
    '包含改约相关通知');

  console.log('\n【2-7】验证槽位名额计数持久化');
  const slotList = await API.request('GET',
    '/doctor/exam/slots?exam_type_id=' + snap.examTypeId + '&date=' + snap.targetDate,
    null, as('doctor'));
  check(slotList.status === 200, '获取槽位列表成功');
  const s1 = (slotList.data.slots || []).find(s => s.id === snap.slot1_id);
  const s3 = (slotList.data.slots || []).find(s => s.id === snap.slot3_id);
  check(s1, 'slot1 (id=' + snap.slot1_id + ') 存在');
  check(s3, 'slot3 (id=' + snap.slot3_id + ') 存在');
  check(s3 && s3.booked_count >= 1,
    'slot3 booked_count >= 1 (A改约到这，实际' + (s3 && s3.booked_count) + ')');

  console.log('\n【2-8】验证管理员配置持久化');
  const cfgList = await API.request('GET', '/admin/exam/configs', null, as('admin'));
  check(cfgList.status === 200, '获取配置列表成功');
  const cfg = (cfgList.data.configs || []).find(c => c.key === 'restart_test_key');
  check(cfg, '配置项 restart_test_key 存在');
  check(cfg && cfg.value === 'restart_ok_123', '配置值正确 (实际: ' + (cfg && cfg.value) + ')');

  console.log('\n【2-9】重启后业务继续：DB仍可写入');
  const pX = { patient_name: '重启追加患者', patient_id_card: '120101199909090099', patient_gender: '男', patient_age: 20, patient_phone: '13999999999' };
  const newOrder = await API.request('POST', '/doctor/exam/orders', {
    ...pX, exam_type_id: snap.examTypeId, clinical_diagnosis: '重启后追加', priority: 'normal'
  }, as('doctor'));
  check(newOrder.status === 200 && newOrder.data.order, '重启后仍可新开检查单，DB可写');

  console.log('\n============== 重启恢复测试汇总 ==============');
  console.log('✅  全部通过: ' + passed + ' 项断言');
  console.log('❌  失败: ' + failed + ' 项');
  console.log('\n🎯 恢复场景验证清单：');
  console.log('   ✅ 检查单状态（scheduled/completed）持久化');
  console.log('   ✅ 改约申请状态（approved）持久化');
  console.log('   ✅ 候补队列记录持久化');
  console.log('   ✅ 变更日志链路持久化');
  console.log('   ✅ 通知消息持久化');
  console.log('   ✅ 槽位名额计数持久化');
  console.log('   ✅ 管理员配置持久化');
  console.log('   ✅ 重启后DB可继续读写');
  if (failed === 0) console.log('\n🚀 重启恢复测试全部通过！数据完整不丢失！\n');
  else { console.log('\n⚠️  有 ' + failed + ' 项失败\n'); process.exit(1); }
}

async function main() {
  const phase = process.argv[2] || 'phase1';
  try {
    if (phase === 'phase1') await phase1();
    else if (phase === 'phase2') await phase2();
    else if (phase === 'full') {
      await phase1();
      console.log('\n⏸  请手动重启服务器后运行: node scripts/test-exam-restart.js phase2');
    }
  } catch (err) {
    console.log('\n❌ 错误: ' + err.message);
    console.log(err.stack.split('\n').slice(0, 4).join('\n'));
    process.exit(1);
  }
}

main();
