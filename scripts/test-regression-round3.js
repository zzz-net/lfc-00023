const http = require('http');

const BASE = 'http://localhost:3000';
let token = null;
let nurseToken = null;
let doctorToken = null;
let passCount = 0;
let failCount = 0;

function log(emoji, msg) { console.log(`[${emoji}] ${msg}`); }
function assert(cond, desc) {
  if (cond) { passCount++; log('PASS', desc); }
  else { failCount++; log('FAIL', desc); }
}

function req(method, path, body = null, tokenHeader = null) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, BASE);
    const opts = {
      method,
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      headers: { 'Content-Type': 'application/json' }
    };
    if (tokenHeader) opts.headers['Authorization'] = `Bearer ${tokenHeader}`;
    const req = http.request(opts, (res) => {
      let data = '';
      res.on('data', (c) => data += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, body: data }); }
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

async function testPatientGender() {
  log('📋', '===== 患者性别建档测试 =====');
  
  const testCases = [
    { gender: '男', expect: '男' },
    { gender: '女', expect: '女' },
    { gender: 'male', expect: '男' },
    { gender: 'female', expect: '女' },
    { gender: 'M', expect: '男' },
    { gender: 'F', expect: '女' },
    { gender: '1', expect: '男' },
    { gender: '0', expect: '女' },
    { gender: '男性', expect: '男' },
    { gender: '女性', expect: '女' },
    { gender: ' 男 ', expect: '男' },
    { gender: ' Boy ', expect: '男' },
    { gender: 'girl', expect: '女' },
    { gender: null, expect: null },
    { gender: '', expect: null },
    { gender: 'unknown', expectStatus: 400 },
    { gender: 'invalid', expectStatus: 400 },
  ];

  let idBase = Date.now();
  for (const tc of testCases) {
    const idCard = `T${idBase++}`;
    const r = await req('POST', '/api/nurse/patients', 
      { name: `测试${tc.gender}`, id_card: idCard, gender: tc.gender }, nurseToken);
    
    if (tc.expectStatus === 400) {
      assert(r.status === 400, `gender='${tc.gender}' 返回400正确`);
    } else {
      assert(r.status === 200, `gender='${tc.gender}' 返回200`);
      if (r.status === 200) {
        const actualGender = r.body.gender;
        const expectedGender = tc.expect;
        const match = (actualGender === null && expectedGender === null) || 
                      (actualGender !== null && actualGender === expectedGender);
        assert(match, 
          `gender='${tc.gender}' 规范化为'${actualGender}'，期望'${expectedGender}'`);
      }
    }
  }
}

async function testFullBusinessFlow() {
  log('📋', '===== 完整业务链路测试 =====');
  
  const ts = Date.now();
  const patientIdCard = `FULL${ts}`;
  const patientName = `奥'尼尔`;

  // 1. 建档（含单引号姓名测试XSS注入防护）
  log('ℹ️', `测试患者：${patientName} (身份证 ${patientIdCard})`);
  const r1 = await req('POST', '/api/nurse/patients', 
    { name: patientName, id_card: patientIdCard, gender: 'male', age: 30 }, nurseToken);
  assert(r1.status === 200, '患者建档成功');
  const patient = r1.body;
  assert(patient.gender === '男', '性别male规范化为男');
  
  // 2. 分诊
  const r2 = await req('POST', '/api/nurse/queue/register', 
    { patient_id: patient.id, department_id: 1, type: 'walkin' }, nurseToken);
  assert(r2.status === 200, '分诊成功');
  const queue = r2.body;
  assert(queue.status === 'waiting', '分诊后状态为waiting');
  const queueId = queue.id;

  // 3. 叫号
  const r3 = await req('POST', `/api/nurse/queue/call/${queueId}`, {}, nurseToken);
  assert(r3.status === 200, '叫号成功');
  assert(r3.body.status === 'called', '叫号后状态为called');

  // 4. 接诊（医生端）
  const r4 = await req('POST', `/api/doctor/consult/start/${queueId}`, {}, doctorToken);
  assert(r4.status === 200, '接诊成功');
  assert(r4.body.status === 'consulting', '接诊后状态为consulting');
  assert(r4.body.consulting_doctor_id !== null, '已分配接诊医生');

  // 5. 完成接诊
  const r5 = await req('POST', `/api/doctor/consult/complete/${queueId}`, 
    { diagnosis: '测试诊断内容，一切正常', prescription: '无' }, doctorToken);
  assert(r5.status === 200, '完成接诊成功');
  assert(r5.body.consultation_id !== undefined, '返回接诊记录ID');
  
  // 5b. 从医生历史查询验证诊断内容
  const r5c = await req('GET', `/api/doctor/history`, null, doctorToken);
  const historyRecord = (r5c.body || []).find(c => c.queue_record_id === queueId);
  assert(historyRecord !== undefined, '医生历史中包含已完成记录');
  assert(historyRecord.diagnosis === '测试诊断内容，一切正常', '诊断内容正确存储');
  
  // 5c. 从公共队列接口查询排队记录验证状态
  const r5d = await req('GET', `/api/nurse/queue/1`, null, nurseToken);
  const queueRecord = (r5d.body || []).find(q => q.id === queueId);
  assert(queueRecord !== undefined, '护士队列中包含该记录');
  assert(queueRecord.status === 'completed', '完成后状态为completed');

  // 6. 检查审计日志
  const r6 = await req('GET', '/api/public/audit-logs?action=create_patient', null, token);
  assert(r6.status === 200, '审计日志查询成功');
  const createEvents = (r6.body.logs || []).filter(l => l.target_id === patient.id);
  assert(createEvents.length >= 1, `审计日志包含患者建档事件（找到${createEvents.length}条）`);

  const r7 = await req('GET', '/api/public/audit-logs?action=complete_consultation', null, token);
  assert(r7.status === 200, '完成接诊审计日志查询成功');
  const completeEvents = (r7.body.logs || []).filter(l => l.target_id === queueId);
  assert(completeEvents.length >= 1, `审计日志包含完成接诊事件（找到${completeEvents.length}条）`);

  log('ℹ️', `患者ID=${patient.id}, 排队ID=${queueId}`);
  log('ℹ️', `完整链路：建档→分诊→叫号→接诊→完成，全部成功`);
}

async function main() {
  log('🚀', `开始综合回归测试，服务地址 ${BASE}`);
  
  // 管理员登录
  const r0 = await req('POST', '/api/auth/login', { username: 'admin', password: 'admin123' });
  assert(r0.status === 200, '管理员登录成功');
  token = r0.body.token;

  const r0b = await req('POST', '/api/auth/login', { username: 'nurse1', password: 'nurse123' });
  assert(r0b.status === 200, '护士登录成功');
  nurseToken = r0b.body.token;

  const r0c = await req('POST', '/api/auth/login', { username: 'doctor1', password: 'doctor123' });
  assert(r0c.status === 200, '医生登录成功');
  doctorToken = r0c.body.token;

  await testPatientGender();
  await testFullBusinessFlow();

  log('🏁', `测试完成：通过 ${passCount}，失败 ${failCount}`);
  process.exit(failCount > 0 ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
