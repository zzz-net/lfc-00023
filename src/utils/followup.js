const db = require('../db');
const { logAudit } = require('./audit');

function getReminderAdvanceDays() {
  const config = db.prepare('SELECT config_value FROM followup_configs WHERE config_key = ?').get('reminder_advance_days');
  return config ? parseInt(config.config_value) : 1;
}

function setReminderAdvanceDays(days, userId) {
  const stmt = db.prepare(`
    INSERT INTO followup_configs (config_key, config_value, description, updated_by, updated_at)
    VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(config_key) DO UPDATE SET
      config_value = excluded.config_value,
      updated_by = excluded.updated_by,
      updated_at = CURRENT_TIMESTAMP
  `);
  stmt.run('reminder_advance_days', days.toString(), '随访提醒提前天数', userId);
}

function checkDuplicatePlan(patientId, departmentId, followupDate, excludeId = null) {
  let sql = `
    SELECT * FROM followup_plans 
    WHERE patient_id = ? AND department_id = ? AND followup_date = ? AND status != 'cancelled'
  `;
  const params = [patientId, departmentId, followupDate];
  
  if (excludeId) {
    sql += ' AND id != ?';
    params.push(excludeId);
  }
  
  return db.prepare(sql).get(...params);
}

function createFollowupPlan(data, userId, ip) {
  const {
    patient_id,
    doctor_id,
    department_id,
    queue_record_id,
    consultation_record_id,
    followup_date,
    reminder_method,
    notes,
    related_diagnosis
  } = data;

  if (!patient_id || !department_id || !followup_date || !reminder_method) {
    return { success: false, error: '患者ID、科室ID、复诊日期和提醒方式不能为空' };
  }

  if (!['电话', '短信', '微信', '无'].includes(reminder_method)) {
    return { success: false, error: '提醒方式必须是电话、短信、微信或无' };
  }

  const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
  if (!dateRegex.test(followup_date)) {
    return { success: false, error: '复诊日期格式必须是YYYY-MM-DD' };
  }

  const today = new Date().toISOString().split('T')[0];
  if (followup_date < today) {
    return { success: false, error: '复诊日期不能早于今日' };
  }

  const patient = db.prepare('SELECT * FROM patients WHERE id = ?').get(patient_id);
  if (!patient) {
    return { success: false, error: '患者不存在' };
  }

  const dept = db.prepare('SELECT * FROM departments WHERE id = ?').get(department_id);
  if (!dept) {
    return { success: false, error: '科室不存在' };
  }

  const duplicate = checkDuplicatePlan(patient_id, department_id, followup_date);
  if (duplicate) {
    return { 
      success: false, 
      error: '该患者此科室此日期已有未取消的随访计划',
      duplicate_plan: duplicate
    };
  }

  const tx = db.transaction(() => {
    const stmt = db.prepare(`
      INSERT INTO followup_plans (
        patient_id, doctor_id, department_id, queue_record_id, consultation_record_id,
        followup_date, reminder_method, notes, related_diagnosis, created_by
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    
    const result = stmt.run(
      patient_id,
      doctor_id || userId,
      department_id,
      queue_record_id || null,
      consultation_record_id || null,
      followup_date,
      reminder_method,
      notes || null,
      related_diagnosis || null,
      userId
    );

    logAudit(userId, 'create_followup_plan', 'followup_plan', result.lastInsertRowid, {
      patient_id,
      patient_name: patient.name,
      department_id,
      department_name: dept.name,
      followup_date,
      reminder_method,
      related_diagnosis
    }, ip);

    return { success: true, plan_id: result.lastInsertRowid };
  });

  try {
    return tx();
  } catch (err) {
    return { success: false, error: err.message };
  }
}

function getFollowupPlan(id, userId, role) {
  const checkSql = `SELECT id, doctor_id FROM followup_plans WHERE id = ?`;
  const existing = db.prepare(checkSql).get(id);
  
  if (!existing) {
    return { success: false, error: '随访计划不存在', code: 404 };
  }
  
  if (role === 'doctor' && existing.doctor_id !== userId) {
    return { success: false, error: '无权限查看该随访计划', code: 403 };
  }

  let sql = `
    SELECT fp.*, p.name as patient_name, p.id_card, p.phone, p.gender, p.age,
           d.name as department_name,
           u.name as doctor_name,
           u2.name as created_by_name,
           u3.name as contacted_by_name,
           u4.name as cancelled_by_name,
           qr.queue_number,
           cr.diagnosis as consultation_diagnosis
    FROM followup_plans fp
    JOIN patients p ON fp.patient_id = p.id
    JOIN departments d ON fp.department_id = d.id
    JOIN users u ON fp.doctor_id = u.id
    JOIN users u2 ON fp.created_by = u2.id
    LEFT JOIN users u3 ON fp.contacted_by = u3.id
    LEFT JOIN users u4 ON fp.cancelled_by = u4.id
    LEFT JOIN queue_records qr ON fp.queue_record_id = qr.id
    LEFT JOIN consultation_records cr ON fp.consultation_record_id = cr.id
    WHERE fp.id = ?
  `;

  const plan = db.prepare(sql).get(id);

  return { success: true, plan };
}

function listFollowupPlans(filters = {}, userId, role) {
  let sql = `
    SELECT fp.*, p.name as patient_name, p.id_card, p.phone,
           d.name as department_name, u.name as doctor_name
    FROM followup_plans fp
    JOIN patients p ON fp.patient_id = p.id
    JOIN departments d ON fp.department_id = d.id
    JOIN users u ON fp.doctor_id = u.id
    WHERE 1=1
  `;
  const params = [];

  if (role === 'doctor') {
    sql += ' AND fp.doctor_id = ?';
    params.push(userId);
  }

  if (filters.patient_id) {
    sql += ' AND fp.patient_id = ?';
    params.push(filters.patient_id);
  }

  if (filters.department_id) {
    sql += ' AND fp.department_id = ?';
    params.push(filters.department_id);
  }

  if (filters.status) {
    sql += ' AND fp.status = ?';
    params.push(filters.status);
  }

  if (filters.start_date) {
    sql += ' AND fp.followup_date >= ?';
    params.push(filters.start_date);
  }

  if (filters.end_date) {
    sql += ' AND fp.followup_date <= ?';
    params.push(filters.end_date);
  }

  if (filters.reminder_date) {
    const advanceDays = getReminderAdvanceDays();
    const d = new Date(filters.reminder_date);
    d.setDate(d.getDate() + advanceDays);
    const targetDate = d.toISOString().split('T')[0];
    sql += ' AND fp.followup_date = ? AND fp.status = ?';
    params.push(targetDate, 'pending');
  }

  sql += ' ORDER BY fp.followup_date ASC, fp.created_at DESC';

  const page = parseInt(filters.page) || 1;
  const pageSize = parseInt(filters.pageSize) || 50;
  const offset = (page - 1) * pageSize;

  sql += ' LIMIT ? OFFSET ?';
  params.push(pageSize, offset);

  const plans = db.prepare(sql).all(...params);

  let countSql = `
    SELECT COUNT(*) as total FROM followup_plans fp
    WHERE 1=1
  `;
  const countParams = [];

  if (role === 'doctor') {
    countSql += ' AND fp.doctor_id = ?';
    countParams.push(userId);
  }

  if (filters.patient_id) { countSql += ' AND fp.patient_id = ?'; countParams.push(filters.patient_id); }
  if (filters.department_id) { countSql += ' AND fp.department_id = ?'; countParams.push(filters.department_id); }
  if (filters.status) { countSql += ' AND fp.status = ?'; countParams.push(filters.status); }
  if (filters.start_date) { countSql += ' AND fp.followup_date >= ?'; countParams.push(filters.start_date); }
  if (filters.end_date) { countSql += ' AND fp.followup_date <= ?'; countParams.push(filters.end_date); }

  const { total } = db.prepare(countSql).get(...countParams);

  return { success: true, plans, pagination: { page, pageSize, total } };
}

function getTodayReminders(userId, role, filters = {}) {
  const advanceDays = getReminderAdvanceDays();
  const today = new Date();
  const targetDate = new Date(today);
  targetDate.setDate(today.getDate() + advanceDays);
  const followupDateStr = targetDate.toISOString().split('T')[0];

  let sql = `
    SELECT fp.*, p.name as patient_name, p.id_card, p.phone, p.gender, p.age,
           d.name as department_name, u.name as doctor_name
    FROM followup_plans fp
    JOIN patients p ON fp.patient_id = p.id
    JOIN departments d ON fp.department_id = d.id
    JOIN users u ON fp.doctor_id = u.id
    WHERE fp.followup_date = ? AND fp.status = 'pending'
  `;
  const params = [followupDateStr];

  if (role === 'nurse' && filters.department_id) {
    sql += ' AND fp.department_id = ?';
    params.push(filters.department_id);
  }

  sql += ' ORDER BY d.name, fp.created_at';

  const plans = db.prepare(sql).all(...params);

  return { success: true, plans, reminder_advance_days: advanceDays };
}

function updateFollowupStatus(planId, status, data, userId, userRole, ip) {
  const validStatuses = ['contacted', 'no_answer', 'cancelled', 'completed'];
  if (!validStatuses.includes(status)) {
    return { success: false, error: '无效的状态' };
  }

  const checkSql = `SELECT id, doctor_id, status FROM followup_plans WHERE id = ?`;
  const existing = db.prepare(checkSql).get(planId);
  
  if (!existing) {
    return { success: false, error: '随访计划不存在', code: 404 };
  }
  
  if (userRole === 'doctor' && existing.doctor_id !== userId) {
    return { success: false, error: '无权限修改该随访计划', code: 403 };
  }

  const planResult = getFollowupPlan(planId, userId, 'admin');
  if (!planResult.success) {
    return planResult;
  }

  const plan = planResult.plan;

  if (plan.status === 'cancelled') {
    return { success: false, error: '已取消的随访计划不能修改状态' };
  }

  if (plan.status === status && status !== 'cancelled') {
    return { success: true, plan };
  }

  const tx = db.transaction(() => {
    const now = new Date().toISOString();
    let stmt;

    if (status === 'cancelled') {
      if (!data || !data.cancel_reason) {
        throw new Error('取消原因不能为空');
      }
      stmt = db.prepare(`
        UPDATE followup_plans 
        SET status = 'cancelled', cancel_reason = ?, cancelled_by = ?, cancelled_at = ?, updated_at = ?
        WHERE id = ?
      `);
      stmt.run(data.cancel_reason, userId, now, now, planId);
      
      logAudit(userId, 'cancel_followup_plan', 'followup_plan', planId, {
        patient_id: plan.patient_id,
        patient_name: plan.patient_name,
        followup_date: plan.followup_date,
        cancel_reason: data.cancel_reason
      }, ip);
    } else if (status === 'contacted' || status === 'no_answer') {
      stmt = db.prepare(`
        UPDATE followup_plans 
        SET status = ?, contact_result = ?, contacted_by = ?, contacted_at = ?, updated_at = ?
        WHERE id = ?
      `);
      stmt.run(status, data?.contact_result || null, userId, now, now, planId);
      
      logAudit(userId, 'record_followup_contact', 'followup_plan', planId, {
        patient_id: plan.patient_id,
        patient_name: plan.patient_name,
        followup_date: plan.followup_date,
        status,
        contact_result: data?.contact_result
      }, ip);
    } else if (status === 'completed') {
      stmt = db.prepare(`
        UPDATE followup_plans 
        SET status = 'completed', contact_result = ?, contacted_by = ?, contacted_at = ?, updated_at = ?
        WHERE id = ?
      `);
      stmt.run(data?.contact_result || null, userId, now, now, planId);
      
      logAudit(userId, 'complete_followup_plan', 'followup_plan', planId, {
        patient_id: plan.patient_id,
        patient_name: plan.patient_name,
        followup_date: plan.followup_date
      }, ip);
    }

    return getFollowupPlan(planId, userId, 'admin');
  });

  try {
    return tx();
  } catch (err) {
    return { success: false, error: err.message };
  }
}

function generateFollowupCSV(filters = {}) {
  let sql = `
    SELECT 
      fp.id as 随访ID,
      p.name as 患者姓名,
      p.id_card as 身份证号,
      p.phone as 联系电话,
      p.gender as 性别,
      p.age as 年龄,
      d.name as 科室,
      u.name as 主治医生,
      fp.followup_date as 复诊日期,
      fp.reminder_method as 提醒方式,
      fp.related_diagnosis as 关联诊断,
      fp.notes as 注意事项,
      CASE fp.status
        WHEN 'pending' THEN '待提醒'
        WHEN 'contacted' THEN '已联系'
        WHEN 'no_answer' THEN '未接通'
        WHEN 'cancelled' THEN '已取消'
        WHEN 'completed' THEN '已完成'
      END as 状态,
      fp.contact_result as 联系结果,
      u2.name as 登记护士,
      fp.contacted_at as 登记时间,
      fp.cancel_reason as 取消原因,
      u3.name as 取消人,
      fp.cancelled_at as 取消时间,
      u4.name as 创建人,
      fp.created_at as 创建时间
    FROM followup_plans fp
    JOIN patients p ON fp.patient_id = p.id
    JOIN departments d ON fp.department_id = d.id
    JOIN users u ON fp.doctor_id = u.id
    LEFT JOIN users u2 ON fp.contacted_by = u2.id
    LEFT JOIN users u3 ON fp.cancelled_by = u3.id
    LEFT JOIN users u4 ON fp.created_by = u4.id
    WHERE 1=1
  `;
  const params = [];

  if (filters.patient_id) { sql += ' AND fp.patient_id = ?'; params.push(filters.patient_id); }
  if (filters.department_id) { sql += ' AND fp.department_id = ?'; params.push(filters.department_id); }
  if (filters.status) { sql += ' AND fp.status = ?'; params.push(filters.status); }
  if (filters.start_date) { sql += ' AND fp.followup_date >= ?'; params.push(filters.start_date); }
  if (filters.end_date) { sql += ' AND fp.followup_date <= ?'; params.push(filters.end_date); }

  sql += ' ORDER BY fp.followup_date DESC, fp.created_at DESC';

  const rows = db.prepare(sql).all(...params);

  if (rows.length === 0) {
    return '随访ID,患者姓名,身份证号,联系电话,性别,年龄,科室,主治医生,复诊日期,提醒方式,关联诊断,注意事项,状态,联系结果,登记护士,登记时间,取消原因,取消人,取消时间,创建人,创建时间\n';
  }

  const headers = Object.keys(rows[0]).join(',');
  const csvRows = rows.map(row => {
    return Object.values(row).map(v => {
      if (v == null) return '';
      const str = String(v).replace(/"/g, '""');
      return /[,"\n]/.test(str) ? `"${str}"` : str;
    }).join(',');
  });

  return [headers, ...csvRows].join('\n') + '\n';
}

module.exports = {
  getReminderAdvanceDays,
  setReminderAdvanceDays,
  checkDuplicatePlan,
  createFollowupPlan,
  getFollowupPlan,
  listFollowupPlans,
  getTodayReminders,
  updateFollowupStatus,
  generateFollowupCSV
};
