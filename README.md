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

### 场景六：测试重复过号（幂等）

1. 护士叫号一位患者
2. 第一次「过号」，状态变为「过号」(missed)，写入一条过号审计事件
3. 再次「过号」，接口返回成功（200），状态仍为「过号」，**不产生新的审计事件**
4. 连续多次过号，审计中该记录的 `miss_patient` 事件始终只有一条

> 说明：过号接口对 `missed` 状态做幂等处理。重复过号视为成功，队列状态不被改坏，审计只保留首次过号事件。
> 仍会报错的情况：对 `waiting`/`completed`/`consulting`/`returned` 状态调用过号，返回 400「只有已叫号的患者才能过号」。

### 场景七：测试退回功能

1. 护士叫号一位患者
2. 点击「退回」，输入原因：患者要求退号
3. 状态变为「退回」，显示退回原因
4. 在统计卡片中「退回」计数+1
5. 该号源可被重新使用（退回数量不计入已用号源）

### 场景八：测试系统重启数据一致性

1. 完成上述部分操作后，记录当前队列状态与审计事件
2. 停止服务（仅停止本进程，例如记下监听 3000 端口的 `node server.js` PID 后 `Stop-Process -Id <PID>`；切勿按进程名批量结束）
3. 重新启动 `npm start`
4. 登录查看：
   - 排队顺序保持不变
   - 已完成、过号、退回状态正确
   - 退回原因、操作者信息完整
   - 审计历史记录完整
   - 日报导出数据一致

> 说明：队列与审计数据持久化在 `data/clinic.db`（SQLite + WAL 模式）。重启后会自动回放 WAL，已提交事务不会丢失。注意：重启时请确保只有一个 `node server.js` 进程在操作该数据库文件，多个进程同时硬终止可能导致 WAL 竞争而丢失未落盘数据。

### 场景九：审计日志筛选查询

`GET /api/public/audit-logs` 支持 `action`、`user_id`、`start_date`、`end_date`、`page`、`pageSize` 任意组合：

```
GET /api/public/audit-logs?action=miss_patient
GET /api/public/audit-logs?user_id=2
GET /api/public/audit-logs?start_date=2026-06-01&end_date=2026-06-30
GET /api/public/audit-logs?action=miss_patient&user_id=2&page=1&pageSize=5
GET /api/public/audit-logs?page=2&pageSize=10
```

预期：以上任一组合均返回 200，并包含 `pagination.total` 与 `logs` 数组；`action` 筛选结果中所有记录的 `action` 字段都与入参一致。

### 场景十：回归测试（一键复现上述两个修复）

```
npm start                          # 1. 启动服务
node scripts/test-regression.js    # 2. 覆盖：叫号→过号→重复过号幂等→审计筛选组合→过号审计唯一性
# 3. 重启服务（记下 3000 端口的 node PID，Stop-Process -Id <PID>，再 npm start）
node scripts/test-after-restart.js # 4. 重启后复测：队列/过号/日志筛选一致性
```

`scripts/test-regression.js` 共 26 项断言，包含：
- 重复过号第二次/第三次返回 200 且状态仍为 `missed`，不写入 `return_reason`
- `action` / `user_id` / `date` / 全组合 / 分页 筛选均返回 200
- 同一排队记录的 `miss_patient` 审计事件仅 1 条

`scripts/test-after-restart.js` 在重启后运行，复测：队列状态、过号幂等、审计筛选均与重启前一致。

### 场景十一：CSV批量导入预约/登记

#### 准备工作
1. 重置数据库：`npm run reset`
2. 启动服务：`npm start`
3. 登录 admin/admin123，为内科配置今日号源（总号源20，现场加号上限5）

#### 11.1 成功导入
1. 登录 nurse1/nurse123（护士台）
2. 进入「批量导入」标签页
3. 点击「下载模板」获取CSV模板
4. 准备CSV内容（保存为 import.csv）：
```csv
id_card,name,department,queue_date,type,phone,gender,age
110101199001013001,批量患者1,内科,2026-06-18,预约,13800003001,男,30
110101199001013002,批量患者2,1,2026-06-18,现场,13800003002,女,25
110101199001013003,批量患者3,内科,2026-06-18,appointment,13800003003,男,35
```
5. 点击「上传CSV文件」选择 import.csv，或直接粘贴CSV内容到文本框
6. 点击「开始导入」
7. 预期结果：
   - 显示导入结果：成功3条，失败0条
   - 进入「排队管理」标签页，看到3位患者状态为「等待中」
   - 排队号码连续（1、2、3号）

