# 门诊分诊排队与叫号系统

本地门诊分诊排队与叫号系统，支持管理员、护士、医生三类角色，实现从建号、分诊、叫号到接诊完成的完整业务流程。

## 技术栈

- **后端**: Node.js + Express
- **数据库**: SQLite (better-sqlite3)
- **认证**: JWT
- **前端**: 原生 HTML/CSS/JavaScript
- **密码加密**: bcryptjs

## 快速开始

### 1. 安装依赖

```bash
npm install
```

### 2. 初始化数据库（首次运行）

```bash
npm run reset
```

> 这会创建数据库表结构，并插入样例数据（科室、账号、患者、号源配置）。

### 3. 启动服务

```bash
npm start
```

服务启动后访问: http://localhost:3000

## 测试账号

| 角色 | 用户名 | 密码 | 所属科室 |
|------|--------|------|----------|
| 管理员 | admin | admin123 | - |
| 护士 | nurse1 | nurse123 | - |
| 护士 | nurse2 | nurse123 | - |
| 内科医生 | doctor1 | doctor123 | 内科 |
| 外科医生 | doctor2 | doctor123 | 外科 |
| 儿科医生 | doctor3 | doctor123 | 儿科 |
| 妇科医生 | doctor4 | doctor123 | 妇科 |

## 页面入口

- 首页: http://localhost:3000/
- 登录页: http://localhost:3000/login.html
- 管理员后台: http://localhost:3000/admin.html
- 护士台: http://localhost:3000/nurse.html
- 医生站: http://localhost:3000/doctor.html
- 叫号屏: http://localhost:3000/display.html

## 完整业务流程测试

### 场景一：完整接诊流程（建号 → 分诊 → 叫号 → 接诊完成）

1. **管理员配置号源**
   - 登录 admin/admin123
   - 进入「号源配置」标签页
   - 选择内科，配置今日号源：总号源20，现场加号上限5
   - 确认配置成功

2. **护士登记患者并挂号**
   - 登录 nurse1/nurse123
   - 选择科室：内科
   - 在「患者登记」标签页输入身份证号：`110101199001011234`（张三，已有样例数据）
   - 点击「查询患者」，确认患者信息
   - 选择挂号类型：预约
   - 点击「确认挂号」，记录返回的排队号码（应为1号）

3. **护士叫号**
   - 切换到「排队管理」标签页
   - 看到张三（1号）状态为「等待中」
   - 点击「叫号」按钮，状态变为「已叫号」
   - 可打开叫号屏 http://localhost:3000/display.html 选择内科查看叫号显示

4. **医生接诊**
   - 登录 doctor1/doctor123（内科医生）
   - 在「已叫号待接诊」区域看到张三（1号）
   - 点击「开始接诊」，状态变为「就诊中」
   - 在「当前接诊」区域点击「填写记录并完成接诊」
   - 填写：
     - 主诉：发热、咳嗽3天
     - 诊断：上呼吸道感染
     - 处方：布洛芬缓释胶囊 0.3g bid * 3天
   - 点击「完成接诊」

5. **查看结果**
   - 护士台刷新后看到张三状态变为「已完成」
   - 叫号屏不再显示该患者
   - 管理员可在「审计日志」查看完整操作记录
   - 管理员可在「日报导出」导出今日数据

### 场景二：测试满号限制

1. 管理员将内科今日号源总号源改为2
2. 护士用2个不同身份证号挂号（如李四、王五）
3. 尝试挂第3个号，系统提示「今日号源已满」

### 场景三：测试现场加号上限

1. 管理员将内科今日现场加号上限改为1
2. 护士选择「现场加号」类型挂1个号成功
3. 尝试挂第2个现场加号，系统提示「今日现场加号已满」

### 场景四：测试停诊时段建号

1. 管理员进入「停诊时段」
2. 为内科添加一个停诊时段（包含今日）
3. 护士尝试为内科挂号，系统提示「该科室今日停诊」

### 场景五：测试越权接诊

1. 护士为外科挂号一位患者并叫号
2. 用内科医生 doctor1 登录
3. 尝试通过接口调用接诊外科患者，系统返回「越权操作：该患者不属于您的科室」

### 场景六：测试重复过号

1. 护士叫号一位患者
2. 点击「过号」，状态变为「过号」
3. 再次点击过号（如果有按钮），系统提示「该患者已经过号，不能重复过号」

### 场景七：测试退回功能

1. 护士叫号一位患者
2. 点击「退回」，输入原因：患者要求退号
3. 状态变为「退回」，显示退回原因
4. 在统计卡片中「退回」计数+1
5. 该号源可被重新使用（退回数量不计入已用号源）

### 场景八：测试系统重启数据一致性

1. 完成上述部分操作后，停止服务（Ctrl+C）
2. 重新启动 `npm start`
3. 登录查看：
   - 排队顺序保持不变
   - 已完成、过号、退回状态正确
   - 退回原因、操作者信息完整
   - 审计历史记录完整
   - 日报导出数据一致

