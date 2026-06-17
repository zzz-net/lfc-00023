const express = require('express');
const db = require('../db');

const router = express.Router();

router.get('/queue/status/:department_id', (req, res) => {
  const { department_id } = req.params;
  const { date } = req.query;
  const queueDate = date || new Date().toISOString().split('T')[0];
  
  const queue = db.prepare(`
    SELECT qr.id, qr.queue_number, qr.status, qr.type, qr.called_at,
           p.name as patient_name, d.name as department_name
    FROM queue_records qr
    JOIN patients p ON qr.patient_id = p.id
    JOIN departments d ON qr.department_id = d.id
    WHERE qr.department_id = ? AND qr.queue_date = ?
    ORDER BY 
      CASE qr.status 
        WHEN 'consulting' THEN 1 
        WHEN 'called' THEN 2 
        WHEN 'waiting' THEN 3 
        WHEN 'missed' THEN 4
        ELSE 5 
      END,
      qr.queue_number
  `).all(department_id, queueDate);
  
  const stats = db.prepare(`
    SELECT 
      status,
      COUNT(*) as count
    FROM queue_records
    WHERE department_id = ? AND queue_date = ?
    GROUP BY status
  `).all(department_id, queueDate);
  
  const result = {
    waiting: 0, called: 0, consulting: 0, completed: 0, missed: 0, returned: 0, total: 0
  };
  stats.forEach(s => { result[s.status] = s.count; result.total += s.count; });
  
  res.json({
    queue,
    stats: result
  });
});

router.get('/queue/display/:department_id', (req, res) => {
  const { department_id } = req.params;
  const today = new Date().toISOString().split('T')[0];
  
  const current = db.prepare(`
    SELECT qr.queue_number, p.name as patient_name
    FROM queue_records qr
    JOIN patients p ON qr.patient_id = p.id
    WHERE qr.department_id = ? AND qr.queue_date = ? AND qr.status = 'consulting'
    ORDER BY qr.queue_number
    LIMIT 1
  `).get(department_id, today);
  
  const next = db.prepare(`
    SELECT qr.queue_number, p.name as patient_name
    FROM queue_records qr
    JOIN patients p ON qr.patient_id = p.id
    WHERE qr.department_id = ? AND qr.queue_date = ? AND qr.status = 'waiting'
    ORDER BY qr.queue_number
    LIMIT 3
  `).all(department_id, today);
  
  const lastCalled = db.prepare(`
    SELECT qr.queue_number, p.name as patient_name
    FROM queue_records qr
    JOIN patients p ON qr.patient_id = p.id
    WHERE qr.department_id = ? AND qr.queue_date = ? AND qr.status = 'called'
    ORDER BY qr.called_at DESC
    LIMIT 1
  `).get(department_id, today);
  
  res.json({
    current: current || null,
    last_called: lastCalled || null,
    next_waiting: next
  });
});

router.get('/audit-logs', (req, res) => {
  const { page = 1, pageSize = 50, action, user_id, start_date, end_date } = req.query;
  
  let sql = `
    SELECT al.*, u.name as user_name
    FROM audit_logs al
    LEFT JOIN users u ON al.user_id = u.id
    WHERE 1=1
  `;
  const params = [];
  
  if (action) {
    sql += ' AND al.action = ?';
    params.push(action);
  }
  if (user_id) {
    sql += ' AND al.user_id = ?';
    params.push(user_id);
  }
  if (start_date) {
    sql += ' AND DATE(al.created_at) >= ?';
    params.push(start_date);
  }
  if (end_date) {
    sql += ' AND DATE(al.created_at) <= ?';
    params.push(end_date);
  }
  
  sql += ' ORDER BY al.created_at DESC LIMIT ? OFFSET ?';
  params.push(parseInt(pageSize), (parseInt(page) - 1) * parseInt(pageSize));
  
  const logs = db.prepare(sql).all(...params);
  
  logs.forEach(log => {
    try {
      log.details = JSON.parse(log.details);
    } catch (e) {}
  });
  
  let countSql = `
    SELECT COUNT(*) as total FROM audit_logs al WHERE 1=1
  `;
  const countParams = [];
  if (action) { countParams.push(action); countSql += ' AND al.action = ?'; }
  if (user_id) { countParams.push(user_id); countSql += ' AND al.user_id = ?'; }
  if (start_date) { countParams.push(start_date); countSql += ' AND DATE(al.created_at) >= ?'; }
  if (end_date) { countParams.push(end_date); countSql += ' AND DATE(al.created_at) <= ?'; }
  
  const { total } = db.prepare(countSql).get(...countParams);
  
  res.json({
    logs,
    pagination: { page: parseInt(page), pageSize: parseInt(pageSize), total }
  });
});

