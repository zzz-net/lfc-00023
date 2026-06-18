const db = require('../db');

function _getConfig(key, defaultValue) {
  const row = db.prepare('SELECT config_value FROM exam_configs WHERE config_key = ?').get(key);
  return row ? row.config_value : (defaultValue === undefined ? null : defaultValue);
}

function _parsePriority(priorityInput, orderUrgency) {
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
    if (orderUrgency === 'emergency') priorityVal = 2;
    else if (orderUrgency === 'urgent') priorityVal = 1;
  }
  return priorityVal;
}

function getSlotWaitlistLimit(slotId) {
  const slot = db.prepare('SELECT waitlist_limit, exam_type_id, date FROM exam_slots WHERE id = ?').get(slotId);
  if (!slot) return null;
  if (slot.waitlist_limit !== undefined && slot.waitlist_limit !== null) {
    return { limit: parseInt(slot.waitlist_limit), exam_type_id: slot.exam_type_id, date: slot.date };
  }
  const defaultLimit = parseInt(_getConfig('waitlist_default_limit', '3')) || 3;
  return { limit: defaultLimit, exam_type_id: slot.exam_type_id, date: slot.date };
}

function getDailyWaitlistLimit(examTypeId, date) {
  const perSlotLimit = parseInt(_getConfig('waitlist_max_per_slot', '5')) || 5;
  const slotCount = db.prepare(
    'SELECT COUNT(*) as count FROM exam_slots WHERE exam_type_id = ? AND date = ? AND status != ?'
  ).get(examTypeId, date, 'cancelled').count;
  return { limit: perSlotLimit * Math.max(1, slotCount), slot_count: slotCount };
}

function getSlotWaitlistCount(slotId) {
  const slot = db.prepare('SELECT exam_type_id, date FROM exam_slots WHERE id = ?').get(slotId);
  if (!slot) return 0;
  return db.prepare(`
    SELECT COUNT(*) as count FROM exam_waitlist
    WHERE exam_type_id = ? AND target_date = ? AND status = 'waiting'
  `).get(slot.exam_type_id, slot.date).count;
}

function getDailyWaitlistCount(examTypeId, date) {
  return db.prepare(`
    SELECT COUNT(*) as count FROM exam_waitlist
    WHERE exam_type_id = ? AND target_date = ? AND status = 'waiting'
  `).get(examTypeId, date).count;
}

function getWaitlistStats(examTypeId, date, slotId) {
  const dailyUsed = getDailyWaitlistCount(examTypeId, date);
  const dailyLimitInfo = getDailyWaitlistLimit(examTypeId, date);
  const dailyRemaining = Math.max(0, dailyLimitInfo.limit - dailyUsed);

  let slotUsed = null;
  let slotLimit = null;
  let slotRemaining = null;
  if (slotId) {
    const slotLimitInfo = getSlotWaitlistLimit(slotId);
    if (slotLimitInfo) {
      slotLimit = slotLimitInfo.limit;
      slotUsed = getSlotWaitlistCount(slotId);
      slotRemaining = Math.max(0, slotLimit - slotUsed);
    }
  }

  return {
    daily: {
      limit: dailyLimitInfo.limit,
      used: dailyUsed,
      remaining: dailyRemaining,
      slot_count: dailyLimitInfo.slot_count
    },
    slot: slotId ? {
      limit: slotLimit,
      used: slotUsed,
      remaining: slotRemaining
    } : null,
    can_add: dailyRemaining > 0
  };
}

function hasActiveWaitlist(examOrderId, examTypeId, targetDate) {
  const count = db.prepare(`
    SELECT COUNT(*) as count FROM exam_waitlist
    WHERE exam_order_id = ? AND exam_type_id = ? AND target_date = ? AND status = 'waiting'
  `).get(examOrderId, examTypeId, targetDate).count;
  return count > 0;
}

