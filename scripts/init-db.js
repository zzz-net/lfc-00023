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

CREATE TABLE IF NOT EXISTS followup_configs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  config_key TEXT UNIQUE NOT NULL,
  config_value TEXT NOT NULL,
  description TEXT,
  updated_by INTEGER,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (updated_by) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS followup_plans (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  patient_id INTEGER NOT NULL,
  doctor_id INTEGER NOT NULL,
  department_id INTEGER NOT NULL,
  queue_record_id INTEGER,
  consultation_record_id INTEGER,
  followup_date TEXT NOT NULL,
  reminder_method TEXT NOT NULL CHECK(reminder_method IN ('电话', '短信', '微信', '无')),
  notes TEXT,
  related_diagnosis TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN (
    'pending', 'contacted', 'no_answer', 'cancelled', 'completed'
  )),
  contact_result TEXT,
  contacted_by INTEGER,
  contacted_at DATETIME,
  cancel_reason TEXT,
  cancelled_by INTEGER,
  cancelled_at DATETIME,
  created_by INTEGER NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (patient_id) REFERENCES patients(id),
  FOREIGN KEY (doctor_id) REFERENCES users(id),
  FOREIGN KEY (department_id) REFERENCES departments(id),
  FOREIGN KEY (queue_record_id) REFERENCES queue_records(id),
  FOREIGN KEY (consultation_record_id) REFERENCES consultation_records(id),
  FOREIGN KEY (contacted_by) REFERENCES users(id),
  FOREIGN KEY (cancelled_by) REFERENCES users(id),
  FOREIGN KEY (created_by) REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS idx_followup_patient ON followup_plans(patient_id);
CREATE INDEX IF NOT EXISTS idx_followup_doctor ON followup_plans(doctor_id);
CREATE INDEX IF NOT EXISTS idx_followup_department ON followup_plans(department_id);
CREATE INDEX IF NOT EXISTS idx_followup_date ON followup_plans(followup_date);
CREATE INDEX IF NOT EXISTS idx_followup_status ON followup_plans(status);
CREATE INDEX IF NOT EXISTS idx_followup_created ON followup_plans(created_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_followup_unique_active ON followup_plans(patient_id, department_id, followup_date) WHERE status != 'cancelled';
`;

db.exec(initSql);

const followupConfigStmt = db.prepare("INSERT OR IGNORE INTO followup_configs (config_key, config_value, description) VALUES (?, ?, ?)");
followupConfigStmt.run('reminder_advance_days', '1', '随访提醒提前天数（默认1天）');

try {
  const tableInfo = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='followup_plans'").get();
  if (tableInfo && tableInfo.sql && tableInfo.sql.includes('UNIQUE(patient_id, department_id, followup_date)')) {
    console.log('检测到旧版随访表结构，开始迁移...');
    db.exec(`
      CREATE TABLE IF NOT EXISTS followup_plans_backup AS SELECT * FROM followup_plans;
      DROP TABLE followup_plans;
    `);
    db.exec(initSql);
    db.exec(`
      INSERT INTO followup_plans SELECT * FROM followup_plans_backup;
      DROP TABLE followup_plans_backup;
    `);
    console.log('随访表迁移完成');
  }
} catch (e) {
  console.log('随访表迁移检查跳过:', e.message);
}

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

const examInitSql = `
CREATE TABLE IF NOT EXISTS exam_types (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT UNIQUE NOT NULL,
  code TEXT UNIQUE NOT NULL,
  department_id INTEGER NOT NULL,
  description TEXT,
  default_duration INTEGER NOT NULL DEFAULT 15,
  is_active INTEGER DEFAULT 1,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (department_id) REFERENCES departments(id)
);

CREATE TABLE IF NOT EXISTS exam_slots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  exam_type_id INTEGER NOT NULL,
  date TEXT NOT NULL,
  start_time TEXT NOT NULL,
  end_time TEXT NOT NULL,
  total_capacity INTEGER NOT NULL DEFAULT 1,
  booked_count INTEGER NOT NULL DEFAULT 0,
  waitlist_limit INTEGER NOT NULL DEFAULT 3,
  status TEXT NOT NULL DEFAULT 'available' CHECK(status IN ('available', 'full', 'closed', 'cancelled')),
  created_by INTEGER,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (exam_type_id) REFERENCES exam_types(id),
  FOREIGN KEY (created_by) REFERENCES users(id),
  UNIQUE(exam_type_id, date, start_time)
);

