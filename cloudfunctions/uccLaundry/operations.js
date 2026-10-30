const {randomBytes, createHash, createCipheriv, createDecipheriv} = require('crypto');
const {clean, intake, today} = require('./order-domain');
const hash = value => createHash('sha256').update(String(value)).digest('hex');
module.exports = async function operations(action, data, actor, ctx) {
  const {orders, stores, products, admins, db, mustAdmin, findOrder, change, checkVersion, now} = ctx;
  const names = ['saveIntake', 'issueClaim', 'claimPreview', 'claimOrder', 'saveCase', 'resolveCase', 'cancelAfterReceipt', 'backupPage', 'retentionList', 'workbenchExtra', 'restoreRehearsal', 'restoreStatus', 'cleanupRestoreChecks'];
  if (!names.includes(action)) return null;
  if (action === 'claimPreview' || action === 'claimOrder') {
    const order = await findOrder(data.id);
    if (action === 'claimOrder' && order.owner === actor) return {id: order._id};
    if (order.source !== 'guest' || order.owner || order.status === 'cancelled' || !/^[a-f0-9]{32}$/.test(String(data.token || '')) || order.claimHash !== hash(data.token) || !order.claimExpiresAt || order.claimExpiresAt <= now()) throw Error('认领入口已失效，请联系店主重新生成');
    if (action === 'claimPreview') return {id: order._id, name: String(order.name || '').slice(0, 1) + '**', phoneTail: String(order.phone).slice(-4), amount: order.actual, itemCount: (order.confirmed || order.items).reduce((n, row) => n + row.qty, 0)};
    await change(order, order.status, {owner: actor, claimHash: '', claimExpiresAt: ''}, '顾客已认领到店订单');
    return {id: order._id};
  }
  await mustAdmin(actor);
  if (action === 'restoreStatus') {
    const rows=(await db.collection('ucc_laundry_v1_restore_checks').where({actor:hash(actor)}).limit(100).get()).data;
    return rows.map(row=>({_id:row._id,runId:row.restoreRun}));
  }
  if (action === 'cleanupRestoreChecks') {
    if(!/^[a-f0-9]{32}$/.test(String(data.runId||'')))throw Error('备份校验请求无效');
    const target=db.collection('ucc_laundry_v1_restore_checks');
    const rows=(await target.where({actor:hash(actor),restoreRun:data.runId}).limit(100).get()).data;
    for(const row of rows)await target.doc(row._id).remove();
    return {cleaned:rows.length};
  }
  if (action === 'restoreRehearsal') {
    if (!/^[a-f0-9]{32}$/.test(String(data.runId || '')) || !data.collections) throw Error('备份校验请求无效');
    const rows = [];
    for (const key of ['store','products','orders','admins']) {
      if (!Array.isArray(data.collections[key])) throw Error('备份校验集合不完整');
      for (const row of data.collections[key]) {
        if (!row || typeof row._id !== 'string') throw Error('备份记录无效');
        rows.push({source: key, payload: JSON.stringify(row)});
      }
    }
    if (!rows.length || rows.length > 100 || rows.some(row => row.payload.length > 500000)) throw Error('备份校验仅支持本批次最多100条记录');
    const collectionName = 'ucc_laundry_v1_restore_checks';
    try { await db.createCollection(collectionName); } catch (e) { if (!/already exist|COLLECTION_EXIST|ResourceExist|Table exist|已存在/i.test(String(e))) throw Error('备份校验集合创建失败：'+String(e.code||e.errCode||'')+' '+String(e.message||e).slice(0,100)); }
    const target = db.collection(collectionName), ids = [], key = randomBytes(32);
    let verified = 0;
    try {
      for (let index = 0; index < rows.length; index++) {
        const testId = data.runId + '_' + index;
        ids.push(testId);
        const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,iv);
        const ciphertext=Buffer.concat([cipher.update(rows[index].payload,'utf8'),cipher.final()]);
        await target.doc(testId).set({data: {restoreRun: data.runId, actor:hash(actor), source:rows[index].source, ciphertext:ciphertext.toString('base64'),iv:iv.toString('base64'),tag:cipher.getAuthTag().toString('base64')}});
        const restored = (await target.doc(testId).get()).data;
        const decipher=createDecipheriv('aes-256-gcm',key,Buffer.from(restored.iv,'base64'));decipher.setAuthTag(Buffer.from(restored.tag,'base64'));
        const payload=Buffer.concat([decipher.update(Buffer.from(restored.ciphertext,'base64')),decipher.final()]).toString('utf8');
        if (restored.source !== rows[index].source || hash(payload) !== hash(rows[index].payload)) throw Error('备份恢复校验不一致');
        verified++;
      }
    } catch (e) {
      throw Error('备份恢复校验失败：'+String(e.code||e.errCode||'')+' '+String(e.message||e).slice(0,100));
    } finally {
      for (const testId of ids) await target.doc(testId).remove();
    }
    return {collection: collectionName, verified, cleaned: ids.length, checkedAt: now()};
  }
  if (action === 'workbenchExtra') {
    const [overdue, exceptions] = await Promise.all([
      orders.where({status: 'processing', dueDate: db.command.lt(today()).and(db.command.gt(''))}).count(),
      orders.where({exceptionOpen: true}).count(),
    ]);
    return {overdue: overdue.total, exceptions: exceptions.total};
  }
  if (action === 'backupPage') {
    const source = {orders, store: stores, products, admins}[data.collection];
    if (!source) throw Error('备份集合无效');
    const page = Number.isInteger(data.page) && data.page >= 0 ? data.page : 0;
    return {collection: data.collection, page, rows: (await source.orderBy('_id', 'asc').skip(page * 100).limit(100).get()).data, exportedAt: now()};
  }
  if (action === 'retentionList') {
    const store = await ctx.getStore();
    const days = Number(store.retentionDays) || 365;
    const cutoff = new Date(Date.now() - days * 86400000).toISOString();
    return (await orders.where({status: db.command.in(['completed', 'cancelled']), updatedAt: db.command.lt(cutoff)}).orderBy('updatedAt', 'asc').limit(100).get()).data.map(row => ({_id: row._id, businessNumber: row.businessNumber, status: row.status, updatedAt: row.updatedAt}));
  }
  const order = await findOrder(data.id);
  checkVersion(order, data.version);
  if (action === 'saveIntake') {
    await change(order, order.status, intake(data.intake), '更新挂号、位置或预计完成日期', true);
    return {};
  }
  if (action === 'issueClaim') {
    if (order.source !== 'guest' || order.owner || order.status === 'cancelled') throw Error('此订单无需认领或已结束');
    const token = randomBytes(16).toString('hex');
    const expiresAt = new Date(Date.now() + 30 * 60000).toISOString();
    await change(order, order.status, {claimHash: hash(token), claimExpiresAt: expiresAt}, '店主生成一次性认领入口', true);
    return {id: order._id, token, expiresAt};
  }
  if (action === 'saveCase') {
    const type = clean(data.type, 20), text = clean(data.text, 500), publicText = clean(data.publicText, 300);
    if (!['污渍', '原有破损', '返洗', '拒洗', '延期', '其他'].includes(type) || !text) throw Error('请填写异常类型和处理说明');
    const photos = Array.isArray(data.photos) ? data.photos : [];
    if (photos.length > 3 || photos.some(file => typeof file !== 'string' || !file.startsWith('cloud://') || !file.includes('/order-evidence/' + actor + '/'))) throw Error('衣物照片无效，请重新上传');
    const cases = order.cases || [];
    if (cases.length >= 100) throw Error('此订单异常记录已达上限，请联系维护人员');
    const entry = {id: randomBytes(12).toString('hex'), type, text, publicText, photos, time: now(), resolved: false};
    if(type==='返洗'&&order.status==='cancelled')throw Error('当前订单已取消，不能登记返洗');
    const returnToProcessing=type==='返洗'&&['ready','completed'].includes(order.status);
    const customerText=publicText||(returnToProcessing?'已登记返洗，衣物正在重新处理。':'');
    const updates = customerText ? [...(order.publicUpdates || []), {time: now(), text: customerText}] : order.publicUpdates || [];
    await change(order, order.status, {cases: [...cases, entry], publicUpdates: updates, exceptionOpen: true,...(returnToProcessing?{status:'processing',notice:'未通知'}:{})}, '新增异常记录：' + type, true);
    return {};
  }
  if (action === 'resolveCase') {
    const text = clean(data.text, 500);
    if (!text) throw Error('请填写处理结果');
    const cases = (order.cases || []).map(entry => entry.id === data.caseId ? {...entry, resolved: true, resolution: text, resolvedAt: now()} : entry);
    if (!cases.some(entry => entry.id === data.caseId)) throw Error('异常记录不存在');
    await change(order, order.status, {cases, exceptionOpen: cases.some(entry => !entry.resolved)}, '记录异常处理结果', true);
    return {};
  }
  if (action === 'cancelAfterReceipt') {
    const reason = clean(data.reason, 200);
    if (!['processing', 'ready'].includes(order.status) || !reason || data.returned !== true) throw Error('请确认已退还衣物并填写退单原因');
    const cases=(order.cases||[]).map(entry=>entry.resolved?entry:{...entry,resolved:true,resolution:'退单且已退还衣物：'+reason,resolvedAt:now()});
    await change(order, order.status, {status: 'cancelled', exceptionOpen: false,cases}, '收衣后退单，已退还衣物；原因：' + reason);
    return {};
  }
};
