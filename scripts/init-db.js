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
