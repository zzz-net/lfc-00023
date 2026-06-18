const bcrypt = require('bcryptjs');
const db = require('../src/db');

function seed() {
  console.log('开始插入样例数据...');

  const departments = [
    { name: '内科', code: 'NK', description: '内科门诊' },
    { name: '外科', code: 'WK', description: '外科门诊' },
    { name: '儿科', code: 'EK', description: '儿科门诊' },
    { name: '妇科', code: 'FK', description: '妇科门诊' }
  ];

  const insertDept = db.prepare('INSERT INTO departments (name, code, description) VALUES (?, ?, ?)');
  departments.forEach(dept => {
    try {
      insertDept.run(dept.name, dept.code, dept.description);
      console.log(`已创建科室: ${dept.name}`);
    } catch (e) {
      console.log(`科室已存在: ${dept.name}`);
    }
  });

  const deptIds = db.prepare('SELECT id, code FROM departments').all();
  const deptMap = {};
  deptIds.forEach(d => deptMap[d.code] = d.id);

  const users = [
    { username: 'admin', password: 'admin123', name: '系统管理员', role: 'admin', department_id: null },
    { username: 'nurse1', password: 'nurse123', name: '张护士', role: 'nurse', department_id: null },
    { username: 'nurse2', password: 'nurse123', name: '李护士', role: 'nurse', department_id: null },
    { username: 'doctor1', password: 'doctor123', name: '王医生', role: 'doctor', department_id: deptMap['NK'] },
    { username: 'doctor2', password: 'doctor123', name: '刘医生', role: 'doctor', department_id: deptMap['WK'] },
    { username: 'doctor3', password: 'doctor123', name: '陈医生', role: 'doctor', department_id: deptMap['EK'] },
    { username: 'doctor4', password: 'doctor123', name: '赵医生', role: 'doctor', department_id: deptMap['FK'] }
  ];

  const insertUser = db.prepare(`
    INSERT INTO users (username, password, name, role, department_id)
    VALUES (?, ?, ?, ?, ?)
  `);

  users.forEach(user => {
    const hashedPwd = bcrypt.hashSync(user.password, 10);
    try {
      insertUser.run(user.username, hashedPwd, user.name, user.role, user.department_id);
      console.log(`已创建用户: ${user.name} (${user.username})`);
    } catch (e) {
      console.log(`用户已存在: ${user.username}`);
    }
  });

  const today = new Date().toISOString().split('T')[0];
  const tomorrow = new Date(Date.now() + 86400000).toISOString().split('T')[0];

  const insertSlot = db.prepare(`
    INSERT OR IGNORE INTO daily_slots (department_id, date, total_slots, walkin_limit)
    VALUES (?, ?, ?, ?)
  `);

  Object.values(deptMap).forEach(deptId => {
    insertSlot.run(deptId, today, 20, 5);
    insertSlot.run(deptId, tomorrow, 20, 5);
  });
  console.log(`已配置号源: ${today} 和 ${tomorrow}`);

  const patients = [
    { name: '张三', id_card: '110101199001011234', phone: '13800138001', gender: '男', age: 34 },
    { name: '李四', id_card: '110101199002022345', phone: '13800138002', gender: '女', age: 33 },
    { name: '王五', id_card: '110101198503033456', phone: '13800138003', gender: '男', age: 39 },
    { name: '赵六', id_card: '110101198804044567', phone: '13800138004', gender: '女', age: 36 },
    { name: '孙七', id_card: '110101199505055678', phone: '13800138005', gender: '男', age: 29 },
    { name: '周八', id_card: '110101199206066789', phone: '13800138006', gender: '女', age: 32 },
    { name: '吴九', id_card: '110101198007077890', phone: '13800138007', gender: '男', age: 44 },
    { name: '郑十', id_card: '110101198308088901', phone: '13800138008', gender: '女', age: 41 }
  ];

  const insertPatient = db.prepare(`
    INSERT OR IGNORE INTO patients (name, id_card, phone, gender, age)
    VALUES (?, ?, ?, ?, ?)
  `);

  patients.forEach(p => {
    insertPatient.run(p.name, p.id_card, p.phone, p.gender, p.age);
  });
  console.log(`已插入 ${patients.length} 个患者样例数据`);

  const examTypes = [
    { name: '血常规检查', code: 'CBC', department_code: 'NK', description: '血液常规检验', duration: 5 },
    { name: '尿常规检查', code: 'URINE', department_code: 'NK', description: '尿液常规检验', duration: 5 },
    { name: '胸部X光', code: 'CHEST_XRAY', department_code: 'WK', description: '胸部正位片', duration: 15 },
    { name: '腹部B超', code: 'ABD_US', department_code: 'WK', description: '腹部超声检查', duration: 20 },
    { name: '心电图', code: 'ECG', department_code: 'NK', description: '常规心电图检查', duration: 10 },
    { name: '肝功能检查', code: 'LFT', department_code: 'NK', description: '肝功生化检验', duration: 5 }
  ];

  const insertExamType = db.prepare(`
    INSERT OR IGNORE INTO exam_types (name, code, department_id, description, default_duration)
    VALUES (?, ?, ?, ?, ?)
  `);
  examTypes.forEach(et => {
    insertExamType.run(et.name, et.code, deptMap[et.department_code], et.description, et.duration);
  });
  console.log(`已插入 ${examTypes.length} 个检查类型样例数据`);

  const examTypeIds = db.prepare('SELECT id, code FROM exam_types').all();
  const examTypeMap = {};
  examTypeIds.forEach(e => examTypeMap[e.code] = e.id);

  const timeSlots = ['08:00', '08:30', '09:00', '09:30', '10:00', '10:30', '11:00', '11:30',
                     '14:00', '14:30', '15:00', '15:30', '16:00', '16:30'];
  const endTimeMap = { '08:00': '08:30', '08:30': '09:00', '09:00': '09:30', '09:30': '10:00',
                       '10:00': '10:30', '10:30': '11:00', '11:00': '11:30', '11:30': '12:00',
                       '14:00': '14:30', '14:30': '15:00', '15:00': '15:30', '15:30': '16:00',
                       '16:00': '16:30', '16:30': '17:00' };

  const insertExamSlot = db.prepare(`
    INSERT OR IGNORE INTO exam_slots (exam_type_id, date, start_time, end_time, total_capacity, waitlist_limit, status)
    VALUES (?, ?, ?, ?, ?, ?, 'available')
  `);

  const dayAfterTomorrow = new Date(Date.now() + 86400000 * 2).toISOString().split('T')[0];
  [today, tomorrow, dayAfterTomorrow].forEach(d => {
    Object.values(examTypeMap).forEach(etId => {
      timeSlots.forEach(st => {
        insertExamSlot.run(etId, d, st, endTimeMap[st], 2, 3);
      });
    });
  });
  console.log('已插入检查排班样例数据');

  const insertConfig = db.prepare(`
    INSERT OR IGNORE INTO exam_configs (config_key, config_value, description, updated_by, updated_at)
    VALUES (?, ?, ?, NULL, CURRENT_TIMESTAMP)
  `);
  insertConfig.run('reschedule_revert_window_minutes', '30', '前台审核后可撤回的时间窗口（分钟）');
  insertConfig.run('waitlist_auto_promote', 'true', '取消/改约时是否自动转正候补');
  insertConfig.run('waitlist_max_per_slot', '5', '每个时段最多候补人数');
  console.log('已插入检查系统默认配置');

  console.log('样例数据插入完成！');
  console.log('\n=== 登录账号 ===');
  console.log('管理员: admin / admin123');
  console.log('护士:   nurse1 / nurse123 或 nurse2 / nurse123');
  console.log('医生:   doctor1 / doctor123 (内科)');
  console.log('        doctor2 / doctor123 (外科)');
  console.log('        doctor3 / doctor123 (儿科)');
  console.log('        doctor4 / doctor123 (妇科)');
}

seed();
