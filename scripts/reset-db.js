const fs = require('fs');
const path = require('path');

const dataDir = path.join(__dirname, '../data');
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const dbPath = path.join(dataDir, 'clinic.db');
const dbWalPath = path.join(dataDir, 'clinic.db-wal');
const dbShmPath = path.join(dataDir, 'clinic.db-shm');

if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
if (fs.existsSync(dbWalPath)) fs.unlinkSync(dbWalPath);
if (fs.existsSync(dbShmPath)) fs.unlinkSync(dbShmPath);

console.log('数据库已重置');

require('./init-db');
require('./seed-data');
