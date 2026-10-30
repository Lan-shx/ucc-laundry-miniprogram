const {createHash} = require('crypto');
const clean = (value, max = 200) => String(value || '').trim().slice(0, max);
const businessNumber = id => 'L' + createHash('sha256').update(id).digest('hex').slice(0, 12).toUpperCase();
const today = () => new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
function intake(value = {}) {
  const dueDate = clean(value.dueDate, 10);
  if (dueDate && (!/^\d{4}-\d{2}-\d{2}$/.test(dueDate) || Number.isNaN(Date.parse(dueDate)) || new Date(dueDate).toISOString().slice(0, 10) !== dueDate)) throw Error('请填写有效的预计完成日期');
  return { ticketNo: clean(value.ticketNo, 30), storageLocation: clean(value.storageLocation, 60), dueDate, internalNote: clean(value.internalNote, 500) };
}
function confirmItems(input, originals, services) {
  if (!Array.isArray(input) || !input.length || input.length > 50) throw Error('请保留至少一项实际收衣项目');
  const seen = new Set();
  return input.map(row => {
    const id = clean(row.id, 100);
    const source = originals.find(item => item.id === id) || services.find(item => item._id === id && item.enabled === true);
    if (!source || seen.has(id) || !Number.isInteger(row.qty) || row.qty < 1 || row.qty > 99 || !Number.isInteger(row.price) || row.price < 0 || row.price > 10000000) throw Error('请检查衣物项目、数量和单价');
    seen.add(id);
    return { id, name: source.name, unit: source.unit, qty: row.qty, price: row.price };
  });
}
const itemsChanged = (a, b) => a.length !== b.length || a.some(item => { const old = b.find(row => row.id === item.id); return !old || old.qty !== item.qty || old.price !== item.price; });
function publicOrder(order) {
  const result = {};
  for (const key of ['_id', 'owner', 'businessNumber', 'source', 'name', 'phone', 'note', 'items', 'confirmed', 'estimate', 'actual', 'status', 'notice', 'createdAt', 'updatedAt', 'version', 'ticketNo', 'dueDate', 'publicUpdates']) if (order[key] !== undefined) result[key] = order[key];
  result.events = (order.events || []).filter(event => !event.internal);
  return result;
}
module.exports = { clean, businessNumber, today, intake, confirmItems, itemsChanged, publicOrder };
