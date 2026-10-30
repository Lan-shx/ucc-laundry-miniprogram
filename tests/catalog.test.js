const assert = require('node:assert/strict');
const Module = require('node:module');
const originalLoad = Module._load;
let identity = 'owner';
let nextId = 0;
const tables = {
  ucc_laundry_v1_admins: { owner: { enabled: true } },
  ucc_laundry_v1_store: { main: { name: '门店', address: '地址', phone: '13800000000', hours: '9:00–18:00', open: true } },
  ucc_laundry_v1_products: {
    coat: { name: '外套', category: '衣物', unit: '件', price: 2000, enabled: true },
    shoe: { name: '运动鞋', category: '鞋靴', unit: '双', price: 3000, enabled: false },
  },
  ucc_laundry_v1_orders: { old: { items: [{ name: '旧外套', price: 1900, qty: 1 }], estimate: 1900, status: 'pending' } },
};
function collection(name) {
  const table = tables[name];
  function query(filter = {}) { return {
    limit(size) { this.size = size; return this; },
    async get() { return { data: Object.entries(table).map(([id, row]) => ({ ...row, _id: id }))
      .filter(row => Object.entries(filter).every(([key, value]) => row[key] === value)).slice(0, this.size || 100) }; },
  }; }
  return { ...query(), where: query,
    doc(id) { return {
      async get() { if (!table[id]) throw Error('DOCUMENT_NOT_EXIST'); return { data: { ...table[id], _id: id } }; },
      async set({ data }) { table[id] = { ...data }; },
    }; },
    async add({ data }) { const id = 'new_' + (++nextId); table[id] = { ...data }; return { _id: id }; },
  };
}
const mock = { init() {}, DYNAMIC_CURRENT_ENV: 'test', database() { return { collection }; }, getWXContext() { return { OPENID: identity }; } };
Module._load = function(name, ...args) { return name === 'wx-server-sdk' ? mock : originalLoad.call(this, name, ...args); };
const api = require('../cloudfunctions/uccLaundry/index.js');
Module._load = originalLoad;
const call = (action, data = {}) => api.main({ action, data });
const sortedNames = result => [...result.data.categoryNames].sort();

(async () => {
  const orderBefore = JSON.stringify(tables.ucc_laundry_v1_orders);
  assert.deepEqual(sortedNames(await call('adminCatalog')), ['衣物', '鞋靴'].sort());
  assert.equal((await call('saveCategory', { name: '全部' })).ok, false);
  assert.equal((await call('saveCategory', { name: ' '.repeat(3) })).ok, false);
  assert.equal((await call('saveCategory', { name: '长'.repeat(31) })).ok, false);
  assert.equal((await call('saveCategory', { name: ' 家纺 ' })).ok, true);
  await Promise.all([call('saveCategory', { name: '家纺' }), call('saveCategory', { name: '家纺' })]);
  assert.equal(Object.values(tables.ucc_laundry_v1_store).filter(row => row.name === '家纺').length, 1);
  assert(sortedNames(await call('adminCatalog')).includes('家纺'), '空类目需要保留');
  const product = { name: '床单', category: '家纺', unit: '件', price: 2500, enabled: true };
  assert.equal((await call('saveProduct', { ...product, category: '不存在' })).ok, false);
  assert.equal((await call('saveProduct', product)).ok, true);
  assert.equal((await call('saveProduct', { ...product, id: 'missing' })).ok, false);
  assert.equal((await call('saveProduct', { ...product, id: 'coat', name: '外套' })).ok, true);
  assert(sortedNames(await call('adminCatalog')).includes('衣物'), '最后一个单品移走后仍保留类目');
  assert.equal((await call('saveStore', { ...tables.ucc_laundry_v1_store.main, name: '新门店名' })).ok, true);
  assert(sortedNames(await call('adminCatalog')).includes('家纺'), '保存营业资料不能覆盖类目');
  assert.equal(JSON.stringify(tables.ucc_laundry_v1_orders), orderBefore, '价目修改不得更改历史订单');
  identity = 'customer';
  assert.equal((await call('saveCategory', { name: '越权类目' })).ok, false);
  assert.equal((await call('saveProduct', product)).ok, false);
  assert.equal((await call('adminCatalog')).ok, false);
  const customer = await call('catalog');
  assert(customer.data.products.every(row => row.enabled));
  assert.equal(customer.data.categoryNames, undefined);
  console.log('旧类目兼容、空类目、重复添加、单品归类、门店资料独立、历史订单与权限测试通过');
})().catch(error => { console.error(error); process.exitCode = 1; });