CREATE TABLE IF NOT EXISTS exam_orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_no TEXT UNIQUE NOT NULL,
  patient_id INTEGER NOT NULL,
  exam_type_id INTEGER NOT NULL,
  department_id INTEGER NOT NULL,
  consultation_record_id INTEGER,
  queue_record_id INTEGER,
  ordered_by INTEGER NOT NULL,
  clinical_indication TEXT,
  urgency TEXT NOT NULL DEFAULT 'normal' CHECK(urgency IN ('normal', 'urgent', 'emergency')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN (
    'pending', 'scheduled', 'rescheduling', 'completed', 'cancelled', 'rejected'
  )),
  scheduled_slot_id INTEGER,
  result TEXT,
  notes TEXT,
  cancel_reason TEXT,
  cancelled_by INTEGER,
  cancelled_at DATETIME,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (patient_id) REFERENCES patients(id),
  FOREIGN KEY (exam_type_id) REFERENCES exam_types(id),
  FOREIGN KEY (department_id) REFERENCES departments(id),
  FOREIGN KEY (consultation_record_id) REFERENCES consultation_records(id),
  FOREIGN KEY (queue_record_id) REFERENCES queue_records(id),
  FOREIGN KEY (ordered_by) REFERENCES users(id),
  FOREIGN KEY (scheduled_slot_id) REFERENCES exam_slots(id),
  FOREIGN KEY (cancelled_by) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS exam_reschedule_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  request_no TEXT UNIQUE NOT NULL,
  exam_order_id INTEGER NOT NULL,
  patient_id INTEGER NOT NULL,
  exam_type_id INTEGER NOT NULL,
  original_slot_id INTEGER NOT NULL,
  requested_start_date TEXT NOT NULL,
  requested_end_date TEXT NOT NULL,
  preferred_time TEXT,
  reason TEXT NOT NULL,
  remarks TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN (
    'pending', 'approved', 'rejected', 'cancelled', 'reverted'
  )),
  requested_by INTEGER NOT NULL,
  reviewed_by INTEGER,
  reviewed_at DATETIME,
  review_notes TEXT,
  new_slot_id INTEGER,
  reverted_by INTEGER,
  reverted_at DATETIME,
  revert_reason TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (exam_order_id) REFERENCES exam_orders(id),
  FOREIGN KEY (patient_id) REFERENCES patients(id),
  FOREIGN KEY (exam_type_id) REFERENCES exam_types(id),
  FOREIGN KEY (original_slot_id) REFERENCES exam_slots(id),
  FOREIGN KEY (requested_by) REFERENCES users(id),
  FOREIGN KEY (reviewed_by) REFERENCES users(id),
  FOREIGN KEY (new_slot_id) REFERENCES exam_slots(id),
  FOREIGN KEY (reverted_by) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS exam_waitlist (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  exam_order_id INTEGER NOT NULL,
  patient_id INTEGER NOT NULL,
  exam_type_id INTEGER NOT NULL,
  target_date TEXT NOT NULL,
  preferred_time TEXT,
  priority INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'waiting' CHECK(status IN (
    'waiting', 'promoted', 'cancelled', 'expired'
  )),
  added_by INTEGER NOT NULL,
  promoted_by INTEGER,
  promoted_at DATETIME,
  promoted_slot_id INTEGER,
  cancel_reason TEXT,
  cancelled_by INTEGER,
  cancelled_at DATETIME,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (exam_order_id) REFERENCES exam_orders(id),
  FOREIGN KEY (patient_id) REFERENCES patients(id),
  FOREIGN KEY (exam_type_id) REFERENCES exam_types(id),
  FOREIGN KEY (added_by) REFERENCES users(id),
  FOREIGN KEY (promoted_by) REFERENCES users(id),
  FOREIGN KEY (promoted_slot_id) REFERENCES exam_slots(id),
  FOREIGN KEY (cancelled_by) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS exam_change_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  exam_order_id INTEGER NOT NULL,
  change_type TEXT NOT NULL CHECK(change_type IN (
    'create', 'schedule', 'reschedule_request', 'reschedule_approve',
    'reschedule_reject', 'reschedule_cancel', 'reschedule_revert',
    'waitlist_add', 'waitlist_promote', 'waitlist_cancel',
    'complete', 'cancel', 'status_update'
  )),
  from_status TEXT,
  to_status TEXT,
  from_slot_id INTEGER,
  to_slot_id INTEGER,
  details TEXT,
  performed_by INTEGER NOT NULL,
  ip_address TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (exam_order_id) REFERENCES exam_orders(id),
  FOREIGN KEY (from_slot_id) REFERENCES exam_slots(id),
  FOREIGN KEY (to_slot_id) REFERENCES exam_slots(id),
  FOREIGN KEY (performed_by) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS exam_notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER,
  patient_id INTEGER,
  exam_order_id INTEGER,
  type TEXT NOT NULL CHECK(type IN (
    'schedule_confirm', 'reschedule_request', 'reschedule_approved',
    'reschedule_rejected', 'waitlist_promoted', 'exam_reminder',
    'exam_cancelled', 'exam_completed'
  )),
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  is_read INTEGER DEFAULT 0,
  read_at DATETIME,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id),
  FOREIGN KEY (patient_id) REFERENCES patients(id),
  FOREIGN KEY (exam_order_id) REFERENCES exam_orders(id)
);

