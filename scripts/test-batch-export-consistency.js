const http = require('http');

const BASE_URL = 'http://localhost:3000';
const API_BASE = '/api';

let passed = 0, failed = 0;
function assert(cond, msg) {
  if (cond) { passed++; console.log('✅PASS: ' + msg); }
  else { failed++; console.log('❌FAIL: ' + msg); }
}

function request(path, options = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(API_BASE + path, BASE_URL);
    const method = options.method || 'GET';
    const headers = options.headers || {};
    const req = http.request({
      hostname: url.hostname, port: url.port,
      path: url.pathname + url.search, method,
      headers
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const p = JSON.parse(data);
          if (res.statusCode >= 200 && res.statusCode < 300) resolve(p);
          else reject({ status: res.statusCode, data: p, path: `${method} ${url.pathname}${url.search}` });
        } catch (e) {
          if (res.statusCode >= 200 && res.statusCode < 300) resolve(data);
          else reject({ status: res.statusCode, data, path: `${method} ${url.pathname}${url.search}` });
        }
      });
    });
    req.on('error', reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

function requestText(path, options = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(API_BASE + path, BASE_URL);
    const method = options.method || 'GET';
    const headers = options.headers || {};
    const req = http.request({
      hostname: url.hostname, port: url.port,
      path: url.pathname + url.search, method,
      headers
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) resolve(data);
        else reject({ status: res.statusCode, data, path: `${method} ${url.pathname}${url.search}` });
      });
    });
    req.on('error', reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

function parseCSVLine(line) {
  const result = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"') {
      if (inQuotes && line[i + 1] === '"') { current += '"'; i++; }
      else inQuotes = !inQuotes;
    } else if (char === ',' && !inQuotes) {
      result.push(current);
      current = '';
    } else current += char;
  }
  result.push(current);
  return result;
}

function parseCSV(csvText) {
  const lines = csvText.trim().replace(/^\uFEFF/, '').split('\n');
  return lines.map(parseCSVLine);
}

async function ensureSlots(adminHeaders, today) {
  for (const deptId of [1, 2]) {
    try {
      await request('/admin/daily-slots', {
        method: 'POST', headers: adminHeaders,
        body: JSON.stringify({ department_id: deptId, date: today, total_slots: 200, walkin_limit: 100 })
      });
    } catch (e) {
      const existing = await request(`/admin/daily-slots?department_id=${deptId}&date=${today}`, { headers: adminHeaders });
      if (existing.length > 0) {
        await request(`/admin/daily-slots/${existing[0].id}`, {
          method: 'PUT', headers: adminHeaders,
          body: JSON.stringify({ total_slots: 200, walkin_limit: 100 })
        });
      }
    }
  }
}