#### 11.2 冲突检测 - 导入包含错误的CSV
1. 准备包含错误的CSV：
```csv
id_card,name,department,queue_date,type,phone,gender,age
110101199001013001,批量患者1,内科,2026-06-18,预约,13800003001,男,30
110101199001013004,批量患者4,不存在的科室,2026-06-18,预约,13800003004,男,40
110101199001013005,批量患者5,内科,2026/06/18,预约,13800003005,男,50
110101199001013006,批量患者6,内科,2026-06-18,错误类型,13800003006,男,60
```
2. 导入后预期结果：
   - 成功1条（第1条新患者）
   - 失败3条：
     - 第2条：科室不存在
     - 第3条：日期格式错误
     - 第4条：挂号类型错误
   - 失败明细显示具体错误代码和信息

#### 11.3 冲突检测 - 号源已满
1. 将内科今日总号源改为2
2. 准备3条患者的CSV导入
3. 预期结果：成功2条，失败1条（号源已满）

#### 11.4 冲突检测 - 停诊时段
1. 管理员为外科添加今日停诊时段
2. 准备外科患者的CSV导入
3. 预期结果：导入失败，提示「该科室今日停诊」

### 场景十二：批次查询、导出与撤销

#### 12.1 批次查询
1. 登录护士/管理员账号
2. 进入「导入批次」标签页
3. 可按日期和科室筛选批次
4. 点击批次号查看详情，显示每条记录的状态、错误信息
5. 预期：所有导入过的批次都能查询到，状态正确

#### 12.2 批次导出CSV
1. 在批次详情页点击「导出CSV」
2. 下载的CSV包含：行号、身份证号、姓名、科室、日期、类型、状态、错误信息
3. 预期：导出内容与页面显示一致

#### 12.3 撤销整批尚未叫号的记录
1. 导入一批新患者（确保都未叫号）
2. 在批次详情页点击「撤销批次」
3. 输入撤销原因，确认撤销
4. 预期结果：
   - 批次状态变为「已撤销」
   - 所有关联记录状态变为「退回」
   - 退回原因为输入的撤销原因
   - 退回人为当前登录用户
   - 审计日志记录 `revoke_batch` 事件和每条记录的 `return_queue` 事件

#### 12.4 撤销限制 - 已叫号的批次无法撤销
1. 导入一批患者
2. 叫号其中一位患者
3. 尝试撤销该批次
4. 预期结果：撤销失败，提示「该批次中存在已叫号或已就诊的记录，无法撤销」

### 场景十三：权限控制 - 医生无法操作批量导入

1. 登录 doctor1/doctor123（内科医生）
2. 尝试直接调用批量导入接口（或在URL中访问护士/管理员批量导入页面）
3. 预期结果：返回403无权限

### 场景十四：服务重启后数据一致性

1. 完成上述批量导入和撤销操作后，记录以下状态：
   - 各批次状态（completed/revoked）
   - 队列中各记录状态（waiting/returned）
   - 审计日志中的导入和撤销事件
2. 停止服务（记下 3000 端口的 node PID，`Stop-Process -Id <PID>`）
3. 重新启动 `npm start`
4. 登录查看：
   - 导入批次列表完整，状态正确
   - 批次详情完整，成功/失败记录清晰
   - 队列顺序保持不变
   - 已撤销批次的记录仍为「退回」状态，退回原因和操作人完整
   - 审计日志中的 `import_batch` 和 `revoke_batch` 事件完整
   - 日报导出数据一致

### 场景十五：一键完整测试（自动化）

```bash
npm run reset                    # 1. 重置数据库
npm start                        # 2. 启动服务
node scripts/test-batch-import.js # 3. 批量导入功能完整测试（25项断言）
# 4. 停止服务（记下 3000 端口的 node PID，Stop-Process -Id <PID>）
npm start                        # 5. 重新启动
node scripts/test-batch-after-restart.js # 6. 重启后一致性测试（14项断言）
```

`scripts/test-batch-import.js` 覆盖25项断言，包含：
- CSV解析与基本导入功能
- 数据一致性验证（批次↔队列）
- 各类冲突检测（身份证重复、科室不存在、停诊、号满等）
- 事务性验证（无半写入）
- 批次查询（日期/科室/分页筛选）
- 批次撤销（成功/失败场景）
- 权限控制（医生403）
- 审计日志完整性
- CSV格式验证（缺少列、日期/类型错误）

