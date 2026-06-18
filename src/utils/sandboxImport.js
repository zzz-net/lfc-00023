const db = require('../db');
const { logAudit } = require('./audit');
const { parseCSV, validateBatch, ERROR_CODES } = require('./batchImport');
const { checkCanRegister, getNextQueueNumber, isDepartmentClosed } = require('./queue');

function generateTaskNo() {
  return 'SBX' + Date.now().toString() + Math.floor(Math.random() * 1000).toString().padStart(3, '0');
}

function logConfirmation(taskId, recordId, action, details, summary, userId, ipAddress) {
  const stmt = db.prepare(`
    INSERT INTO sandbox_confirmations (task_id, record_id, action, details, summary, performed_by, ip_address)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  stmt.run(taskId, recordId || null, action, JSON.stringify(details), summary || null, userId, ipAddress || null);
}

function saveFieldMappings(taskId, csvText) {
  const parseResult = parseCSV(csvText);
  if (parseResult.error) return;

  const lines = csvText.trim().split('\n');
  const headerLine = lines[0].replace(/\uFEFF/g, '').trim();
  const sourceFields = headerLine.split(',').map(h => h.trim());

  const targetMap = {
    'id_card': 'id_card',
    'name': 'name',
    'department': 'department_name',
    'queue_date': 'queue_date',
    'type': 'type',
    'phone': 'phone',
    'gender': 'gender',
    'age': 'age'
  };
  const requiredFields = ['id_card', 'name', 'department', 'queue_date', 'type'];

  const stmt = db.prepare(`
    INSERT INTO sandbox_field_mappings (task_id, source_field, target_field, is_required)
    VALUES (?, ?, ?, ?)
  `);

  sourceFields.forEach(f => {
    const target = targetMap[f] || f;
    const isRequired = requiredFields.includes(f) ? 1 : 0;
    stmt.run(taskId, f, target, isRequired);
  });
}

function createSandboxTask(params, userId, ipAddress) {
  const { task_name, template_version, target_dataset, scope_type, scope_value, csv_text } = params;

  if (!task_name) {
    return { success: false, error: '任务名称不能为空' };
  }

  const existingName = db.prepare('SELECT id FROM sandbox_tasks WHERE task_name = ? AND status != ?').get(task_name, 'voided');
  if (existingName) {
    return { success: false, error: '同名任务已存在，请使用其他名称' };
  }

  const taskNo = generateTaskNo();

  try {
    const stmt = db.prepare(`
      INSERT INTO sandbox_tasks (
        task_no, task_name, template_version, target_dataset,
        scope_type, scope_value, csv_text, created_by
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const result = stmt.run(
      taskNo, task_name, template_version || 'v1',
      target_dataset || 'queue_records', scope_type || 'department',
      scope_value || null, csv_text || null, userId
    );

    const taskId = result.lastInsertRowid;

    if (csv_text) {
      saveFieldMappings(taskId, csv_text);
    }

    logConfirmation(taskId, null, 'precheck', {
      task_name, template_version, target_dataset, scope_type, scope_value
    }, '创建沙箱任务', userId, ipAddress);

    logAudit(userId, 'create_sandbox_task', 'sandbox_task', taskId, {
      task_no: taskNo, task_name
    }, ipAddress);

    return {
      success: true,
      task_id: taskId,
      task_no: taskNo
    };
  } catch (err) {
    return { success: false, error: '创建沙箱任务失败: ' + err.message };
  }
}

function precheckSandboxTask(taskId, csvText, userId, ipAddress) {
  const task = db.prepare('SELECT * FROM sandbox_tasks WHERE id = ?').get(taskId);
  if (!task) {
    return { success: false, error: '沙箱任务不存在' };
  }

  if (task.status === 'voided') {
    return { success: false, error: '该任务已作废，无法预检' };
  }

  if (!csvText && !task.csv_text) {
    return { success: false, error: 'CSV内容不能为空' };
  }

  const actualCsv = csvText || task.csv_text;
  const departments = db.prepare('SELECT id, name, code FROM departments WHERE is_active = 1').all();

  const lines = actualCsv.trim().split('\n');
  if (lines.length < 2) {
    return { success: false, error: 'CSV文件至少需要包含表头和一行数据' };
  }

  const headerLine = lines[0].replace(/\uFEFF/g, '').trim();
  const headers = headerLine.split(',').map(h => h.trim());
  const requiredHeaders = ['id_card', 'name', 'department', 'queue_date', 'type'];
  const missingHeaders = requiredHeaders.filter(h => !headers.includes(h));
  if (missingHeaders.length > 0) {
    return { success: false, error: `缺少必填列: ${missingHeaders.join(', ')}` };
  }

  let newCount = 0, overwriteCount = 0, skipCount = 0, failCount = 0;
  const validationResults = [];

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    const values = line.split(',');
    if (values.length !== headers.length) {
      failCount++;
      validationResults.push({
        record: { _rowIndex: i, id_card: '', name: '', department: '', queue_date: '', type: '', _rawLine: line },
        errors: [{ code: ERROR_CODES.INVALID_CSV, message: `列数不匹配: 期望${headers.length}列，实际${values.length}列` }],
        _isParseError: true
      });
      continue;
    }

    const record = {};
    headers.forEach((h, idx) => {
      record[h] = values[idx] ? values[idx].trim() : '';
    });
    record._rowIndex = i;

    const vr = validateBatch([record], departments)[0];
    validationResults.push(vr);
  }

  const allResults = [];

  for (const vr of validationResults) {
    const record = vr.record;
    let sandboxStatus = 'pending';
    let conflictType = null;
    let conflictDetail = null;
    let actionType = null;
    let errorCode = null;
    let errorMessage = null;

    if (vr.errors.length > 0) {
      sandboxStatus = 'failed';
      failCount++;
      errorCode = vr.errors[0].code;
      errorMessage = vr.errors.map(e => e.message).join('; ');
    } else {
      const existing = db.prepare(`
        SELECT COUNT(*) as count FROM queue_records
        WHERE patient_id IN (SELECT id FROM patients WHERE id_card = ?)
          AND department_id = ? AND queue_date = ?
          AND status NOT IN ('returned')
      `).get(record.id_card, record._departmentId, record.queue_date);

      if (existing.count > 0) {
        sandboxStatus = 'conflict';
        conflictType = 'duplicate_registration';
        conflictDetail = '该患者当日已在此科室挂号';
        actionType = 'overwrite';
        overwriteCount++;
      } else {
        const slotCheck = checkCanRegister(record._departmentId, record.queue_date, record._type);
        if (!slotCheck.can) {
          sandboxStatus = 'conflict';
          conflictType = 'slot_unavailable';
          conflictDetail = slotCheck.reason;
          actionType = 'skip';
          skipCount++;
          errorCode = ERROR_CODES.SLOT_FULL;
          errorMessage = slotCheck.reason;
        } else {
          sandboxStatus = 'validated';
          actionType = 'new';
          newCount++;
        }
      }
    }

    allResults.push({
      rowIndex: record._rowIndex,
      record,
      errors: vr.errors,
      sandboxStatus,
      conflictType,
      conflictDetail,
      actionType,
      errorCode,
      errorMessage
    });
  }

  const transaction = db.transaction(() => {
    db.prepare('DELETE FROM sandbox_records WHERE task_id = ?').run(taskId);
    db.prepare('DELETE FROM sandbox_field_mappings WHERE task_id = ?').run(taskId);

    saveFieldMappings(taskId, actualCsv);

    const recordStmt = db.prepare(`
      INSERT INTO sandbox_records (
        task_id, row_index, id_card, name, phone, gender, age,
        department_id, department_name, queue_date, type,
        sandbox_status, conflict_type, conflict_detail, action_type,
        error_code, error_message
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    for (const r of allResults) {
      recordStmt.run(
        taskId, r.rowIndex, r.record.id_card, r.record.name, r.record.phone || null,
        r.record._gender || r.record.gender || null, r.record._age || r.record.age || null,
        r.record._departmentId || null, r.record._departmentName || r.record.department || null,
        r.record.queue_date, r.record._type || r.record.type,
        r.sandboxStatus, r.conflictType, r.conflictDetail, r.actionType,
        r.errorCode, r.errorMessage
      );
    }

    db.prepare(`
      UPDATE sandbox_tasks
      SET status = 'prechecked', csv_text = ?, total_count = ?,
          new_count = ?, overwrite_count = ?, skip_count = ?, fail_count = ?,
          updated_by = ?, updated_at = ?
      WHERE id = ?
    `).run(
      actualCsv, allResults.length, newCount, overwriteCount, skipCount, failCount,
      userId, new Date().toISOString(), taskId
    );

    logConfirmation(taskId, null, 'precheck', {
      total: allResults.length, new: newCount, overwrite: overwriteCount,
      skip: skipCount, fail: failCount
    }, `预检完成: 总计${allResults.length}条, 新增${newCount}, 覆盖${overwriteCount}, 跳过${skipCount}, 失败${failCount}`,
       userId, ipAddress);

    logAudit(userId, 'precheck_sandbox_task', 'sandbox_task', taskId, {
      task_no: task.task_no, total: allResults.length,
      new: newCount, overwrite: overwriteCount, skip: skipCount, fail: failCount
    }, ipAddress);
  });

  try {
    transaction();
    return {
      success: true,
      task_id: taskId,
      total_count: allResults.length,
      new_count: newCount,
      overwrite_count: overwriteCount,
      skip_count: skipCount,
      fail_count: failCount,
      details: {
        validated: allResults.filter(r => r.sandboxStatus === 'validated').map(r => ({
          row: r.rowIndex, id_card: r.record.id_card, name: r.record.name,
          department: r.record._departmentName, queue_date: r.record.queue_date,
          type: r.record._type, action_type: r.actionType
        })),
        conflict: allResults.filter(r => r.sandboxStatus === 'conflict').map(r => ({
          row: r.rowIndex, id_card: r.record.id_card, name: r.record.name,
          department: r.record._departmentName, queue_date: r.record.queue_date,
          type: r.record._type, conflict_type: r.conflictType,
          conflict_detail: r.conflictDetail, action_type: r.actionType
        })),
        failed: allResults.filter(r => r.sandboxStatus === 'failed').map(r => ({
          row: r.rowIndex, id_card: r.record.id_card, name: r.record.name,
          errors: r.errors
        }))
      }
    };
  } catch (err) {
    return { success: false, error: '预检失败: ' + err.message };
  }
}

function practiceSandboxTask(taskId, userId, ipAddress) {
  const task = db.prepare('SELECT * FROM sandbox_tasks WHERE id = ?').get(taskId);
  if (!task) {
    return { success: false, error: '沙箱任务不存在' };
  }

  if (task.status === 'voided') {
    return { success: false, error: '该任务已作废，无法演练' };
  }

  const records = db.prepare('SELECT * FROM sandbox_records WHERE task_id = ? ORDER BY row_index').all(taskId);
  if (records.length === 0) {
    return { success: false, error: '该任务暂无记录，请先执行预检' };
  }

  const slotUsage = new Map();
  const walkinUsage = new Map();
  const registeredPatients = new Set();
  let successCount = 0, overwriteCount = 0, failCount = 0;
  const practiceResults = [];

  for (const sr of records) {
    if (sr.sandbox_status === 'failed' || sr.is_reverted) {
      practiceResults.push({ id: sr.id, success: false, reason: '预检失败或已撤销' });
      failCount++;
      continue;
    }

    if (sr.action_type === 'skip') {
      practiceResults.push({ id: sr.id, success: false, reason: '标记为跳过' });
      continue;
    }

    const patientKey = `${sr.id_card}|${sr.department_id}|${sr.queue_date}`;
    if (registeredPatients.has(patientKey)) {
      practiceResults.push({ id: sr.id, success: false, reason: '演练批次中重复挂号' });
      failCount++;
      continue;
    }

    const slotKey = `${sr.department_id}|${sr.queue_date}`;
    const walkinKey = `${sr.department_id}|${sr.queue_date}|walkin`;
    const currentTotal = db.prepare(
      "SELECT COUNT(*) as count FROM queue_records WHERE department_id = ? AND queue_date = ? AND status NOT IN ('returned')"
    ).get(sr.department_id, sr.queue_date).count + (slotUsage.get(slotKey) || 0);
    const currentWalkin = db.prepare(
      "SELECT COUNT(*) as count FROM queue_records WHERE department_id = ? AND queue_date = ? AND type = ? AND status NOT IN ('returned')"
    ).get(sr.department_id, sr.queue_date, 'walkin').count + (walkinUsage.get(walkinKey) || 0);

    const slot = db.prepare('SELECT * FROM daily_slots WHERE department_id = ? AND date = ?').get(sr.department_id, sr.queue_date);

    if (!slot) {
      practiceResults.push({ id: sr.id, success: false, reason: '该科室今日未配置号源' });
      failCount++;
      continue;
    }
    if (isDepartmentClosed(sr.department_id, sr.queue_date)) {
      practiceResults.push({ id: sr.id, success: false, reason: '该科室今日停诊' });
      failCount++;
      continue;
    }
    if (currentTotal >= slot.total_slots) {
      practiceResults.push({ id: sr.id, success: false, reason: '今日号源已满' });
      failCount++;
      continue;
    }
    if (sr.type === 'walkin' && currentWalkin >= slot.walkin_limit) {
      practiceResults.push({ id: sr.id, success: false, reason: '今日现场加号已满' });
      failCount++;
      continue;
    }

    const practiceQueueNumber = slot.total_slots + 10000 + successCount + overwriteCount + 1;
    const practicePatientId = 900000 + sr.id;

    practiceResults.push({
      id: sr.id,
      success: true,
      practice_queue_number: practiceQueueNumber,
      practice_patient_id: practicePatientId,
      is_overwrite: sr.action_type === 'overwrite'
    });

    if (sr.action_type === 'overwrite') overwriteCount++;
    else successCount++;

    slotUsage.set(slotKey, (slotUsage.get(slotKey) || 0) + 1);
    if (sr.type === 'walkin') {
      walkinUsage.set(walkinKey, (walkinUsage.get(walkinKey) || 0) + 1);
    }
    registeredPatients.add(patientKey);
  }

  const transaction = db.transaction(() => {
    const updateStmt = db.prepare(`
      UPDATE sandbox_records
      SET sandbox_status = ?, practice_queue_number = ?, practice_patient_id = ?,
          updated_at = ?, error_code = ?, error_message = ?
      WHERE id = ?
    `);

    for (const pr of practiceResults) {
      const sr = records.find(r => r.id === pr.id);
      if (!sr) continue;

      if (pr.success) {
        updateStmt.run(
          pr.is_overwrite ? 'practice_overwrite' : 'practice_success',
          pr.practice_queue_number, pr.practice_patient_id,
          new Date().toISOString(), null, null, pr.id
        );
      } else if (sr.sandbox_status !== 'failed' && !sr.is_reverted && sr.action_type !== 'skip') {
        updateStmt.run(
          'failed', null, null, new Date().toISOString(),
          ERROR_CODES.CONFIRM_SLOT_TAKEN, pr.reason, pr.id
        );
      }
    }

    db.prepare(`
      UPDATE sandbox_tasks
      SET status = 'practiced', updated_by = ?, updated_at = ?
      WHERE id = ?
    `).run(userId, new Date().toISOString(), taskId);

    logConfirmation(taskId, null, 'practice', {
      success: successCount, overwrite: overwriteCount, fail: failCount
    }, `演练完成: 成功${successCount}, 覆盖${overwriteCount}, 失败${failCount}`,
       userId, ipAddress);

    logAudit(userId, 'practice_sandbox_task', 'sandbox_task', taskId, {
      task_no: task.task_no, success: successCount, overwrite: overwriteCount, fail: failCount
    }, ipAddress);
  });

  try {
    transaction();
    return {
      success: true,
      task_id: taskId,
      success_count: successCount,
      overwrite_count: overwriteCount,
      fail_count: failCount
    };
  } catch (err) {
    return { success: false, error: '演练失败: ' + err.message };
  }
}

function revertSandboxRecord(taskId, recordId, userId, ipAddress, reason) {
  const task = db.prepare('SELECT * FROM sandbox_tasks WHERE id = ?').get(taskId);
  if (!task) {
    return { success: false, error: '沙箱任务不存在' };
  }
  if (task.status === 'voided') {
    return { success: false, error: '该任务已作废' };
  }
  if (task.status === 'submitted') {
    return { success: false, error: '该任务已提交到正式数据，无法单条撤销' };
  }

  const record = db.prepare('SELECT * FROM sandbox_records WHERE id = ? AND task_id = ?').get(recordId, taskId);
  if (!record) {
    return { success: false, error: '记录不存在' };
  }
  if (record.is_reverted) {
    return { success: false, error: '该记录已撤销' };
  }

  try {
    db.prepare(`
      UPDATE sandbox_records
      SET sandbox_status = 'reverted', is_reverted = 1,
          reverted_by = ?, reverted_at = ?, revert_reason = ?,
          updated_at = ?
      WHERE id = ?
    `).run(userId, new Date().toISOString(), reason || '手动撤销', new Date().toISOString(), recordId);

    logConfirmation(taskId, recordId, 'revert_record', {
      row_index: record.row_index, id_card: record.id_card, name: record.name, reason: reason || '手动撤销'
    }, `撤销单条记录: 行${record.row_index} ${record.name}`, userId, ipAddress);

    logAudit(userId, 'revert_sandbox_record', 'sandbox_record', recordId, {
      task_no: task.task_no, row_index: record.row_index, reason: reason || '手动撤销'
    }, ipAddress);

    return { success: true, message: '记录已撤销' };
  } catch (err) {
    return { success: false, error: '撤销失败: ' + err.message };
  }
}

function voidSandboxTask(taskId, userId, ipAddress, reason) {
  const task = db.prepare('SELECT * FROM sandbox_tasks WHERE id = ?').get(taskId);
  if (!task) {
    return { success: false, error: '沙箱任务不存在' };
  }
  if (task.status === 'voided') {
    return { success: false, error: '该任务已作废' };
  }
  if (task.status === 'submitted') {
    return { success: false, error: '该任务已提交到正式数据，无法作废' };
  }

  try {
    db.prepare(`
      UPDATE sandbox_tasks
      SET status = 'voided', voided_by = ?, voided_at = ?, void_reason = ?,
          updated_by = ?, updated_at = ?
      WHERE id = ?
    `).run(userId, new Date().toISOString(), reason || '整批作废', userId, new Date().toISOString(), taskId);

    db.prepare(`
      UPDATE sandbox_records
      SET sandbox_status = 'voided', updated_at = ?
      WHERE task_id = ? AND sandbox_status NOT IN ('reverted')
    `).run(new Date().toISOString(), taskId);

    logConfirmation(taskId, null, 'void_task', {
      reason: reason || '整批作废'
    }, `整批作废: ${reason || '整批作废'}`, userId, ipAddress);

    logAudit(userId, 'void_sandbox_task', 'sandbox_task', taskId, {
      task_no: task.task_no, reason: reason || '整批作废'
    }, ipAddress);

    return { success: true, message: '任务已作废' };
  } catch (err) {
    return { success: false, error: '作废失败: ' + err.message };
  }
}

function reimportSandboxTask(taskId, userId, ipAddress) {
  const task = db.prepare('SELECT * FROM sandbox_tasks WHERE id = ?').get(taskId);
  if (!task) {
    return { success: false, error: '沙箱任务不存在' };
  }

  if (!task.csv_text) {
    return { success: false, error: '该任务没有CSV内容，无法重新导入' };
  }

  try {
    db.prepare(`
      UPDATE sandbox_tasks
      SET status = 'draft', total_count = 0, new_count = 0,
          overwrite_count = 0, skip_count = 0, fail_count = 0,
          updated_by = ?, updated_at = ?
      WHERE id = ?
    `).run(userId, new Date().toISOString(), taskId);

    db.prepare('DELETE FROM sandbox_records WHERE task_id = ?').run(taskId);

    logConfirmation(taskId, null, 'reimport', {
      task_no: task.task_no
    }, '重新导入沙箱任务，重置为草稿状态', userId, ipAddress);

    logAudit(userId, 'reimport_sandbox_task', 'sandbox_task', taskId, {
      task_no: task.task_no
    }, ipAddress);

    return { success: true, message: '已重置为草稿状态，请重新执行预检' };
  } catch (err) {
    return { success: false, error: '重置失败: ' + err.message };
  }
}

function submitSandboxTask(taskId, userId, ipAddress) {
  const task = db.prepare('SELECT * FROM sandbox_tasks WHERE id = ?').get(taskId);
  if (!task) {
    return { success: false, error: '沙箱任务不存在' };
  }

  if (task.status !== 'practiced' && task.status !== 'prechecked' && task.status !== 'approved') {
    return { success: false, error: '只有演练完成、预检完成或审批通过的任务才能提交' };
  }

  if (task.status === 'submitted') {
    return { success: false, error: '该任务已提交' };
  }

  const records = db.prepare(
    "SELECT * FROM sandbox_records WHERE task_id = ? AND sandbox_status IN ('practice_success', 'practice_overwrite', 'validated', 'conflict') AND is_reverted = 0 AND action_type != 'skip' ORDER BY row_index"
  ).all(taskId);

  const patientStmt = db.prepare(`
    INSERT OR IGNORE INTO patients (name, id_card, phone, gender, age)
    VALUES (?, ?, ?, ?, ?)
  `);
  const getPatientStmt = db.prepare('SELECT id FROM patients WHERE id_card = ?');
  const importRecordStmt = db.prepare(`
    INSERT INTO import_records (
      batch_id, row_index, id_card, name, phone, gender, age,
      department_id, department_name, queue_date, type,
      status, error_code, error_message, is_overwrite, overwrite_hint
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const queueStmt = db.prepare(`
    INSERT INTO queue_records (
      patient_id, department_id, queue_date, queue_number, type,
      batch_id, import_record_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const updateRecordStmt = db.prepare(`
    UPDATE sandbox_records
    SET sandbox_status = 'submitted', practice_result_id = ?, updated_at = ?
    WHERE id = ?
  `);

  const slotUsage = new Map();
  const walkinUsage = new Map();
  const registeredPatients = new Set();
  let successCount = 0, failCount = 0;
  const submitResults = [];
  let batchId = null;

  const transaction = db.transaction(() => {
    const batchResult = db.prepare(`
      INSERT INTO import_batches (batch_no, total_count, success_count, fail_count, status, imported_by)
      VALUES (?, ?, 0, 0, 'processing', ?)
    `).run(task.task_no + '-SBX', records.length, userId);
    batchId = batchResult.lastInsertRowid;

    for (const sr of records) {
      const patientKey = `${sr.id_card}|${sr.department_id}|${sr.queue_date}`;
      if (registeredPatients.has(patientKey)) {
        submitResults.push({ id: sr.id, success: false, reason: '批次中重复挂号' });
        failCount++;
        continue;
      }

      const slotKey = `${sr.department_id}|${sr.queue_date}`;
      const walkinKey = `${sr.department_id}|${sr.queue_date}|walkin`;
      const currentTotal = db.prepare(
        "SELECT COUNT(*) as count FROM queue_records WHERE department_id = ? AND queue_date = ? AND status NOT IN ('returned')"
      ).get(sr.department_id, sr.queue_date).count + (slotUsage.get(slotKey) || 0);
      const currentWalkin = db.prepare(
        "SELECT COUNT(*) as count FROM queue_records WHERE department_id = ? AND queue_date = ? AND type = ? AND status NOT IN ('returned')"
      ).get(sr.department_id, sr.queue_date, 'walkin').count + (walkinUsage.get(walkinKey) || 0);

      const slot = db.prepare('SELECT * FROM daily_slots WHERE department_id = ? AND date = ?').get(sr.department_id, sr.queue_date);
      if (!slot || isDepartmentClosed(sr.department_id, sr.queue_date) ||
          currentTotal >= slot.total_slots ||
          (sr.type === 'walkin' && currentWalkin >= slot.walkin_limit)) {
        submitResults.push({ id: sr.id, success: false, reason: '提交时资源检查失败' });
        failCount++;
        continue;
      }

      const existingReg = db.prepare(`
        SELECT COUNT(*) as count FROM queue_records
        WHERE patient_id IN (SELECT id FROM patients WHERE id_card = ?)
          AND department_id = ? AND queue_date = ?
          AND status NOT IN ('returned')
      `).get(sr.id_card, sr.department_id, sr.queue_date);

      if (sr.action_type !== 'overwrite' && existingReg.count > 0) {
        submitResults.push({ id: sr.id, success: false, reason: '提交时发现重复挂号' });
        failCount++;
        continue;
      }

      patientStmt.run(sr.name, sr.id_card, sr.phone || null, sr.gender || null, sr.age || null);
      const patient = getPatientStmt.get(sr.id_card);

      const ir = importRecordStmt.run(
        batchId, sr.row_index, sr.id_card, sr.name, sr.phone || null,
        sr.gender || null, sr.age || null,
        sr.department_id, sr.department_name, sr.queue_date, sr.type,
        'success', null, null,
        sr.action_type === 'overwrite' ? 1 : 0, sr.conflict_detail || null
      );

      const queueNumber = getNextQueueNumber(sr.department_id, sr.queue_date);
      const qr = queueStmt.run(
        patient.id, sr.department_id, sr.queue_date, queueNumber, sr.type, batchId, ir.lastInsertRowid
      );

      updateRecordStmt.run(qr.lastInsertRowid, new Date().toISOString(), sr.id);

      slotUsage.set(slotKey, (slotUsage.get(slotKey) || 0) + 1);
      if (sr.type === 'walkin') {
        walkinUsage.set(walkinKey, (walkinUsage.get(walkinKey) || 0) + 1);
      }
      registeredPatients.add(patientKey);

      submitResults.push({ id: sr.id, success: true, queue_number: queueNumber });
      successCount++;

      logAudit(userId, 'register_queue', 'queue_record', qr.lastInsertRowid, {
        patient_id: patient.id, patient_name: sr.name, department_id: sr.department_id,
        department_name: sr.department_name, type: sr.type, queue_number: queueNumber,
        sandbox_task_no: task.task_no
      }, ipAddress);
    }

    db.prepare(`
      UPDATE import_batches
      SET status = 'completed', success_count = ?, fail_count = ?,
          confirmed_by = ?, confirmed_at = ?
      WHERE id = ?
    `).run(successCount, failCount, userId, new Date().toISOString(), batchId);

    db.prepare(`
      UPDATE sandbox_tasks
      SET status = 'submitted', submitted_by = ?, submitted_at = ?,
          updated_by = ?, updated_at = ?
      WHERE id = ?
    `).run(userId, new Date().toISOString(), userId, new Date().toISOString(), taskId);

    logConfirmation(taskId, null, 'submit', {
      batch_id: batchId, success: successCount, fail: failCount
    }, `提交完成: 成功${successCount}, 失败${failCount}, 关联批次ID=${batchId}`, userId, ipAddress);

    logAudit(userId, 'submit_sandbox_task', 'sandbox_task', taskId, {
      task_no: task.task_no, batch_id: batchId, success: successCount, fail: failCount
    }, ipAddress);
  });

  try {
    transaction();
    return {
      success: true,
      task_id: taskId,
      batch_id: batchId,
      success_count: successCount,
      fail_count: failCount,
      retry_records: submitResults.filter(r => !r.success).map(r => {
        const sr = records.find(x => x.id === r.id);
        return {
          sandbox_record_id: r.id,
          row_index: sr ? sr.row_index : null,
          id_card: sr ? sr.id_card : null,
          name: sr ? sr.name : null,
          reason: r.reason
        };
      })
    };
  } catch (err) {
    return { success: false, error: '提交失败: ' + err.message };
  }
}

function getSandboxTaskDetail(taskId, userId, userRole) {
  const task = db.prepare(`
    SELECT st.*,
           u1.name as created_by_name, u2.name as updated_by_name,
           u3.name as submitted_by_name, u4.name as approved_by_name,
           u5.name as voided_by_name
    FROM sandbox_tasks st
    LEFT JOIN users u1 ON st.created_by = u1.id
    LEFT JOIN users u2 ON st.updated_by = u2.id
    LEFT JOIN users u3 ON st.submitted_by = u3.id
    LEFT JOIN users u4 ON st.approved_by = u4.id
    LEFT JOIN users u5 ON st.voided_by = u5.id
    WHERE st.id = ?
  `).get(taskId);

  if (!task) {
    return { success: false, error: '沙箱任务不存在' };
  }

  if (userRole !== 'admin' && task.created_by !== userId) {
    return { success: false, error: '无权查看此任务' };
  }

  const records = db.prepare('SELECT * FROM sandbox_records WHERE task_id = ? ORDER BY row_index').all(taskId);
  const confirmations = db.prepare(`
    SELECT sc.*, u.name as performed_by_name
    FROM sandbox_confirmations sc
    LEFT JOIN users u ON sc.performed_by = u.id
    WHERE sc.task_id = ?
    ORDER BY sc.performed_at DESC
  `).all(taskId);
  const mappings = db.prepare('SELECT * FROM sandbox_field_mappings WHERE task_id = ?').all(taskId);

  task.records = records;
  task.confirmations = confirmations;
  task.field_mappings = mappings;

  return { success: true, task };
}

function listSandboxTasks(params, userId, userRole) {
  const { status, page = 1, pageSize = 20 } = params;
  let sql = `
    SELECT st.*, u.name as created_by_name
    FROM sandbox_tasks st
    LEFT JOIN users u ON st.created_by = u.id
    WHERE 1=1
  `;
  const sqlParams = [];

  if (userRole !== 'admin') {
    sql += ' AND st.created_by = ?';
    sqlParams.push(userId);
  }
  if (status) {
    sql += ' AND st.status = ?';
    sqlParams.push(status);
  }

  const countSql = sql.replace('SELECT st.*, u.name as created_by_name', 'SELECT COUNT(*) as total');
  const { total } = db.prepare(countSql).get(...sqlParams);

  sql += ' ORDER BY st.created_at DESC LIMIT ? OFFSET ?';
  sqlParams.push(parseInt(pageSize), (parseInt(page) - 1) * parseInt(pageSize));

  const tasks = db.prepare(sql).all(...sqlParams);

  return {
    success: true,
    tasks,
    pagination: { page: parseInt(page), pageSize: parseInt(pageSize), total }
  };
}

function approveSandboxTask(taskId, userId, ipAddress, remark) {
  const task = db.prepare('SELECT * FROM sandbox_tasks WHERE id = ?').get(taskId);
  if (!task) {
    return { success: false, error: '沙箱任务不存在' };
  }
  if (task.status !== 'practiced') {
    return { success: false, error: '只有演练完成的任务才能审批' };
  }

  try {
    db.prepare(`
      UPDATE sandbox_tasks
      SET status = 'approved', approved_by = ?, approved_at = ?, approval_remark = ?,
          updated_by = ?, updated_at = ?
      WHERE id = ?
    `).run(userId, new Date().toISOString(), remark || '', userId, new Date().toISOString(), taskId);

    logConfirmation(taskId, null, 'approve', { remark: remark || '' }, '审批通过', userId, ipAddress);
    logAudit(userId, 'approve_sandbox_task', 'sandbox_task', taskId, {
      task_no: task.task_no, remark: remark || ''
    }, ipAddress);

    return { success: true, message: '审批通过' };
  } catch (err) {
    return { success: false, error: '审批失败: ' + err.message };
  }
}

function rejectSandboxTask(taskId, userId, ipAddress, remark) {
  const task = db.prepare('SELECT * FROM sandbox_tasks WHERE id = ?').get(taskId);
  if (!task) {
    return { success: false, error: '沙箱任务不存在' };
  }
  if (task.status !== 'practiced') {
    return { success: false, error: '只有演练完成的任务才能审批' };
  }

  try {
    db.prepare(`
      UPDATE sandbox_tasks
      SET status = 'rejected', approved_by = ?, approved_at = ?, approval_remark = ?,
          updated_by = ?, updated_at = ?
      WHERE id = ?
    `).run(userId, new Date().toISOString(), remark || '', userId, new Date().toISOString(), taskId);

    logConfirmation(taskId, null, 'reject', { remark: remark || '' }, '审批拒绝', userId, ipAddress);
    logAudit(userId, 'reject_sandbox_task', 'sandbox_task', taskId, {
      task_no: task.task_no, remark: remark || ''
    }, ipAddress);

    return { success: true, message: '已拒绝' };
  } catch (err) {
    return { success: false, error: '拒绝失败: ' + err.message };
  }
}

function generateSandboxReportCSV(taskId) {
  const task = db.prepare('SELECT * FROM sandbox_tasks WHERE id = ?').get(taskId);
  if (!task) {
    return { success: false, error: '沙箱任务不存在' };
  }

  const records = db.prepare(`
    SELECT sr.*, u.name as reverted_by_name
    FROM sandbox_records sr
    LEFT JOIN users u ON sr.reverted_by = u.id
    WHERE sr.task_id = ?
    ORDER BY sr.row_index
  `).all(taskId);

  const confirmations = db.prepare(`
    SELECT sc.*, u.name as performed_by_name
    FROM sandbox_confirmations sc
    LEFT JOIN users u ON sc.performed_by = u.id
    WHERE sc.task_id = ?
    ORDER BY sc.performed_at
  `).all(taskId);

  const headers = [
    '行号', '身份证号', '姓名', '手机号', '性别', '年龄',
    '科室', '挂号日期', '挂号类型', '沙箱状态', '动作类型',
    '冲突类型', '冲突详情', '演练排队号', '是否已撤销',
    '撤销人', '撤销原因', '错误代码', '错误信息'
  ];

  const statusMap = {
    pending: '待处理', validated: '校验通过', conflict: '冲突',
    skipped: '已跳过', reverted: '已撤销', failed: '失败',
    practice_success: '演练成功', practice_overwrite: '演练覆盖',
    submitted: '已提交', voided: '已作废'
  };
  const actionMap = { new: '新增', overwrite: '覆盖', skip: '跳过' };
  const typeMap = { appointment: '预约', walkin: '现场' };

  const rows = records.map(r => [
    r.row_index, r.id_card, r.name, r.phone || '', r.gender || '', r.age || '',
    r.department_name || '', r.queue_date, typeMap[r.type] || r.type,
    statusMap[r.sandbox_status] || r.sandbox_status, actionMap[r.action_type] || '',
    r.conflict_type || '', r.conflict_detail || '',
    r.practice_queue_number || '', r.is_reverted ? '是' : '否',
    r.reverted_by_name || '', r.revert_reason || '',
    r.error_code || '', r.error_message || ''
  ]);

  let csv = `# 沙箱任务报告 - ${task.task_name} (${task.task_no})\n`;
  csv += `# 任务状态: ${statusMap[task.status] || task.status}\n`;
  csv += `# 总计: ${task.total_count}, 新增: ${task.new_count}, 覆盖: ${task.overwrite_count}, 跳过: ${task.skip_count}, 失败: ${task.fail_count}\n`;
  csv += `# 创建时间: ${task.created_at}\n\n`;
  csv += [headers, ...rows].map(row => row.map(escapeCSV).join(',')).join('\n');

  csv += '\n\n# 操作确认痕迹\n';
  csv += ['时间', '操作人', '动作', '摘要', '详情'].map(escapeCSV).join(',') + '\n';
  for (const c of confirmations) {
    csv += [
      c.performed_at, c.performed_by_name || '', c.action,
      c.summary || '', (c.details || '').replace(/\n/g, ' ')
    ].map(escapeCSV).join(',') + '\n';
  }

  return { success: true, csv, task_no: task.task_no, task_name: task.name };
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
  createSandboxTask,
  precheckSandboxTask,
  practiceSandboxTask,
  revertSandboxRecord,
  voidSandboxTask,
  reimportSandboxTask,
  submitSandboxTask,
  getSandboxTaskDetail,
  listSandboxTasks,
  approveSandboxTask,
  rejectSandboxTask,
  generateSandboxReportCSV
};
