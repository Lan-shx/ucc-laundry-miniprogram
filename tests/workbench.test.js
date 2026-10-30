const assert = require('node:assert/strict');
const Module = require('node:module');
const originalLoad = Module._load;
let identity = 'owner';
let failCount = false;
const orders = {};
let sequence = 0;
function add(status, notice) {
  const id = 'fixture_' + (++sequence);
  orders[id] = { _id: id, owner: sequence % 2 ? 'customer' : '', source: sequence % 2 ? 'customer' : 'guest', status, notice, version: 1, events: [], createdAt: String(sequence).padStart(4, '0') };
  return id;
}
for (let i = 0; i < 35; i++) add('pending');
for (let i = 0; i < 27; i++) add('processing');
for (let i = 0; i < 12; i++) add('ready', '未通知');
for (let i = 0; i < 9; i++) add('ready', '未接通');
for (let i = 0; i < 10; i++) add('ready', '已通知');
add('ready'); // Old orders without a notice field must remain actionable.
for (let i = 0; i < 8; i++) add('completed');
for (let i = 0; i < 7; i++) add('cancelled');

function query(filter = {}) {
  const matches = row => Object.entries(filter).every(([key, value]) =>
    value && Object.hasOwn(value, 'notEqual') ? row[key] !== value.notEqual : row[key] === value);
  return {
    orderBy() { return this; },
    skip(value) { this.offset = value; return this; },
    limit(value) { this.size = value; return this; },
    async count() { if (failCount) throw Error('offline'); return { total: Object.values(orders).filter(matches).length }; },
    async get() { return { data: Object.values(orders).filter(matches).slice(this.offset || 0, (this.offset || 0) + (this.size || 100)) }; },
    async update({ data }) {
      let updated = 0;
      for (const row of Object.values(orders)) if (matches(row)) { Object.assign(row, data); updated++; }
      return { stats: { updated } };
    },
  };
}
const mock = {
  init() {}, DYNAMIC_CURRENT_ENV: 'test',
  getWXContext() { return { OPENID: identity }; },
  database() { return {
    command: { neq: notEqual => ({ notEqual }) },
    collection(name) {
      if (name.endsWith('_admins')) return { doc(id) { return { async get() { return { data: { enabled: id === 'owner' } }; } }; } };
      if (name.endsWith('_orders')) return { ...query(), where: query, doc(id) { return { async get() { return { data: orders[id] }; } }; } };
      return {};
    },
  }; },
};
Module._load = function(name, ...args) { return name === 'wx-server-sdk' ? mock : originalLoad.call(this, name, ...args); };
const api = require('../cloudfunctions/uccLaundry/index.js');
Module._load = originalLoad;
const call = (action, data = {}) => api.main({ action, data });

(async () => {
  assert.deepEqual((await call('workbench')).data, { pending: 35, processing: 27, ready: 32, unnotified: 22 });
  assert.equal((await call('list', { admin: true, status: 'pending' })).data.length, 20);
  const first = (await call('list', { admin: true, noticeOnly: true })).data;
  const second = (await call('list', { admin: true, noticeOnly: true, page: 1 })).data;
  assert.equal(first.length + second.length, 22);
  assert(first.concat(second).every(row => row.status === 'ready' && row.notice !== '已通知'));
  const target = first[0];
  assert.equal((await call('transition', { id: target._id, version: target.version, op: 'notice', notice: '已通知' })).ok, true);
  assert.equal((await call('workbench')).data.unnotified, 21);
  assert.equal((await call('transition', { id: target._id, version: target.version, op: 'complete' })).ok, true);
  assert.equal((await call('workbench')).data.ready, 31);
  identity = 'customer';
  assert.equal((await call('workbench')).ok, false);
  assert.equal((await call('list', { admin: true, noticeOnly: true })).ok, false);
  assert((await call('list', { admin: false, noticeOnly: true })).data.every(row => row.owner === 'customer'));
  identity = 'owner'; failCount = true;
  assert.equal((await call('workbench')).ok, false, '失败不能伪装成零待办');
  console.log('全店待办计数、超过20条分页、代客单、旧单、通知与取件变更、失败和权限检查通过');
})().catch(error => { console.error(error); process.exitCode = 1; });
