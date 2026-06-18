const fs = require('fs');
const path = require('path');
const db = require('../src/db');

const dataDir = path.join(__dirname, '../data');
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const initSql = `
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  password TEXT NOT NULL,
  name TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('admin', 'nurse', 'doctor')),
  department_id INTEGER,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (department_id) REFERENCES departments(id)
);

CREATE TABLE IF NOT EXISTS departments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT UNIQUE NOT NULL,
  code TEXT UNIQUE NOT NULL,
  description TEXT,
  is_active INTEGER DEFAULT 1,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS daily_slots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  department_id INTEGER NOT NULL,
  date TEXT NOT NULL,
  total_slots INTEGER NOT NULL DEFAULT 20,
  walkin_limit INTEGER NOT NULL DEFAULT 5,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (department_id) REFERENCES departments(id),
  UNIQUE(department_id, date)
);

CREATE TABLE IF NOT EXISTS closed_periods (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  department_id INTEGER NOT NULL,
  start_date TEXT NOT NULL,
  end_date TEXT NOT NULL,
  reason TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (department_id) REFERENCES departments(id)
);

CREATE TABLE IF NOT EXISTS patients (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  id_card TEXT UNIQUE NOT NULL,
  phone TEXT,
  gender TEXT CHECK(gender IN ('男', '女')),
  age INTEGER,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS queue_records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  patient_id INTEGER NOT NULL,
  department_id INTEGER NOT NULL,
  queue_date TEXT NOT NULL,
  queue_number INTEGER NOT NULL,
  type TEXT NOT NULL CHECK(type IN ('appointment', 'walkin')),
  status TEXT NOT NULL DEFAULT 'waiting' CHECK(status IN ('waiting', 'called', 'consulting', 'completed', 'missed', 'returned')),
  called_at DATETIME,
  called_by INTEGER,
  consulting_doctor_id INTEGER,
  consultation_started_at DATETIME,
  consultation_ended_at DATETIME,
  return_reason TEXT,
  returned_by INTEGER,
  returned_at DATETIME,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (patient_id) REFERENCES patients(id),
  FOREIGN KEY (department_id) REFERENCES departments(id),
  FOREIGN KEY (called_by) REFERENCES users(id),
  FOREIGN KEY (consulting_doctor_id) REFERENCES users(id),
  FOREIGN KEY (returned_by) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS consultation_records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  queue_record_id INTEGER NOT NULL,
  patient_id INTEGER NOT NULL,
  doctor_id INTEGER NOT NULL,
  department_id INTEGER NOT NULL,
  symptoms TEXT,
  diagnosis TEXT,
  prescription TEXT,
  notes TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (queue_record_id) REFERENCES queue_records(id),
  FOREIGN KEY (patient_id) REFERENCES patients(id),
  FOREIGN KEY (doctor_id) REFERENCES users(id),
  FOREIGN KEY (department_id) REFERENCES departments(id)
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER,
  action TEXT NOT NULL,
  target_type TEXT,
  target_id INTEGER,
  details TEXT,
  ip_address TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS import_batches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_no TEXT UNIQUE NOT NULL,
  total_count INTEGER NOT NULL DEFAULT 0,
  success_count INTEGER NOT NULL DEFAULT 0,
  fail_count INTEGER NOT NULL DEFAULT 0,
  precheck_failed_count INTEGER NOT NULL DEFAULT 0,
  confirm_failed_count INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('draft', 'pending', 'processing', 'completed', 'failed', 'revoked')),
  imported_by INTEGER NOT NULL,
  imported_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  confirmed_by INTEGER,
  confirmed_at DATETIME,
  revoked_by INTEGER,
  revoked_at DATETIME,
  revoke_reason TEXT,
  FOREIGN KEY (imported_by) REFERENCES users(id),
  FOREIGN KEY (confirmed_by) REFERENCES users(id),
  FOREIGN KEY (revoked_by) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS import_records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_id INTEGER NOT NULL,
  row_index INTEGER NOT NULL,
  id_card TEXT NOT NULL,
  name TEXT NOT NULL,
  phone TEXT,
  gender TEXT,
  age INTEGER,
  department_id INTEGER,
  department_name TEXT,
  queue_date TEXT NOT NULL,
  type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('draft_success', 'draft_failed', 'precheck_failed', 'confirm_failed', 'pending', 'success', 'failed', 'enqueued')),
  error_code TEXT,
  error_message TEXT,
  is_overwrite INTEGER DEFAULT 0,
  overwrite_hint TEXT,
  patient_id INTEGER,
  queue_record_id INTEGER,
  FOREIGN KEY (batch_id) REFERENCES import_batches(id) ON DELETE CASCADE,
  FOREIGN KEY (patient_id) REFERENCES patients(id),
  FOREIGN KEY (queue_record_id) REFERENCES queue_records(id),
  UNIQUE(batch_id, row_index)
);

CREATE INDEX IF NOT EXISTS idx_queue_department_date ON queue_records(department_id, queue_date);
CREATE INDEX IF NOT EXISTS idx_queue_status ON queue_records(status);
CREATE INDEX IF NOT EXISTS idx_audit_user ON audit_logs(user_id);
CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_logs(action);
CREATE INDEX IF NOT EXISTS idx_import_batch_date ON import_batches(DATE(imported_at));
CREATE INDEX IF NOT EXISTS idx_import_record_batch ON import_records(batch_id);
CREATE INDEX IF NOT EXISTS idx_import_record_status ON import_records(status);

CREATE TABLE IF NOT EXISTS sandbox_tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_no TEXT UNIQUE NOT NULL,
  task_name TEXT NOT NULL,
  template_version TEXT NOT NULL DEFAULT 'v1',
  target_dataset TEXT NOT NULL DEFAULT 'queue_records',
  scope_type TEXT NOT NULL DEFAULT 'department' CHECK(scope_type IN ('department', 'all', 'custom')),
  scope_value TEXT,
  status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN (
    'draft', 'prechecking', 'prechecked', 'practicing', 'practiced',
    'pending_approval', 'approved', 'rejected', 'submitting',
    'submitted', 'voided'
  )),
  total_count INTEGER NOT NULL DEFAULT 0,
  new_count INTEGER NOT NULL DEFAULT 0,
  overwrite_count INTEGER NOT NULL DEFAULT 0,
  skip_count INTEGER NOT NULL DEFAULT 0,
  fail_count INTEGER NOT NULL DEFAULT 0,
  csv_text TEXT,
  created_by INTEGER NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_by INTEGER,
  updated_at DATETIME,
  submitted_by INTEGER,
  submitted_at DATETIME,
  approved_by INTEGER,
  approved_at DATETIME,
  approval_remark TEXT,
  voided_by INTEGER,
  voided_at DATETIME,
  void_reason TEXT,
  FOREIGN KEY (created_by) REFERENCES users(id),
  FOREIGN KEY (submitted_by) REFERENCES users(id),
  FOREIGN KEY (approved_by) REFERENCES users(id),
  FOREIGN KEY (voided_by) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS sandbox_records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER NOT NULL,
  row_index INTEGER NOT NULL,
  id_card TEXT NOT NULL,
  name TEXT NOT NULL,
  phone TEXT,
  gender TEXT,
  age INTEGER,
  department_id INTEGER,
  department_name TEXT,
  queue_date TEXT NOT NULL,
  type TEXT NOT NULL,
  sandbox_status TEXT NOT NULL DEFAULT 'pending' CHECK(sandbox_status IN (
    'pending', 'validated', 'conflict', 'skipped', 'reverted', 'failed',
    'practice_success', 'practice_overwrite', 'submitted', 'voided'
  )),
  conflict_type TEXT,
  conflict_detail TEXT,
  action_type TEXT CHECK(action_type IN ('new', 'overwrite', 'skip')),
  error_code TEXT,
  error_message TEXT,
  practice_result_id INTEGER,
  practice_queue_number INTEGER,
  practice_patient_id INTEGER,
  is_reverted INTEGER DEFAULT 0,
  reverted_by INTEGER,
  reverted_at DATETIME,
  revert_reason TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME,
  FOREIGN KEY (task_id) REFERENCES sandbox_tasks(id) ON DELETE CASCADE,
  FOREIGN KEY (reverted_by) REFERENCES users(id),
  UNIQUE(task_id, row_index)
);

CREATE TABLE IF NOT EXISTS sandbox_confirmations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER NOT NULL,
  record_id INTEGER,
  action TEXT NOT NULL CHECK(action IN (
    'precheck', 'practice', 'revert_record', 'void_task', 'resubmit',
    'submit', 'approve', 'reject', 'reimport'
  )),
  details TEXT,
  summary TEXT,
  performed_by INTEGER NOT NULL,
  performed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  ip_address TEXT,
  FOREIGN KEY (task_id) REFERENCES sandbox_tasks(id) ON DELETE CASCADE,
  FOREIGN KEY (record_id) REFERENCES sandbox_records(id) ON DELETE CASCADE,
  FOREIGN KEY (performed_by) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS sandbox_field_mappings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER NOT NULL,
  source_field TEXT NOT NULL,
  target_field TEXT NOT NULL,
  is_required INTEGER DEFAULT 0,
  transform_rule TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (task_id) REFERENCES sandbox_tasks(id) ON DELETE CASCADE,
  UNIQUE(task_id, source_field)
);

CREATE INDEX IF NOT EXISTS idx_sandbox_task_status ON sandbox_tasks(status);
CREATE INDEX IF NOT EXISTS idx_sandbox_task_created ON sandbox_tasks(created_at);
CREATE INDEX IF NOT EXISTS idx_sandbox_record_task ON sandbox_records(task_id);
CREATE INDEX IF NOT EXISTS idx_sandbox_record_status ON sandbox_records(sandbox_status);
CREATE INDEX IF NOT EXISTS idx_sandbox_confirmation_task ON sandbox_confirmations(task_id);
CREATE INDEX IF NOT EXISTS idx_sandbox_mapping_task ON sandbox_field_mappings(task_id);
`;

