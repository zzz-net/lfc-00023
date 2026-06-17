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
  DEPARTMENT_INACTIVE: 'DEPARTMENT_INACTIVE',
  NO_SLOT_CONFIG: 'NO_SLOT_CONFIG',
  SLOT_FULL: 'SLOT_FULL',
  WALKIN_LIMIT_REACHED: 'WALKIN_LIMIT_REACHED',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
  BATCH_NOT_DRAFT: 'BATCH_NOT_DRAFT',
  BATCH_NOT_FOUND: 'BATCH_NOT_FOUND',
  CONFIRM_SLOT_TAKEN: 'CONFIRM_SLOT_TAKEN',
  CONFIRM_DEPARTMENT_CLOSED: 'CONFIRM_DEPARTMENT_CLOSED',
  CONFIRM_DEPARTMENT_INACTIVE: 'CONFIRM_DEPARTMENT_INACTIVE',
  CONFIRM_NO_SLOT_CONFIG: 'CONFIRM_NO_SLOT_CONFIG',
  CONFIRM_DUPLICATE_REGISTRATION: 'CONFIRM_DUPLICATE_REGISTRATION',
  CONFIRM_DATA_CHANGED: 'CONFIRM_DATA_CHANGED',
  BATCH_REVOKED: 'BATCH_REVOKED'
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

  const seenKeys = new Set();
  results.forEach(r => {
    if (r.record.id_card && r.record._departmentId && r.record.queue_date) {
      const key = `${r.record.id_card}|${r.record._departmentId}|${r.record.queue_date}`;
      if (seenKeys.has(key)) {
        r.errors.push({ 
          code: ERROR_CODES.DUPLICATE_ID_CARD_IN_BATCH, 
          message: '同一批次中存在重复的身份证号+科室+日期组合' 
        });
      } else {
        seenKeys.add(key);
      }
    }
  });

  return results;
}

function checkDatabaseConflictsPrecheck(records) {
  const results = [];

  for (const record of records) {
    const conflicts = [];
    let isOverwrite = false;
    let overwriteHint = null;

    if (record._departmentId && record.queue_date) {
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
        isOverwrite = true;
        overwriteHint = '该患者当日已在此科室挂号，导入将失败';
      }

      if (conflicts.length === 0) {
        const slotKey = `${record._departmentId}|${record.queue_date}`;
        const walkinKey = `${record._departmentId}|${record.queue_date}|walkin`;
        
        const slot = db.prepare('SELECT * FROM daily_slots WHERE department_id = ? AND date = ?').get(record._departmentId, record.queue_date);
        const currentTotal = db.prepare("SELECT COUNT(*) as count FROM queue_records WHERE department_id = ? AND queue_date = ? AND status NOT IN ('returned')").get(record._departmentId, record.queue_date).count;
        const currentWalkin = db.prepare("SELECT COUNT(*) as count FROM queue_records WHERE department_id = ? AND queue_date = ? AND type = ? AND status NOT IN ('returned')").get(record._departmentId, record.queue_date, 'walkin').count;

        if (isDepartmentClosed(record._departmentId, record.queue_date)) {
          conflicts.push({ code: ERROR_CODES.DEPARTMENT_CLOSED, message: '该科室今日停诊' });
        } else if (!slot) {
          conflicts.push({ code: ERROR_CODES.NO_SLOT_CONFIG, message: '该科室今日未配置号源' });
        } else if (currentTotal >= slot.total_slots) {
          conflicts.push({ code: ERROR_CODES.SLOT_FULL, message: '今日号源已满' });
        } else if (record._type === 'walkin' && currentWalkin >= slot.walkin_limit) {
          conflicts.push({ code: ERROR_CODES.WALKIN_LIMIT_REACHED, message: '今日现场加号已满' });
        }
      }
    }

    results.push({ record, conflicts, isOverwrite, overwriteHint });
  }

  return results;
}

