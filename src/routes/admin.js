const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db');
const { logAudit } = require('../utils/audit');
const { precheckBatch, confirmBatch, revokeBatch, generateBatchCSV } = require('../utils/batchImport');
const {
  listSandboxTasks, getSandboxTaskDetail, approveSandboxTask,
  rejectSandboxTask, generateSandboxReportCSV
} = require('../utils/sandboxImport');
const {
  getReminderAdvanceDays,
  setReminderAdvanceDays,
  getFollowupPlan,
  listFollowupPlans,
  updateFollowupStatus,
  generateFollowupCSV
} = require('../utils/followup');
const {
  createExamOrder,
  scheduleExamOrder,
  approveReschedule,
  rejectReschedule,
  revertReschedule,
  listExamOrders,
  getExamOrderDetail,
  listRescheduleRequests,
  listWaitlist,
  promoteWaitlist,
  cancelWaitlist,
  listExamSlots,
  listTodayExecutions,
  listExamTypes,
  completeExamOrder,
  cancelExamOrder,
  listConfigs,
  updateConfig,
  generateExamCSV,
  generateRescheduleCSV,
  generateWaitlistCSV
} = require('../utils/exam');

const router = express.Router();

router.get('/departments', (req, res) => {
  const depts = db.prepare('SELECT * FROM departments ORDER BY id').all();
  res.json(depts);
});

router.post('/departments', (req, res) => {
  const { name, code, description } = req.body;
  
  if (!name || !code) {
    return res.status(400).json({ error: '科室名称和代码不能为空' });
  }

  try {
    const stmt = db.prepare('INSERT INTO departments (name, code, description) VALUES (?, ?, ?)');
    const result = stmt.run(name, code, description);
    
    logAudit(req.user.id, 'create_department', 'department', result.lastInsertRowid, 
      { name, code, description }, req.ip);
    
    res.json({ id: result.lastInsertRowid, name, code, description });
  } catch (err) {
    if (err.message.includes('UNIQUE')) {
      return res.status(400).json({ error: '科室名称或代码已存在' });
    }
    res.status(500).json({ error: err.message });
  }
});

router.put('/departments/:id', (req, res) => {
  const { id } = req.params;
  const { name, code, description, is_active } = req.body;
  
  const dept = db.prepare('SELECT * FROM departments WHERE id = ?').get(id);
  if (!dept) {
    return res.status(404).json({ error: '科室不存在' });
  }

  try {
    const stmt = db.prepare(`
      UPDATE departments 
      SET name = COALESCE(?, name), 
          code = COALESCE(?, code), 
          description = COALESCE(?, description),
          is_active = COALESCE(?, is_active)
      WHERE id = ?
    `);
    stmt.run(name, code, description, is_active, id);
    
    logAudit(req.user.id, 'update_department', 'department', id, 
      { name, code, description, is_active }, req.ip);
    
    res.json({ id, name, code, description, is_active });
  } catch (err) {
    if (err.message.includes('UNIQUE')) {
      return res.status(400).json({ error: '科室名称或代码已存在' });
    }
    res.status(500).json({ error: err.message });
  }
});

router.delete('/departments/:id', (req, res) => {
  const { id } = req.params;
  
  const dept = db.prepare('SELECT * FROM departments WHERE id = ?').get(id);
  if (!dept) {
    return res.status(404).json({ error: '科室不存在' });
  }

  const hasQueues = db.prepare('SELECT COUNT(*) as count FROM queue_records WHERE department_id = ?').get(id);
  if (hasQueues.count > 0) {
    return res.status(400).json({ error: '该科室已有排队记录，无法删除' });
  }

  db.prepare('DELETE FROM departments WHERE id = ?').run(id);
  
  logAudit(req.user.id, 'delete_department', 'department', id, { name: dept.name }, req.ip);
  
  res.json({ message: '删除成功' });
});