db.exec(initSql);

const pragmaInfo = db.prepare("PRAGMA table_info(queue_records)").all();
const existingColumns = pragmaInfo.map(c => c.name);
if (!existingColumns.includes('batch_id')) {
  db.exec(`
    ALTER TABLE queue_records ADD COLUMN batch_id INTEGER REFERENCES import_batches(id);
    ALTER TABLE queue_records ADD COLUMN import_record_id INTEGER REFERENCES import_records(id);
  `);
}
db.exec("CREATE INDEX IF NOT EXISTS idx_queue_batch ON queue_records(batch_id);");

const batchPragma = db.prepare("PRAGMA table_info(import_batches)").all();
const batchColumns = batchPragma.map(c => c.name);
if (!batchColumns.includes('confirmed_by')) {
  db.exec(`
    ALTER TABLE import_batches ADD COLUMN confirmed_by INTEGER REFERENCES users(id);
    ALTER TABLE import_batches ADD COLUMN confirmed_at DATETIME;
  `);
}

const recordPragma = db.prepare("PRAGMA table_info(import_records)").all();
const recordColumns = recordPragma.map(c => c.name);
if (!recordColumns.includes('is_overwrite')) {
  db.exec(`
    ALTER TABLE import_records ADD COLUMN is_overwrite INTEGER DEFAULT 0;
    ALTER TABLE import_records ADD COLUMN overwrite_hint TEXT;
  `);
}

const batchPragma2 = db.prepare("PRAGMA table_info(import_batches)").all();
const batchColumns2 = batchPragma2.map(c => c.name);
if (!batchColumns2.includes('precheck_failed_count')) {
  db.exec(`
    ALTER TABLE import_batches ADD COLUMN precheck_failed_count INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE import_batches ADD COLUMN confirm_failed_count INTEGER NOT NULL DEFAULT 0;
  `);
}

console.log('数据库初始化完成');
