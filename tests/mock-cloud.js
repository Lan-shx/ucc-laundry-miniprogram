const Module = require('node:module');
class Condition {
  constructor(test) { this.test = test; }
  and(other) { return new Condition(value => this.test(value) && other.test(value)); }
}
module.exports = function testApi() {
  let actor = 'owner', sequence = 0;
  const tables = {
    ucc_laundry_v1_admins: {owner: {enabled: true}},
    ucc_laundry_v1_store: {main: {name: '门店', address: '真实地址', phone: '13800000000', hours: '9:00–18:00', open: true}},
    ucc_laundry_v1_products: {
      p1: {name: '外套', category: '衣物', unit: '件', price: 2000, enabled: true},
      p2: {name: '鞋', category: '鞋靴', unit: '双', price: 3000, enabled: true},
      p3: {name: '衬衫', category: '衣物', unit: '件', price: 1500, enabled: true},
    },
    ucc_laundry_v1_orders: {},
  };
  const command = {
    in: values => new Condition(value => values.includes(value)),
    neq: expected => new Condition(value => value !== expected),
    lt: expected => new Condition(value => typeof value === typeof expected && value < expected),
    gt: expected => new Condition(value => typeof value === typeof expected && value > expected),
    gte: expected => new Condition(value => typeof value === typeof expected && value >= expected),
  };
  function collection(name) {
    const table = tables[name] || (tables[name] = {});
    const matches = (row, filter) => Object.entries(filter).every(([key, expected]) => expected instanceof Condition ? expected.test(row[key]) : expected instanceof RegExp ? expected.test(row[key]) : row[key] === expected);
    function query(filter = {}) { return {
      orderBy(field, direction) { this.sort = {field, direction}; return this; },
      skip(value) { this.offset = value; return this; },
      limit(value) { this.size = value; return this; },
      async count() { return {total: Object.entries(table).filter(([id, row]) => matches({...row, _id: id}, filter)).length}; },
      async get() {
        const rows = Object.entries(table).map(([id, row]) => ({...structuredClone(row), _id: id})).filter(row => matches(row, filter));
        if (this.sort) rows.sort((a, b) => String(a[this.sort.field] || '').localeCompare(String(b[this.sort.field] || '')) * (this.sort.direction === 'desc' ? -1 : 1));
        return {data: rows.slice(this.offset || 0, (this.offset || 0) + (this.size || 100))};
      },
      async update({data}) { let updated = 0; for (const [id, row] of Object.entries(table)) if (matches({...row, _id: id}, filter)) { Object.assign(row, structuredClone(data)); updated++; } return {stats: {updated}}; },
    }; }
    return {...query(), where: query,
      doc(id) { return {
        async get() { if (!table[id]) throw Error('DOCUMENT_NOT_EXIST'); return {data: {...structuredClone(table[id]), _id: id}}; },
        async set({data}) { table[id] = structuredClone(data); },
        async remove() { const removed=table[id]?1:0;delete table[id];return {stats:{removed}}; },
      }; },
      async add({data}) { const id = data._id || 'generated_' + (++sequence); if (table[id]) throw Error('duplicate'); table[id] = structuredClone(data); return {_id: id}; },
    };
  }
  const mock = {
    init() {}, DYNAMIC_CURRENT_ENV: 'test',
    database() { return {collection, command, async createCollection(name){if(tables[name])throw Error('[ResourceUnavailable.ResourceExist] Table exist');tables[name]={};}, RegExp: ({regexp, options}) => new RegExp(regexp, options)}; },
    getWXContext() { return {OPENID: actor}; },
    async getTempFileURL({fileList}) { return {fileList: fileList.map(fileID => ({fileID, status: 0, tempFileURL: 'https://example.test/' + encodeURIComponent(fileID)}))}; },
    openapi: {subscribeMessage: {async send() { return {errCode: 0}; }}},
  };
  const original = Module._load;
  Module._load = function(name, ...args) { return name === 'wx-server-sdk' ? mock : original.call(this, name, ...args); };
  delete require.cache[require.resolve('../cloudfunctions/uccLaundry/index.js')];
  const api = require('../cloudfunctions/uccLaundry/index.js');
  Module._load = original;
  return {tables, setActor(value) { actor = value; }, call(action, data = {}) { return api.main({action, data}); }};
};
