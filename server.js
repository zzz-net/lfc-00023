require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');

const { authenticateToken, requireRole } = require('./src/middleware/auth');

const authRoutes = require('./src/routes/auth');
const adminRoutes = require('./src/routes/admin');
const nurseRoutes = require('./src/routes/nurse');
const doctorRoutes = require('./src/routes/doctor');
const publicRoutes = require('./src/routes/public');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.use('/api/auth', authRoutes);
app.use('/api/admin', authenticateToken, requireRole('admin'), adminRoutes);
app.use('/api/nurse', authenticateToken, requireRole('nurse'), nurseRoutes);
app.use('/api/doctor', authenticateToken, requireRole('doctor'), doctorRoutes);
app.use('/api/public', publicRoutes);

app.get('/api/me', authenticateToken, (req, res) => {
  res.json(req.user);
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`门诊分诊排队系统已启动: http://localhost:${PORT}`);
  console.log('\n=== 登录入口 ===');
  console.log('登录页: http://localhost:3000/login.html');
  console.log('管理员: http://localhost:3000/admin.html');
  console.log('护士台:  http://localhost:3000/nurse.html');
  console.log('医生站:  http://localhost:3000/doctor.html');
  console.log('叫号屏:  http://localhost:3000/display.html');
});