router.get('/reports/daily', (req, res) => {
  const { date } = req.query;
  const reportDate = date || new Date().toISOString().split('T')[0];
  
  const data = db.prepare(`
    SELECT 
      d.id as department_id,
      d.name as department_name,
      ds.total_slots,
      ds.walkin_limit,
      COUNT(CASE WHEN qr.type = 'appointment' AND qr.status != 'returned' THEN 1 END) as appointment_count,
      COUNT(CASE WHEN qr.type = 'walkin' AND qr.status != 'returned' THEN 1 END) as walkin_count,
      COUNT(CASE WHEN qr.status = 'waiting' THEN 1 END) as waiting_count,
      COUNT(CASE WHEN qr.status = 'called' THEN 1 END) as called_count,
      COUNT(CASE WHEN qr.status = 'consulting' THEN 1 END) as consulting_count,
      COUNT(CASE WHEN qr.status = 'completed' THEN 1 END) as completed_count,
      COUNT(CASE WHEN qr.status = 'missed' THEN 1 END) as missed_count,
      COUNT(CASE WHEN qr.status = 'returned' THEN 1 END) as returned_count,
      COUNT(CASE WHEN qr.status != 'returned' THEN 1 END) as total_patients
    FROM departments d
    LEFT JOIN daily_slots ds ON d.id = ds.department_id AND ds.date = ?
    LEFT JOIN queue_records qr ON d.id = qr.department_id AND qr.queue_date = ?
    WHERE d.is_active = 1
    GROUP BY d.id, d.name, ds.total_slots, ds.walkin_limit
    ORDER BY d.id
  `).all(reportDate, reportDate);
  
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="daily-report-${reportDate}.json"`);
  
  res.json({
    date: reportDate,
    generated_at: new Date().toISOString(),
    departments: data,
    summary: {
      total_departments: data.length,
      total_patients: data.reduce((sum, d) => sum + d.total_patients, 0),
      total_completed: data.reduce((sum, d) => sum + d.completed_count, 0),
      total_missed: data.reduce((sum, d) => sum + d.missed_count, 0)
    }
  });
});

router.get('/reports/daily/csv', (req, res) => {
  const { date } = req.query;
  const reportDate = date || new Date().toISOString().split('T')[0];
  
  const data = db.prepare(`
    SELECT 
      d.id as department_id,
      d.name as department_name,
      ds.total_slots,
      ds.walkin_limit,
      COUNT(CASE WHEN qr.type = 'appointment' AND qr.status != 'returned' THEN 1 END) as appointment_count,
      COUNT(CASE WHEN qr.type = 'walkin' AND qr.status != 'returned' THEN 1 END) as walkin_count,
      COUNT(CASE WHEN qr.status = 'waiting' THEN 1 END) as waiting_count,
      COUNT(CASE WHEN qr.status = 'called' THEN 1 END) as called_count,
      COUNT(CASE WHEN qr.status = 'consulting' THEN 1 END) as consulting_count,
      COUNT(CASE WHEN qr.status = 'completed' THEN 1 END) as completed_count,
      COUNT(CASE WHEN qr.status = 'missed' THEN 1 END) as missed_count,
      COUNT(CASE WHEN qr.status = 'returned' THEN 1 END) as returned_count,
      COUNT(CASE WHEN qr.status != 'returned' THEN 1 END) as total_patients
    FROM departments d
    LEFT JOIN daily_slots ds ON d.id = ds.department_id AND ds.date = ?
    LEFT JOIN queue_records qr ON d.id = qr.department_id AND qr.queue_date = ?
    WHERE d.is_active = 1
    GROUP BY d.id, d.name, ds.total_slots, ds.walkin_limit
    ORDER BY d.id
  `).all(reportDate, reportDate);
  
  const headers = ['科室ID', '科室名称', '总号源', '现场加号上限', '预约数', '现场加号数', 
                   '等待中', '已叫号', '就诊中', '已完成', '过号数', '退回数', '总接诊数'];
  const rows = data.map(d => [
    d.department_id, d.department_name, d.total_slots || 0, d.walkin_limit || 0,
    d.appointment_count, d.walkin_count, d.waiting_count, d.called_count,
    d.consulting_count, d.completed_count, d.missed_count, d.returned_count, d.total_patients
  ]);
  
  const csv = [headers, ...rows].map(row => row.join(',')).join('\n');
  
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="daily-report-${reportDate}.csv"`);
  res.send('\uFEFF' + csv);
});

router.get('/departments', (req, res) => {
  const depts = db.prepare('SELECT id, name, code, description, is_active FROM departments WHERE is_active = 1 ORDER BY id').all();
  res.json(depts);
});

module.exports = router;