router.get('/daily-slots', (req, res) => {
  const { department_id, date } = req.query;
  
  let sql = `SELECT ds.*, d.name as department_name 
             FROM daily_slots ds 
             JOIN departments d ON ds.department_id = d.id WHERE 1=1`;
  const params = [];
  
  if (department_id) {
    sql += ' AND ds.department_id = ?';
    params.push(department_id);
  }
  if (date) {
    sql += ' AND ds.date = ?';
    params.push(date);
  }
  
  sql += ' ORDER BY ds.date DESC, ds.department_id';
  
  const slots = db.prepare(sql).all(...params);
  res.json(slots);
});

router.post('/daily-slots', (req, res) => {
  const { department_id, date, total_slots, walkin_limit } = req.body;
  
  if (!department_id || !date) {
    return res.status(400).json({ error: '科室和日期不能为空' });
  }

  const dept = db.prepare('SELECT * FROM departments WHERE id = ?').get(department_id);
  if (!dept) {
    return res.status(404).json({ error: '科室不存在' });
  }

  try {
    const stmt = db.prepare(`
      INSERT INTO daily_slots (department_id, date, total_slots, walkin_limit)
      VALUES (?, ?, ?, ?)
    `);
    const result = stmt.run(department_id, date, total_slots || 20, walkin_limit || 5);
    
    logAudit(req.user.id, 'create_daily_slot', 'daily_slot', result.lastInsertRowid, 
      { department_id, date, total_slots, walkin_limit }, req.ip);
    
    res.json({ id: result.lastInsertRowid, department_id, date, total_slots, walkin_limit });
  } catch (err) {
    if (err.message.includes('UNIQUE')) {
      return res.status(400).json({ error: '该科室此日期已配置号源' });
    }
    res.status(500).json({ error: err.message });
  }
});

router.put('/daily-slots/:id', (req, res) => {
  const { id } = req.params;
  const { total_slots, walkin_limit } = req.body;
  
  const slot = db.prepare('SELECT * FROM daily_slots WHERE id = ?').get(id);
  if (!slot) {
    return res.status(404).json({ error: '号源配置不存在' });
  }

  const stmt = db.prepare(`
    UPDATE daily_slots 
    SET total_slots = COALESCE(?, total_slots), 
        walkin_limit = COALESCE(?, walkin_limit)
    WHERE id = ?
  `);
  stmt.run(total_slots, walkin_limit, id);
  
  logAudit(req.user.id, 'update_daily_slot', 'daily_slot', id, 
    { total_slots, walkin_limit }, req.ip);
  
  res.json({ id, total_slots, walkin_limit });
});

router.get('/closed-periods', (req, res) => {
  const periods = db.prepare(`
    SELECT cp.*, d.name as department_name 
    FROM closed_periods cp 
    JOIN departments d ON cp.department_id = d.id
    ORDER BY cp.start_date DESC
  `).all();
  res.json(periods);
});

router.post('/closed-periods', (req, res) => {
  const { department_id, start_date, end_date, reason } = req.body;
  
  if (!department_id || !start_date || !end_date) {
    return res.status(400).json({ error: '科室、开始日期和结束日期不能为空' });
  }

  const dept = db.prepare('SELECT * FROM departments WHERE id = ?').get(department_id);
  if (!dept) {
    return res.status(404).json({ error: '科室不存在' });
  }

  if (start_date > end_date) {
    return res.status(400).json({ error: '开始日期不能晚于结束日期' });
  }

  const stmt = db.prepare(`
    INSERT INTO closed_periods (department_id, start_date, end_date, reason)
    VALUES (?, ?, ?, ?)
  `);
  const result = stmt.run(department_id, start_date, end_date, reason);
  
  logAudit(req.user.id, 'create_closed_period', 'closed_period', result.lastInsertRowid, 
    { department_id, start_date, end_date, reason }, req.ip);
  
  res.json({ id: result.lastInsertRowid, department_id, start_date, end_date, reason });
});

