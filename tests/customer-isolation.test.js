const assert = require('assert');
const Module = require('module');
const originalLoad = Module._load;
let identity = 'owner';
const tables = {
  ucc_laundry_v1_admins: { owner: { enabled: true } },
  ucc_laundry_v1_store: { main: { open: true } },
  ucc_laundry_v1_products: { service: { name: '测试服务', unit: '件', price: 1000, enabled: true } },
  ucc_laundry_v1_orders: {},
};

function collection(name) {
  const table = tables[name];
  function query(filter = {}) {
    return {
      orderBy() { return this; },
      skip(value) { this.offset = value; return this; },
      limit(value) { this.size = value; return this; },
      async get() {
        const rows = Object.entries(table).map(([id, row]) => ({ ...row, _id: id }))
          .filter(row => Object.entries(filter).every(([key, value]) => row[key] === value));
        return { data: rows.slice(this.offset || 0, (this.offset || 0) + (this.size || 100)) };
      },
      async update({ data }) {
        const row = table[filter._id];
        if (!row || row.status !== filter.status || row.version !== filter.version) return { stats: { updated: 0 } };
        Object.assign(row, data);
        return { stats: { updated: 1 } };
      },
    };
  }
  return {
    ...query(),
    where: query,
    doc(id) { return { async get() { if (!table[id]) throw new Error('DOCUMENT_NOT_EXIST'); return { data: { ...table[id], _id: id } }; } }; },
    async add({ data }) { if (table[data._id]) throw new Error('duplicate'); table[data._id] = { ...data }; return { _id: data._id }; },
  };
}

const mock = {
  DYNAMIC_CURRENT_ENV: 'test',
  init() {},
  database() { return { collection }; },
  getWXContext() { return { OPENID: identity }; },
  openapi: { subscribeMessage: { async send() { return { errCode: 0 }; } } },
};
Module._load = function(name, ...args) { return name === 'wx-server-sdk' ? mock : originalLoad.call(this, name, ...args); };
const api = require('../cloudfunctions/uccLaundry/index.js');
const call = (action, data = {}) => api.main({ action, data });

(async () => {
  const ids = {};
  for (const [user, phone] of [['alice', '13800000001'], ['bob', '13800000002']]) {
    identity = user;
    const result = await call('create', { name: user, phone, items: [{ id: 'service', qty: 1 }], requestId: `test_request_${user}_123456` });
    assert.strictEqual(result.ok, true);
    ids[user] = result.data.id;
  }
  for (const [user, other] of [['alice', 'bob'], ['bob', 'alice']]) {
    identity = user;
    const list = await call('list', { admin: false });
    assert.deepStrictEqual(list.data.map(order => order._id), [ids[user]]);
    assert.strictEqual((await call('detail', { id: ids[user] })).ok, true);
    assert.strictEqual((await call('detail', { id: ids[other] })).ok, false);
    assert.strictEqual((await call('cancel', { id: ids[other], version: 1 })).ok, false);
    assert.strictEqual((await call('list', { admin: true })).ok, false);
    assert.strictEqual((await call('transition', { id: ids[other], op: 'ready' })).ok, false);
  }
  identity = 'owner';
  assert.deepStrictEqual(new Set((await call('list', { admin: true })).data.map(order => order._id)), new Set(Object.values(ids)));
  console.log('模拟两位顾客：订单列表、详情、取消和店主权限隔离通过');
})().catch(error => { console.error(error); process.exitCode = 1; });