`scripts/test-batch-after-restart.js` 在重启后运行，覆盖32项断言，包含：
- 批次状态持久化
- 撤销状态和原因持久化
- 队列状态与撤销记录一致
- 审计日志持久化
- 排队号码连续性
- 批次记录完整性
- 日报和统计数据一致性

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

# 批量导入
POST   /api/nurse/batch/import         # CSV批量导入（预约/现场登记）
GET    /api/nurse/batches              # 批次列表（支持 date/department_id/page/pageSize 筛选）
GET    /api/nurse/batches/:id          # 批次详情（含每条记录状态与错误信息）
GET    /api/nurse/batches/:id/csv      # 导出批次结果 CSV
POST   /api/nurse/batches/:id/revoke   # 撤销整批尚未叫号的记录
```

> 管理员接口 `/api/admin/batch/import`、`/api/admin/batches` 等与护士完全一致。医生接口不含任何批量导入能力。

**批量导入请求体（POST /api/nurse/batch/import）**：
```json
{ "csv_text": "id_card,name,department,queue_date,type\n110101199001013001,张三,内科,2026-06-18,预约" }
```

**批量导入返回示例**：
```json
{
  "success": true,
  "batch_id": 1,
  "batch_no": "BATCH1781723483898681",
  "total_count": 3,
  "success_count": 2,
  "fail_count": 1,
  "details": {
    "success": [{ "row": 1, "id_card": "110101199001013001", "name": "张三", "department": "内科", "queue_date": "2026-06-18", "type": "appointment" }],
    "failed":  [{ "row": 3, "id_card": "...", "errors": [{ "code": "SLOT_FULL", "message": "今日号源已满" }] }]
  }
}
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
GET    /api/public/audit-logs          # 审计日志（支持 action/user_id/date/分页 组合筛选）
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
7. **过号幂等**: 对 `missed` 状态重复过号视为成功（幂等），不重复写审计、不改状态；对其它非 `called` 状态才返回 400
8. **退回限制**: 已完成或正在就诊的患者不能退回
9. **数据一致性**: 所有操作记录审计日志，可追溯

## 可用命令

```bash
npm start      # 启动服务
npm run init   # 初始化数据库表
npm run seed   # 插入样例数据
npm run reset  # 重置数据库（删除+重建+插入样例）
node scripts/test-regression.js     # 回归测试：过号幂等 + 审计筛选
node scripts/test-after-restart.js  # 重启后一致性复测
node scripts/test-followup.js       # 随访模块完整测试
node scripts/test-followup-restart.js  # 随访模块重启后一致性测试
```

## 项目结构

```
.
├── server.js              # 主服务器入口
├── package.json
├── .env                   # 环境变量
├── scripts/
│   ├── init-db.js         # 数据库初始化（含随访表）
│   ├── seed-data.js       # 样例数据
│   ├── reset-db.js        # 数据库重置
│   ├── test-regression.js # 回归测试（过号幂等 + 审计筛选）
│   ├── test-after-restart.js # 重启后一致性复测
│   ├── test-followup.js   # 随访模块完整测试
│   └── test-followup-restart.js # 随访模块重启后一致性测试
├── src/
│   ├── db/index.js        # 数据库连接
│   ├── middleware/auth.js # 认证中间件
│   ├── utils/
│   │   ├── audit.js       # 审计日志
│   │   ├── queue.js       # 队列工具函数
│   │   └── followup.js    # 随访模块核心工具函数
│   └── routes/
│       ├── auth.js        # 认证接口
│       ├── admin.js       # 管理员接口（含随访管理）
│       ├── nurse.js       # 护士接口（含随访提醒）
│       ├── doctor.js      # 医生接口（含随访计划）
│       └── public.js      # 公共接口
└── public/                # 前端页面
    ├── index.html
    ├── login.html
    ├── admin.html         # 含随访管理标签页
    ├── nurse.html         # 含随访提醒标签页
    ├── doctor.html        # 含随访计划管理标签页
    ├── display.html
    ├── css/style.css
    └── js/api.js          # 含随访API包装
```

## 场景十六：导入沙箱模块 - 反复演练不碰正式数据

### 16.1 功能概述

导入沙箱模块允许管理员和护士在提交到正式数据之前，对 CSV 导入任务进行反复演练。整个过程完全不碰正式的排队记录数据，所有操作都在独立的沙箱表中完成。

