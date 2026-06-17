const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db');
const { logAudit } = require('../utils/audit');

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

module.exports = router;
