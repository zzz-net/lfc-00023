const db = require('../db');
const { logAudit } = require('./audit');
const { checkCanRegister, getNextQueueNumber, isDepartmentClosed } = require('./queue');

const ERROR_CODES = {
  INVALID_CSV: 'INVALID_CSV',
  MISSING_REQUIRED_FIELD: 'MISSING_REQUIRED_FIELD',
  INVALID_GENDER: 'INVALID_GENDER',
  INVALID_AGE: 'INVALID_AGE',
  INVALID_TYPE: 'INVALID_TYPE',
  INVALID_DATE: 'INVALID_DATE',
  INVALID_ID_CARD: 'INVALID_ID_CARD',
  DEPARTMENT_NOT_FOUND: 'DEPARTMENT_NOT_FOUND',
  DUPLICATE_ID_CARD_IN_BATCH: 'DUPLICATE_ID_CARD_IN_BATCH',
  DUPLICATE_REGISTRATION: 'DUPLICATE_REGISTRATION',
  DEPARTMENT_CLOSED: 'DEPARTMENT_CLOSED',
  NO_SLOT_CONFIG: 'NO_SLOT_CONFIG',
  SLOT_FULL: 'SLOT_FULL',
  WALKIN_LIMIT_REACHED: 'WALKIN_LIMIT_REACHED',
  INTERNAL_ERROR: 'INTERNAL_ERROR'
};

function parseCSV(csvText) {
  const lines = csvText.trim().split('\n');
  if (lines.length < 2) {
    return { error: 'CSV文件至少需要包含表头和一行数据' };
  }

  const headerLine = lines[0].replace(/\uFEFF/g, '').trim();
  const headers = headerLine.split(',').map(h => h.trim());
  
  const requiredHeaders = ['id_card', 'name', 'department', 'queue_date', 'type'];
  const missingHeaders = requiredHeaders.filter(h => !headers.includes(h));
  if (missingHeaders.length > 0) {
    return { error: `缺少必填列: ${missingHeaders.join(', ')}` };
  }

  const records = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    
    const values = parseCSVLine(line);
    if (values.length !== headers.length) {
      return { error: `第${i + 1}行列数不匹配: 期望${headers.length}列，实际${values.length}列` };
    }

    const record = {};
    headers.forEach((h, idx) => {
      record[h] = values[idx] ? values[idx].trim() : '';
    });
    record._rowIndex = i;
    records.push(record);
  }

  return { records };
}