## API 接口文档

### 认证接口

```
POST /api/auth/login
Body: { username, password }
Return: { token, user }
```

### 管理员接口

```
GET    /api/admin/departments          # 获取科室列表
POST   /api/admin/departments          # 创建科室
PUT    /api/admin/departments/:id      # 更新科室
DELETE /api/admin/departments/:id      # 删除科室

GET    /api/admin/daily-slots          # 获取号源配置
POST   /api/admin/daily-slots          # 创建号源配置
PUT    /api/admin/daily-slots/:id      # 更新号源配置

GET    /api/admin/closed-periods       # 获取停诊时段
POST   /api/admin/closed-periods       # 创建停诊时段
DELETE /api/admin/closed-periods/:id   # 删除停诊时段

GET    /api/admin/users                # 获取用户列表
POST   /api/admin/users                # 创建用户
```

### 护士接口

```
POST   /api/nurse/patients             # 创建/查询患者
GET    /api/nurse/patients/:id_card    # 查询患者

POST   /api/nurse/queue/register       # 挂号
GET    /api/nurse/queue/:dept_id       # 获取排队列表
POST   /api/nurse/queue/call/:id       # 叫号
POST   /api/nurse/queue/miss/:id       # 过号
POST   /api/nurse/queue/return/:id     # 退回
GET    /api/nurse/queue/stats/:dept_id # 获取排队统计
```

### 医生接口

```
GET    /api/doctor/current             # 获取当前待接诊患者
GET    /api/doctor/queue               # 获取本科室排队
GET    /api/doctor/consulting          # 获取我正在接诊的患者
POST   /api/doctor/consult/start/:id   # 开始接诊
POST   /api/doctor/consult/complete/:id # 完成接诊
GET    /api/doctor/history             # 历史接诊记录
```

### 公共接口

```
GET    /api/public/departments         # 获取活跃科室列表
GET    /api/public/queue/status/:dept_id  # 获取队列状态
GET    /api/public/queue/display/:dept_id # 获取叫号屏数据
GET    /api/public/audit-logs          # 审计日志（支持分页筛选）
GET    /api/public/reports/daily       # 导出日报 JSON
GET    /api/public/reports/daily/csv   # 导出日报 CSV
```

## 数据模型

### 核心表结构

- **users**: 用户表（管理员、护士、医生）
- **departments**: 科室表
- **daily_slots**: 每日号源配置
- **closed_periods**: 停诊时段
- **patients**: 患者表
- **queue_records**: 排队记录表（核心业务表）
  - 状态: waiting（等待）→ called（已叫号）→ consulting（就诊中）→ completed（已完成）
  - 其他状态: missed（过号）、returned（退回）
- **consultation_records**: 诊疗记录表
- **audit_logs**: 审计日志表

## 关键业务规则

1. **满号检测**: 挂号前检查总号源和现场加号上限
2. **停诊检测**: 挂号前检查科室是否停诊
3. **重复挂号**: 同一患者同一天同一科室只能挂一个号
4. **叫号规则**: 同一时间只能有一位患者在就诊
5. **越权检测**: 医生只能接诊本科室、由自己接诊的患者
6. **状态流转**: 严格的状态机控制，不允许逆向操作
7. **重复过号**: 已过号患者不能再次过号
8. **退回限制**: 已完成或正在就诊的患者不能退回
9. **数据一致性**: 所有操作记录审计日志，可追溯

## 可用命令

```bash
npm start      # 启动服务
npm run init   # 初始化数据库表
npm run seed   # 插入样例数据
npm run reset  # 重置数据库（删除+重建+插入样例）
```

## 项目结构

```
.
├── server.js              # 主服务器入口
├── package.json
├── .env                   # 环境变量
├── scripts/
│   ├── init-db.js         # 数据库初始化
│   ├── seed-data.js       # 样例数据
│   └── reset-db.js        # 数据库重置
├── src/
│   ├── db/index.js        # 数据库连接
│   ├── middleware/auth.js # 认证中间件
│   ├── utils/
│   │   ├── audit.js       # 审计日志
│   │   └── queue.js       # 队列工具函数
│   └── routes/
│       ├── auth.js        # 认证接口
│       ├── admin.js       # 管理员接口
│       ├── nurse.js       # 护士接口
│       ├── doctor.js      # 医生接口
│       └── public.js      # 公共接口
└── public/                # 前端页面
    ├── index.html
    ├── login.html
    ├── admin.html
    ├── nurse.html
    ├── doctor.html
    ├── display.html
    ├── css/style.css
    └── js/api.js
```

## 注意事项

1. 数据库文件存储在 `data/clinic.db`，SQLite 文件，系统重启数据不丢失
2. JWT Token 有效期 24 小时
3. 密码使用 bcryptjs 加密存储
4. 所有写操作均记录审计日志，包含操作人、时间、IP、详情
5. 前端页面每 3-5 秒自动刷新数据