router.delete('/closed-periods/:id', (req, res) => {
  const { id } = req.params;
  
  const period = db.prepare('SELECT * FROM closed_periods WHERE id = ?').get(id);
  if (!period) {
    return res.status(404).json({ error: '停诊时段不存在' });
  }

  db.prepare('DELETE FROM closed_periods WHERE id = ?').run(id);
  
  logAudit(req.user.id, 'delete_closed_period', 'closed_period', id, 
    { department_id: period.department_id }, req.ip);
  
  res.json({ message: '删除成功' });
});

router.get('/users', (req, res) => {
  const users = db.prepare(`
    SELECT u.id, u.username, u.name, u.role, u.department_id, d.name as department_name
    FROM users u
    LEFT JOIN departments d ON u.department_id = d.id
    ORDER BY u.id
  `).all();
  res.json(users);
});

router.post('/users', (req, res) => {
  const { username, password, name, role, department_id } = req.body;
  
  if (!username || !password || !name || !role) {
    return res.status(400).json({ error: '用户名、密码、姓名、角色不能为空' });
  }

  if (!['admin', 'nurse', 'doctor'].includes(role)) {
    return res.status(400).json({ error: '角色必须是admin、nurse或doctor' });
  }

  if (role === 'doctor' && !department_id) {
    return res.status(400).json({ error: '医生必须指定所属科室' });
  }

  const hashedPassword = bcrypt.hashSync(password, 10);

  try {
    const stmt = db.prepare(`
      INSERT INTO users (username, password, name, role, department_id)
      VALUES (?, ?, ?, ?, ?)
    `);
    const result = stmt.run(username, hashedPassword, name, role, department_id);
    
    logAudit(req.user.id, 'create_user', 'user', result.lastInsertRowid, 
      { username, name, role, department_id }, req.ip);
    
    res.json({ id: result.lastInsertRowid, username, name, role, department_id });
  } catch (err) {
    if (err.message.includes('UNIQUE')) {
      return res.status(400).json({ error: '用户名已存在' });
    }
    res.status(500).json({ error: err.message });
  }
});

router.post('/batch/precheck', (req, res) => {
  const { csv_text } = req.body;
  
  if (!csv_text) {
    return res.status(400).json({ error: 'CSV内容不能为空' });
  }

  const result = precheckBatch(csv_text, req.user.id, req.ip);
  
  if (!result.success) {
    return res.status(400).json(result);
  }
  
  res.json(result);
});

router.post('/batch/confirm', (req, res) => {
  const { batch_id } = req.body;
  
  if (!batch_id) {
    return res.status(400).json({ error: '批次ID不能为空' });
  }

  const batch = db.prepare('SELECT * FROM import_batches WHERE id = ?').get(batch_id);
  if (!batch) {
    return res.status(404).json({ error: '批次不存在' });
  }

  const result = confirmBatch(parseInt(batch_id), req.user.id, req.ip);
  
  if (!result.success) {
    return res.status(400).json(result);
  }
  
  res.json(result);
});

