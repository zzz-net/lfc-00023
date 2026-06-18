const express = require('express');
const db = require('../db');
const { logAudit } = require('../utils/audit');
const { checkCanRegister, getNextQueueNumber, getTodayQueueCount } = require('../utils/queue');
const { precheckBatch, confirmBatch, revokeBatch, generateBatchCSV } = require('../utils/batchImport');
const {
  getFollowupPlan,
  listFollowupPlans,
  getTodayReminders,
  updateFollowupStatus
} = require('../utils/followup');
const {
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
  cancelExamOrder
} = require('../utils/exam');

const router = express.Router();

router.post('/patients', (req, res) => {
  let { name, id_card, phone, gender, age } = req.body;
  
  if (!name || !id_card) {
    return res.status(400).json({ error: '姓名和身份证号不能为空' });
  }

  const normalizeGender = (g) => {
    if (g == null || g === '') return null;
    const s = String(g).trim().toLowerCase().replace(/\uFEFF/g, '').replace(/\s/g, '');
    if (s === '男' || ['male', 'm', '1', '男性', 'boy', 'man', '男生', '男士', '爷', '哥'].includes(s)) return '男';
    if (s === '女' || ['female', 'f', '0', '女性', 'girl', 'woman', '女生', '女士', '妹', '姐'].includes(s)) return '女';
    return '__INVALID__';
  };

  gender = normalizeGender(gender);
  if (gender === '__INVALID__') {
    return res.status(400).json({ error: '性别值不合法，请使用"男"或"女"，或常见等价表示' });
  }

  try {
    let patient = db.prepare('SELECT * FROM patients WHERE id_card = ?').get(id_card);
    
    if (!patient) {
      const stmt = db.prepare(`
        INSERT INTO patients (name, id_card, phone, gender, age)
        VALUES (?, ?, ?, ?, ?)
      `);
      const result = stmt.run(name, id_card, phone || null, gender, age || null);
      patient = { id: result.lastInsertRowid, name, id_card, phone, gender, age };
      
      logAudit(req.user.id, 'create_patient', 'patient', patient.id, 
        { name, id_card }, req.ip);
    }
    
    res.json(patient);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/patients/:id_card', (req, res) => {
  const { id_card } = req.params;
  const patient = db.prepare('SELECT * FROM patients WHERE id_card = ?').get(id_card);
  
  if (!patient) {
    return res.status(404).json({ error: '患者不存在' });
  }
  
  res.json(patient);
});

router.post('/queue/register', (req, res) => {
  const { patient_id, department_id, type } = req.body;
  
  if (!patient_id || !department_id || !type) {
    return res.status(400).json({ error: '患者ID、科室ID和挂号类型不能为空' });
  }

  if (!['appointment', 'walkin'].includes(type)) {
    return res.status(400).json({ error: '挂号类型必须是appointment或walkin' });
  }

  const patient = db.prepare('SELECT * FROM patients WHERE id = ?').get(patient_id);
  if (!patient) {
    return res.status(404).json({ error: '患者不存在' });
  }

  const dept = db.prepare('SELECT * FROM departments WHERE id = ? AND is_active = 1').get(department_id);
  if (!dept) {
    return res.status(404).json({ error: '科室不存在或未启用' });
  }

  const today = new Date().toISOString().split('T')[0];
  
  const existing = db.prepare(`
    SELECT * FROM queue_records 
    WHERE patient_id = ? AND department_id = ? AND queue_date = ? AND status NOT IN ('returned')
  `).get(patient_id, department_id, today);
  
  if (existing) {
    return res.status(400).json({ error: '该患者今日已在此科室挂号' });
  }

  const checkResult = checkCanRegister(department_id, today, type);
  if (!checkResult.can) {
    return res.status(400).json({ error: checkResult.reason });
  }

  const queueNumber = getNextQueueNumber(department_id, today);

  const stmt = db.prepare(`
    INSERT INTO queue_records (patient_id, department_id, queue_date, queue_number, type)
    VALUES (?, ?, ?, ?, ?)
  `);
  const result = stmt.run(patient_id, department_id, today, queueNumber, type);
  
  logAudit(req.user.id, 'register_queue', 'queue_record', result.lastInsertRowid, 
    { patient_id, patient_name: patient.name, department_id, department_name: dept.name, type, queue_number: queueNumber }, req.ip);
  
  const queueRecord = db.prepare(`
    SELECT qr.*, p.name as patient_name, d.name as department_name
    FROM queue_records qr
    JOIN patients p ON qr.patient_id = p.id
    JOIN departments d ON qr.department_id = d.id
    WHERE qr.id = ?
  `).get(result.lastInsertRowid);
  
  res.json(queueRecord);
});

router.get('/queue/:department_id', (req, res) => {
  const { department_id } = req.params;
  const { date } = req.query;
  const queueDate = date || new Date().toISOString().split('T')[0];
  
  const queue = db.prepare(`
    SELECT qr.*, p.name as patient_name, p.id_card, p.phone, d.name as department_name,
           u.name as called_by_name, u2.name as doctor_name
    FROM queue_records qr
    JOIN patients p ON qr.patient_id = p.id
    JOIN departments d ON qr.department_id = d.id
    LEFT JOIN users u ON qr.called_by = u.id
    LEFT JOIN users u2 ON qr.consulting_doctor_id = u2.id
    WHERE qr.department_id = ? AND qr.queue_date = ?
    ORDER BY 
      CASE qr.status 
        WHEN 'consulting' THEN 1 
        WHEN 'called' THEN 2 
        WHEN 'waiting' THEN 3 
        WHEN 'missed' THEN 4
        WHEN 'returned' THEN 5
        ELSE 6 
      END,
      qr.queue_number
  `).all(department_id, queueDate);
  
  res.json(queue);
});

router.post('/queue/call/:id', (req, res) => {
  const { id } = req.params;
  
  const record = db.prepare('SELECT * FROM queue_records WHERE id = ?').get(id);
  if (!record) {
    return res.status(404).json({ error: '排队记录不存在' });
  }

  if (record.status === 'returned') {
    return res.status(400).json({ error: '该记录已退回，无法叫号' });
  }

  if (record.status === 'completed') {
    return res.status(400).json({ error: '该患者已完成就诊' });
  }

  if (record.status === 'called' || record.status === 'consulting') {
    return res.status(400).json({ error: '该患者已在叫号或就诊中' });
  }

  const currentDoctor = db.prepare(`
    SELECT COUNT(*) as count FROM queue_records 
    WHERE department_id = ? AND queue_date = ? AND status = 'consulting'
  `).get(record.department_id, record.queue_date);
  
  if (currentDoctor.count > 0) {
    return res.status(400).json({ error: '当前有患者正在就诊，请先完成当前接诊' });
  }

  const now = new Date().toISOString();
  
  db.prepare(`
    UPDATE queue_records 
    SET status = 'called', called_at = ?, called_by = ?
    WHERE id = ?
  `).run(now, req.user.id, id);
  
  logAudit(req.user.id, 'call_patient', 'queue_record', id, 
    { queue_number: record.queue_number, previous_status: record.status }, req.ip);
  
  const updated = db.prepare(`
    SELECT qr.*, p.name as patient_name, d.name as department_name
    FROM queue_records qr
    JOIN patients p ON qr.patient_id = p.id
    JOIN departments d ON qr.department_id = d.id
    WHERE qr.id = ?
  `).get(id);
  
  res.json(updated);
});

router.post('/queue/miss/:id', (req, res) => {
  const { id } = req.params;
  
  const record = db.prepare('SELECT * FROM queue_records WHERE id = ?').get(id);
  if (!record) {
    return res.status(404).json({ error: '排队记录不存在' });
  }

  const fetchDetail = () => db.prepare(`
    SELECT qr.*, p.name as patient_name, d.name as department_name
    FROM queue_records qr
    JOIN patients p ON qr.patient_id = p.id
    JOIN departments d ON qr.department_id = d.id
    WHERE qr.id = ?
  `).get(id);

  if (record.status === 'missed') {
    return res.json(fetchDetail());
  }

  if (record.status !== 'called') {
    return res.status(400).json({ error: '只有已叫号的患者才能过号' });
  }

  db.prepare(`
    UPDATE queue_records 
    SET status = 'missed'
    WHERE id = ?
  `).run(id);
  
  logAudit(req.user.id, 'miss_patient', 'queue_record', id, 
    { queue_number: record.queue_number }, req.ip);
  
  res.json(fetchDetail());
});

router.post('/queue/return/:id', (req, res) => {
  const { id } = req.params;
  const { reason } = req.body;
  
  if (!reason) {
    return res.status(400).json({ error: '退回原因不能为空' });
  }

  const record = db.prepare('SELECT * FROM queue_records WHERE id = ?').get(id);
  if (!record) {
    return res.status(404).json({ error: '排队记录不存在' });
  }

  if (record.status === 'returned') {
    return res.status(400).json({ error: '该记录已退回' });
  }

  if (record.status === 'completed') {
    return res.status(400).json({ error: '已完成就诊的记录无法退回' });
  }

  if (record.status === 'consulting') {
    return res.status(400).json({ error: '正在就诊中的患者无法退回，请先完成或取消接诊' });
  }

  const now = new Date().toISOString();
  
  db.prepare(`
    UPDATE queue_records 
    SET status = 'returned', return_reason = ?, returned_by = ?, returned_at = ?
    WHERE id = ?
  `).run(reason, req.user.id, now, id);
  
  logAudit(req.user.id, 'return_queue', 'queue_record', id, 
    { queue_number: record.queue_number, reason }, req.ip);
  
  const updated = db.prepare(`
    SELECT qr.*, p.name as patient_name, d.name as department_name,
           u.name as returned_by_name
    FROM queue_records qr
    JOIN patients p ON qr.patient_id = p.id
    JOIN departments d ON qr.department_id = d.id
    LEFT JOIN users u ON qr.returned_by = u.id
    WHERE qr.id = ?
  `).get(id);
  
  res.json(updated);
});

router.get('/queue/stats/:department_id', (req, res) => {
  const { department_id } = req.params;
  const { date } = req.query;
  const queueDate = date || new Date().toISOString().split('T')[0];
  
  const stats = db.prepare(`
    SELECT 
      status,
      COUNT(*) as count
    FROM queue_records
    WHERE department_id = ? AND queue_date = ?
    GROUP BY status
  `).all(department_id, queueDate);
  
  const result = {
    waiting: 0,
    called: 0,
    consulting: 0,
    completed: 0,
    missed: 0,
    returned: 0,
    total: 0
  };
  
  stats.forEach(s => {
    result[s.status] = s.count;
    result.total += s.count;
  });
  
  const slot = db.prepare('SELECT * FROM daily_slots WHERE department_id = ? AND date = ?')
    .get(department_id, queueDate);
  
  result.total_slots = slot ? slot.total_slots : 0;
  result.available = slot ? Math.max(0, slot.total_slots - result.total + result.returned) : 0;
  
  res.json(result);
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

  if (batch.imported_by !== req.user.id) {
    return res.status(403).json({ error: '只能确认自己发起的批次' });
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
  
  sql += ' AND b.imported_by = ?';
  params.push(req.user.id);
  
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
  
  let countSql = `SELECT COUNT(*) as total FROM import_batches b WHERE 1=1 AND b.imported_by = ?`;
  const countParams = [req.user.id];
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

  if (batch.imported_by !== req.user.id) {
    return res.status(403).json({ error: '只能查看自己发起的批次' });
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

  if (batch.imported_by !== req.user.id) {
    return res.status(403).json({ error: '只能导出自己发起的批次' });
  }
  
  const csv = generateBatchCSV(id);
  
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="batch-${batch.batch_no}.csv"`);
  res.send('\uFEFF' + csv);
});

router.post('/batches/:id/revoke', (req, res) => {
  const { id } = req.params;
  const { reason } = req.body;
  
  const batch = db.prepare('SELECT * FROM import_batches WHERE id = ?').get(id);
  if (!batch) {
    return res.status(404).json({ error: '批次不存在' });
  }

  if (batch.imported_by !== req.user.id) {
    return res.status(403).json({ error: '只能撤销自己发起的批次' });
  }
  
  const result = revokeBatch(parseInt(id), req.user.id, req.ip, reason);
  
  if (!result.success) {
    return res.status(400).json(result);
  }
  
  res.json(result);
});

router.get('/followup/today', (req, res) => {
  const filters = {};
  if (req.query.department_id) {
    filters.department_id = req.query.department_id;
  }
  const result = getTodayReminders(req.user.id, req.user.role, filters);
  if (!result.success) {
    return res.status(400).json(result);
  }
  res.json(result);
});

router.get('/followup', (req, res) => {
  const result = listFollowupPlans(req.query, req.user.id, req.user.role);
  if (!result.success) {
    return res.status(400).json(result);
  }
  res.json(result);
});

router.get('/followup/:id', (req, res) => {
  const result = getFollowupPlan(parseInt(req.params.id), req.user.id, req.user.role);
  if (!result.success) {
    const statusCode = result.code || 404;
    return res.status(statusCode).json(result);
  }
  res.json(result.plan);
});

router.post('/followup/:id/contact', (req, res) => {
  const { status, contact_result } = req.body;
  
  if (!['contacted', 'no_answer', 'completed'].includes(status)) {
    return res.status(400).json({ success: false, error: '状态必须是contacted、no_answer或completed' });
  }
  
  const result = updateFollowupStatus(parseInt(req.params.id), status, { contact_result }, req.user.id, req.user.role, req.ip);
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

router.get('/exam/orders/:id', (req, res) => {
  const result = getExamOrderDetail(parseInt(req.params.id), req.user.id, req.user.role);
  if (!result.success) {
    const statusCode = result.code || 404;
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

router.get('/exam/reschedule', (req, res) => {
  const result = listRescheduleRequests(req.query, req.user.id, req.user.role);
  if (!result.success) {
    return res.status(400).json(result);
  }
  res.json(result);
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