function parseCSVLine(line) {
  const result = [];
  let current = '';
  let inQuotes = false;
  
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (char === ',' && !inQuotes) {
      result.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  result.push(current);
  return result;
}

function validateRecord(record, departmentsMap) {
  const errors = [];

  if (!record.id_card) {
    errors.push({ code: ERROR_CODES.MISSING_REQUIRED_FIELD, message: '身份证号不能为空' });
  } else if (record.id_card.length !== 15 && record.id_card.length !== 18) {
    errors.push({ code: ERROR_CODES.INVALID_ID_CARD, message: '身份证号格式不正确' });
  }

  if (!record.name) {
    errors.push({ code: ERROR_CODES.MISSING_REQUIRED_FIELD, message: '姓名不能为空' });
  }

  if (!record.department) {
    errors.push({ code: ERROR_CODES.MISSING_REQUIRED_FIELD, message: '科室不能为空' });
  } else {
    const dept = departmentsMap.get(record.department.trim());
    if (!dept) {
      errors.push({ code: ERROR_CODES.DEPARTMENT_NOT_FOUND, message: `科室"${record.department}"不存在` });
    } else {
      record._departmentId = dept.id;
      record._departmentName = dept.name;
    }
  }

  if (!record.queue_date) {
    errors.push({ code: ERROR_CODES.MISSING_REQUIRED_FIELD, message: '挂号日期不能为空' });
  } else if (!/^\d{4}-\d{2}-\d{2}$/.test(record.queue_date)) {
    errors.push({ code: ERROR_CODES.INVALID_DATE, message: `日期格式不正确，请使用YYYY-MM-DD格式` });
  }

  if (!record.type) {
    errors.push({ code: ERROR_CODES.MISSING_REQUIRED_FIELD, message: '挂号类型不能为空' });
  } else {
    const typeLower = record.type.toLowerCase().trim();
    if (['预约', 'appointment', '预约挂号'].includes(typeLower)) {
      record._type = 'appointment';
    } else if (['现场', 'walkin', '现场加号', '加号'].includes(typeLower)) {
      record._type = 'walkin';
    } else {
      errors.push({ code: ERROR_CODES.INVALID_TYPE, message: `挂号类型"${record.type}"不正确，应为'预约'或'现场'` });
    }
  }

  if (record.gender) {
    const g = record.gender.toString().trim();
    if (['男', 'male', 'm', '1', '男性'].includes(g)) {
      record._gender = '男';
    } else if (['女', 'female', 'f', '0', '女性'].includes(g)) {
      record._gender = '女';
    } else {
      errors.push({ code: ERROR_CODES.INVALID_GENDER, message: `性别"${record.gender}"不合法` });
    }
  }

  if (record.age) {
    const age = parseInt(record.age);
    if (isNaN(age) || age < 0 || age > 150) {
      errors.push({ code: ERROR_CODES.INVALID_AGE, message: `年龄"${record.age}"不合法` });
    } else {
      record._age = age;
    }
  }

  return errors;
}

function validateBatch(records, departments) {
  const departmentsMap = new Map();
  departments.forEach(d => departmentsMap.set(d.name.trim(), d));
  departments.forEach(d => departmentsMap.set(d.code.trim(), d));
  departments.forEach(d => departmentsMap.set(String(d.id), d));

  const results = records.map(record => ({
    record,
    errors: validateRecord(record, departmentsMap)
  }));

  const idCardCounts = new Map();
  records.forEach(r => {
    if (r.id_card) {
      const key = `${r.id_card}|${r._departmentId || r.department}|${r.queue_date}`;
      idCardCounts.set(key, (idCardCounts.get(key) || 0) + 1);
    }
  });

  results.forEach(r => {
    if (r.record.id_card && r.record._departmentId && r.record.queue_date) {
      const key = `${r.record.id_card}|${r.record._departmentId}|${r.record.queue_date}`;
      if (idCardCounts.get(key) > 1) {
        r.errors.push({ 
          code: ERROR_CODES.DUPLICATE_ID_CARD_IN_BATCH, 
          message: '同一批次中存在重复的身份证号+科室+日期组合' 
        });
      }
    }
  });

  return results;
}

function checkDatabaseConflicts(records) {
  const results = [];
  const slotUsage = new Map();
  const walkinUsage = new Map();
  const registeredPatients = new Set();

  for (const record of records) {
    const conflicts = [];

    if (record._departmentId && record.queue_date) {
      const patientKey = `${record.id_card}|${record._departmentId}|${record.queue_date}`;
      if (registeredPatients.has(patientKey)) {
        conflicts.push({ 
          code: ERROR_CODES.DUPLICATE_REGISTRATION, 
          message: '该患者当日已在此科室挂号' 
        });
      } else {
        const existing = db.prepare(`
          SELECT COUNT(*) as count FROM queue_records 
          WHERE patient_id IN (SELECT id FROM patients WHERE id_card = ?)
            AND department_id = ? 
            AND queue_date = ? 
            AND status NOT IN ('returned')
        `).get(record.id_card, record._departmentId, record.queue_date);

        if (existing.count > 0) {
          conflicts.push({ 
            code: ERROR_CODES.DUPLICATE_REGISTRATION, 
            message: '该患者当日已在此科室挂号' 
          });
        }
      }

      if (conflicts.length === 0) {
        const slotKey = `${record._departmentId}|${record.queue_date}`;
        const walkinKey = `${record._departmentId}|${record.queue_date}|walkin`;
        
        const slot = db.prepare('SELECT * FROM daily_slots WHERE department_id = ? AND date = ?').get(record._departmentId, record.queue_date);
        const currentTotal = db.prepare("SELECT COUNT(*) as count FROM queue_records WHERE department_id = ? AND queue_date = ? AND status NOT IN ('returned')").get(record._departmentId, record.queue_date).count + (slotUsage.get(slotKey) || 0);
        const currentWalkin = db.prepare("SELECT COUNT(*) as count FROM queue_records WHERE department_id = ? AND queue_date = ? AND type = ? AND status NOT IN ('returned')").get(record._departmentId, record.queue_date, 'walkin').count + (walkinUsage.get(walkinKey) || 0);

        if (isDepartmentClosed(record._departmentId, record.queue_date)) {
          conflicts.push({ code: ERROR_CODES.DEPARTMENT_CLOSED, message: '该科室今日停诊' });
        } else if (!slot) {
          conflicts.push({ code: ERROR_CODES.NO_SLOT_CONFIG, message: '该科室今日未配置号源' });
        } else if (currentTotal >= slot.total_slots) {
          conflicts.push({ code: ERROR_CODES.SLOT_FULL, message: '今日号源已满' });
        } else if (record._type === 'walkin' && currentWalkin >= slot.walkin_limit) {
          conflicts.push({ code: ERROR_CODES.WALKIN_LIMIT_REACHED, message: '今日现场加号已满' });
        } else {
          slotUsage.set(slotKey, (slotUsage.get(slotKey) || 0) + 1);
          if (record._type === 'walkin') {
            walkinUsage.set(walkinKey, (walkinUsage.get(walkinKey) || 0) + 1);
          }
          registeredPatients.add(patientKey);
        }
      }
    }

    results.push({ record, conflicts });
  }

  return results;
}

function processBatchImport(csvText, userId, ipAddress) {
  const parseResult = parseCSV(csvText);
  if (parseResult.error) {
    return { 
      success: false, 
      error: parseResult.error,
      errorCode: ERROR_CODES.INVALID_CSV
    };
  }

  const departments = db.prepare('SELECT id, name, code FROM departments WHERE is_active = 1').all();
  const batchNo = 'BATCH' + Date.now().toString() + Math.floor(Math.random() * 1000).toString().padStart(3, '0');

  const validationResults = validateBatch(parseResult.records, departments);
  const validRecords = validationResults
    .filter(r => r.errors.length === 0)
    .map(r => r.record);

  const conflictResults = checkDatabaseConflicts(validRecords);
  
  const allResults = [];
  validationResults.forEach(vr => {
    if (vr.errors.length > 0) {
      allResults.push({
        rowIndex: vr.record._rowIndex,
        record: vr.record,
        errors: vr.errors,
        success: false
      });
    }
  });

  conflictResults.forEach(cr => {
    const existing = allResults.find(r => r.rowIndex === cr.record._rowIndex);
    if (existing) {
      existing.errors.push(...cr.conflicts);
    } else if (cr.conflicts.length > 0) {
      allResults.push({
        rowIndex: cr.record._rowIndex,
        record: cr.record,
        errors: cr.conflicts,
        success: false
      });
    } else {
      allResults.push({
        rowIndex: cr.record._rowIndex,
        record: cr.record,
        errors: [],
        success: true
      });
    }
  });

  allResults.sort((a, b) => a.rowIndex - b.rowIndex);

  const successRecords = allResults.filter(r => r.success);
  const failRecords = allResults.filter(r => !r.success);

  const insertTransaction = db.transaction(() => {
    const batchStmt = db.prepare(`
      INSERT INTO import_batches (batch_no, total_count, success_count, fail_count, status, imported_by)
      VALUES (?, ?, ?, ?, 'completed', ?)
    `);
    const batchResult = batchStmt.run(batchNo, allResults.length, successRecords.length, failRecords.length, userId);
    const batchId = batchResult.lastInsertRowid;

    const recordStmt = db.prepare(`
      INSERT INTO import_records (
        batch_id, row_index, id_card, name, phone, gender, age, 
        department_id, department_name, queue_date, type, 
        status, error_code, error_message
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const patientStmt = db.prepare(`
      INSERT OR IGNORE INTO patients (name, id_card, phone, gender, age)
      VALUES (?, ?, ?, ?, ?)
    `);

    const getPatientStmt = db.prepare('SELECT id FROM patients WHERE id_card = ?');

    const queueStmt = db.prepare(`
      INSERT INTO queue_records (
        patient_id, department_id, queue_date, queue_number, type,
        batch_id, import_record_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    const updateRecordStmt = db.prepare(`
      UPDATE import_records SET patient_id = ?, queue_record_id = ? WHERE id = ?
    `);

    for (const result of allResults) {
      const r = result.record;
      const isSuccess = result.success;
      const errorCode = isSuccess ? null : result.errors[0].code;
      const errorMessage = isSuccess ? null : result.errors.map(e => e.message).join('; ');

      const recordResult = recordStmt.run(
        batchId, r._rowIndex, r.id_card, r.name, r.phone || null,
        r._gender || r.gender || null, r._age || r.age || null,
        r._departmentId || null, r._departmentName || r.department || null,
        r.queue_date, r._type || r.type,
        isSuccess ? 'success' : 'failed',
        errorCode, errorMessage
      );

      if (isSuccess) {
        const importRecordId = recordResult.lastInsertRowid;
        
        patientStmt.run(r.name, r.id_card, r.phone || null, r._gender || r.gender || null, r._age || r.age || null);
        const patient = getPatientStmt.get(r.id_card);
        
        const queueNumber = getNextQueueNumber(r._departmentId, r.queue_date);
        const queueResult = queueStmt.run(
          patient.id, r._departmentId, r.queue_date, queueNumber, r._type,
          batchId, importRecordId
        );

        updateRecordStmt.run(patient.id, queueResult.lastInsertRowid, importRecordId);

        logAudit(userId, 'register_queue', 'queue_record', queueResult.lastInsertRowid, {
          patient_id: patient.id,
          patient_name: r.name,
          department_id: r._departmentId,
          department_name: r._departmentName,
          type: r._type,
          queue_number: queueNumber,
          batch_no: batchNo,
          import_row: r._rowIndex
        }, ipAddress);
      }
    }

    logAudit(userId, 'import_batch', 'import_batch', batchId, {
      batch_no: batchNo,
      total_count: allResults.length,
      success_count: successRecords.length,
      fail_count: failRecords.length
    }, ipAddress);

    return { batchId, batchNo };
  });

  try {
    const { batchId, batchNo } = insertTransaction();
    return {
      success: true,
      batch_id: batchId,
      batch_no: batchNo,
      total_count: allResults.length,
      success_count: successRecords.length,
      fail_count: failRecords.length,
      details: {
        success: successRecords.map(r => ({
          row: r.rowIndex,
          id_card: r.record.id_card,
          name: r.record.name,
          department: r.record._departmentName,
          queue_date: r.record.queue_date,
          type: r.record._type
        })),
        failed: failRecords.map(r => ({
          row: r.rowIndex,
          id_card: r.record.id_card,
          name: r.record.name,
          department: r.record._departmentName || r.record.department,
          queue_date: r.record.queue_date,
          type: r.record._type || r.record.type,
          errors: r.errors
        }))
      }
    };
  } catch (err) {
    return {
      success: false,
      error: '导入失败：' + err.message,
      errorCode: ERROR_CODES.INTERNAL_ERROR
    };
  }
}

function revokeBatch(batchId, userId, ipAddress, reason) {
  const batch = db.prepare(`
    SELECT b.*, u.name as imported_by_name
    FROM import_batches b
    LEFT JOIN users u ON b.imported_by = u.id
    WHERE b.id = ?
  `).get(batchId);

  if (!batch) {
    return { success: false, error: '批次不存在' };
  }

  if (batch.status === 'revoked') {
    return { success: false, error: '该批次已撤销' };
  }

  const calledRecords = db.prepare(`
    SELECT COUNT(*) as count FROM queue_records
    WHERE batch_id = ? AND status IN ('called', 'consulting', 'completed')
  `).get(batchId);

  if (calledRecords.count > 0) {
    return { success: false, error: '该批次中存在已叫号或已就诊的记录，无法撤销' };
  }

  const revokeTransaction = db.transaction(() => {
    const queueRecords = db.prepare(`
      SELECT id, queue_number, patient_id, department_id, queue_date
      FROM queue_records WHERE batch_id = ?
    `).all(batchId);

    db.prepare(`
      UPDATE queue_records 
      SET status = 'returned', return_reason = ?, returned_by = ?, returned_at = ?
      WHERE batch_id = ?
    `).run(reason || '批量撤销', userId, new Date().toISOString(), batchId);

    for (const qr of queueRecords) {
      logAudit(userId, 'return_queue', 'queue_record', qr.id, {
        queue_number: qr.queue_number,
        reason: reason || '批量撤销',
        batch_no: batch.batch_no,
        revoked: true
      }, ipAddress);
    }

    db.prepare(`
      UPDATE import_batches 
      SET status = 'revoked', revoked_by = ?, revoked_at = ?, revoke_reason = ?
      WHERE id = ?
    `).run(userId, new Date().toISOString(), reason || '批量撤销', batchId);

    db.prepare(`
      UPDATE import_records SET status = 'failed', error_code = 'BATCH_REVOKED', error_message = '批次已撤销'
      WHERE batch_id = ? AND status = 'success'
    `).run(batchId);

    logAudit(userId, 'revoke_batch', 'import_batch', batchId, {
      batch_no: batch.batch_no,
      reason: reason || '批量撤销',
      revoked_count: queueRecords.length
    }, ipAddress);

    return queueRecords.length;
  });

  try {
    const count = revokeTransaction();
    return {
      success: true,
      message: `成功撤销${count}条记录`,
      revoked_count: count
    };
  } catch (err) {
    return { success: false, error: '撤销失败：' + err.message };
  }
}

function generateBatchCSV(batchId) {
  const records = db.prepare(`
    SELECT ir.*, u1.name as imported_by_name, u2.name as revoked_by_name
    FROM import_records ir
    LEFT JOIN import_batches ib ON ir.batch_id = ib.id
    LEFT JOIN users u1 ON ib.imported_by = u1.id
    LEFT JOIN users u2 ON ib.revoked_by = u2.id
    WHERE ir.batch_id = ?
    ORDER BY ir.row_index
  `).all(batchId);

  const headers = ['行号', '身份证号', '姓名', '手机号', '性别', '年龄', 
                   '科室', '挂号日期', '挂号类型', '状态', '错误代码', '错误信息'];
  const statusMap = { pending: '待处理', success: '成功', failed: '失败' };
  const typeMap = { appointment: '预约', walkin: '现场' };

  const rows = records.map(r => [
    r.row_index, r.id_card, r.name, r.phone || '', r.gender || '', r.age || '',
    r.department_name || '', r.queue_date, typeMap[r.type] || r.type,
    statusMap[r.status] || r.status, r.error_code || '', r.error_message || ''
  ]);

  return [headers, ...rows].map(row => row.map(escapeCSV).join(',')).join('\n');
}

function escapeCSV(value) {
  if (value == null) return '';
  const str = value.toString();
  if (str.includes(',') || str.includes('"') || str.includes('\n')) {
    return '"' + str.replace(/"/g, '""') + '"';
  }
  return str;
}

module.exports = {
  processBatchImport,
  revokeBatch,
  generateBatchCSV,
  parseCSV,
  validateBatch,
  checkDatabaseConflicts,
  ERROR_CODES
};
