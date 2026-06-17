const db = require('../db');

function isDepartmentClosed(departmentId, date) {
  const stmt = db.prepare(`
    SELECT COUNT(*) as count FROM closed_periods
    WHERE department_id = ? AND start_date <= ? AND end_date >= ?
  `);
  const result = stmt.get(departmentId, date, date);
  return result.count > 0;
}

function getDailySlot(departmentId, date) {
  const stmt = db.prepare(`
    SELECT * FROM daily_slots WHERE department_id = ? AND date = ?
  `);
  return stmt.get(departmentId, date);
}

function getTodayQueueCount(departmentId, date, type = null) {
  let sql = `SELECT COUNT(*) as count FROM queue_records 
             WHERE department_id = ? AND queue_date = ? AND status NOT IN ('returned')`;
  const params = [departmentId, date];
  
  if (type) {
    sql += ' AND type = ?';
    params.push(type);
  }
  
  const stmt = db.prepare(sql);
  return stmt.get(...params).count;
}

function getNextQueueNumber(departmentId, date) {
  const stmt = db.prepare(`
    SELECT COALESCE(MAX(queue_number), 0) + 1 as next_num
    FROM queue_records
    WHERE department_id = ? AND queue_date = ?
  `);
  return stmt.get(departmentId, date).next_num;
}

function checkCanRegister(departmentId, date, type) {
  if (isDepartmentClosed(departmentId, date)) {
    return { can: false, reason: '该科室今日停诊' };
  }

  const slot = getDailySlot(departmentId, date);
  if (!slot) {
    return { can: false, reason: '该科室今日未配置号源' };
  }

  const totalCount = getTodayQueueCount(departmentId, date);
  if (totalCount >= slot.total_slots) {
    return { can: false, reason: '今日号源已满' };
  }

  if (type === 'walkin') {
    const walkinCount = getTodayQueueCount(departmentId, date, 'walkin');
    if (walkinCount >= slot.walkin_limit) {
      return { can: false, reason: '今日现场加号已满' };
    }
  }

  return { can: true, slot };
}

module.exports = {
  isDepartmentClosed,
  getDailySlot,
  getTodayQueueCount,
  getNextQueueNumber,
  checkCanRegister
};
