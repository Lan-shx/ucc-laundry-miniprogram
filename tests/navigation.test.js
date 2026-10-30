const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

let definition;
const requests = [];
let failWorkbench = false;
let failCategory = false;
let confirmAnswer = true;
const catalogCategoryNames = ['衣物', '鞋靴'];
const source = fs.readFileSync(path.join(__dirname, '../miniprogram/pages/index/index.js'), 'utf8');
const sampleOrder = { _id: 'order_12345678', status: 'pending', items: [{ id: 'service', name: '外套', qty: 1, price: 2000 }], createdAt: '2026-10-29T00:00:00Z' };
vm.runInNewContext(source, {
  Page(value) { definition = value; },
  wx: {
    pageScrollTo() {},
    showToast() {},
    showModal(options) { options.success({confirm:confirmAnswer}); },
    cloud: { async callFunction({ data }) {
      requests.push(data);
      if (data.action === 'workbench' && failWorkbench) return { result: { ok: false, error: '统计暂不可用' } };
      if (data.action === 'saveCategory') {
        if (failCategory) return { result: { ok: false, error: '保存失败，请重试' } };
        if (!catalogCategoryNames.includes(data.data.name)) catalogCategoryNames.push(data.data.name);
      }
      const result = ['catalog', 'adminCatalog'].includes(data.action)
        ? { store: { name: '门店', open: true }, categoryNames: catalogCategoryNames,
          products: [{ _id: 'service', name: '外套', category: '衣物', price: 2000, unit: '件', enabled: true }] }
        : data.action === 'detail' ? sampleOrder : data.action === 'workbench' ? { pending: 35, processing: 27, ready: 32, unnotified: 22 } : [];
      return { result: { ok: true, data: result } };
    } },
  },
});

function makePage(admin = true) {
  const page = { ...definition, data: JSON.parse(JSON.stringify(definition.data)) };
  page.data.admin = admin;
  page.setData = function(patch, callback) {
    for (const [key, value] of Object.entries(patch)) {
      const parts = key.replace(/\[(\d+)\]/g, '.$1').split('.');
      let target = this.data;
      for (const part of parts.slice(0, -1)) target = target[part];
      target[parts.at(-1)] = value;
    }
    if (callback) callback();
  };
  return page;
}
const event = page => ({ currentTarget: { dataset: { page } } });

(async () => {
  const owner = makePage();
  await owner.mode();
  assert.equal(owner.data.adminMode, true);
  assert.equal(owner.data.page, 'workbench');
  assert.equal(owner.data.stats.pending, 35);
  failWorkbench = true;
  await owner.loadWorkbench();
  assert.equal(owner.data.statsError, true);
  assert.equal(owner.data.stats.pending, 35, '更新失败保留上次结果');
  failWorkbench = false;
  await owner.loadWorkbench();
  assert.equal(owner.data.statsError, false);
  await owner.taskOrders({ currentTarget: { dataset: { filter: '待通知' } } });
  assert.equal(requests.at(-1).data.noticeOnly, true);
  owner.setData({ orders: [
    { status: 'ready', notice: '未接通' },
    { status: 'ready', notice: '已通知' },
    { status: 'ready' },
    { status: 'processing' },
  ] });
  owner.filterOrders();
  assert.equal(owner.data.shownOrders.length, 2);
  await owner.taskOrders({ currentTarget: { dataset: { filter: '待取件' } } });
  assert.equal(owner.data.page, 'admin');
  assert.equal(requests.at(-1).data.status, 'ready');
  await owner.open({ currentTarget: { dataset: { id: sampleOrder._id } } });
  assert.equal(owner.data.orderReturn, 'admin');
  assert.equal(owner.data.editChanged, false);
  const priceInput = value => ({ currentTarget: { dataset: { index: 0, key: 'priceText' } }, detail: { value } });
  owner.editField(priceInput('20.00'));
  assert.equal(owner.data.editChanged, false);
  owner.editField(priceInput('21.00'));
  assert.equal(owner.data.editChanged, true);
  owner.editField(priceInput('20'));
  assert.equal(owner.data.editChanged, false);
  owner.data.loading=false;
  await owner.onShow();
  assert.equal(owner.data.detailStale,true,'未保存的调整不应被自动刷新覆盖');
  confirmAnswer=false;
  await owner.go(event('admin'));
  assert.equal(owner.data.page,'detail','拒绝放弃草稿时保留详情');
  confirmAnswer=true;
  await owner.go(event('admin'));
  assert.equal(owner.data.filter, '待取件');
  await owner.adminTab(event('manage'));
  assert.equal(owner.data.page, 'manage');
  await owner.go(event('prices'));
  assert.equal(owner.data.page, 'prices');
  owner.newCategory();
  owner.setData({ categoryDraft: '家纺' });
  await owner.saveCategory();
  assert.equal(owner.data.page, 'prices');
  assert.equal(owner.data.priceCategory, '家纺');
  assert.equal(owner.data.priceProducts.length, 0);
  owner.newProduct();
  assert.equal(owner.data.product.category, '家纺');
  owner.setData({ 'product.name': '床单', 'product.price': '25.50' });
  owner.newCategory();
  owner.setData({ categoryDraft: '窗帘' });
  failCategory = true;
  await owner.saveCategory();
  assert.equal(owner.data.page, 'categoryForm');
  assert.equal(owner.data.product.name, '床单');
  assert.equal(owner.data.categoryDraft, '窗帘');
  failCategory = false;
  await owner.saveCategory();
  assert.equal(owner.data.page, 'product');
  assert.equal(owner.data.product.name, '床单');
  assert.equal(owner.data.product.price, '25.50');
  assert.equal(owner.data.product.category, '窗帘');
  await owner.saveProduct();
  const savedProduct = requests.findLast(request => request.action === 'saveProduct');
  assert.equal(savedProduct.data.price, 2550);
  assert.equal(savedProduct.data.category, '窗帘');
  assert.equal(owner.data.priceCategory, '窗帘');
  await owner.go(event('manage'));
  await owner.adminTab(event('workbench'));
  await owner.go(event('prices'));
  assert.equal(owner.data.page, 'prices');
  await owner.go(event('workbench'));
  await owner.go(event('guest'));
  assert.equal(owner.data.orderReturn, 'workbench');
  await owner.go(event('workbench'));
  await owner.mode();
  assert.equal(owner.data.adminMode, false);
  assert.equal(owner.data.page, 'mine');
  await owner.mode();
  assert.equal(owner.data.page, 'workbench');
  assert.equal(owner.data.adminMode, true);

  const customer = makePage(false);
  const count = requests.length;
  for (const page of ['workbench', 'admin', 'manage', 'prices', 'settings', 'guest', 'help', 'categoryForm']) {
    await customer.go(event(page));
    assert.equal(customer.data.page, 'home');
  }
  assert.equal(requests.length, count);
  await customer.loadWorkbench();
  assert.equal(requests.length, count);
  await customer.go(event('mine'));
  assert.equal(customer.data.page, 'mine');
  await customer.mode();
  assert.equal(customer.data.adminMode, false);
  assert.equal(customer.data.page, 'mine');
  await customer.go(event('orders'));
  assert.equal(customer.data.page, 'orders');
  assert.equal(requests.at(-1).data.admin, false);

  owner.data.adminMode = true;
  owner.data.page = 'workbench';
  owner.data.busy = true;
  await owner.adminTab(event('manage'));
  assert.equal(owner.data.page, 'workbench');
  console.log('工作台统计与失败恢复、待通知筛选、导航返回、忙碌保护与顾客入口隔离通过');
})().catch(error => { console.error(error); process.exitCode = 1; });
