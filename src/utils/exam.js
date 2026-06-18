const db = require('../db');

function generateOrderNo() {
  return 'EX' + Date.now() + Math.floor(Math.random() * 1000);
}

function generateRequestNo() {
  return 'RS' + Date.now() + Math.floor(Math.random() * 1000);
}

function logChange(examOrderId, changeType, fromStatus, toStatus, fromSlotId, toSlotId, details, userId, ip) {
  const stmt = db.prepare(`
    INSERT INTO exam_change_logs 
    (exam_order_id, change_type, from_status, to_status, from_slot_id, to_slot_id, details, performed_by, ip_address)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  stmt.run(
    examOrderId, changeType, fromStatus, toStatus,
    fromSlotId, toSlotId,
    JSON.stringify(details || {}),
    userId, ip || null
  );
}

function sendNotification(userId, patientId, examOrderId, type, title, content) {
  const stmt = db.prepare(`
    INSERT INTO exam_notifications (user_id, patient_id, exam_order_id, type, title, content)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  stmt.run(userId || null, patientId || null, examOrderId || null, type, title, content);
}

function getExamTypeName(typeId) {
  const t = db.prepare('SELECT name FROM exam_types WHERE id = ?').get(typeId);
  return t ? t.name : '检查';
}

function aliasOrder(o) {
  if (!o) return o;
  const r = { ...o };
  if ('urgency' in r) r.priority = r.urgency;
  if ('scheduled_slot_id' in r) r.slot_id = r.scheduled_slot_id;
  return r;
}

function aliasRequest(r) {
  if (!r) return r;
  return r;
}

function aliasWaitlist(w) {
  if (!w) return w;
  return w;
}

function aliasConfig(c) {
  if (!c) return c;
  const r = { ...c };
  if ('config_key' in r) r.key = r.config_key;
  if ('config_value' in r) r.value = r.config_value;
  return r;
}

function getConfig(key, defaultValue) {
  const row = db.prepare('SELECT config_value FROM exam_configs WHERE config_key = ?').get(key);
  return row ? row.config_value : (defaultValue === undefined ? null : defaultValue);
}

function setConfig(key, value, description, userId) {
  const stmt = db.prepare(`
    INSERT INTO exam_configs (config_key, config_value, description, updated_by, updated_at)
    VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(config_key) DO UPDATE SET
      config_value = excluded.config_value,
      description = excluded.description,
      updated_by = excluded.updated_by,
      updated_at = CURRENT_TIMESTAMP
  `);
  stmt.run(key, String(value), description || null, userId || null);
}

function safeParse(s) {
  try { return s ? JSON.parse(s) : {}; } catch (_) { return { raw: s }; }
}

function getOrCreatePatient(data) {
  if (data.patient_id) {
    const p = db.prepare('SELECT * FROM patients WHERE id = ?').get(data.patient_id);
    if (p) return p;
  }
  if (data.patient_id_card) {
    const p = db.prepare('SELECT * FROM patients WHERE id_card = ?').get(data.patient_id_card);
    if (p) return p;
  }
  if (data.patient_name && data.patient_id_card) {
    const stmt = db.prepare(`
      INSERT INTO patients (name, id_card, gender, age, phone)
      VALUES (?, ?, ?, ?, ?)
    `);
    const r = stmt.run(
      data.patient_name,
      data.patient_id_card,
      data.patient_gender || null,
      data.patient_age || null,
      data.patient_phone || null
    );
    return { id: r.lastInsertRowid };
  }
  return null;
}

function listExamTypes() {
  try {
    const rows = db.prepare('SELECT * FROM exam_types WHERE is_active = 1 ORDER BY name').all();
    return { success: true, types: rows };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

function listExamSlots(query) {
  try {
    const q = query || {};
    let sql = `
      SELECT s.*, t.name AS exam_type_name, t.code AS exam_type_code
      FROM exam_slots s
      LEFT JOIN exam_types t ON s.exam_type_id = t.id
      WHERE 1=1
    `;
    const params = [];
    if (q.exam_type_id) { sql += ' AND s.exam_type_id = ?'; params.push(parseInt(q.exam_type_id)); }
    if (q.date) { sql += ' AND s.date = ?'; params.push(q.date); }
    if (q.status) { sql += ' AND s.status = ?'; params.push(q.status); }
    sql += ' ORDER BY s.date, s.start_time';
    const rows = db.prepare(sql).all(...params).map(function (r) {
      const bc = r.booked_count || 0;
      const tc = r.total_capacity || 0;
      return Object.assign({}, r, {
        booked_count: bc,
        remaining_count: Math.max(0, tc - bc)
      });
    });
    return { success: true, slots: rows };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

function createExamOrder(data, userId, ip) {
  const patient = getOrCreatePatient(data);
  if (!patient) return { success: false, error: '患者信息不完整（需要姓名和身份证号或患者ID）' };
  const examTypeId = data.exam_type_id;
  if (!examTypeId) return { success: false, error: '检查类型ID不能为空' };
  const examType = db.prepare('SELECT * FROM exam_types WHERE id = ? AND is_active = 1').get(examTypeId);
  if (!examType) return { success: false, error: '检查类型不存在或未启用' };
  const urgency = data.urgency || data.priority || 'normal';
  const clinicalIndication = data.clinical_indication || data.clinical_diagnosis || null;
  const orderNo = generateOrderNo();
  const departmentId = data.department_id || examType.department_id;
  try {
    const stmt = db.prepare(`
      INSERT INTO exam_orders
      (order_no, patient_id, exam_type_id, department_id,
       consultation_record_id, queue_record_id, ordered_by,
       clinical_indication, urgency, notes, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')
    `);
    const result = stmt.run(
      orderNo, patient.id, examTypeId, departmentId,
      data.consultation_record_id || null,
      data.queue_record_id || null,
      userId,
      clinicalIndication,
      urgency,
      data.notes || null
    );
    const orderId = result.lastInsertRowid;
    logChange(orderId, 'create', null, 'pending', null, null,
      { order_no: orderNo, exam_type: examType.name,
        patient_name: data.patient_name || patient.name, urgency }, userId, ip);
    const fullOrder = db.prepare('SELECT * FROM exam_orders WHERE id = ?').get(orderId);
    return { success: true, order: aliasOrder(fullOrder) };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

function scheduleExamOrder(orderId, slotId, userId, role, ip) {
  const order = db.prepare('SELECT * FROM exam_orders WHERE id = ?').get(orderId);
  if (!order) return { success: false, error: '检查单不存在', code: 404 };
  if (role === 'doctor' && order.ordered_by !== userId) {
    return { success: false, error: '无权操作其他医生的检查单', code: 403 };
  }
  if (['cancelled', 'completed', 'rejected'].indexOf(order.status) >= 0) {
    return { success: false, error: '当前状态' + order.status + '不能预约' };
  }
  const slot = db.prepare('SELECT * FROM exam_slots WHERE id = ?').get(slotId);
  if (!slot) return { success: false, error: '时段不存在', code: 404 };
  if (slot.exam_type_id !== order.exam_type_id) {
    return { success: false, error: '时段与检查类型不匹配' };
  }
  if (slot.status !== 'available') {
    return { success: false, error: '该时段不可预约' };
  }
  if (slot.booked_count >= slot.total_capacity) {
    return { success: false, error: '该时段已满，可加入候补队列' };
  }
  const oldSlotId = order.scheduled_slot_id;
  const oldStatus = order.status;
  const tx = db.transaction(function () {
    db.prepare(`
      UPDATE exam_orders SET status = 'scheduled', scheduled_slot_id = ?,
        updated_at = CURRENT_TIMESTAMP WHERE id = ?
    `).run(slotId, orderId);
    db.prepare(`
      UPDATE exam_slots SET booked_count = booked_count + 1,
        status = CASE WHEN booked_count + 1 >= total_capacity THEN 'full' ELSE 'available' END,
        updated_at = CURRENT_TIMESTAMP WHERE id = ?
    `).run(slotId);
    if (oldSlotId && oldSlotId !== slotId) {
      db.prepare(`
        UPDATE exam_slots SET booked_count = MAX(0, booked_count - 1),
          status = CASE WHEN MAX(0, booked_count - 1) < total_capacity THEN 'available' ELSE status END,
          updated_at = CURRENT_TIMESTAMP WHERE id = ?
      `).run(oldSlotId);
    }
  });
  try {
    tx();
    logChange(orderId, 'schedule', oldStatus, 'scheduled', oldSlotId, slotId,
      { slot_date: slot.date, start_time: slot.start_time }, userId, ip);
    sendNotification(null, order.patient_id, orderId, 'schedule_confirm',
      '检查预约成功',
      '您的' + getExamTypeName(order.exam_type_id) + '检查已预约到' + slot.date + ' ' + slot.start_time);
    const fullOrder = db.prepare('SELECT * FROM exam_orders WHERE id = ?').get(orderId);
    return { success: true, order: aliasOrder(fullOrder) };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

function requestReschedule(data, userId, role, ip) {
  const examOrderId = data.exam_order_id;
  const requestedStartDate = data.requested_start_date || data.desired_start_date;
  const requestedEndDate = data.requested_end_date || data.desired_end_date;
  const preferredTime = data.preferred_time || data.desired_time_preference || null;
  const reason = data.reason;
  const remarks = data.remarks || data.notes || null;
  const newPriority = data.new_priority;
  if (!examOrderId || !requestedStartDate || !requestedEndDate || !reason) {
    return { success: false, error: '检查单ID、改约日期范围和原因为必填' };
  }
  const order = db.prepare('SELECT * FROM exam_orders WHERE id = ?').get(examOrderId);
  if (!order) return { success: false, error: '检查单不存在', code: 404 };
  if (role === 'doctor' && order.ordered_by !== userId) {
    return { success: false, error: '无权操作其他医生的检查单', code: 403 };
  }
  if (order.status !== 'scheduled') {
    return { success: false, error: '当前状态' + order.status + '不能申请改约' };
  }
  if (!order.scheduled_slot_id) {
    return { success: false, error: '检查单尚未预约时段' };
  }
  const requestNo = generateRequestNo();
  try {
    const stmt = db.prepare(`
      INSERT INTO exam_reschedule_requests
      (request_no, exam_order_id, patient_id, exam_type_id, original_slot_id,
       requested_start_date, requested_end_date, preferred_time, reason, remarks,
       status, requested_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)
    `);
    const result = stmt.run(
      requestNo, examOrderId, order.patient_id, order.exam_type_id, order.scheduled_slot_id,
      requestedStartDate, requestedEndDate, preferredTime, reason, remarks, userId
    );
    const reqId = result.lastInsertRowid;
    db.prepare('UPDATE exam_orders SET status = \'rescheduling\', updated_at = CURRENT_TIMESTAMP WHERE id = ?')
      .run(examOrderId);
    if (newPriority && order.urgency !== newPriority) {
      db.prepare('UPDATE exam_orders SET urgency = ? WHERE id = ?').run(newPriority, examOrderId);
    }
    logChange(examOrderId, 'reschedule_request', 'scheduled', 'rescheduling',
      order.scheduled_slot_id, null,
      { request_no: requestNo, requested_start_date: requestedStartDate,
        requested_end_date: requestedEndDate, reason: reason,
        old_urgency: order.urgency, new_priority: newPriority },
      userId, ip);
    sendNotification(null, order.patient_id, examOrderId, 'reschedule_request',
      '改约申请已提交',
      '您的' + getExamTypeName(order.exam_type_id) + '改约申请已提交，等待审核');
    const fullReq = db.prepare('SELECT * FROM exam_reschedule_requests WHERE id = ?').get(reqId);
    return { success: true, request: aliasRequest(fullReq) };
  } catch (e) {
    if (e.message && e.message.indexOf('UNIQUE') >= 0 && e.message.indexOf('idx_reschedule_active') >= 0) {
      return { success: false, error: '该检查单已有待处理的改约申请，请先取消或等待处理' };
    }
    return { success: false, error: e.message };
  }
}

function approveReschedule(requestId, userId, role, ip, newSlotId, reviewNotes) {
  if (role !== 'admin' && role !== 'nurse') {
    return { success: false, error: '无权审核改约申请', code: 403 };
  }
  const req = db.prepare('SELECT * FROM exam_reschedule_requests WHERE id = ?').get(requestId);
  if (!req) return { success: false, error: '改约申请不存在', code: 404 };
  if (req.status !== 'pending') {
    return { success: false, error: '该申请状态' + req.status + '不能审核' };
  }
  if (!newSlotId) return { success: false, error: '请选择新时段' };
  const order = db.prepare('SELECT * FROM exam_orders WHERE id = ?').get(req.exam_order_id);
  if (!order) return { success: false, error: '检查单不存在', code: 404 };
  const newSlot = db.prepare('SELECT * FROM exam_slots WHERE id = ?').get(newSlotId);
  if (!newSlot) return { success: false, error: '新时段不存在', code: 404 };
  if (newSlot.exam_type_id !== req.exam_type_id) {
    return { success: false, error: '新时段与检查类型不匹配' };
  }
  if (newSlot.status !== 'available' || newSlot.booked_count >= newSlot.total_capacity) {
    return { success: false, error: '新时段已满或不可用' };
  }
  const oldSlotId = req.original_slot_id;
  const tx = db.transaction(function () {
    db.prepare(`
      UPDATE exam_reschedule_requests SET
        status = 'approved', reviewed_by = ?, reviewed_at = CURRENT_TIMESTAMP,
        review_notes = ?, new_slot_id = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(userId, reviewNotes || null, newSlotId, requestId);
    db.prepare(`
      UPDATE exam_orders SET status = 'scheduled', scheduled_slot_id = ?,
        updated_at = CURRENT_TIMESTAMP WHERE id = ?
    `).run(newSlotId, req.exam_order_id);
    db.prepare(`
      UPDATE exam_slots SET booked_count = booked_count + 1,
        status = CASE WHEN booked_count + 1 >= total_capacity THEN 'full' ELSE 'available' END,
        updated_at = CURRENT_TIMESTAMP WHERE id = ?
    `).run(newSlotId);
    if (oldSlotId) {
      db.prepare(`
        UPDATE exam_slots SET booked_count = MAX(0, booked_count - 1),
          status = CASE WHEN MAX(0, booked_count - 1) < total_capacity THEN 'available' ELSE status END,
          updated_at = CURRENT_TIMESTAMP WHERE id = ?
      `).run(oldSlotId);
    }
  });
  try {
    tx();
    logChange(req.exam_order_id, 'reschedule_approve', 'rescheduling', 'scheduled',
      oldSlotId, newSlotId,
      { request_no: req.request_no, new_date: newSlot.date,
        new_start_time: newSlot.start_time, review_notes: reviewNotes || null },
      userId, ip);
    sendNotification(null, order.patient_id, req.exam_order_id, 'reschedule_approved',
      '改约申请已通过',
      '您的' + getExamTypeName(req.exam_type_id) + '改约已通过，新时间：' + newSlot.date + ' ' + newSlot.start_time);
    if (oldSlotId) tryPromoteWaitlistForSlot(oldSlotId, userId, ip);
    const fullOrder = db.prepare('SELECT * FROM exam_orders WHERE id = ?').get(req.exam_order_id);
    const fullReq = db.prepare('SELECT * FROM exam_reschedule_requests WHERE id = ?').get(requestId);
    return { success: true, order: aliasOrder(fullOrder), request: aliasRequest(fullReq) };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

function rejectReschedule(requestId, userId, role, ip, reviewNotes) {
  if (role !== 'admin' && role !== 'nurse') {
    return { success: false, error: '无权审核改约申请', code: 403 };
  }
  const req = db.prepare('SELECT * FROM exam_reschedule_requests WHERE id = ?').get(requestId);
  if (!req) return { success: false, error: '改约申请不存在', code: 404 };
  if (req.status !== 'pending') {
    return { success: false, error: '该申请状态' + req.status + '不能审核' };
  }
  const order = db.prepare('SELECT * FROM exam_orders WHERE id = ?').get(req.exam_order_id);
  if (!order) return { success: false, error: '检查单不存在', code: 404 };
  const tx = db.transaction(function () {
    db.prepare(`
      UPDATE exam_reschedule_requests SET
        status = 'rejected', reviewed_by = ?, reviewed_at = CURRENT_TIMESTAMP,
        review_notes = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(userId, reviewNotes || null, requestId);
    db.prepare('UPDATE exam_orders SET status = \'scheduled\', updated_at = CURRENT_TIMESTAMP WHERE id = ?')
      .run(req.exam_order_id);
  });
  try {
    tx();
    logChange(req.exam_order_id, 'reschedule_reject', 'rescheduling', 'scheduled',
      req.original_slot_id, null,
      { request_no: req.request_no, review_notes: reviewNotes || null }, userId, ip);
    sendNotification(null, order.patient_id, req.exam_order_id, 'reschedule_rejected',
      '改约申请被驳回',
      '您的' + getExamTypeName(req.exam_type_id) + '改约申请被驳回：' + (reviewNotes || '原因未说明'));
    const fullOrder = db.prepare('SELECT * FROM exam_orders WHERE id = ?').get(req.exam_order_id);
    const fullReq = db.prepare('SELECT * FROM exam_reschedule_requests WHERE id = ?').get(requestId);
    return { success: true, order: aliasOrder(fullOrder), request: aliasRequest(fullReq) };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

function cancelRescheduleRequest(requestId, userId, role, ip) {
  const req = db.prepare('SELECT * FROM exam_reschedule_requests WHERE id = ?').get(requestId);
  if (!req) return { success: false, error: '改约申请不存在', code: 404 };
  if (req.status !== 'pending') {
    return { success: false, error: '该申请状态' + req.status + '不能取消' };
  }
  const order = db.prepare('SELECT * FROM exam_orders WHERE id = ?').get(req.exam_order_id);
  if (!order) return { success: false, error: '检查单不存在', code: 404 };
  if (role === 'doctor' && order.ordered_by !== userId) {
    return { success: false, error: '无权操作其他医生的检查单', code: 403 };
  }
  if (role !== 'admin' && role !== 'nurse' && order.ordered_by !== userId) {
    return { success: false, error: '无权操作', code: 403 };
  }
  const tx = db.transaction(function () {
    db.prepare('UPDATE exam_reschedule_requests SET status = \'cancelled\', updated_at = CURRENT_TIMESTAMP WHERE id = ?')
      .run(requestId);
    db.prepare('UPDATE exam_orders SET status = \'scheduled\', updated_at = CURRENT_TIMESTAMP WHERE id = ?')
      .run(req.exam_order_id);
  });
  try {
    tx();
    logChange(req.exam_order_id, 'reschedule_cancel', 'rescheduling', 'scheduled',
      req.original_slot_id, null, { request_no: req.request_no }, userId, ip);
    const fullOrder = db.prepare('SELECT * FROM exam_orders WHERE id = ?').get(req.exam_order_id);
    const fullReq = db.prepare('SELECT * FROM exam_reschedule_requests WHERE id = ?').get(requestId);
    return { success: true, order: aliasOrder(fullOrder), request: aliasRequest(fullReq) };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

function revertReschedule(requestId, userId, role, ip, revertReason) {
  if (role !== 'admin' && role !== 'nurse') {
    return { success: false, error: '无权撤回改约审核', code: 403 };
  }
  const req = db.prepare('SELECT * FROM exam_reschedule_requests WHERE id = ?').get(requestId);
  if (!req) return { success: false, error: '改约申请不存在', code: 404 };
  if (req.status !== 'approved') {
    return { success: false, error: '只有已通过(approved)的改约才能撤回，当前状态' + req.status };
  }
  const revertWindow = parseInt(getConfig('reschedule_revert_window_minutes', '30')) || 30;
  const reviewedAt = new Date(req.reviewed_at.replace(' ', 'T') + 'Z');
  const now = new Date();
  const diffMin = (now - reviewedAt) / (1000 * 60);
  if (diffMin > revertWindow) {
    return { success: false, error: '超过撤回时间窗口（' + revertWindow + '分钟）' };
  }
  const order = db.prepare('SELECT * FROM exam_orders WHERE id = ?').get(req.exam_order_id);
  if (!order) return { success: false, error: '检查单不存在', code: 404 };
  const oldSlot = db.prepare('SELECT * FROM exam_slots WHERE id = ?').get(req.original_slot_id);
  const newSlot = db.prepare('SELECT * FROM exam_slots WHERE id = ?').get(req.new_slot_id);
  if (!oldSlot || !newSlot) {
    return { success: false, error: '原时段或新时段不存在，无法撤回' };
  }
  const reqLog = db.prepare(`
    SELECT details FROM exam_change_logs WHERE exam_order_id = ? AND change_type = 'reschedule_request'
    ORDER BY created_at DESC LIMIT 1
  `).get(req.exam_order_id);
  let restoredUrgency = null;
  if (reqLog && reqLog.details) {
    try {
      const d = JSON.parse(reqLog.details);
      if (d.old_urgency) restoredUrgency = d.old_urgency;
    } catch (_) {}
  }
  const tx = db.transaction(function () {
    db.prepare(`
      UPDATE exam_reschedule_requests SET
        status = 'reverted', reverted_by = ?, reverted_at = CURRENT_TIMESTAMP,
        revert_reason = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(userId, revertReason || null, requestId);
    if (restoredUrgency) {
      db.prepare(`
        UPDATE exam_orders SET status = 'scheduled', scheduled_slot_id = ?,
          urgency = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?
      `).run(req.original_slot_id, restoredUrgency, req.exam_order_id);
    } else {
      db.prepare(`
        UPDATE exam_orders SET status = 'scheduled', scheduled_slot_id = ?,
          updated_at = CURRENT_TIMESTAMP WHERE id = ?
      `).run(req.original_slot_id, req.exam_order_id);
    }
    db.prepare(`
      UPDATE exam_slots SET booked_count = MAX(0, booked_count - 1),
        status = CASE WHEN MAX(0, booked_count - 1) < total_capacity THEN 'available' ELSE status END,
        updated_at = CURRENT_TIMESTAMP WHERE id = ?
    `).run(req.new_slot_id);
    db.prepare(`
      UPDATE exam_slots SET booked_count = booked_count + 1,
        status = CASE WHEN booked_count + 1 >= total_capacity THEN 'full' ELSE 'available' END,
        updated_at = CURRENT_TIMESTAMP WHERE id = ?
    `).run(req.original_slot_id);
  });
  try {
    tx();
    logChange(req.exam_order_id, 'reschedule_revert', 'scheduled', 'scheduled',
      req.new_slot_id, req.original_slot_id,
      { request_no: req.request_no, revert_reason: revertReason || null }, userId, ip);
    tryPromoteWaitlistForSlot(req.new_slot_id, userId, ip);
    const fullOrder = db.prepare('SELECT * FROM exam_orders WHERE id = ?').get(req.exam_order_id);
    const fullReq = db.prepare('SELECT * FROM exam_reschedule_requests WHERE id = ?').get(requestId);
    return { success: true, order: aliasOrder(fullOrder), request: aliasRequest(fullReq) };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

function addToWaitlist(data, userId, role, ip) {
  const examOrderId = data.exam_order_id;
  const examTypeId = data.exam_type_id;
  const targetDate = data.target_date;
  const preferredTime = data.preferred_time || data.time_preference || null;
  const priorityInput = data.priority;
  if (!examOrderId || !examTypeId || !targetDate) {
    return { success: false, error: '检查单ID、检查类型ID和目标日期为必填' };
  }
  const order = db.prepare('SELECT * FROM exam_orders WHERE id = ?').get(examOrderId);
  if (!order) return { success: false, error: '检查单不存在', code: 404 };
  if (role === 'doctor' && order.ordered_by !== userId) {
    return { success: false, error: '无权操作其他医生的检查单', code: 403 };
  }
  let priorityVal = 0;
  if (priorityInput !== undefined && priorityInput !== null && priorityInput !== '') {
    if (typeof priorityInput === 'number') {
      priorityVal = priorityInput;
    } else if (typeof priorityInput === 'string') {
      if (priorityInput === 'emergency') priorityVal = 2;
      else if (priorityInput === 'urgent') priorityVal = 1;
      else if (priorityInput === 'normal') priorityVal = 0;
      else {
        const pv = parseInt(priorityInput);
        if (!isNaN(pv)) priorityVal = pv;
      }
    }
  } else {
    if (order.urgency === 'emergency') priorityVal = 2;
    else if (order.urgency === 'urgent') priorityVal = 1;
  }
  try {
    const stmt = db.prepare(`
      INSERT INTO exam_waitlist
      (exam_order_id, patient_id, exam_type_id, target_date,
       preferred_time, priority, status, added_by)
      VALUES (?, ?, ?, ?, ?, ?, 'waiting', ?)
    `);
    const result = stmt.run(examOrderId, order.patient_id, examTypeId, targetDate, preferredTime, priorityVal, userId);
    const wlId = result.lastInsertRowid;
    logChange(examOrderId, 'waitlist_add', order.status, order.status, null, null,
      { waitlist_id: wlId, target_date: targetDate, priority: priorityVal,
        preferred_time: preferredTime }, userId, ip);
    const fullWL = db.prepare('SELECT * FROM exam_waitlist WHERE id = ?').get(wlId);
    return { success: true, waitlist: aliasWaitlist(fullWL) };
  } catch (e) {
    if (e.message && e.message.indexOf('UNIQUE') >= 0 && e.message.indexOf('idx_waitlist_active') >= 0) {
      return { success: false, error: '该检查单在该日期已有候补记录' };
    }
    return { success: false, error: e.message };
  }
}

function tryPromoteWaitlistForSlot(slotId, userId, ip) {
  const slot = db.prepare('SELECT * FROM exam_slots WHERE id = ?').get(slotId);
  if (!slot) return false;
  if (slot.booked_count >= slot.total_capacity) return false;
  const autoPromote = getConfig('waitlist_auto_promote', 'true') === 'true';
  if (!autoPromote) return false;
  const remaining = slot.total_capacity - slot.booked_count;
  if (remaining <= 0) return false;
  const promoteLimit = 1;
  const waiters = db.prepare(`
    SELECT w.* FROM exam_waitlist w
    WHERE w.exam_type_id = ? AND w.target_date = ? AND w.status = 'waiting'
    ORDER BY w.priority DESC, w.created_at ASC
    LIMIT ?
  `).all(slot.exam_type_id, slot.date, Math.min(remaining, promoteLimit));
  if (waiters.length === 0) return false;
  let promotedCount = 0;
  for (let i = 0; i < waiters.length; i++) {
    const w = waiters[i];
    const s = db.prepare('SELECT * FROM exam_slots WHERE id = ?').get(slotId);
    if (!s || s.booked_count >= s.total_capacity) break;
    const order = db.prepare('SELECT * FROM exam_orders WHERE id = ?').get(w.exam_order_id);
    if (!order) continue;
    if (order.status === 'completed' || order.status === 'cancelled') continue;
    try {
      const oldSlotId = order.scheduled_slot_id;
      const tx = db.transaction(function () {
        db.prepare(`
          UPDATE exam_waitlist SET
            status = 'promoted', promoted_by = ?, promoted_at = CURRENT_TIMESTAMP,
            promoted_slot_id = ?, updated_at = CURRENT_TIMESTAMP
          WHERE id = ?
        `).run(userId || null, slotId, w.id);
        db.prepare(`
          UPDATE exam_orders SET status = 'scheduled', scheduled_slot_id = ?,
            updated_at = CURRENT_TIMESTAMP WHERE id = ?
        `).run(slotId, w.exam_order_id);
        db.prepare(`
          UPDATE exam_slots SET booked_count = booked_count + 1,
            status = CASE WHEN booked_count + 1 >= total_capacity THEN 'full' ELSE 'available' END,
            updated_at = CURRENT_TIMESTAMP WHERE id = ?
        `).run(slotId);
        if (oldSlotId && oldSlotId !== slotId) {
          db.prepare(`
            UPDATE exam_slots SET booked_count = MAX(0, booked_count - 1),
              status = CASE WHEN MAX(0, booked_count - 1) < total_capacity THEN 'available' ELSE status END,
              updated_at = CURRENT_TIMESTAMP WHERE id = ?
          `).run(oldSlotId);
        }
      });
      tx();
      promotedCount++;
      logChange(w.exam_order_id, 'waitlist_promote', order.status, 'scheduled',
        oldSlotId, slotId,
        { waitlist_id: w.id, slot_date: slot.date, start_time: slot.start_time },
        userId || null, ip);
      sendNotification(null, w.patient_id, w.exam_order_id, 'waitlist_promoted',
        '候补转正成功',
        '您的' + getExamTypeName(w.exam_type_id) + '候补已安排到' + slot.date + ' ' + slot.start_time);
      if (oldSlotId && oldSlotId !== slotId) {
        tryPromoteWaitlistForSlot(oldSlotId, userId, ip);
      }
    } catch (e) {
      console.error('候补转正失败:', e.message);
    }
  }
  return promotedCount > 0;
}

function promoteWaitlist(waitlistId, userId, role, ip) {
  if (role !== 'admin' && role !== 'nurse') {
    return { success: false, error: '无权执行候补转正', code: 403 };
  }
  const w = db.prepare('SELECT * FROM exam_waitlist WHERE id = ?').get(waitlistId);
  if (!w) return { success: false, error: '候补记录不存在', code: 404 };
  if (w.status !== 'waiting') {
    return { success: false, error: '该候补状态' + w.status + '不能转正' };
  }
  const slots = db.prepare(`
    SELECT * FROM exam_slots
    WHERE exam_type_id = ? AND date = ? AND status = 'available'
      AND booked_count < total_capacity
    ORDER BY start_time ASC
  `).all(w.exam_type_id, w.target_date);
  if (slots.length === 0) return { success: false, error: '目标日期无可用时段' };
  const slot = slots[0];
  const order = db.prepare('SELECT * FROM exam_orders WHERE id = ?').get(w.exam_order_id);
  if (!order) return { success: false, error: '检查单不存在', code: 404 };
  const oldSlotId = order.scheduled_slot_id;
  const tx = db.transaction(function () {
    db.prepare(`
      UPDATE exam_waitlist SET
        status = 'promoted', promoted_by = ?, promoted_at = CURRENT_TIMESTAMP,
        promoted_slot_id = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(userId, slot.id, waitlistId);
    db.prepare(`
      UPDATE exam_orders SET status = 'scheduled', scheduled_slot_id = ?,
        updated_at = CURRENT_TIMESTAMP WHERE id = ?
    `).run(slot.id, w.exam_order_id);
    db.prepare(`
      UPDATE exam_slots SET booked_count = booked_count + 1,
        status = CASE WHEN booked_count + 1 >= total_capacity THEN 'full' ELSE 'available' END,
        updated_at = CURRENT_TIMESTAMP WHERE id = ?
    `).run(slot.id);
    if (oldSlotId && oldSlotId !== slot.id) {
      db.prepare(`
        UPDATE exam_slots SET booked_count = MAX(0, booked_count - 1),
          status = CASE WHEN MAX(0, booked_count - 1) < total_capacity THEN 'available' ELSE status END,
          updated_at = CURRENT_TIMESTAMP WHERE id = ?
      `).run(oldSlotId);
    }
  });
  try {
    tx();
    logChange(w.exam_order_id, 'waitlist_promote', order.status, 'scheduled',
      oldSlotId, slot.id,
      { waitlist_id: waitlistId, slot_date: slot.date, start_time: slot.start_time },
      userId, ip);
    sendNotification(null, w.patient_id, w.exam_order_id, 'waitlist_promoted',
      '候补转正成功',
      '您的' + getExamTypeName(w.exam_type_id) + '候补已安排到' + slot.date + ' ' + slot.start_time);
    if (oldSlotId && oldSlotId !== slot.id) {
      tryPromoteWaitlistForSlot(oldSlotId, userId, ip);
    }
    const fullOrder = db.prepare('SELECT * FROM exam_orders WHERE id = ?').get(w.exam_order_id);
    return { success: true, order: aliasOrder(fullOrder), slot_id: slot.id };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

function cancelWaitlist(waitlistId, userId, role, ip, cancelReason) {
  const w = db.prepare('SELECT * FROM exam_waitlist WHERE id = ?').get(waitlistId);
  if (!w) return { success: false, error: '候补记录不存在', code: 404 };
  if (w.status !== 'waiting') {
    return { success: false, error: '该候补状态' + w.status + '不能取消' };
  }
  const order = db.prepare('SELECT * FROM exam_orders WHERE id = ?').get(w.exam_order_id);
  if (!order) return { success: false, error: '检查单不存在', code: 404 };
  if (role === 'doctor' && order.ordered_by !== userId) {
    return { success: false, error: '无权操作其他医生的检查单', code: 403 };
  }
  if (role !== 'admin' && role !== 'nurse' && order.ordered_by !== userId) {
    return { success: false, error: '无权操作', code: 403 };
  }
  try {
    db.prepare(`
      UPDATE exam_waitlist SET
        status = 'cancelled', cancel_reason = ?, cancelled_by = ?,
        cancelled_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(cancelReason || null, userId, waitlistId);
    logChange(w.exam_order_id, 'waitlist_cancel', order.status, order.status,
      null, null, { waitlist_id: waitlistId, cancel_reason: cancelReason || null },
      userId, ip);
    const fullWL = db.prepare('SELECT * FROM exam_waitlist WHERE id = ?').get(waitlistId);
    return { success: true, waitlist: aliasWaitlist(fullWL) };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

function cancelExamOrder(orderId, userId, role, ip, cancelReason) {
  const order = db.prepare('SELECT * FROM exam_orders WHERE id = ?').get(orderId);
  if (!order) return { success: false, error: '检查单不存在', code: 404 };
  if (order.status === 'completed') {
    return { success: false, error: '当前状态' + order.status + '不能取消' };
  }
  if (role === 'doctor' && order.ordered_by !== userId) {
    return { success: false, error: '无权操作其他医生的检查单', code: 403 };
  }
  const oldSlotId = order.scheduled_slot_id;
  const oldStatus = order.status;
  const tx = db.transaction(function () {
    db.prepare(`
      UPDATE exam_orders SET
        status = 'cancelled', cancel_reason = ?, cancelled_by = ?,
        cancelled_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(cancelReason || null, userId, orderId);
    if (oldSlotId) {
      db.prepare(`
        UPDATE exam_slots SET booked_count = MAX(0, booked_count - 1),
          status = CASE WHEN MAX(0, booked_count - 1) < total_capacity THEN 'available' ELSE status END,
          updated_at = CURRENT_TIMESTAMP WHERE id = ?
      `).run(oldSlotId);
    }
    db.prepare(`
      UPDATE exam_reschedule_requests SET
        status = 'cancelled', updated_at = CURRENT_TIMESTAMP
      WHERE exam_order_id = ? AND status IN ('pending', 'approved')
    `).run(orderId);
    db.prepare(`
      UPDATE exam_waitlist SET
        status = 'cancelled', cancel_reason = '检查单已取消', cancelled_by = ?,
        cancelled_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
      WHERE exam_order_id = ? AND status = 'waiting'
    `).run(userId, orderId);
  });
  try {
    tx();
    logChange(orderId, 'cancel', oldStatus, 'cancelled', oldSlotId, null,
      { cancel_reason: cancelReason || null }, userId, ip);
    sendNotification(null, order.patient_id, orderId, 'exam_cancelled',
      '检查已取消',
      '您的' + getExamTypeName(order.exam_type_id) + '检查已取消：' + (cancelReason || '原因未说明'));
    if (oldSlotId) tryPromoteWaitlistForSlot(oldSlotId, userId, ip);
    const fullOrder = db.prepare('SELECT * FROM exam_orders WHERE id = ?').get(orderId);
    return { success: true, order: aliasOrder(fullOrder) };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

function completeExamOrder(orderId, userId, role, ip, resultText) {
  if (role !== 'admin' && role !== 'nurse') {
    return { success: false, error: '无权完成检查登记', code: 403 };
  }
  const order = db.prepare('SELECT * FROM exam_orders WHERE id = ?').get(orderId);
  if (!order) return { success: false, error: '检查单不存在', code: 404 };
  if (order.status !== 'scheduled') {
    return { success: false, error: '当前状态' + order.status + '不能完成登记' };
  }
  const oldStatus = order.status;
  try {
    db.prepare(`
      UPDATE exam_orders SET status = 'completed', result = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?
    `).run(resultText || null, orderId);
    logChange(orderId, 'complete', oldStatus, 'completed',
      order.scheduled_slot_id, null, { result: resultText || null }, userId, ip);
    sendNotification(null, order.patient_id, orderId, 'exam_completed',
      '检查已完成', '您的' + getExamTypeName(order.exam_type_id) + '检查已完成');
    const fullOrder = db.prepare('SELECT * FROM exam_orders WHERE id = ?').get(orderId);
    return { success: true, order: aliasOrder(fullOrder) };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

function listExamOrders(query, userId, role) {
  try {
    const q = query || {};
    let sql = `
      SELECT o.*, p.name AS patient_name, p.id_card AS patient_id_card,
        p.gender AS patient_gender, p.age AS patient_age, p.phone AS patient_phone,
        t.name AS exam_type_name,
        s.date AS slot_date, s.start_time AS slot_start_time, s.end_time AS slot_end_time,
        u1.username AS doctor_name, u1.name AS doctor_real_name,
        d.name AS department_name
      FROM exam_orders o
      LEFT JOIN patients p ON o.patient_id = p.id
      LEFT JOIN exam_types t ON o.exam_type_id = t.id
      LEFT JOIN exam_slots s ON o.scheduled_slot_id = s.id
      LEFT JOIN users u1 ON o.ordered_by = u1.id
      LEFT JOIN departments d ON o.department_id = d.id
      WHERE 1=1
    `;
    const params = [];
    if (role === 'doctor') {
      sql += ' AND o.ordered_by = ?';
      params.push(userId);
    }
    if (q.status) { sql += ' AND o.status = ?'; params.push(q.status); }
    if (q.patient_id) { sql += ' AND o.patient_id = ?'; params.push(parseInt(q.patient_id)); }
    if (q.exam_type_id) { sql += ' AND o.exam_type_id = ?'; params.push(parseInt(q.exam_type_id)); }
    if (q.ordered_by) { sql += ' AND o.ordered_by = ?'; params.push(parseInt(q.ordered_by)); }
    if (q.scheduled_date) { sql += ' AND s.date = ?'; params.push(q.scheduled_date); }
    sql += ' ORDER BY o.created_at DESC';
    const rows = db.prepare(sql).all(...params).map(aliasOrder);
    return { success: true, orders: rows };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

function getExamOrderDetail(orderId, userId, role) {
  try {
    const order = db.prepare(`
      SELECT o.*, p.name AS patient_name, p.id_card AS patient_id_card,
        p.gender AS patient_gender, p.age AS patient_age, p.phone AS patient_phone,
        t.name AS exam_type_name, t.code AS exam_type_code,
        s.date AS slot_date, s.start_time AS slot_start_time, s.end_time AS slot_end_time,
        u1.username AS doctor_name, u1.name AS doctor_real_name,
        d.name AS department_name
      FROM exam_orders o
      LEFT JOIN patients p ON o.patient_id = p.id
      LEFT JOIN exam_types t ON o.exam_type_id = t.id
      LEFT JOIN exam_slots s ON o.scheduled_slot_id = s.id
      LEFT JOIN users u1 ON o.ordered_by = u1.id
      LEFT JOIN departments d ON o.department_id = d.id
      WHERE o.id = ?
    `).get(orderId);
    if (!order) return { success: false, error: '检查单不存在', code: 404 };
    if (role === 'doctor' && order.ordered_by !== userId) {
      return { success: false, error: '无权查看其他医生的检查单', code: 403 };
    }
    const changeLogs = db.prepare(`
      SELECT l.*, u.username AS performer_username, u.name AS performer_real_name,
        fs.date AS from_slot_date, fs.start_time AS from_slot_start_time,
        ts.date AS to_slot_date, ts.start_time AS to_slot_start_time
      FROM exam_change_logs l
      LEFT JOIN users u ON l.performed_by = u.id
      LEFT JOIN exam_slots fs ON l.from_slot_id = fs.id
      LEFT JOIN exam_slots ts ON l.to_slot_id = ts.id
      WHERE l.exam_order_id = ?
      ORDER BY l.created_at DESC
    `).all(orderId).map(function (l) {
      return Object.assign({}, l, { details: safeParse(l.details) });
    });
    const notifications = db.prepare(`
      SELECT * FROM exam_notifications WHERE exam_order_id = ? ORDER BY created_at DESC
    `).all(orderId);
    const reschedules = db.prepare(`
      SELECT r.*,
        os.date AS original_slot_date, os.start_time AS original_slot_start_time,
        ns.date AS new_slot_date, ns.start_time AS new_slot_start_time,
        u1.username AS requester_name, u1.name AS requester_real_name,
        u2.username AS reviewer_name, u2.name AS reviewer_real_name
      FROM exam_reschedule_requests r
      LEFT JOIN exam_slots os ON r.original_slot_id = os.id
      LEFT JOIN exam_slots ns ON r.new_slot_id = ns.id
      LEFT JOIN users u1 ON r.requested_by = u1.id
      LEFT JOIN users u2 ON r.reviewed_by = u2.id
      WHERE r.exam_order_id = ?
      ORDER BY r.created_at DESC
    `).all(orderId);
    const waitlist = db.prepare(`
      SELECT w.*, s.date AS promoted_slot_date, s.start_time AS promoted_slot_start_time,
        u1.username AS adder_name, u1.name AS adder_real_name
      FROM exam_waitlist w
      LEFT JOIN exam_slots s ON w.promoted_slot_id = s.id
      LEFT JOIN users u1 ON w.added_by = u1.id
      WHERE w.exam_order_id = ?
      ORDER BY w.created_at DESC
    `).all(orderId);
    return {
      success: true,
      order: aliasOrder(order),
      change_logs: changeLogs,
      notifications: notifications,
      reschedule_requests: reschedules,
      waitlist_records: waitlist
    };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

function listRescheduleRequests(query, userId, role) {
  try {
    const q = query || {};
    let sql = `
      SELECT r.*, p.name AS patient_name, p.id_card AS patient_id_card,
        t.name AS exam_type_name,
        os.date AS original_slot_date, os.start_time AS original_slot_start_time,
        ns.date AS new_slot_date, ns.start_time AS new_slot_start_time,
        u1.username AS requester_name, u1.name AS requester_real_name,
        u2.username AS reviewer_name, u2.name AS reviewer_real_name,
        u3.username AS reverter_name, u3.name AS reverter_real_name
      FROM exam_reschedule_requests r
      LEFT JOIN patients p ON r.patient_id = p.id
      LEFT JOIN exam_types t ON r.exam_type_id = t.id
      LEFT JOIN exam_slots os ON r.original_slot_id = os.id
      LEFT JOIN exam_slots ns ON r.new_slot_id = ns.id
      LEFT JOIN users u1 ON r.requested_by = u1.id
      LEFT JOIN users u2 ON r.reviewed_by = u2.id
      LEFT JOIN users u3 ON r.reverted_by = u3.id
      WHERE 1=1
    `;
    const params = [];
    if (role === 'doctor') {
      sql += ' AND r.requested_by = ?';
      params.push(userId);
    }
    if (q.status) { sql += ' AND r.status = ?'; params.push(q.status); }
    if (q.exam_type_id) { sql += ' AND r.exam_type_id = ?'; params.push(parseInt(q.exam_type_id)); }
    if (q.requested_by) { sql += ' AND r.requested_by = ?'; params.push(parseInt(q.requested_by)); }
    sql += ' ORDER BY r.created_at DESC';
    const rows = db.prepare(sql).all(...params);
    return { success: true, requests: rows };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

function listWaitlist(query, userId, role) {
  try {
    const q = query || {};
    let sql = `
      SELECT w.*, p.name AS patient_name, p.id_card AS patient_id_card,
        t.name AS exam_type_name,
        s.date AS promoted_slot_date, s.start_time AS promoted_slot_start_time,
        u1.username AS adder_name, u1.name AS adder_real_name,
        u2.username AS promoter_name, u2.name AS promoter_real_name,
        o.order_no, o.urgency AS order_urgency, o.status AS order_status
      FROM exam_waitlist w
      LEFT JOIN patients p ON w.patient_id = p.id
      LEFT JOIN exam_types t ON w.exam_type_id = t.id
      LEFT JOIN exam_slots s ON w.promoted_slot_id = s.id
      LEFT JOIN users u1 ON w.added_by = u1.id
      LEFT JOIN users u2 ON w.promoted_by = u2.id
      LEFT JOIN exam_orders o ON w.exam_order_id = o.id
      WHERE 1=1
    `;
    const params = [];
    if (q.status) { sql += ' AND w.status = ?'; params.push(q.status); }
    if (q.exam_type_id) { sql += ' AND w.exam_type_id = ?'; params.push(parseInt(q.exam_type_id)); }
    if (q.target_date) { sql += ' AND w.target_date = ?'; params.push(q.target_date); }
    sql += ' ORDER BY w.priority DESC, w.created_at ASC';
    const rows = db.prepare(sql).all(...params);
    return { success: true, waitlist: rows };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

function listTodayExecutions(date) {
  try {
    const rows = db.prepare(`
      SELECT o.*, p.name AS patient_name, p.id_card AS patient_id_card,
        p.gender AS patient_gender, p.age AS patient_age, p.phone AS patient_phone,
        t.name AS exam_type_name,
        s.date AS slot_date, s.start_time AS slot_start_time,
        u1.username AS doctor_name, u1.name AS doctor_real_name
      FROM exam_orders o
      LEFT JOIN patients p ON o.patient_id = p.id
      LEFT JOIN exam_types t ON o.exam_type_id = t.id
      LEFT JOIN exam_slots s ON o.scheduled_slot_id = s.id
      LEFT JOIN users u1 ON o.ordered_by = u1.id
      WHERE s.date = ?
      ORDER BY s.start_time ASC
    `).all(date);
    return { success: true, executions: rows, today: rows };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

function listPromotions() {
  try {
    const rows = db.prepare(`
      SELECT w.*, p.name AS patient_name, p.id_card AS patient_id_card,
        t.name AS exam_type_name,
        s.date AS promoted_slot_date, s.start_time AS promoted_slot_start_time,
        u.username AS promoter_name, u.name AS promoter_real_name,
        o.order_no
      FROM exam_waitlist w
      LEFT JOIN patients p ON w.patient_id = p.id
      LEFT JOIN exam_types t ON w.exam_type_id = t.id
      LEFT JOIN exam_slots s ON w.promoted_slot_id = s.id
      LEFT JOIN users u ON w.promoted_by = u.id
      LEFT JOIN exam_orders o ON w.exam_order_id = o.id
      WHERE w.status = 'promoted'
      ORDER BY w.promoted_at DESC
      LIMIT 100
    `).all();
    return { success: true, promotions: rows };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

function listChangeLogs(orderId) {
  try {
    let sql, params;
    if (orderId) {
      sql = 'SELECT * FROM exam_change_logs WHERE exam_order_id = ? ORDER BY created_at DESC';
      params = [orderId];
    } else {
      sql = 'SELECT * FROM exam_change_logs ORDER BY created_at DESC LIMIT 200';
      params = [];
    }
    const rows = db.prepare(sql).all(...params).map(function (r) {
      return Object.assign({}, r, { details: safeParse(r.details) });
    });
    return { success: true, logs: rows };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

function listConfigs() {
  try {
    const rows = db.prepare('SELECT * FROM exam_configs ORDER BY config_key').all().map(aliasConfig);
    return { success: true, configs: rows };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

function updateConfig(key, value, description, userId) {
  try {
    setConfig(key, value, description, userId);
    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

function csvEscape(v) {
  if (v === null || v === undefined) return '';
  const s = String(v);
  if (/[",\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

function generateExamCSV(query) {
  const result = listExamOrders(query, null, 'admin');
  if (!result.success) return result;
  const headers = ['单号', '患者姓名', '身份证号', '检查类型', '科室', '开单医生',
    '优先级', '状态', '预约日期', '开始时间', '临床诊断', '备注', '结果', '取消原因', '创建时间'];
  const rows = result.orders.map(function (o) {
    return [
      o.order_no, o.patient_name, o.patient_id_card, o.exam_type_name,
      o.department_name, o.doctor_name,
      o.urgency, o.status, o.slot_date, o.slot_start_time,
      o.clinical_indication, o.notes, o.result, o.cancel_reason, o.created_at
    ];
  });
  const content = [headers].concat(rows).map(function (r) {
    return r.map(csvEscape).join(',');
  }).join('\n');
  return { success: true, content: content, filename: 'exam_orders_' + Date.now() + '.csv' };
}

function generateRescheduleCSV(query) {
  const result = listRescheduleRequests(query, null, 'admin');
  if (!result.success) return result;
  const headers = ['申请单号', '患者姓名', '检查类型', '原时段', '期望开始日期', '期望结束日期',
    '原因', '状态', '申请人', '审核人', '审核时间', '审核备注', '新时段', '撤回人', '撤回时间', '撤回原因'];
  const rows = result.requests.map(function (r) {
    return [
      r.request_no, r.patient_name, r.exam_type_name,
      (r.original_slot_date || '') + ' ' + (r.original_slot_start_time || ''),
      r.requested_start_date, r.requested_end_date, r.reason, r.status,
      r.requester_name,
      r.reviewer_name,
      r.reviewed_at, r.review_notes,
      (r.new_slot_date || '') + ' ' + (r.new_slot_start_time || ''),
      r.reverter_name, r.reverted_at, r.revert_reason
    ];
  });
  const content = [headers].concat(rows).map(function (r) {
    return r.map(csvEscape).join(',');
  }).join('\n');
  return { success: true, content: content, filename: 'reschedule_requests_' + Date.now() + '.csv' };
}

function generateWaitlistCSV(query) {
  const result = listWaitlist(query, null, 'admin');
  if (!result.success) return result;
  const headers = ['检查单号', '患者姓名', '检查类型', '目标日期', '优先级', '状态',
    '加入人', '转正时段', '转正人', '转正时间', '取消原因'];
  const rows = result.waitlist.map(function (w) {
    return [
      w.order_no, w.patient_name, w.exam_type_name, w.target_date,
      w.priority, w.status,
      w.adder_name,
      (w.promoted_slot_date || '') + ' ' + (w.promoted_slot_start_time || ''),
      w.promoter_name, w.promoted_at, w.cancel_reason
    ];
  });
  const content = [headers].concat(rows).map(function (r) {
    return r.map(csvEscape).join(',');
  }).join('\n');
  return { success: true, content: content, filename: 'exam_waitlist_' + Date.now() + '.csv' };
}

function createExamType(data, userId) {
  const name = data.name, code = data.code, departmentId = data.department_id;
  const description = data.description || null;
  const defaultDuration = parseInt(data.default_duration) || 15;
  if (!name || !code || !departmentId) {
    return { success: false, error: '名称、编码和科室为必填' };
  }
  try {
    const stmt = db.prepare(`
      INSERT INTO exam_types (name, code, department_id, description, default_duration, is_active)
      VALUES (?, ?, ?, ?, ?, 1)
    `);
    const r = stmt.run(name, code, parseInt(departmentId), description, defaultDuration);
    return { success: true, id: r.lastInsertRowid };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

function updateExamType(id, data, userId) {
  const keys = ['name', 'code', 'department_id', 'description', 'default_duration', 'is_active'];
  const fields = [];
  const params = [];
  for (let i = 0; i < keys.length; i++) {
    const k = keys[i];
    if (data[k] !== undefined) {
      fields.push(k + ' = ?');
      params.push(data[k]);
    }
  }
  if (fields.length === 0) return { success: true };
  params.push(id);
  try {
    db.prepare('UPDATE exam_types SET ' + fields.join(', ') + ' WHERE id = ?').run(...params);
    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

function createExamSlot(data, userId) {
  const examTypeId = data.exam_type_id, date = data.date, startTime = data.start_time, endTime = data.end_time;
  const totalCapacity = parseInt(data.total_capacity) || 1;
  const waitlistLimit = parseInt(data.waitlist_limit) || 3;
  if (!examTypeId || !date || !startTime || !endTime) {
    return { success: false, error: '检查类型、日期、开始和结束时间为必填' };
  }
  try {
    const stmt = db.prepare(`
      INSERT INTO exam_slots
      (exam_type_id, date, start_time, end_time, total_capacity,
       booked_count, waitlist_limit, status, created_by)
      VALUES (?, ?, ?, ?, ?, 0, ?, 'available', ?)
    `);
    const r = stmt.run(parseInt(examTypeId), date, startTime, endTime, totalCapacity, waitlistLimit, userId);
    return { success: true, id: r.lastInsertRowid };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

function updateExamSlot(id, data, userId) {
  const keys = ['date', 'start_time', 'end_time', 'total_capacity', 'waitlist_limit', 'status'];
  const fields = [];
  const params = [];
  for (let i = 0; i < keys.length; i++) {
    const k = keys[i];
    if (data[k] !== undefined) {
      fields.push(k + ' = ?');
      params.push(data[k]);
    }
  }
  if (fields.length === 0) return { success: true };
  fields.push("updated_at = CURRENT_TIMESTAMP");
  params.push(id);
  try {
    db.prepare('UPDATE exam_slots SET ' + fields.join(', ') + ' WHERE id = ?').run(...params);
    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

module.exports = {
  generateOrderNo: generateOrderNo,
  generateRequestNo: generateRequestNo,
  getOrCreatePatient: getOrCreatePatient,
  logChange: logChange,
  sendNotification: sendNotification,
  getConfig: getConfig,
  setConfig: setConfig,
  listExamTypes: listExamTypes,
  createExamType: createExamType,
  updateExamType: updateExamType,
  listExamSlots: listExamSlots,
  createExamSlot: createExamSlot,
  updateExamSlot: updateExamSlot,
  createExamOrder: createExamOrder,
  scheduleExamOrder: scheduleExamOrder,
  requestReschedule: requestReschedule,
  approveReschedule: approveReschedule,
  rejectReschedule: rejectReschedule,
  cancelRescheduleRequest: cancelRescheduleRequest,
  revertReschedule: revertReschedule,
  addToWaitlist: addToWaitlist,
  promoteWaitlist: promoteWaitlist,
  cancelWaitlist: cancelWaitlist,
  tryPromoteWaitlistForSlot: tryPromoteWaitlistForSlot,
  cancelExamOrder: cancelExamOrder,
  completeExamOrder: completeExamOrder,
  listExamOrders: listExamOrders,
  getExamOrderDetail: getExamOrderDetail,
  listRescheduleRequests: listRescheduleRequests,
  listWaitlist: listWaitlist,
  listTodayExecutions: listTodayExecutions,
  listPromotions: listPromotions,
  listChangeLogs: listChangeLogs,
  listConfigs: listConfigs,
  updateConfig: updateConfig,
  generateExamCSV: generateExamCSV,
  generateRescheduleCSV: generateRescheduleCSV,
  generateWaitlistCSV: generateWaitlistCSV,
  getExamTypeName: getExamTypeName
};