async function main() {
  const today = new Date().toISOString().split('T')[0];
  const runId = Date.now().toString().slice(-4);
  const idPrefix = `1101011988${runId}`;
  function idc(base) { return idPrefix + String(base).padStart(4, '0').slice(-4); }

  console.log(`=== 批量导入导出一致性回归测试 (${today}, runId=${runId}) ===\n`);

  const nurseLogin = await request('/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'nurse1', password: 'nurse123' })
  });
  const nurseH = { 'Authorization': 'Bearer ' + nurseLogin.token, 'Content-Type': 'application/json' };
  const nurseNoCT = { 'Authorization': 'Bearer ' + nurseLogin.token };

  const adminLogin = await request('/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin123' })
  });
  const adminH = { 'Authorization': 'Bearer ' + adminLogin.token, 'Content-Type': 'application/json' };

  await ensureSlots(adminH, today);

  try {
    const periods = await request('/admin/closed-periods', { headers: adminH });
    for (const p of periods) {
      if (p.start_date <= today && p.end_date >= today) {
        await request(`/admin/closed-periods/${p.id}`, { method: 'DELETE', headers: adminH });
      }
    }
  } catch (_) {}

  console.log('登录 & 号源配置完成\n');

  // ==========================================
  // 用例 1: 草稿批次导出CSV与页面状态一致
  // ==========================================
  console.log('=== 用例1: 草稿批次导出CSV与页面状态一致 ===');

  const csv1 = `id_card,name,department,queue_date,type\n${idc(101)},导出A1,内科,${today},预约\n${idc(102)},导出A2,不存在的科室,${today},预约\n${idc(103)},导出A3,内科,${today},预约\n${idc(103)},导出A4,内科,${today},预约`;
  const pre1 = await request('/nurse/batch/precheck', {
    method: 'POST', headers: nurseH, body: JSON.stringify({ csv_text: csv1 })
  });
  assert(pre1.success === true, '1 预检成功');
  assert(pre1.success_count === 2, '1 预检成功 2 条');
  assert(pre1.fail_count === 2, '1 预检失败 2 条');

  const batch1 = await request(`/nurse/batches/${pre1.batch_id}`, { headers: nurseH });
  assert(batch1.status === 'draft', '1 批次状态为 draft');
  assert(batch1.records.length === 4, '1 有 4 条记录');

  const export1 = await requestText(`/nurse/batches/${pre1.batch_id}/csv`, { headers: nurseNoCT });
  const csvParsed1 = parseCSV(export1);
  assert(csvParsed1.length === 5, '1 CSV有 5 行（1行表头 + 4行数据）');

  const headers1 = csvParsed1[0];
  const expectedHeaders = ['行号', '身份证号', '姓名', '手机号', '性别', '年龄', '科室', '挂号日期', '挂号类型', '状态', '是否覆盖', '覆盖提示', '错误代码', '错误信息'];
  assert(headers1.join(',') === expectedHeaders.join(','), '1 CSV表头正确');

  const pageRecords1 = batch1.records.sort((a, b) => a.row_index - b.row_index);
  for (let i = 0; i < pageRecords1.length; i++) {
    const pageRec = pageRecords1[i];
    const csvRow = csvParsed1[i + 1];

    assert(parseInt(csvRow[0]) === pageRec.row_index, `1 row${i + 1}: 行号一致`);
    assert(csvRow[1] === pageRec.id_card, `1 row${i + 1}: 身份证号一致`);
    assert(csvRow[2] === pageRec.name, `1 row${i + 1}: 姓名一致`);
    assert(csvRow[6] === (pageRec.department_name || ''), `1 row${i + 1}: 科室一致`);
    assert(csvRow[7] === pageRec.queue_date, `1 row${i + 1}: 挂号日期一致`);

    const expectedStatus = pageRec.status === 'draft_success' ? '预检通过' :
                          pageRec.status === 'draft_failed' ? '预检失败' :
                          pageRec.status;
    assert(csvRow[9] === expectedStatus, `1 row${i + 1}: 状态一致 (${csvRow[9]} === ${expectedStatus})`);

    const expectedOverwrite = pageRec.is_overwrite ? '是' : '否';
    assert(csvRow[10] === expectedOverwrite, `1 row${i + 1}: 是否覆盖一致`);
    assert(csvRow[11] === (pageRec.overwrite_hint || ''), `1 row${i + 1}: 覆盖提示一致`);
    assert(csvRow[12] === (pageRec.error_code || ''), `1 row${i + 1}: 错误代码一致`);
    assert(csvRow[13] === (pageRec.error_message || ''), `1 row${i + 1}: 错误信息一致`);
  }

  console.log('用例1 通过 ✅ 草稿批次导出CSV与页面状态一致\n');

  // ==========================================
  // 用例 2: 确认后批次导出CSV与页面状态一致
  // ==========================================
  console.log('=== 用例2: 确认后批次导出CSV与页面状态一致 ===');

  const conf2 = await request('/nurse/batch/confirm', {
    method: 'POST', headers: nurseH, body: JSON.stringify({ batch_id: pre1.batch_id })
  });
  assert(conf2.success === true, '2 确认成功');
  assert(conf2.success_count === 2, '2 成功 2 条');
  assert(conf2.fail_count === 2, '2 失败 2 条');

  const batch2 = await request(`/nurse/batches/${pre1.batch_id}`, { headers: nurseH });
  assert(batch2.status === 'completed', '2 批次状态为 completed');

  const enqueuedRecords2 = batch2.records.filter(r => r.status === 'enqueued');
  const failedRecords2 = batch2.records.filter(r => r.status === 'precheck_failed' || r.status === 'failed');
  assert(enqueuedRecords2.length === 2, '2 有 2 条"已入队"记录');
  assert(failedRecords2.length === 2, '2 有 2 条"预检失败"记录');

  const export2 = await requestText(`/nurse/batches/${pre1.batch_id}/csv`, { headers: nurseNoCT });
  const csvParsed2 = parseCSV(export2);
  assert(csvParsed2.length === 5, '2 CSV有 5 行');

  const pageRecords2 = batch2.records.sort((a, b) => a.row_index - b.row_index);
  for (let i = 0; i < pageRecords2.length; i++) {
    const pageRec = pageRecords2[i];
    const csvRow = csvParsed2[i + 1];

    let expectedStatus;
    if (pageRec.status === 'enqueued') {
      expectedStatus = '已入队';
    } else if (pageRec.status === 'precheck_failed' || pageRec.status === 'draft_failed') {
      expectedStatus = '预检失败';
    } else if (pageRec.status === 'confirm_failed') {
      expectedStatus = '确认失败';
    } else if (pageRec.status === 'failed') {
      expectedStatus = '失败';
    } else {
      expectedStatus = pageRec.status;
    }
    assert(csvRow[9] === expectedStatus, `2 row${i + 1}: 状态一致 (${csvRow[9]} === ${expectedStatus})`);
    assert(parseInt(csvRow[0]) === pageRec.row_index, `2 row${i + 1}: 行号一致`);
    assert(csvRow[1] === pageRec.id_card, `2 row${i + 1}: 身份证号一致`);
    assert(csvRow[2] === pageRec.name, `2 row${i + 1}: 姓名一致`);
    assert(csvRow[10] === (pageRec.is_overwrite ? '是' : '否'), `2 row${i + 1}: 是否覆盖一致`);
    assert(csvRow[13] === (pageRec.error_message || ''), `2 row${i + 1}: 错误信息一致`);
  }

  console.log('用例2 通过 ✅ 确认后批次导出CSV与页面状态一致\n');

  // ==========================================
  // 用例 3: 撤销后批次导出CSV与页面状态一致
  // ==========================================
  console.log('=== 用例3: 撤销后批次导出CSV与页面状态一致 ===');

  const csv3 = `id_card,name,department,queue_date,type\n${idc(301)},导出B1,内科,${today},预约\n${idc(302)},导出B2,内科,${today},预约`;
  const pre3 = await request('/nurse/batch/precheck', {
    method: 'POST', headers: nurseH, body: JSON.stringify({ csv_text: csv3 })
  });
  await request('/nurse/batch/confirm', {
    method: 'POST', headers: nurseH, body: JSON.stringify({ batch_id: pre3.batch_id })
  });

  const rvk3 = await request(`/nurse/batches/${pre3.batch_id}/revoke`, {
    method: 'POST', headers: nurseH, body: JSON.stringify({ reason: '导出测试撤销' })
  });
  assert(rvk3.success === true, '3 撤销成功');

  const batch3 = await request(`/nurse/batches/${pre3.batch_id}`, { headers: nurseH });
  assert(batch3.status === 'revoked', '3 批次状态为 revoked');

  const export3 = await requestText(`/nurse/batches/${pre3.batch_id}/csv`, { headers: nurseNoCT });
  const csvParsed3 = parseCSV(export3);
  const pageRecords3 = batch3.records.sort((a, b) => a.row_index - b.row_index);

  for (let i = 0; i < pageRecords3.length; i++) {
    const pageRec = pageRecords3[i];
    const csvRow = csvParsed3[i + 1];

    assert(csvRow[9] === '失败', `3 row${i + 1}: 撤销后状态为"失败"`);
    assert(csvRow[12] === 'BATCH_REVOKED', `3 row${i + 1}: 错误代码为 BATCH_REVOKED`);
    assert(csvRow[13].includes('已撤销'), `3 row${i + 1}: 错误信息包含"已撤销"`);
  }

  console.log('用例3 通过 ✅ 撤销后批次导出CSV与页面状态一致\n');

  // ==========================================
  // 用例 4: 草稿撤销后导出CSV与页面状态一致
  // ==========================================
  console.log('=== 用例4: 草稿撤销后导出CSV与页面状态一致 ===');

  const csv4 = `id_card,name,department,queue_date,type\n${idc(401)},导出C1,内科,${today},预约`;
  const pre4 = await request('/nurse/batch/precheck', {
    method: 'POST', headers: nurseH, body: JSON.stringify({ csv_text: csv4 })
  });

  const rvk4 = await request(`/nurse/batches/${pre4.batch_id}/revoke`, {
    method: 'POST', headers: nurseH, body: JSON.stringify({ reason: '草稿撤销' })
  });
  assert(rvk4.success === true, '4 草稿撤销成功');

  const batch4 = await request(`/nurse/batches/${pre4.batch_id}`, { headers: nurseH });
  assert(batch4.status === 'revoked', '4 批次状态为 revoked');

  const export4 = await requestText(`/nurse/batches/${pre4.batch_id}/csv`, { headers: nurseNoCT });
  const csvParsed4 = parseCSV(export4);
  const csvRow4 = csvParsed4[1];

  assert(csvRow4[9] === '失败', '4 撤销后状态为"失败"');
  assert(csvRow4[12] === 'BATCH_REVOKED', '4 错误代码为 BATCH_REVOKED');
  assert(csvRow4[13].includes('草稿批次已撤销'), '4 错误信息包含"草稿批次已撤销"');

  console.log('用例4 通过 ✅ 草稿撤销后导出CSV与页面状态一致\n');

  // ==========================================
  // 用例 5: 管理员导出与护士导出内容一致
  // ==========================================
  console.log('=== 用例5: 管理员导出与护士导出内容一致 ===');

  const export5Nurse = await requestText(`/nurse/batches/${pre1.batch_id}/csv`, { headers: nurseNoCT });
  const adminNoCT = { 'Authorization': 'Bearer ' + adminLogin.token };
  const export5Admin = await requestText(`/admin/batches/${pre1.batch_id}/csv`, { headers: adminNoCT });

  const cleanCSV = (csv) => csv.trim().replace(/^\uFEFF/, '');
  assert(cleanCSV(export5Nurse) === cleanCSV(export5Admin), '5 管理员与护士导出内容一致');

  console.log('用例5 通过 ✅ 管理员导出与护士导出内容一致\n');

  // ==========================================
  // 用例 6: CSV包含覆盖相关字段
  // ==========================================
  console.log('=== 用例6: CSV包含覆盖相关字段 ===');

  const csv6a = `id_card,name,department,queue_date,type\n${idc(601)},导出D1,内科,${today},预约`;
  const imp6a = await request('/nurse/batch/precheck', {
    method: 'POST', headers: nurseH, body: JSON.stringify({ csv_text: csv6a })
  });
  await request('/nurse/batch/confirm', {
    method: 'POST', headers: nurseH, body: JSON.stringify({ batch_id: imp6a.batch_id })
  });

  const csv6b = `id_card,name,department,queue_date,type\n${idc(601)},导出D1,内科,${today},预约\n${idc(602)},导出D2,内科,${today},预约`;
  const pre6 = await request('/nurse/batch/precheck', {
    method: 'POST', headers: nurseH, body: JSON.stringify({ csv_text: csv6b })
  });

  const export6 = await requestText(`/nurse/batches/${pre6.batch_id}/csv`, { headers: nurseNoCT });
  const csvParsed6 = parseCSV(export6);
  const headers6 = csvParsed6[0];

  const overwriteIdx = headers6.indexOf('是否覆盖');
  const hintIdx = headers6.indexOf('覆盖提示');
  assert(overwriteIdx >= 0, '6 CSV包含"是否覆盖"列');
  assert(hintIdx >= 0, '6 CSV包含"覆盖提示"列');

  const row1 = csvParsed6[1];
  assert(row1[overwriteIdx] === '是', '6 row1 是否覆盖为"是"');
  assert(row1[hintIdx].includes('已在此科室挂号'), '6 row1 覆盖提示正确');

  const row2 = csvParsed6[2];
  assert(row2[overwriteIdx] === '否', '6 row2 是否覆盖为"否"');
  assert(row2[hintIdx] === '', '6 row2 覆盖提示为空');

  console.log('用例6 通过 ✅ CSV包含覆盖相关字段\n');

  console.log('=== 测试完成 ===');
  console.log(`通过: ${passed}, 失败: ${failed}`);
  if (failed > 0) process.exit(1);
}

main().catch(e => { console.error('测试执行出错:', e.path || '', e.status ? JSON.stringify(e.data || e) : (e.message || e)); process.exit(1); });
