const express = require('express');
const db = require('../db');
const {
  createSandboxTask, precheckSandboxTask, practiceSandboxTask,
  revertSandboxRecord, voidSandboxTask, reimportSandboxTask,
  submitSandboxTask, getSandboxTaskDetail, listSandboxTasks,
  generateSandboxReportCSV
} = require('../utils/sandboxImport');

const router = express.Router();

router.post('/tasks', (req, res) => {
  const result = createSandboxTask(req.body, req.user.id, req.ip);
  if (!result.success) return res.status(400).json(result);
  res.json(result);
});

router.get('/tasks', (req, res) => {
  const result = listSandboxTasks(req.query, req.user.id, req.user.role);
  if (!result.success) return res.status(400).json(result);
  res.json(result);
});

router.get('/tasks/:id', (req, res) => {
  const result = getSandboxTaskDetail(parseInt(req.params.id), req.user.id, req.user.role);
  if (!result.success) {
    if (result.error === '无权查看此任务') return res.status(403).json(result);
    if (result.error === '沙箱任务不存在') return res.status(404).json(result);
    return res.status(400).json(result);
  }
  res.json(result.task);
});

router.post('/tasks/:id/precheck', (req, res) => {
  const { csv_text } = req.body;
  const task = db.prepare('SELECT * FROM sandbox_tasks WHERE id = ?').get(parseInt(req.params.id));
  if (!task) return res.status(404).json({ success: false, error: '沙箱任务不存在' });
  if (task.created_by !== req.user.id && req.user.role !== 'admin') {
    return res.status(403).json({ success: false, error: '无权操作此任务' });
  }
  const result = precheckSandboxTask(parseInt(req.params.id), csv_text, req.user.id, req.ip);
  if (!result.success) return res.status(400).json(result);
  res.json(result);
});

router.post('/tasks/:id/practice', (req, res) => {
  const task = db.prepare('SELECT * FROM sandbox_tasks WHERE id = ?').get(parseInt(req.params.id));
  if (!task) return res.status(404).json({ success: false, error: '沙箱任务不存在' });
  if (task.created_by !== req.user.id && req.user.role !== 'admin') {
    return res.status(403).json({ success: false, error: '无权操作此任务' });
  }
  const result = practiceSandboxTask(parseInt(req.params.id), req.user.id, req.ip);
  if (!result.success) return res.status(400).json(result);
  res.json(result);
});

router.post('/tasks/:id/records/:recordId/revert', (req, res) => {
  const { reason } = req.body;
  const task = db.prepare('SELECT * FROM sandbox_tasks WHERE id = ?').get(parseInt(req.params.id));
  if (!task) return res.status(404).json({ success: false, error: '沙箱任务不存在' });
  if (task.created_by !== req.user.id && req.user.role !== 'admin') {
    return res.status(403).json({ success: false, error: '无权操作此任务' });
  }
  const result = revertSandboxRecord(parseInt(req.params.id), parseInt(req.params.recordId), req.user.id, req.ip, reason);
  if (!result.success) return res.status(400).json(result);
  res.json(result);
});

router.post('/tasks/:id/void', (req, res) => {
  const { reason } = req.body;
  const task = db.prepare('SELECT * FROM sandbox_tasks WHERE id = ?').get(parseInt(req.params.id));
  if (!task) return res.status(404).json({ success: false, error: '沙箱任务不存在' });
  if (task.created_by !== req.user.id && req.user.role !== 'admin') {
    return res.status(403).json({ success: false, error: '无权操作此任务' });
  }
  const result = voidSandboxTask(parseInt(req.params.id), req.user.id, req.ip, reason);
  if (!result.success) return res.status(400).json(result);
  res.json(result);
});

router.post('/tasks/:id/reimport', (req, res) => {
  const task = db.prepare('SELECT * FROM sandbox_tasks WHERE id = ?').get(parseInt(req.params.id));
  if (!task) return res.status(404).json({ success: false, error: '沙箱任务不存在' });
  if (task.created_by !== req.user.id && req.user.role !== 'admin') {
    return res.status(403).json({ success: false, error: '无权操作此任务' });
  }
  const result = reimportSandboxTask(parseInt(req.params.id), req.user.id, req.ip);
  if (!result.success) return res.status(400).json(result);
  res.json(result);
});

router.post('/tasks/:id/submit', (req, res) => {
  const task = db.prepare('SELECT * FROM sandbox_tasks WHERE id = ?').get(parseInt(req.params.id));
  if (!task) return res.status(404).json({ success: false, error: '沙箱任务不存在' });
  if (task.created_by !== req.user.id && req.user.role !== 'admin') {
    return res.status(403).json({ success: false, error: '无权操作此任务' });
  }
  const result = submitSandboxTask(parseInt(req.params.id), req.user.id, req.ip);
  if (!result.success) return res.status(400).json(result);
  res.json(result);
});

router.get('/tasks/:id/export', (req, res) => {
  const task = db.prepare('SELECT * FROM sandbox_tasks WHERE id = ?').get(parseInt(req.params.id));
  if (!task) return res.status(404).json({ success: false, error: '沙箱任务不存在' });
  if (task.created_by !== req.user.id && req.user.role !== 'admin') {
    return res.status(403).json({ success: false, error: '无权操作此任务' });
  }
  const result = generateSandboxReportCSV(parseInt(req.params.id));
  if (!result.success) return res.status(400).json(result);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="sandbox-${result.task_no || req.params.id}.csv"`);
  res.send('\uFEFF' + result.csv);
});

module.exports = router;
