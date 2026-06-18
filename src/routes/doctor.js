const express = require('express');
const db = require('../db');
const { logAudit } = require('../utils/audit');
const {
  createFollowupPlan,
  getFollowupPlan,
  listFollowupPlans,
  updateFollowupStatus
} = require('../utils/followup');
const {
  createExamOrder,
  scheduleExamOrder,
  requestReschedule,
  cancelRescheduleRequest,
  addToWaitlist,
  cancelWaitlist,
  cancelExamOrder,
  listExamOrders,
  getExamOrderDetail,
  listRescheduleRequests,
  listExamSlots,
  listExamTypes
} = require('../utils/exam');

const router = express.Router();

router.get('/current', (req, res) => {
  const departmentId = req.user.department_id;
  const today = new Date().toISOString().split('T')[0];
  
  const current = db.prepare(`
    SELECT qr.*, p.name as patient_name, p.id_card, p.phone, p.gender, p.age,
           d.name as department_name
    FROM queue_records qr
    JOIN patients p ON qr.patient_id = p.id
    JOIN departments d ON qr.department_id = d.id
    WHERE qr.department_id = ? AND qr.queue_date = ? AND qr.status = 'called'
    ORDER BY qr.queue_number
    LIMIT 1
  `).get(departmentId, today);
  
  res.json(current || null);
});

router.get('/queue', (req, res) => {
  const departmentId = req.user.department_id;
  const today = new Date().toISOString().split('T')[0];
  
  const queue = db.prepare(`
    SELECT qr.*, p.name as patient_name, p.id_card, p.phone, p.gender, p.age,
           d.name as department_name
    FROM queue_records qr
    JOIN patients p ON qr.patient_id = p.id
    JOIN departments d ON qr.department_id = d.id
    WHERE qr.department_id = ? AND qr.queue_date = ? 
      AND qr.status IN ('waiting', 'called')
    ORDER BY qr.queue_number
  `).all(departmentId, today);
  
  res.json(queue);
});

router.get('/consulting', (req, res) => {
  const departmentId = req.user.department_id;
  const today = new Date().toISOString().split('T')[0];
  
  const consulting = db.prepare(`
    SELECT qr.*, p.name as patient_name, p.id_card, p.phone, p.gender, p.age,
           d.name as department_name
    FROM queue_records qr
    JOIN patients p ON qr.patient_id = p.id
    JOIN departments d ON qr.department_id = d.id
    WHERE qr.department_id = ? AND qr.queue_date = ? AND qr.status = 'consulting'
      AND qr.consulting_doctor_id = ?
  `).get(departmentId, today, req.user.id);
  
  res.json(consulting || null);
});

router.post('/consult/start/:queue_id', (req, res) => {
  const { queue_id } = req.params;
  const departmentId = req.user.department_id;
  
  const record = db.prepare('SELECT * FROM queue_records WHERE id = ?').get(queue_id);
  if (!record) {
    return res.status(404).json({ error: '排队记录不存在' });
  }

  if (record.department_id !== departmentId) {
    return res.status(403).json({ error: '越权操作：该患者不属于您的科室' });
  }

  if (record.status !== 'called') {
    return res.status(400).json({ error: '只能接诊已叫到的患者' });
  }

  const existingConsult = db.prepare(`
    SELECT * FROM queue_records 
    WHERE department_id = ? AND status = 'consulting' AND queue_date = ?
  `).get(departmentId, record.queue_date);
  
  if (existingConsult) {
    return res.status(400).json({ error: '您已有正在接诊的患者，请先完成当前接诊' });
  }

  const now = new Date().toISOString();
  
  db.prepare(`
    UPDATE queue_records 
    SET status = 'consulting', consulting_doctor_id = ?, consultation_started_at = ?
    WHERE id = ?
  `).run(req.user.id, now, queue_id);
  
  logAudit(req.user.id, 'start_consultation', 'queue_record', queue_id, 
    { patient_id: record.patient_id, queue_number: record.queue_number }, req.ip);
  
  const updated = db.prepare(`
    SELECT qr.*, p.name as patient_name, p.id_card, p.phone, p.gender, p.age,
           d.name as department_name
    FROM queue_records qr
    JOIN patients p ON qr.patient_id = p.id
    JOIN departments d ON qr.department_id = d.id
    WHERE qr.id = ?
  `).get(queue_id);
  
  res.json(updated);
});