router.get('/batches', (req, res) => {
  const { date, department_id, page = 1, pageSize = 20 } = req.query;
  
  let sql = `
    SELECT b.*, u.name as imported_by_name, u2.name as revoked_by_name, u3.name as confirmed_by_name,
           COUNT(ir.id) as record_count
    FROM import_batches b
    LEFT JOIN users u ON b.imported_by = u.id
    LEFT JOIN users u2 ON b.revoked_by = u2.id
    LEFT JOIN users u3 ON b.confirmed_by = u3.id
    LEFT JOIN import_records ir ON b.id = ir.batch_id
    WHERE 1=1
  `;
  const params = [];
  
  if (date) {
    sql += ' AND DATE(b.imported_at) = ?';
    params.push(date);
  }
  
  if (department_id) {
    sql += ` AND b.id IN (
      SELECT DISTINCT batch_id FROM import_records 
      WHERE department_id = ?
    )`;
    params.push(department_id);
  }
  
  sql += `
    GROUP BY b.id
    ORDER BY b.imported_at DESC
    LIMIT ? OFFSET ?
  `;
  params.push(parseInt(pageSize), (parseInt(page) - 1) * parseInt(pageSize));
  
  const batches = db.prepare(sql).all(...params);
  
  let countSql = `SELECT COUNT(*) as total FROM import_batches b WHERE 1=1`;
  const countParams = [];
  if (date) { countParams.push(date); countSql += ' AND DATE(b.imported_at) = ?'; }
  if (department_id) { 
    countParams.push(department_id);
    countSql += ` AND b.id IN (SELECT DISTINCT batch_id FROM import_records WHERE department_id = ?)`;
  }
  
  const { total } = db.prepare(countSql).get(...countParams);
  
  res.json({
    batches,
    pagination: { page: parseInt(page), pageSize: parseInt(pageSize), total }
  });
});

router.get('/batches/:id', (req, res) => {
  const { id } = req.params;
  
  const batch = db.prepare(`
    SELECT b.*, u.name as imported_by_name, u2.name as revoked_by_name, u3.name as confirmed_by_name
    FROM import_batches b
    LEFT JOIN users u ON b.imported_by = u.id
    LEFT JOIN users u2 ON b.revoked_by = u2.id
    LEFT JOIN users u3 ON b.confirmed_by = u3.id
    WHERE b.id = ?
  `).get(id);
  
  if (!batch) {
    return res.status(404).json({ error: '批次不存在' });
  }
  
  const records = db.prepare(`
    SELECT ir.*, p.id_card as patient_id_card, p.name as patient_name,
           qr.queue_number, qr.status as queue_status
    FROM import_records ir
    LEFT JOIN patients p ON ir.patient_id = p.id
    LEFT JOIN queue_records qr ON ir.queue_record_id = qr.id
    WHERE ir.batch_id = ?
    ORDER BY ir.row_index
  `).all(id);
  
  batch.records = records;
  res.json(batch);
});

router.get('/batches/:id/csv', (req, res) => {
  const { id } = req.params;
  
  const batch = db.prepare('SELECT * FROM import_batches WHERE id = ?').get(id);
  if (!batch) {
    return res.status(404).json({ error: '批次不存在' });
  }
  
  const csv = generateBatchCSV(id);
  
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="batch-${batch.batch_no}.csv"`);
  res.send('\uFEFF' + csv);
});

router.post('/batches/:id/revoke', (req, res) => {
  const { id } = req.params;
  const { reason } = req.body;
  
  const result = revokeBatch(parseInt(id), req.user.id, req.ip, reason);
  
  if (!result.success) {
    return res.status(400).json(result);
  }
  
  res.json(result);
});

router.get('/sandbox/tasks', (req, res) => {
  const result = listSandboxTasks(req.query, req.user.id, req.user.role);
  if (!result.success) return res.status(400).json(result);
  res.json(result);
});

router.get('/sandbox/tasks/:id', (req, res) => {
  const result = getSandboxTaskDetail(parseInt(req.params.id), req.user.id, req.user.role);
  if (!result.success) {
    if (result.error === '沙箱任务不存在') return res.status(404).json(result);
    return res.status(400).json(result);
  }
  res.json(result.task);
});

router.post('/sandbox/tasks/:id/approve', (req, res) => {
  const { remark } = req.body;
  const result = approveSandboxTask(parseInt(req.params.id), req.user.id, req.ip, remark);
  if (!result.success) return res.status(400).json(result);
  res.json(result);
});

router.post('/sandbox/tasks/:id/reject', (req, res) => {
  const { remark } = req.body;
  const result = rejectSandboxTask(parseInt(req.params.id), req.user.id, req.ip, remark);
  if (!result.success) return res.status(400).json(result);
  res.json(result);
});

router.get('/sandbox/tasks/:id/export', (req, res) => {
  const result = generateSandboxReportCSV(parseInt(req.params.id));
  if (!result.success) return res.status(400).json(result);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="sandbox-${result.task_no || req.params.id}.csv"`);
  res.send('\uFEFF' + result.csv);
});