function precheckBatch(csvText, userId, ipAddress) {
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

  const conflictResults = checkDatabaseConflictsPrecheck(validRecords);
  
  const allResults = [];
  validationResults.forEach(vr => {
    if (vr.errors.length > 0) {
      allResults.push({
        rowIndex: vr.record._rowIndex,
        record: vr.record,
        errors: vr.errors,
        success: false,
        isOverwrite: false,
        overwriteHint: null
      });
    }
  });

  conflictResults.forEach(cr => {
    const existing = allResults.find(r => r.rowIndex === cr.record._rowIndex);
    if (existing) {
      existing.errors.push(...cr.conflicts);
      existing.isOverwrite = cr.isOverwrite;
      existing.overwriteHint = cr.overwriteHint;
    } else if (cr.conflicts.length > 0) {
      allResults.push({
        rowIndex: cr.record._rowIndex,
        record: cr.record,
        errors: cr.conflicts,
        success: false,
        isOverwrite: cr.isOverwrite,
        overwriteHint: cr.overwriteHint
      });
    } else {
      allResults.push({
        rowIndex: cr.record._rowIndex,
        record: cr.record,
        errors: [],
        success: true,
        isOverwrite: cr.isOverwrite,
        overwriteHint: cr.overwriteHint
      });
    }
  });

  allResults.sort((a, b) => a.rowIndex - b.rowIndex);

  const successRecords = allResults.filter(r => r.success);
  const failRecords = allResults.filter(r => !r.success);

  const insertTransaction = db.transaction(() => {
    const batchStmt = db.prepare(`
      INSERT INTO import_batches (batch_no, total_count, success_count, fail_count, status, imported_by)
      VALUES (?, ?, ?, ?, 'draft', ?)
    `);
    const batchResult = batchStmt.run(batchNo, allResults.length, successRecords.length, failRecords.length, userId);
    const batchId = batchResult.lastInsertRowid;

    const recordStmt = db.prepare(`
      INSERT INTO import_records (
        batch_id, row_index, id_card, name, phone, gender, age, 
        department_id, department_name, queue_date, type, 
        status, error_code, error_message, is_overwrite, overwrite_hint
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    for (const result of allResults) {
      const r = result.record;
      const isSuccess = result.success;
      const errorCode = isSuccess ? null : result.errors[0].code;
      const errorMessage = isSuccess ? null : result.errors.map(e => e.message).join('; ');

      recordStmt.run(
        batchId, r._rowIndex, r.id_card, r.name, r.phone || null,
        r._gender || r.gender || null, r._age || r.age || null,
        r._departmentId || null, r._departmentName || r.department || null,
        r.queue_date, r._type || r.type,
        isSuccess ? 'draft_success' : 'draft_failed',
        errorCode, errorMessage,
        result.isOverwrite ? 1 : 0,
        result.overwriteHint
      );
    }

    logAudit(userId, 'precheck_batch', 'import_batch', batchId, {
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
      status: 'draft',
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
          type: r.record._type,
          is_overwrite: r.isOverwrite,
          overwrite_hint: r.overwriteHint
        })),
        failed: failRecords.map(r => ({
          row: r.rowIndex,
          id_card: r.record.id_card,
          name: r.record.name,
          department: r.record._departmentName || r.record.department,
          queue_date: r.record.queue_date,
          type: r.record._type || r.record.type,
          is_overwrite: r.isOverwrite,
          overwrite_hint: r.overwriteHint,
          errors: r.errors
        }))
      }
    };
  } catch (err) {
    return {
      success: false,
      error: '预检失败：' + err.message,
      errorCode: ERROR_CODES.INTERNAL_ERROR
    };
  }
}

function confirmBatch(batchId, userId, ipAddress) {
  const batch = db.prepare(`
    SELECT * FROM import_batches WHERE id = ?
  `).get(batchId);

  if (!batch) {
    return { success: false, error: '批次不存在', errorCode: ERROR_CODES.BATCH_NOT_FOUND };
  }

  if (batch.status !== 'draft') {
    return { success: false, error: '该批次不是草稿状态，无法确认', errorCode: ERROR_CODES.BATCH_NOT_DRAFT };
  }

  const draftRecords = db.prepare(`
    SELECT * FROM import_records WHERE batch_id = ? ORDER BY row_index
  `).all(batchId);

  const recheckResults = [];
  const slotUsage = new Map();
  const walkinUsage = new Map();
  const registeredPatients = new Set();

  for (const dr of draftRecords) {
    if (dr.status === 'draft_failed') {
      recheckResults.push({
        id: dr.id,
        row_index: dr.row_index,
        id_card: dr.id_card,
        name: dr.name,
        status: 'precheck_failed',
        error_code: dr.error_code,
        error_message: dr.error_message,
        can_enqueue: false,
        is_new_conflict: false
      });
      continue;
    }

    if (dr.status !== 'draft_success') {
      recheckResults.push({
        id: dr.id,
        row_index: dr.row_index,
        id_card: dr.id_card,
        name: dr.name,
        status: 'precheck_failed',
        error_code: dr.error_code,
        error_message: dr.error_message || '预检未通过',
        can_enqueue: false,
        is_new_conflict: false
      });
      continue;
    }

    const conflicts = [];
    const patientKey = `${dr.id_card}|${dr.department_id}|${dr.queue_date}`;

    if (registeredPatients.has(patientKey)) {
      conflicts.push({
        code: ERROR_CODES.CONFIRM_DUPLICATE_REGISTRATION,
        message: '确认时发现本批次中已有同身份证同科室同日期记录'
      });
    }

    const existingRegistration = db.prepare(`
      SELECT COUNT(*) as count FROM queue_records 
      WHERE patient_id IN (SELECT id FROM patients WHERE id_card = ?)
        AND department_id = ? 
        AND queue_date = ? 
        AND status NOT IN ('returned')
    `).get(dr.id_card, dr.department_id, dr.queue_date);

    if (existingRegistration.count > 0) {
      conflicts.push({
        code: ERROR_CODES.CONFIRM_DUPLICATE_REGISTRATION,
        message: '预检后该患者当日已在此科室挂号（被他人抢先）'
      });
    }

    const dept = db.prepare('SELECT * FROM departments WHERE id = ?').get(dr.department_id);
    if (!dept || dept.is_active !== 1) {
      conflicts.push({
        code: ERROR_CODES.CONFIRM_DEPARTMENT_INACTIVE,
        message: '预检后该科室已被停用'
      });
    }

    if (isDepartmentClosed(dr.department_id, dr.queue_date)) {
      conflicts.push({
        code: ERROR_CODES.CONFIRM_DEPARTMENT_CLOSED,
        message: '预检后该科室已停诊'
      });
    }

    const slotKey = `${dr.department_id}|${dr.queue_date}`;
    const walkinKey = `${dr.department_id}|${dr.queue_date}|walkin`;
    
    const slot = db.prepare('SELECT * FROM daily_slots WHERE department_id = ? AND date = ?').get(dr.department_id, dr.queue_date);
    const currentTotal = db.prepare("SELECT COUNT(*) as count FROM queue_records WHERE department_id = ? AND queue_date = ? AND status NOT IN ('returned')").get(dr.department_id, dr.queue_date).count + (slotUsage.get(slotKey) || 0);
    const currentWalkin = db.prepare("SELECT COUNT(*) as count FROM queue_records WHERE department_id = ? AND queue_date = ? AND type = ? AND status NOT IN ('returned')").get(dr.department_id, dr.queue_date, 'walkin').count + (walkinUsage.get(walkinKey) || 0);

    if (!slot) {
      conflicts.push({
        code: ERROR_CODES.CONFIRM_NO_SLOT_CONFIG,
        message: '预检后该科室此日期号源配置已被删除'
      });
    } else if (currentTotal >= slot.total_slots) {
      conflicts.push({
        code: ERROR_CODES.CONFIRM_SLOT_TAKEN,
        message: `预检后号源已被占满（总号源${slot.total_slots}，当前已用${currentTotal}）`
      });
    } else if (dr.type === 'walkin' && currentWalkin >= slot.walkin_limit) {
      conflicts.push({
        code: ERROR_CODES.CONFIRM_SLOT_TAKEN,
        message: `预检后现场加号已满（现场号源${slot.walkin_limit}，当前已用${currentWalkin}）`
      });
    }

    if (conflicts.length > 0) {
      recheckResults.push({
        id: dr.id,
        row_index: dr.row_index,
        id_card: dr.id_card,
        name: dr.name,
        department_name: dr.department_name,
        queue_date: dr.queue_date,
        type: dr.type,
        status: 'confirm_failed',
        error_code: conflicts[0].code,
        error_message: conflicts.map(c => c.message).join('; '),
        can_enqueue: false,
        is_new_conflict: true,
        conflicts
      });
    } else {
      recheckResults.push({
        id: dr.id,
        row_index: dr.row_index,
        id_card: dr.id_card,
        name: dr.name,
        department_name: dr.department_name,
        queue_date: dr.queue_date,
        type: dr.type,
        status: 'ready',
        can_enqueue: true,
        is_new_conflict: false
      });
      slotUsage.set(slotKey, (slotUsage.get(slotKey) || 0) + 1);
      if (dr.type === 'walkin') {
        walkinUsage.set(walkinKey, (walkinUsage.get(walkinKey) || 0) + 1);
      }
      registeredPatients.add(patientKey);
    }
  }

  const newConflicts = recheckResults.filter(r => r.is_new_conflict);
  const precheckFailed = recheckResults.filter(r => r.status === 'precheck_failed');
  const readyCount = recheckResults.filter(r => r.can_enqueue).length;

  if (newConflicts.length > 0 || precheckFailed.length > 0) {
    logAudit(userId, 'confirm_batch_recheck', 'import_batch', batchId, {
      batch_no: batch.batch_no,
      total_count: batch.total_count,
      ready_count: readyCount,
      precheck_failed_count: precheckFailed.length,
      new_conflict_count: newConflicts.length,
      new_conflicts: newConflicts.map(c => ({
        row_index: c.row_index,
        id_card: c.id_card,
        name: c.name,
        error_code: c.error_code,
        error_message: c.error_message
      }))
    }, ipAddress);
  }

  const confirmTransaction = db.transaction(() => {
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

    const enqueueRecordStmt = db.prepare(`
      UPDATE import_records 
      SET status = 'enqueued', patient_id = ?, queue_record_id = ?, 
          error_code = NULL, error_message = NULL
      WHERE id = ?
    `);

    const precheckFailKeepStmt = db.prepare(`
      UPDATE import_records 
      SET status = 'precheck_failed'
      WHERE id = ?
    `);

    const confirmFailStmt = db.prepare(`
      UPDATE import_records 
      SET status = 'confirm_failed', error_code = ?, error_message = ?
      WHERE id = ?
    `);

    let actualSuccessCount = 0;
    let actualPrecheckFailCount = 0;
    let actualConfirmFailCount = 0;

    const txSlotUsage = new Map();
    const txWalkinUsage = new Map();
    const txRegisteredPatients = new Set();

    for (const rr of recheckResults) {
      if (rr.status === 'precheck_failed') {
        precheckFailKeepStmt.run(rr.id);
        actualPrecheckFailCount++;
        continue;
      }

      if (rr.status === 'confirm_failed') {
        confirmFailStmt.run(rr.error_code, rr.error_message, rr.id);
        actualConfirmFailCount++;
        continue;
      }

      if (rr.status !== 'ready' || !rr.can_enqueue) {
        precheckFailKeepStmt.run(rr.id);
        actualPrecheckFailCount++;
        continue;
      }

      const dr = draftRecords.find(d => d.id === rr.id);
      if (!dr) {
        actualPrecheckFailCount++;
        continue;
      }

      const patientKey = `${dr.id_card}|${dr.department_id}|${dr.queue_date}`;
      if (txRegisteredPatients.has(patientKey)) {
        confirmFailStmt.run(ERROR_CODES.CONFIRM_DUPLICATE_REGISTRATION, '确认时发现本批次中已有同身份证同科室同日期记录', rr.id);
        actualConfirmFailCount++;
        continue;
      }

      const existingRegistration2 = db.prepare(`
        SELECT COUNT(*) as count FROM queue_records 
        WHERE patient_id IN (SELECT id FROM patients WHERE id_card = ?)
          AND department_id = ? 
          AND queue_date = ? 
          AND status NOT IN ('returned')
      `).get(dr.id_card, dr.department_id, dr.queue_date);

      if (existingRegistration2.count > 0) {
        confirmFailStmt.run(ERROR_CODES.CONFIRM_DUPLICATE_REGISTRATION, '预检后该患者当日已在此科室挂号（被他人抢先）', rr.id);
        actualConfirmFailCount++;
        continue;
      }

      const txSlotKey = `${dr.department_id}|${dr.queue_date}`;
      const txWalkinKey = `${dr.department_id}|${dr.queue_date}|walkin`;
      
      const slot2 = db.prepare('SELECT * FROM daily_slots WHERE department_id = ? AND date = ?').get(dr.department_id, dr.queue_date);
      const currentTotal2 = db.prepare("SELECT COUNT(*) as count FROM queue_records WHERE department_id = ? AND queue_date = ? AND status NOT IN ('returned')").get(dr.department_id, dr.queue_date).count + (txSlotUsage.get(txSlotKey) || 0);
      const currentWalkin2 = db.prepare("SELECT COUNT(*) as count FROM queue_records WHERE department_id = ? AND queue_date = ? AND type = ? AND status NOT IN ('returned')").get(dr.department_id, dr.queue_date, 'walkin').count + (txWalkinUsage.get(txWalkinKey) || 0);

      if (!slot2) {
        confirmFailStmt.run(ERROR_CODES.CONFIRM_NO_SLOT_CONFIG, '预检后该科室此日期号源配置已被删除', rr.id);
        actualConfirmFailCount++;
        continue;
      }

      if (isDepartmentClosed(dr.department_id, dr.queue_date)) {
        confirmFailStmt.run(ERROR_CODES.CONFIRM_DEPARTMENT_CLOSED, '预检后该科室已停诊', rr.id);
        actualConfirmFailCount++;
        continue;
      }

      if (currentTotal2 >= slot2.total_slots) {
        confirmFailStmt.run(ERROR_CODES.CONFIRM_SLOT_TAKEN, `预检后号源已被占满（总号源${slot2.total_slots}，当前已用${currentTotal2}）`, rr.id);
        actualConfirmFailCount++;
        continue;
      }

      if (dr.type === 'walkin' && currentWalkin2 >= slot2.walkin_limit) {
        confirmFailStmt.run(ERROR_CODES.CONFIRM_SLOT_TAKEN, `预检后现场加号已满（现场号源${slot2.walkin_limit}，当前已用${currentWalkin2}）`, rr.id);
        actualConfirmFailCount++;
        continue;
      }

      patientStmt.run(dr.name, dr.id_card, dr.phone || null, dr.gender || null, dr.age || null);
      const patient = getPatientStmt.get(dr.id_card);
      
      const queueNumber = getNextQueueNumber(dr.department_id, dr.queue_date);
      const queueResult = queueStmt.run(
        patient.id, dr.department_id, dr.queue_date, queueNumber, dr.type,
        batchId, dr.id
      );

      enqueueRecordStmt.run(patient.id, queueResult.lastInsertRowid, dr.id);

      txSlotUsage.set(txSlotKey, (txSlotUsage.get(txSlotKey) || 0) + 1);
      if (dr.type === 'walkin') {
        txWalkinUsage.set(txWalkinKey, (txWalkinUsage.get(txWalkinKey) || 0) + 1);
      }
      txRegisteredPatients.add(patientKey);

      actualSuccessCount++;

      logAudit(userId, 'register_queue', 'queue_record', queueResult.lastInsertRowid, {
        patient_id: patient.id,
        patient_name: dr.name,
        department_id: dr.department_id,
        department_name: dr.department_name,
        type: dr.type,
        queue_number: queueNumber,
        batch_no: batch.batch_no,
        import_row: dr.row_index
      }, ipAddress);
    }

    db.prepare(`
      UPDATE import_batches 
      SET status = 'completed', success_count = ?, fail_count = ?, 
          precheck_failed_count = ?, confirm_failed_count = ?,
          confirmed_by = ?, confirmed_at = ?
      WHERE id = ?
    `).run(
      actualSuccessCount, 
      actualPrecheckFailCount + actualConfirmFailCount,
      actualPrecheckFailCount,
      actualConfirmFailCount,
      userId, new Date().toISOString(), batchId
    );

    logAudit(userId, 'confirm_batch', 'import_batch', batchId, {
      batch_no: batch.batch_no,
      total_count: batch.total_count,
      success_count: actualSuccessCount,
      precheck_failed_count: actualPrecheckFailCount,
      confirm_failed_count: actualConfirmFailCount,
      fail_count: actualPrecheckFailCount + actualConfirmFailCount
    }, ipAddress);

    return { actualSuccessCount, actualPrecheckFailCount, actualConfirmFailCount };
  });

  try {
    const { actualSuccessCount, actualPrecheckFailCount, actualConfirmFailCount } = confirmTransaction();
    return {
      success: true,
      batch_id: batchId,
      batch_no: batch.batch_no,
      status: 'completed',
      total_count: batch.total_count,
      success_count: actualSuccessCount,
      precheck_failed_count: actualPrecheckFailCount,
      confirm_failed_count: actualConfirmFailCount,
      fail_count: actualPrecheckFailCount + actualConfirmFailCount,
      recheck_details: {
        ready: recheckResults.filter(r => r.can_enqueue).map(r => ({
          row: r.row_index,
          id_card: r.id_card,
          name: r.name,
          department: r.department_name,
          queue_date: r.queue_date,
          type: r.type
        })),
        precheck_failed: precheckFailed.map(r => ({
          row: r.row_index,
          id_card: r.id_card,
          name: r.name,
          error_code: r.error_code,
          error_message: r.error_message
        })),
        new_conflicts: newConflicts.map(r => ({
          row: r.row_index,
          id_card: r.id_card,
          name: r.name,
          department: r.department_name,
          queue_date: r.queue_date,
          type: r.type,
          error_code: r.error_code,
          error_message: r.error_message
        }))
      }
    };
  } catch (err) {
    return {
      success: false,
      error: '确认导入失败：' + err.message,
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

  if (batch.status === 'draft') {
    const revokeTransaction = db.transaction(() => {
      db.prepare(`
        UPDATE import_batches 
        SET status = 'revoked', revoked_by = ?, revoked_at = ?, revoke_reason = ?
        WHERE id = ?
      `).run(userId, new Date().toISOString(), reason || '草稿撤销', batchId);

      db.prepare(`
        UPDATE import_records SET status = 'precheck_failed', error_code = 'BATCH_REVOKED', error_message = '草稿批次已撤销'
        WHERE batch_id = ? AND status IN ('draft_success', 'draft_failed')
      `).run(batchId);

      logAudit(userId, 'revoke_batch', 'import_batch', batchId, {
        batch_no: batch.batch_no,
        reason: reason || '草稿撤销',
        was_draft: true
      }, ipAddress);

      return 0;
    });

    try {
      const count = revokeTransaction();
      return {
        success: true,
        message: `草稿已撤销`,
        revoked_count: count
      };
    } catch (err) {
      return { success: false, error: '撤销失败：' + err.message };
    }
  }

  const nonWaitingRecords = db.prepare(`
    SELECT COUNT(*) as count FROM queue_records
    WHERE batch_id = ? AND status != 'waiting'
  `).get(batchId);

  if (nonWaitingRecords.count > 0) {
    return { success: false, error: '该批次中存在已叫号、过号或已就诊的记录，无法撤销' };
  }

  const revokeTransaction = db.transaction(() => {
    const queueRecords = db.prepare(`
      SELECT id, queue_number, patient_id, department_id, queue_date
      FROM queue_records WHERE batch_id = ? AND status = 'waiting'
    `).all(batchId);

    db.prepare(`
      UPDATE queue_records 
      SET status = 'returned', return_reason = ?, returned_by = ?, returned_at = ?
      WHERE batch_id = ? AND status = 'waiting'
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
      UPDATE import_records SET status = 'precheck_failed', error_code = 'BATCH_REVOKED', error_message = '批次已撤销'
      WHERE batch_id = ? AND status = 'enqueued'
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
                   '科室', '挂号日期', '挂号类型', '状态', '是否覆盖', '覆盖提示', '错误代码', '错误信息'];
  
  const statusMap = { 
    draft_success: '预检通过', 
    draft_failed: '预检失败',
    precheck_failed: '预检失败',
    confirm_failed: '确认失败',
    pending: '待处理', 
    success: '成功', 
    failed: '失败', 
    enqueued: '已入队' 
  };
  
  const typeMap = { appointment: '预约', walkin: '现场' };

  const rows = records.map(r => [
    r.row_index, r.id_card, r.name, r.phone || '', r.gender || '', r.age || '',
    r.department_name || '', r.queue_date, typeMap[r.type] || r.type,
    statusMap[r.status] || r.status,
    r.is_overwrite ? '是' : '否',
    r.overwrite_hint || '',
    r.error_code || '', r.error_message || ''
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
  precheckBatch,
  confirmBatch,
  revokeBatch,
  generateBatchCSV,
  parseCSV,
  validateBatch,
  checkDatabaseConflictsPrecheck,
  ERROR_CODES
};