router.post('/consult/complete/:queue_id', (req, res) => {
  const { queue_id } = req.params;
  const { symptoms, diagnosis, prescription, notes } = req.body;
  const departmentId = req.user.department_id;
  
  const record = db.prepare('SELECT * FROM queue_records WHERE id = ?').get(queue_id);
  if (!record) {
    return res.status(404).json({ error: '排队记录不存在' });
  }

  if (record.department_id !== departmentId) {
    return res.status(403).json({ error: '越权操作：该患者不属于您的科室' });
  }

  if (record.status !== 'consulting') {
    return res.status(400).json({ error: '该患者不在接诊状态' });
  }

  if (record.consulting_doctor_id !== req.user.id) {
    return res.status(403).json({ error: '越权操作：该患者不是由您接诊的' });
  }

  if (!diagnosis) {
    return res.status(400).json({ error: '诊断结果不能为空' });
  }

  const now = new Date().toISOString();
  
  const insertRecord = db.prepare(`
    INSERT INTO consultation_records 
    (queue_record_id, patient_id, doctor_id, department_id, symptoms, diagnosis, prescription, notes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const consultResult = insertRecord.run(
    queue_id, record.patient_id, req.user.id, departmentId,
    symptoms, diagnosis, prescription, notes
  );
  
  db.prepare(`
    UPDATE queue_records 
    SET status = 'completed', consultation_ended_at = ?
    WHERE id = ?
  `).run(now, queue_id);
  
  logAudit(req.user.id, 'complete_consultation', 'queue_record', queue_id, 
    { patient_id: record.patient_id, queue_number: record.queue_number, diagnosis }, req.ip);
  
  res.json({
    consultation_id: consultResult.lastInsertRowid,
    message: '接诊完成'
  });
});

router.get('/history', (req, res) => {
  const departmentId = req.user.department_id;
  const { date } = req.query;
  const queryDate = date || new Date().toISOString().split('T')[0];
  
  const records = db.prepare(`
    SELECT cr.*, qr.queue_number, p.name as patient_name, p.id_card,
           qr.consultation_started_at, qr.consultation_ended_at
    FROM consultation_records cr
    JOIN queue_records qr ON cr.queue_record_id = qr.id
    JOIN patients p ON cr.patient_id = p.id
    WHERE cr.doctor_id = ? AND cr.department_id = ? AND DATE(cr.created_at) = ?
    ORDER BY cr.created_at DESC
  `).all(req.user.id, departmentId, queryDate);
  
  res.json(records);
});

router.post('/followup', (req, res) => {
  const result = createFollowupPlan(req.body, req.user.id, req.ip);
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

router.post('/exam/orders', (req, res) => {
  const data = { ...req.body, department_id: req.user.department_id };
  const result = createExamOrder(data, req.user.id, req.ip);
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

router.post('/exam/reschedule', (req, res) => {
  const result = requestReschedule(req.body, req.user.id, req.user.role, req.ip);
  if (!result.success) {
    const statusCode = result.code || 400;
    return res.status(statusCode).json(result);
  }
  res.json(result);
});

router.post('/exam/reschedule/:id/cancel', (req, res) => {
  const result = cancelRescheduleRequest(parseInt(req.params.id), req.user.id, req.user.role, req.ip);
  if (!result.success) {
    const statusCode = result.code || 400;
    return res.status(statusCode).json(result);
  }
  res.json(result);
});

router.post('/exam/waitlist', (req, res) => {
  const result = addToWaitlist(req.body, req.user.id, req.user.role, req.ip);
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