router.get('/followup/config', (req, res) => {
  const advanceDays = getReminderAdvanceDays();
  const config = db.prepare('SELECT * FROM followup_configs WHERE config_key = ?').get('reminder_advance_days');
  res.json({
    reminder_advance_days: advanceDays,
    description: config?.description,
    updated_by: config?.updated_by,
    updated_at: config?.updated_at
  });
});

router.post('/followup/config', (req, res) => {
  const { reminder_advance_days } = req.body;
  
  if (reminder_advance_days == null) {
    return res.status(400).json({ error: 'reminder_advance_days 不能为空' });
  }
  
  const days = parseInt(reminder_advance_days);
  if (isNaN(days) || days < 0 || days > 30) {
    return res.status(400).json({ error: 'reminder_advance_days 必须是0-30之间的整数' });
  }
  
  setReminderAdvanceDays(days, req.user.id);
  
  logAudit(req.user.id, 'update_followup_config', 'followup_config', null, {
    reminder_advance_days: days
  }, req.ip);
  
  res.json({ success: true, reminder_advance_days: days });
});

router.get('/followup', (req, res) => {
  const result = listFollowupPlans(req.query, req.user.id, req.user.role);
  if (!result.success) {
    return res.status(400).json(result);
  }
  res.json(result);
});

router.get('/followup/export', (req, res) => {
  const csv = generateFollowupCSV(req.query);
  
  const now = new Date().toISOString().split('T')[0];
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="followup-plans-${now}.csv"`);
  res.send('\uFEFF' + csv);
});

router.get('/followup/:id', (req, res) => {
  const result = getFollowupPlan(parseInt(req.params.id), req.user.id, req.user.role);
  if (!result.success) {
    const statusCode = result.code || 404;
    return res.status(statusCode).json(result);
  }
  res.json(result.plan);
});

router.post('/followup/:id/cancel', (req, res) => {
  const { cancel_reason } = req.body;
  if (!cancel_reason) {
    return res.status(400).json({ success: false, error: '取消原因不能为空' });
  }
  const result = updateFollowupStatus(parseInt(req.params.id), 'cancelled', { cancel_reason }, req.user.id, req.user.role, req.ip);
  if (!result.success) {
    const statusCode = result.code || 400;
    return res.status(statusCode).json(result);
  }
  res.json(result);
});

router.get('/exam/types', (req, res) => {
  const result = listExamTypes();
  res.json(result);
});

router.post('/exam/types', (req, res) => {
  const { name, code, department_id, description, default_duration } = req.body;
  if (!name || !code || !department_id) {
    return res.status(400).json({ success: false, error: '名称、代码和科室ID不能为空' });
  }
  try {
    const stmt = db.prepare(`
      INSERT INTO exam_types (name, code, department_id, description, default_duration)
      VALUES (?, ?, ?, ?, ?)
    `);
    const result = stmt.run(name, code, department_id, description || null, default_duration || 15);
    logAudit(req.user.id, 'create_exam_type', 'exam_type', result.lastInsertRowid, { name, code, department_id }, req.ip);
    res.json({ success: true, id: result.lastInsertRowid });
  } catch (e) {
    return res.status(400).json({ success: false, error: e.message });
  }
});

router.put('/exam/types/:id', (req, res) => {
  const { name, code, description, default_duration, is_active } = req.body;
  try {
    db.prepare(`
      UPDATE exam_types SET 
        name = COALESCE(?, name),
        code = COALESCE(?, code),
        description = COALESCE(?, description),
        default_duration = COALESCE(?, default_duration),
        is_active = COALESCE(?, is_active)
      WHERE id = ?
    `).run(name, code, description, default_duration, is_active, req.params.id);
    logAudit(req.user.id, 'update_exam_type', 'exam_type', req.params.id, req.body, req.ip);
    res.json({ success: true });
  } catch (e) {
    return res.status(400).json({ success: false, error: e.message });
  }
});

router.get('/exam/configs', (req, res) => {
  const result = listConfigs();
  res.json(result);
});

router.post('/exam/configs', (req, res) => {
  const { key, value, description } = req.body;
  if (!key || value == null) {
    return res.status(400).json({ success: false, error: '配置key和value不能为空' });
  }
  const result = updateConfig(key, value, description, req.user.id);
  logAudit(req.user.id, 'update_exam_config', 'exam_config', null, { key, value, description }, req.ip);
  res.json(result);
});

router.get('/exam/today', (req, res) => {
  const date = req.query.date || new Date().toISOString().split('T')[0];
  const result = listTodayExecutions(date);
  res.json(result);
});

router.get('/exam/orders', (req, res) => {
  const result = listExamOrders(req.query, req.user.id, req.user.role);
  if (!result.success) {
    return res.status(400).json(result);
  }
  res.json(result);
});

router.get('/exam/orders/export', (req, res) => {
  const result = generateExamCSV(req.query);
  if (!result.success) {
    return res.status(400).json(result);
  }
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${result.filename}"`);
  res.send('\uFEFF' + result.content);
});