function _logChange(examOrderId, changeType, fromStatus, toStatus, fromSlotId, toSlotId, details, userId, ip) {
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

function _sendNotification(userId, patientId, examOrderId, type, title, content) {
  const stmt = db.prepare(`
    INSERT INTO exam_notifications (user_id, patient_id, exam_order_id, type, title, content)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  stmt.run(userId || null, patientId || null, examOrderId || null, type, title, content);
}

function _getExamTypeName(typeId) {
  const t = db.prepare('SELECT name FROM exam_types WHERE id = ?').get(typeId);
  return t ? t.name : '检查';
}

function _updateSlotBookedCount(slotId, delta) {
  if (delta > 0) {
    db.prepare(`
      UPDATE exam_slots SET booked_count = booked_count + ?,
        status = CASE WHEN booked_count + ? >= total_capacity THEN 'full' ELSE 'available' END,
        updated_at = CURRENT_TIMESTAMP WHERE id = ?
    `).run(delta, delta, slotId);
  } else if (delta < 0) {
    const absDelta = Math.abs(delta);
    db.prepare(`
      UPDATE exam_slots SET booked_count = MAX(0, booked_count - ?),
        status = CASE WHEN MAX(0, booked_count - ?) < total_capacity THEN 'available' ELSE status END,
        updated_at = CURRENT_TIMESTAMP WHERE id = ?
    `).run(absDelta, absDelta, slotId);
  }
}

function addWaitlist(data, userId, role, ip) {
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

  const examType = db.prepare('SELECT * FROM exam_types WHERE id = ? AND is_active = 1').get(examTypeId);
  if (!examType) return { success: false, error: '检查类型不存在或未启用' };

  if (hasActiveWaitlist(examOrderId, examTypeId, targetDate)) {
    return { success: false, error: '该检查单在该日期已有候补记录' };
  }

  const stats = getWaitlistStats(examTypeId, targetDate);
  if (!stats.can_add) {
    return { success: false, error: '当日该检查类型候补名额已满' };
  }

  const priorityVal = _parsePriority(priorityInput, order.urgency);

  try {
    const stmt = db.prepare(`
      INSERT INTO exam_waitlist
      (exam_order_id, patient_id, exam_type_id, target_date,
       preferred_time, priority, status, added_by)
      VALUES (?, ?, ?, ?, ?, ?, 'waiting', ?)
    `);
    const result = stmt.run(examOrderId, order.patient_id, examTypeId, targetDate, preferredTime, priorityVal, userId);
    const wlId = result.lastInsertRowid;

    _logChange(examOrderId, 'waitlist_add', order.status, order.status, null, null,
      { waitlist_id: wlId, target_date: targetDate, priority: priorityVal,
        preferred_time: preferredTime }, userId, ip);

    const fullWL = db.prepare('SELECT * FROM exam_waitlist WHERE id = ?').get(wlId);
    return { success: true, waitlist: fullWL, stats };
  } catch (e) {
    if (e.message && e.message.indexOf('UNIQUE') >= 0 && e.message.indexOf('idx_waitlist_active') >= 0) {
      return { success: false, error: '该检查单在该日期已有候补记录' };
    }
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

    _logChange(w.exam_order_id, 'waitlist_cancel', order.status, order.status,
      null, null, { waitlist_id: waitlistId, cancel_reason: cancelReason || null },
      userId, ip);

    const fullWL = db.prepare('SELECT * FROM exam_waitlist WHERE id = ?').get(waitlistId);
    const stats = getWaitlistStats(w.exam_type_id, w.target_date);
    return { success: true, waitlist: fullWL, stats };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

function promoteWaitlistEntry(waitlistId, userId, role, ip) {
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

    _updateSlotBookedCount(slot.id, 1);

    if (oldSlotId && oldSlotId !== slot.id) {
      _updateSlotBookedCount(oldSlotId, -1);
    }
  });

  try {
    tx();

    _logChange(w.exam_order_id, 'waitlist_promote', order.status, 'scheduled',
      oldSlotId, slot.id,
      { waitlist_id: waitlistId, slot_date: slot.date, start_time: slot.start_time },
      userId, ip);

    _sendNotification(null, w.patient_id, w.exam_order_id, 'waitlist_promoted',
      '候补转正成功',
      '您的' + _getExamTypeName(w.exam_type_id) + '候补已安排到' + slot.date + ' ' + slot.start_time);

    if (oldSlotId && oldSlotId !== slot.id) {
      autoPromoteForSlot(oldSlotId, userId, ip);
    }

    const fullOrder = db.prepare('SELECT * FROM exam_orders WHERE id = ?').get(w.exam_order_id);
    const stats = getWaitlistStats(w.exam_type_id, w.target_date);
    return { success: true, order: fullOrder, slot_id: slot.id, stats };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

function autoPromoteForSlot(slotId, userId, ip) {
  const slot = db.prepare('SELECT * FROM exam_slots WHERE id = ?').get(slotId);
  if (!slot) return false;
  if (slot.booked_count >= slot.total_capacity) return false;

  const autoPromote = _getConfig('waitlist_auto_promote', 'true') === 'true';
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

        _updateSlotBookedCount(slotId, 1);

        if (oldSlotId && oldSlotId !== slotId) {
          _updateSlotBookedCount(oldSlotId, -1);
        }
      });
      tx();
      promotedCount++;

      _logChange(w.exam_order_id, 'waitlist_promote', order.status, 'scheduled',
        oldSlotId, slotId,
        { waitlist_id: w.id, slot_date: slot.date, start_time: slot.start_time },
        userId || null, ip);

      _sendNotification(null, w.patient_id, w.exam_order_id, 'waitlist_promoted',
        '候补转正成功',
        '您的' + _getExamTypeName(w.exam_type_id) + '候补已安排到' + slot.date + ' ' + slot.start_time);

      if (oldSlotId && oldSlotId !== slotId) {
        autoPromoteForSlot(oldSlotId, userId, ip);
      }
    } catch (e) {
      console.error('候补转正失败:', e.message);
    }
  }
  return promotedCount > 0;
}

function onSlotFreed(slotId, userId, ip) {
  if (!slotId) return false;
  return autoPromoteForSlot(slotId, userId, ip);
}

function onExamOrderCancelled(orderId, userId, ip) {
  const order = db.prepare('SELECT * FROM exam_orders WHERE id = ?').get(orderId);
  if (!order) return false;

  if (order.scheduled_slot_id) {
    onSlotFreed(order.scheduled_slot_id, userId, ip);
  }

  db.prepare(`
    UPDATE exam_waitlist SET
      status = 'cancelled', cancel_reason = '检查单已取消', cancelled_by = ?,
      cancelled_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
    WHERE exam_order_id = ? AND status = 'waiting'
  `).run(userId, orderId);

  return true;
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

function getWaitlistStatsForList(examTypeId, date) {
  return getWaitlistStats(examTypeId, date);
}

module.exports = {
  getSlotWaitlistLimit,
  getDailyWaitlistLimit,
  getSlotWaitlistCount,
  getDailyWaitlistCount,
  getWaitlistStats,
  hasActiveWaitlist,
  addWaitlist,
  cancelWaitlist,
  promoteWaitlistEntry,
  autoPromoteForSlot,
  onSlotFreed,
  onExamOrderCancelled,
  listWaitlist,
  getWaitlistStatsForList
};