CREATE TABLE IF NOT EXISTS exam_configs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  config_key TEXT UNIQUE NOT NULL,
  config_value TEXT NOT NULL,
  description TEXT,
  updated_by INTEGER,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (updated_by) REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS idx_exam_order_patient ON exam_orders(patient_id);
CREATE INDEX IF NOT EXISTS idx_exam_order_type ON exam_orders(exam_type_id);
CREATE INDEX IF NOT EXISTS idx_exam_order_status ON exam_orders(status);
CREATE INDEX IF NOT EXISTS idx_exam_order_date ON exam_orders(created_at);
CREATE INDEX IF NOT EXISTS idx_exam_slot_type_date ON exam_slots(exam_type_id, date);
CREATE INDEX IF NOT EXISTS idx_exam_slot_status ON exam_slots(status);
CREATE INDEX IF NOT EXISTS idx_reschedule_order ON exam_reschedule_requests(exam_order_id);
CREATE INDEX IF NOT EXISTS idx_reschedule_status ON exam_reschedule_requests(status);
CREATE INDEX IF NOT EXISTS idx_reschedule_date ON exam_reschedule_requests(created_at);
CREATE INDEX IF NOT EXISTS idx_waitlist_type_date ON exam_waitlist(exam_type_id, target_date);
CREATE INDEX IF NOT EXISTS idx_waitlist_status ON exam_waitlist(status);
CREATE INDEX IF NOT EXISTS idx_waitlist_order ON exam_waitlist(exam_order_id);
CREATE INDEX IF NOT EXISTS idx_changelog_order ON exam_change_logs(exam_order_id);
CREATE INDEX IF NOT EXISTS idx_changelog_date ON exam_change_logs(created_at);
CREATE INDEX IF NOT EXISTS idx_notification_user ON exam_notifications(user_id);
CREATE INDEX IF NOT EXISTS idx_notification_patient ON exam_notifications(patient_id);
CREATE INDEX IF NOT EXISTS idx_notification_read ON exam_notifications(is_read);

CREATE UNIQUE INDEX IF NOT EXISTS idx_reschedule_active ON exam_reschedule_requests(exam_order_id) 
  WHERE status IN ('pending', 'approved');

CREATE UNIQUE INDEX IF NOT EXISTS idx_waitlist_active ON exam_waitlist(exam_order_id, exam_type_id, target_date) 
  WHERE status = 'waiting';
`;

db.exec(examInitSql);

const examConfigStmt = db.prepare("INSERT OR IGNORE INTO exam_configs (config_key, config_value, description) VALUES (?, ?, ?)");
examConfigStmt.run('waitlist_auto_promote', 'true', '有空闲时段时自动将候补转正');
examConfigStmt.run('waitlist_default_limit', '3', '每个时段默认候补人数上限');
examConfigStmt.run('reminder_hours_before', '24', '检查前多少小时发送提醒');
examConfigStmt.run('allow_same_day_reschedule', 'true', '是否允许同一天改约');
examConfigStmt.run('reschedule_revert_window_minutes', '30', '前台审核后可撤回的时间窗口（分钟）');

console.log('数据库初始化完成');