核心特性：
- **模板版本管理**：支持 v1（标准模板）和 v2（扩展模板）
- **生效范围控制**：按科室、全部或自定义范围
- **字段映射保存**：CSV 列名与系统字段的映射关系自动保存
- **校验结果持久化**：每条记录的校验错误、冲突类型、冲突详情
- **新增/覆盖/跳过摘要**：预检后自动统计各类动作数量
- **确认痕迹审计**：每次预检、演练、撤销、作废、提交均记录操作人、时间和摘要
- **跨重启恢复**：所有沙箱状态持久化在 SQLite，服务重启后完整恢复
- **同名任务冲突处理**：不允许创建同名未作废的任务
- **角色权限隔离**：普通护士只能查看和操作自己创建的任务，管理员可查看全部
- **单条撤销**：可针对单条演练成功的记录单独撤销
- **整批作废**：一键作废整个沙箱任务
- **重新导入**：清空当前结果回到草稿状态重新开始
- **失败重试入口**：最终提交时返回所有失败记录，便于重试
- **导出报告**：CSV 报告包含所有记录明细和完整的操作确认痕迹

### 16.2 完整沙箱操作流程

1. **登录管理员/护士账号**
2. **进入「导入沙箱」标签页**
3. **创建沙箱任务**：填写任务名称、选择模板版本、目标数据集和生效范围
4. **上传/粘贴 CSV**：或直接在文本框中粘贴 CSV 内容
5. **执行预检**：系统解析 CSV、校验字段、检测冲突，显示新增/覆盖/跳过/失败统计
6. **演练确认**：在沙箱内模拟导入流程，生成虚拟排队号，不写入正式表
7. **（可选）单条撤销**：对不想要的演练记录单独撤销，填写撤销原因
8. **（可选）整批作废**：放弃整个任务，填写作废原因
9. **（可选）重新导入**：清空当前结果，回到草稿状态重新预检
10. **管理员审批（可选）**：管理员可对演练完成的任务进行通过或拒绝
11. **最终提交**：将沙箱中校验通过且未撤销的记录写入正式数据，关联生成标准导入批次
12. **查看失败重试入口**：提交结果返回所有失败记录及其原因
13. **导出报告**：下载包含完整明细和操作确认痕迹的 CSV 报告

### 16.3 状态流转

```
draft(草稿) → prechecked(预检完成) → practiced(演练完成) 
    → approved(审批通过)/rejected(审批拒绝) → submitted(已提交)
    或任何状态 → voided(已作废)
    任何非最终状态 → reimport → draft(回到草稿)
```

### 16.4 权限控制

| 操作 | 管理员 | 护士（自己的任务） | 护士（他人任务） | 医生 |
|------|--------|------------------|----------------|------|
| 创建任务 | ✅ | ✅ | ❌ | ❌ |
| 查看列表 | 全部 | 仅自己 | ❌ | ❌ |
| 查看详情 | ✅ | ✅ | ❌ | ❌ |
| 预检/演练/撤销/作废 | ✅ | ✅ | ❌ | ❌ |
| 审批通过/拒绝 | ✅ | ❌ | ❌ | ❌ |
| 最终提交 | ✅ | ✅ | ❌ | ❌ |
| 导出报告 | ✅ | ✅ | ❌ | ❌ |

### 16.5 沙箱数据与正式数据隔离

- 所有沙箱数据存储在以下独立表中，永不直接操作 `queue_records`：
  - `sandbox_tasks`：任务主表
  - `sandbox_records`：记录明细表
  - `sandbox_confirmations`：操作确认痕迹表
  - `sandbox_field_mappings`：字段映射表
- 演练时生成的 `practice_queue_number`（虚拟排队号）使用 `10000+` 号段，与正式号段隔离
- 只有在「最终提交」时，才会通过事务原子性地写入 `patients`、`queue_records` 和标准的 `import_batches`/`import_records` 表

## 注意事项

1. 数据库文件存储在 `data/clinic.db`，SQLite 文件，系统重启数据不丢失
2. JWT Token 有效期 24 小时
3. 密码使用 bcryptjs 加密存储
4. 所有写操作均记录审计日志，包含操作人、时间、IP、详情
5. 前端页面每 3-5 秒自动刷新数据
6. 沙箱模块配置项（`.env`）：
   - `SANDBOX_ENABLED=true`：启用沙箱模块
   - `SANDBOX_REQUIRE_APPROVAL=false`：是否强制要求管理员审批后才能提交
   - `SANDBOX_DEFAULT_TEMPLATE=v1`：默认模板版本
