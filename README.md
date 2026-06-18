# 门诊分诊排队与叫号系统 —— 检查改约与候补模块

基于 Node.js + Express + SQLite (better-sqlite3) + 原生 HTML/CSS/JS 的门诊检查管理系统，支持医生开单、预约时段、改约申请、前台审核、护士执行、候补队列自动转正、全链路审计日志、CSV 导出与系统配置管理。

---

## 目录

- [快速启动](#快速启动)
- [功能模块](#功能模块)
- [角色与权限矩阵](#角色与权限矩阵)
- [核心状态机](#核心状态机)
- [数据库设计](#数据库设计)
- [API 接口清单](#api-接口清单)
- [回归测试](#回归测试)
- [目录结构](#目录结构)

---

## 快速启动

```bash
# 1. 安装依赖
npm install

# 2. 初始化数据库（仅建表，不删除已有数据）
node scripts/init-db.js

# 3. 导入样例数据（科室、用户、患者、检查类型、排班槽位、默认配置）
node scripts/seed-data.js

# 4. 启动服务
node server.js
# 访问: http://localhost:3000
```

### 默认账号

| 角色   | 用户名   | 密码       | 说明        |
| ------ | -------- | ---------- | ----------- |
| 管理员 | admin    | admin123   | 全权限      |
| 护士   | nurse1   | nurse123   | 护士台 / 前台审核 |
| 护士   | nurse2   | nurse123   | 护士台      |
| 医生   | doctor1  | doctor123  | 内科        |
| 医生   | doctor2  | doctor123  | 外科        |
| 医生   | doctor3  | doctor123  | 儿科        |
| 医生   | doctor4  | doctor123  | 妇科        |

### 前端入口

- 登录页:    http://localhost:3000/login.html
- 管理员:    http://localhost:3000/admin.html
- 护士台:    http://localhost:3000/nurse.html
- 医生站:    http://localhost:3000/doctor.html
- 叫号屏:    http://localhost:3000/display.html

---

## 功能模块

### 1. 医生站
- 开检查单：指定患者（自动建档或按身份证复用）、检查类型、优先级、临床诊断、备注
- 预约时段：查看可用排班、选择时段进行预约
- 申请改约：指定原时段、期望改约日期范围、时段偏好（morning/afternoon）、原因、备注、可提升优先级
- 加入候补：检查单未排到时加入候补队列，支持优先级
- 取消检查单 / 取消改约申请 / 取消候补

### 2. 护士台（前台）
- 当日待执行清单：按日期查看待执行检查单列表
- 改约审核：通过（指定新时段）、驳回（附原因）、撤回（30 分钟内可撤回误操作并回滚所有状态）
- 候补转正：手动将候补患者排到空缺时段，也会在取消/改约成功/撤回时自动触发
- 完成检查：登记检查结果
- 取消检查：登记取消原因
- 候补管理：查看/转正/取消候补记录
- 变更记录：每张检查单完整的操作历史

### 3. 管理员后台
- 检查类型管理（新增/修改）
- 排班时段管理（新增/修改容量）
- 系统配置（撤回窗口、候补上限、提醒时间等）
- 全量数据查看（所有检查单、改约申请、候补记录）
- CSV 批量导出（检查单 / 改约申请 / 候补记录）

### 4. 数据联动与一致性
- 事务保障：所有多表写入（检查单变更 + 槽位计数 + 审计日志 + 通知消息）均在 SQLite 事务中原子提交
- 级联转正：检查单取消 / 改约成功 / 撤回时，自动调用 `tryPromoteWaitlistForSlot()` 将最高优先级候补转正（每次仅释放 1 个名额 → 仅转正 1 人）
- 冲突防重：`idx_reschedule_active` 与 `idx_waitlist_active` 部分唯一索引，防止同一检查单重复待处理改约或同日重复候补
- 权限隔离：中间件基于 JWT role 拦截；医生仅能操作自己开的检查单（`scheduleExamOrder` / `requestReschedule` / `cancelExamOrder` 均校验 `ordered_by`）
- 撤回窗口：配置 `reschedule_revert_window_minutes`（默认 30 分钟），SQLite UTC 时间戳正确解析

### 5. 持久化与重启恢复
- SQLite WAL 模式（`db/index.js` 启动时 `PRAGMA journal_mode=WAL`），事务 ACID 保证
- 服务重启后：检查单状态、改约申请、候补队列、变更日志、通知消息、槽位计数、管理员配置 —— **全部完整恢复**
- 重启后可正常读写新数据，无数据损坏

---

## 角色与权限矩阵

| 操作                       | 医生（doctor） | 护士（nurse） | 管理员（admin） | 说明                                     |
| -------------------------- | :-----------: | :-----------: | :-------------: | ---------------------------------------- |
| 开检查单                   |       ✅       |       ❌       |        ❌        | 仅本人所属科室                           |
| 预约时段                   |       ✅       |       ✅       |        ✅        | 医生仅本人开单                            |
| 申请改约                   |       ✅       |       ❌       |        ❌        | 仅本人开单                                |
| 改约审核（通过/驳回）      |       ❌       |       ✅       |        ✅        |                                          |
| 撤回改约（时间窗口内）     |       ❌       |       ✅       |        ✅        | 自动回滚时段、优先级、名额                |
| 取消检查单                 |       ✅       |       ✅       |        ✅        | 医生仅本人开单                            |
| 完成检查（登记结果）       |       ❌       |       ✅       |        ✅        |                                          |
| 加入候补                   |       ✅       |       ❌       |        ❌        |                                          |
| 候补转正                   |       ❌       |       ✅       |        ✅        |                                          |
| 查看当日待执行             |       ❌       |       ✅       |        ✅        |                                          |
| 查看全量数据               |       仅本人   |       ✅       |        ✅        |                                          |
| 配置管理                   |       ❌       |       ❌       |        ✅        |                                          |
| CSV 导出                   |       ❌       |       ❌       |        ✅        |                                          |
| 检查类型 / 排班时段管理    |       ❌       |       ❌       |        ✅        |                                          |

---

## 核心状态机

### 检查单（exam_orders.status）

```
pending ──schedule──▶ scheduled ──request_reschedule──▶ rescheduling ──approve──▶ scheduled (新时段)
                                                │                        │
                                                │                        └──reject──▶ scheduled (原时段)
                                                └──cancel_request──▶ scheduled
scheduled ──cancel──▶ cancelled
scheduled ──complete──▶ completed
rescheduling ──approve──revert_within_window──▶ scheduled (回滚至原时段 + 原优先级 + 名额)
```

### 改约申请（exam_reschedule_requests.status）

```
pending ──approve──▶ approved ──revert(within window)──▶ reverted
pending ──reject──▶ rejected
pending ──cancel──▶ cancelled
```

### 候补（exam_waitlist.status）

```
waiting ──promote──▶ promoted
waiting ──cancel──▶ cancelled
waiting ──expire──▶ expired
```

---

## 数据库设计

共 **8 张表 + 索引 + 部分唯一索引**，位于 `data/clinic.db`（WAL 模式）：

| 表名                       | 说明                            | 关键字段                                                  |
| -------------------------- | ------------------------------- | --------------------------------------------------------- |
| `exam_types`               | 检查类型                        | id, name, code, description                               |
| `exam_slots`               | 排班时段                        | id, exam_type_id, date, start_time, end_time, capacity, booked_count |
| `exam_orders`              | 检查单                          | id, order_no, patient_id, exam_type_id, ordered_by, urgency, status, scheduled_slot_id, result, cancel_reason |
| `exam_reschedule_requests` | 改约申请                        | id, request_no, exam_order_id, original_slot_id, requested_start/end_date, preferred_time, reason, status, requested_by, reviewed_by, reviewed_at, new_slot_id, reverted_by, reverted_at, revert_reason |
| `exam_waitlist`            | 候补队列                        | id, exam_order_id, target_date, priority, status, added_by, promoted_by, promoted_at, promoted_slot_id |
| `exam_change_logs`         | 变更日志（审计）                | id, exam_order_id, change_type, from_status, to_status, from_slot_id, to_slot_id, details(JSON), performed_by, ip_address |
| `exam_notifications`       | 通知消息                        | id, user_id, patient_id, exam_order_id, type, title, content, is_read |
| `exam_configs`             | 系统配置                        | id, config_key, config_value, description, updated_by, updated_at |

### 关键索引

```sql
-- 防止同一检查单同时存在多条待处理改约
CREATE UNIQUE INDEX idx_reschedule_active
ON exam_reschedule_requests(exam_order_id)
WHERE status IN ('pending');

-- 防止同一检查单同日重复候补
CREATE UNIQUE INDEX idx_waitlist_active
ON exam_waitlist(exam_order_id, target_date)
WHERE status = 'waiting';
```

### 默认配置（`exam_configs`）

| config_key                        | 默认值 | 说明                                       |
| --------------------------------- | ------ | ------------------------------------------ |
| `reschedule_revert_window_minutes`| 30     | 前台审核后可撤回的时间窗口（分钟）          |
| `waitlist_auto_promote`           | true   | 释放名额时是否自动转正候补                  |
| `waitlist_default_limit`          | 3      | 每时段默认候补上限                          |
| `waitlist_max_per_slot`           | 5      | 每时段候补人数上限                          |
| `allow_same_day_reschedule`       | true   | 是否允许改约到同一天                        |
| `reminder_hours_before`           | 24     | 检查前多少小时发送提醒                      |

---

## API 接口清单

### 医生端 `/api/doctor/*`

| 方法   | 路径                                         | 说明                     |
| ------ | -------------------------------------------- | ------------------------ |
| GET    | `/exam/types`                                | 获取检查类型列表         |
| GET    | `/exam/slots?exam_type_id=&date=`            | 查询可用排班时段         |
| GET    | `/exam/orders`                               | 我开的检查单列表         |
| GET    | `/exam/orders/:id`                           | 检查单详情（含日志/通知）|
| POST   | `/exam/orders`                               | 开检查单                 |
| POST   | `/exam/orders/:id/schedule`                  | 预约时段                 |
| POST   | `/exam/orders/:id/cancel`                    | 取消检查单               |
| POST   | `/exam/reschedule`                           | 提交改约申请             |
| GET    | `/exam/reschedule`                           | 我的改约申请列表         |
| POST   | `/exam/reschedule/:id/cancel`                | 取消改约申请             |
| POST   | `/exam/waitlist`                             | 加入候补                 |
| POST   | `/exam/waitlist/:id/cancel`                  | 取消候补                 |

### 护士端 `/api/nurse/*`

| 方法   | 路径                                         | 说明                     |
| ------ | -------------------------------------------- | ------------------------ |
| GET    | `/exam/types`                                | 检查类型                 |
| GET    | `/exam/today?date=`                          | 当日待执行清单           |
| GET    | `/exam/orders`                               | 检查单列表               |
| GET    | `/exam/orders/:id`                           | 检查单详情               |
| POST   | `/exam/orders/:id/complete`                  | 完成检查（登记结果）     |
| POST   | `/exam/orders/:id/cancel`                    | 取消检查                 |
| GET    | `/exam/slots`                                | 排班时段                 |
| GET    | `/exam/reschedule`                           | 改约申请列表             |
| POST   | `/exam/reschedule/:id/approve`               | 审核通过（slot_id=新时段）|
| POST   | `/exam/reschedule/:id/reject`                | 驳回                     |
| POST   | `/exam/reschedule/:id/revert`                | 撤回（含状态回滚）       |
| GET    | `/exam/waitlist`                             | 候补列表                 |
| POST   | `/exam/waitlist/:id/promote`                 | 候补手动转正             |
| POST   | `/exam/waitlist/:id/cancel`                  | 取消候补                 |

### 管理员 `/api/admin/*`

| 方法   | 路径                                         | 说明                     |
| ------ | -------------------------------------------- | ------------------------ |
| GET    | `/exam/types`                                | 检查类型列表             |
| POST   | `/exam/types`                                | 新增检查类型             |
| POST   | `/exam/types/:id`                            | 修改检查类型             |
| GET    | `/exam/slots`                                | 排班时段列表             |
| POST   | `/exam/slots`                                | 新增时段                 |
| POST   | `/exam/slots/:id`                            | 修改时段容量             |
| GET    | `/exam/today`                                | 当日清单                 |
| GET    | `/exam/orders`                               | 全量检查单               |
| GET    | `/exam/orders/:id`                           | 检查单详情               |
| POST   | `/exam/orders/:id/schedule`                  | 管理员预约               |
| POST   | `/exam/orders/:id/cancel`                    | 取消                     |
| GET    | `/exam/orders/export`                        | CSV 导出检查单           |
| GET    | `/exam/reschedule/export`                    | CSV 导出改约申请         |
| GET    | `/exam/waitlist/export`                      | CSV 导出候补记录         |
| GET    | `/exam/configs`                              | 获取配置列表             |
| POST   | `/exam/configs`                              | 更新配置                 |

---

## 回归测试

### 主测试（77 项断言，覆盖全部核心场景）

```bash
node scripts/test-exam.js
```

覆盖场景：
1. ✅ **登录与基础数据** — 各角色登录、检查类型、排班时段加载
2. ✅ **医生开单** — 3 张不同优先级检查单创建成功
3. ✅ **预约时段** — 槽位 booked_count 正确 +1
4. ✅ **发起改约申请** — 状态变为 rescheduling，优先级可提升
5. ✅ **重复申请冲突** — 同一检查单重复改约被拒绝
6. ✅ **权限拦截** — 医生 2 无法操作医生 1 的单（均返回 403）
7. ✅ **改约审核驳回** — 状态回退为 scheduled，可重新申请
8. ✅ **改约审核通过** — 新时段正确、原时段释放、优先级提升
9. ✅ **候补加入与去重** — 按优先级排序，同日重复候补被拒绝
10. ✅ **取消触发候补自动转正** — 释放名额 → 高优先级候补 C 转正到 slot2，D 仍排队
11. ✅ **前台误操作撤回（核心）** — 30 分钟内撤回 → 时段回原、优先级回滚、名额恢复（兼容自动候补）
12. ✅ **完成检查** — 结果登记，状态 completed
13. ✅ **护士视图** — 当日待执行、变更日志链路（create/schedule/reschedule/approve/revert/complete）
14. ✅ **CSV 导出** — 检查单 / 改约申请 / 候补记录三类均成功
15. ✅ **管理员配置** — 读写配置正常，含撤回窗口等
16. ✅ **通知消息** — 预约确认、改约申请等均写入消息表

### 重启恢复测试（28 项断言，验证持久化）

```bash
# Phase 1：写入测试数据并保存快照
node scripts/test-exam-restart.js phase1

# 重启服务器后，Phase 2：验证数据完整恢复
node scripts/test-exam-restart.js phase2
```

验证项目：
- ✅ 检查单状态（scheduled / completed）持久化
- ✅ 改约申请状态（approved）持久化
- ✅ 候补队列记录持久化
- ✅ 变更日志链路持久化（create/schedule/reschedule_request/reschedule_approve）
- ✅ 通知消息持久化（schedule_confirm/reschedule_request/reschedule_approved）
- ✅ 槽位名额计数持久化
- ✅ 管理员配置持久化（restart_test_key = restart_ok_123）
- ✅ 重启后 DB 可继续读写（新开检查单成功）

---

## 目录结构

```
lfc-00023/
├── server.js                  # 服务入口
├── package.json
├── data/
│   └── clinic.db              # SQLite 数据库（WAL 模式）
├── scripts/
│   ├── init-db.js             # 初始化建表（仅 CREATE IF NOT EXISTS）
│   ├── seed-data.js           # 导入样例数据 + 默认配置
│   ├── test-exam.js           # 主回归测试（77 项）
│   └── test-exam-restart.js   # 重启恢复测试（28 项）
├── src/
│   ├── db/
│   │   └── index.js           # SQLite 连接（启用 WAL）
│   ├── utils/
│   │   ├── exam.js            # 检查改约核心工具层（状态机、事务、别名、CSV）
│   │   └── ...                # 其他业务工具
│   ├── middleware/
│   │   └── auth.js            # JWT 认证中间件
│   └── routes/
│       ├── doctor.js          # 医生端 API
│       ├── nurse.js           # 护士台 API
│       ├── admin.js           # 管理员 API
│       └── ...
└── public/
    ├── login.html             # 登录
    ├── doctor.html            # 医生站前端
    ├── nurse.html             # 护士台前端
    ├── admin.html             # 管理员后台
    ├── display.html           # 叫号屏
    ├── css/
    ├── js/
    │   ├── api.js             # 前端 API 封装
    │   └── ...
    └── ...
```

---

## 技术栈说明

- **后端**: Node.js 20 + Express 4
- **数据库**: SQLite (better-sqlite3)，WAL 模式保证并发与 ACID
- **认证**: JWT (jsonwebtoken) + bcryptjs 密码散列
- **前端**: 原生 HTML/CSS/JavaScript（无构建依赖）
- **事务**: 所有多表变更通过 `db.transaction(() => {...})` 原子提交
- **时区**: SQLite `CURRENT_TIMESTAMP` 存储 UTC，JS 解析时 `replace(' ', 'T') + 'Z'` 保证 UTC 正确
- **字段别名**: 后端兼容两套命名（urgency ↔ priority, scheduled_slot_id ↔ slot_id, requested_start_date ↔ desired_start_date, config_key ↔ key 等），通过 `aliasOrder` / `aliasConfig` 统一输出

---

## 许可证

内部系统使用