router.get('/exam/orders/:id', (req, res) => {
  const result = getExamOrderDetail(parseInt(req.params.id), req.user.id, req.user.role);
  if (!result.success) {
    const statusCode = result.code || 404;
    return res.status(statusCode).json(result);
  }
  res.json(result);
});

router.post('/exam/orders', (req, res) => {
  const result = createExamOrder(req.body, req.user.id, req.ip);
  if (!result.success) {
    return res.status(400).json(result);
  }
  res.json(result);
});

router.post('/exam/orders/:id/schedule', (req, res) => {
  const { slot_id } = req.body;
  if (!slot_id) {
    return res.status(400).json({ success: false, error: '时段ID不能为空' });
  }
  const result = scheduleExamOrder(parseInt(req.params.id), parseInt(slot_id), req.user.id, req.user.role, req.ip);
  if (!result.success) {
    const statusCode = result.code || 400;
    return res.status(statusCode).json(result);
  }
  res.json(result);
});

router.post('/exam/orders/:id/complete', (req, res) => {
  const { result: examResult } = req.body;
  const result = completeExamOrder(parseInt(req.params.id), req.user.id, req.user.role, req.ip, examResult);
  if (!result.success) {
    const statusCode = result.code || 400;
    return res.status(statusCode).json(result);
  }
  res.json(result);
});

router.post('/exam/orders/:id/cancel', (req, res) => {
  const { cancel_reason } = req.body;
  if (!cancel_reason) {
    return res.status(400).json({ success: false, error: '取消原因不能为空' });
  }
  const result = cancelExamOrder(parseInt(req.params.id), req.user.id, req.user.role, req.ip, cancel_reason);
  if (!result.success) {
    const statusCode = result.code || 400;
    return res.status(statusCode).json(result);
  }
  res.json(result);
});

router.get('/exam/slots', (req, res) => {
  const result = listExamSlots(req.query);
  res.json(result);
});

