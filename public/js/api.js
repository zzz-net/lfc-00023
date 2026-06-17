const API_BASE = '/api';

function getToken() {
  return localStorage.getItem('token');
}

function setToken(token) {
  localStorage.setItem('token', token);
}

function clearToken() {
  localStorage.removeItem('token');
  localStorage.removeItem('user');
}

function setUser(user) {
  localStorage.setItem('user', JSON.stringify(user));
}

function getUser() {
  const u = localStorage.getItem('user');
  return u ? JSON.parse(u) : null;
}

async function request(url, options = {}) {
  const headers = { 'Content-Type': 'application/json', ...options.headers };
  const token = getToken();
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const response = await fetch(`${API_BASE}${url}`, { ...options, headers });
  const data = await response.json();

  if (!response.ok) {
    throw new Error(data.error || `请求失败: ${response.status}`);
  }
  return data;
}

const api = {
  login: (username, password) => request('/auth/login', { method: 'POST', body: JSON.stringify({ username, password }) }),
  logout: () => request('/auth/logout', { method: 'POST' }),
  me: () => request('/me'),

  getDepartments: () => request('/public/departments'),
  getQueueStatus: (deptId, date) => request(`/public/queue/status/${deptId}${date ? `?date=${date}` : ''}`),
  getQueueDisplay: (deptId) => request(`/public/queue/display/${deptId}`),
  getAuditLogs: (params = {}) => {
    const qs = new URLSearchParams(params).toString();
    return request(`/public/audit-logs${qs ? `?${qs}` : ''}`);
  },
  getDailyReport: (date, format = 'json') => request(`/public/reports/daily${format === 'csv' ? '/csv' : ''}${date ? `?date=${date}` : ''}`),

  admin: {
    getDepartments: () => request('/admin/departments'),
    createDepartment: (data) => request('/admin/departments', { method: 'POST', body: JSON.stringify(data) }),
    updateDepartment: (id, data) => request(`/admin/departments/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
    deleteDepartment: (id) => request(`/admin/departments/${id}`, { method: 'DELETE' }),
    getDailySlots: (params = {}) => {
      const qs = new URLSearchParams(params).toString();
      return request(`/admin/daily-slots${qs ? `?${qs}` : ''}`);
    },
    createDailySlot: (data) => request('/admin/daily-slots', { method: 'POST', body: JSON.stringify(data) }),
    updateDailySlot: (id, data) => request(`/admin/daily-slots/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
    getClosedPeriods: () => request('/admin/closed-periods'),
    createClosedPeriod: (data) => request('/admin/closed-periods', { method: 'POST', body: JSON.stringify(data) }),
    deleteClosedPeriod: (id) => request(`/admin/closed-periods/${id}`, { method: 'DELETE' }),
    getUsers: () => request('/admin/users'),
    createUser: (data) => request('/admin/users', { method: 'POST', body: JSON.stringify(data) }),
    batchImport: (csvText) => request('/admin/batch/import', { method: 'POST', body: JSON.stringify({ csv_text: csvText }) }),
    getBatches: (params = {}) => {
      const qs = new URLSearchParams(params).toString();
      return request(`/admin/batches${qs ? `?${qs}` : ''}`);
    },
    getBatchDetail: (id) => request(`/admin/batches/${id}`),
    exportBatchCSV: (id) => `/api/admin/batches/${id}/csv`,
    revokeBatch: (id, reason) => request(`/admin/batches/${id}/revoke`, { method: 'POST', body: JSON.stringify({ reason }) }),
  },

  nurse: {
    createPatient: (data) => request('/nurse/patients', { method: 'POST', body: JSON.stringify(data) }),
    getPatient: (idCard) => request(`/nurse/patients/${idCard}`),
    registerQueue: (data) => request('/nurse/queue/register', { method: 'POST', body: JSON.stringify(data) }),
    getQueue: (deptId, date) => request(`/nurse/queue/${deptId}${date ? `?date=${date}` : ''}`),
    callPatient: (id) => request(`/nurse/queue/call/${id}`, { method: 'POST' }),
    missPatient: (id) => request(`/nurse/queue/miss/${id}`, { method: 'POST' }),
    returnQueue: (id, reason) => request(`/nurse/queue/return/${id}`, { method: 'POST', body: JSON.stringify({ reason }) }),
    getQueueStats: (deptId, date) => request(`/nurse/queue/stats/${deptId}${date ? `?date=${date}` : ''}`),
    batchImport: (csvText) => request('/nurse/batch/import', { method: 'POST', body: JSON.stringify({ csv_text: csvText }) }),
    getBatches: (params = {}) => {
      const qs = new URLSearchParams(params).toString();
      return request(`/nurse/batches${qs ? `?${qs}` : ''}`);
    },
    getBatchDetail: (id) => request(`/nurse/batches/${id}`),
    exportBatchCSV: (id) => `/api/nurse/batches/${id}/csv`,
    revokeBatch: (id, reason) => request(`/nurse/batches/${id}/revoke`, { method: 'POST', body: JSON.stringify({ reason }) }),
  },

  doctor: {
    getCurrent: () => request('/doctor/current'),
    getQueue: () => request('/doctor/queue'),
    getConsulting: () => request('/doctor/consulting'),
    startConsult: (queueId) => request(`/doctor/consult/start/${queueId}`, { method: 'POST' }),
    completeConsult: (queueId, data) => request(`/doctor/consult/complete/${queueId}`, { method: 'POST', body: JSON.stringify(data) }),
    getHistory: (date) => request(`/doctor/history${date ? `?date=${date}` : ''}`),
  },
};
