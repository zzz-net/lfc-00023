const db = require('../db');

function logAudit(userId, action, targetType, targetId, details, ipAddress) {
  const stmt = db.prepare(`
    INSERT INTO audit_logs (user_id, action, target_type, target_id, details, ip_address)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  stmt.run(userId, action, targetType, targetId, JSON.stringify(details), ipAddress);
}

module.exports = { logAudit };