router.post('/exam/slots', (req, res) => {
  const { exam_type_id, date, start_time, end_time, total_capacity, waitlist_limit } = req.body;
  if (!exam_type_id || !date || !start_time || !end_time) {
    return res.status(400).json({ success: false, error: '检查类型、日期、开始和结束时间不能为空' });
  }
  try {
    const stmt = db.prepare(`
      INSERT INTO exam_slots (exam_type_id, date, start_time, end_time, total_capacity, waitlist_limit, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    const result = stmt.run(exam_type_id, date, start_time, end_time, total_capacity || 1, waitlist_limit || 3, req.user.id);
    logAudit(req.user.id, 'create_exam_slot', 'exam_slot', result.lastInsertRowid, req.body, req.ip);
    res.json({ success: true, id: result.lastInsertRowid });
  } catch (e) {
    return res.status(400).json({ success: false, error: e.message });
  }
});

router.put('/exam/slots/:id', (req, res) => {
  const { total_capacity, waitlist_limit, status } = req.body;
  try {
    db.prepare(`
      UPDATE exam_slots SET 
        total_capacity = COALESCE(?, total_capacity),
        waitlist_limit = COALESCE(?, waitlist_limit),
        status = COALESCE(?, status),
        updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(total_capacity, waitlist_limit, status, req.params.id);
    logAudit(req.user.id, 'update_exam_slot', 'exam_slot', req.params.id, req.body, req.ip);
    res.json({ success: true });
  } catch (e) {
    return res.status(400).json({ success: false, error: e.message });
  }
});

router.get('/exam/reschedule', (req, res) => {
  const result = listRescheduleRequests(req.query, req.user.id, req.user.role);
  if (!result.success) {
    return res.status(400).json(result);
  }
  res.json(result);
});

router.get('/exam/reschedule/export', (req, res) => {
  const result = generateRescheduleCSV(req.query);
  if (!result.success) {
    return res.status(400).json(result);
  }
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${result.filename}"`);
  res.send('\uFEFF' + result.content);
});

router.post('/exam/reschedule/:id/approve', (req, res) => {
  const { slot_id, review_notes } = req.body;
  const result = approveReschedule(parseInt(req.params.id), req.user.id, req.user.role, req.ip, slot_id ? parseInt(slot_id) : null, review_notes);
  if (!result.success) {
    const statusCode = result.code || 400;
    return res.status(statusCode).json(result);
  }
  res.json(result);
});

router.post('/exam/reschedule/:id/reject', (req, res) => {
  const { review_notes } = req.body;
  const result = rejectReschedule(parseInt(req.params.id), req.user.id, req.user.role, req.ip, review_notes);
  if (!result.success) {
    const statusCode = result.code || 400;
    return res.status(statusCode).json(result);
  }
  res.json(result);
});

router.post('/exam/reschedule/:id/revert', (req, res) => {
  const { revert_reason } = req.body;
  const result = revertReschedule(parseInt(req.params.id), req.user.id, req.user.role, req.ip, revert_reason);
  if (!result.success) {
    const statusCode = result.code || 400;
    return res.status(statusCode).json(result);
  }
  res.json(result);
});

router.get('/exam/waitlist', (req, res) => {
  const result = listWaitlist(req.query);
  if (!result.success) {
    return res.status(400).json(result);
  }
  res.json(result);
});

router.get('/exam/waitlist/export', (req, res) => {
  const result = generateWaitlistCSV(req.query);
  if (!result.success) {
    return res.status(400).json(result);
  }
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${result.filename}"`);
  res.send('\uFEFF' + result.content);
});

router.post('/exam/waitlist/:id/promote', (req, res) => {
  const result = promoteWaitlist(parseInt(req.params.id), req.user.id, req.user.role, req.ip);
  if (!result.success) {
    const statusCode = result.code || 400;
    return res.status(statusCode).json(result);
  }
  res.json(result);
});

router.post('/exam/waitlist/:id/cancel', (req, res) => {
  const { cancel_reason } = req.body;
  const result = cancelWaitlist(parseInt(req.params.id), req.user.id, req.user.role, req.ip, cancel_reason);
  if (!result.success) {
    const statusCode = result.code || 400;
    return res.status(statusCode).json(result);
  }
  res.json(result);
});

module.exports = router;
