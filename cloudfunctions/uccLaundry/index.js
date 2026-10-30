const cloud = require('wx-server-sdk');
const {createHash} = require('crypto');
const domain = require('./order-domain');
const operations = require('./operations');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const stores = db.collection('ucc_laundry_v1_store'), products = db.collection('ucc_laundry_v1_products'), orders = db.collection('ucc_laundry_v1_orders'), admins = db.collection('ucc_laundry_v1_admins');
const clean = (v, n=200) => String(v || '').trim().slice(0,n);
const integer = (v, min, max) => Number.isInteger(v) && v >= min && v <= max;
const total = items => items.reduce((n,i)=>n+i.price*i.qty,0);
const validPhone = s => /^1\d{10}$/.test(s);
const defaults = {name:'', address:'', phone:'', hours:'', open:false};
const now = () => new Date().toISOString();
const notificationTemplate='8rmUEA-A59h5MtruY50pvt7OSyaxwm7CMSINfsJqicc';
const requestSignature = (guest,name,phone,note,items) => JSON.stringify({guest,name,phone,note,items:items.map(i=>({id:clean(i.id,100),qty:i.qty,expectedPrice:i.expectedPrice === undefined ? null : i.expectedPrice}))});
async function getStore(){ try { return (await stores.doc('main').get()).data || defaults; } catch(e) { if (/not exist|不存在|DOCUMENT_NOT_EXIST/i.test(String(e))) return defaults; throw e; } }
async function isAdmin(id){ try { const r=await admins.doc(id).get(); return !!(r.data && r.data.enabled === true); } catch(e) { if (/not exist|不存在|DOCUMENT_NOT_EXIST/i.test(String(e))) return false; throw e; } }
async function mustAdmin(id){ if(!await isAdmin(id)) throw new Error('没有店主权限'); }
async function findOrder(id){ if(!clean(id,100)) throw new Error('订单不存在'); try{return (await orders.doc(id).get()).data;}catch(e){throw new Error('订单不存在');} }
function checkVersion(o, version){if(version!==undefined&&version!==o.version)throw new Error('订单状态已变化，请刷新后重试');}
function history(o, text, internal=false){ return [{time:now(),text,...(internal?{internal:true}:{})},...(o.events||[])]; }
async function catalog(){return (await products.limit(100).get()).data;}
async function categoryCatalog(all){
 const records=(await stores.where({kind:'catalogCategory'}).limit(100).get()).data;
 const stored=new Set(records.map(record=>record.name));
 const names=[...new Set([...stored,...all.map(product=>clean(product.category,30)||'未分类')])].sort((a,b)=>a.localeCompare(b,'zh-CN'));
 return {names,missing:names.filter(name=>!stored.has(name))};
}
async function persistCategories(names){
 await Promise.all(names.map(name=>stores.doc('category_'+createHash('sha256').update(name).digest('hex')).set({data:{kind:'catalogCategory',name}})));
}
async function displayProducts(items){
 const ids=[...new Set(items.map(p=>p.image).filter(Boolean))], urls={};
 for(let i=0;i<ids.length;i+=50){const result=await cloud.getTempFileURL({fileList:ids.slice(i,i+50)});for(const f of result.fileList||[])if(f.status===0&&f.tempFileURL)urls[f.fileID]=f.tempFileURL;}
 return items.map(p=>({...p,imageUrl:urls[p.image]||''}));
}
async function displayStore(store){if(!store.storefrontImage)return store;const [image]=await displayProducts([{image:store.storefrontImage}]);return {...store,storefrontUrl:image.imageUrl};}
async function notifyOwner(order){
 try {
  const receivers=(await admins.where({enabled:true}).limit(100).get()).data;
  if(!receivers.length)return 'failed';
  const shortNumber=order._id.slice(-20).replace(/[^a-zA-Z0-9]/g,'').slice(-18)||'1';
  const localTime=new Date(new Date(order.createdAt).getTime()+8*3600000).toISOString().replace('T',' ').slice(0,16);
  let sent=0;
  for(const receiver of receivers){try{const response=await cloud.openapi.subscribeMessage.send({touser:receiver._id,templateId:notificationTemplate,page:'pages/index/index?notice=1',data:{character_string3:{value:shortNumber},thing4:{value:Array.from(order.items.map(x=>x.name).join('、')).slice(0,20).join('')||'送洗服务'},phrase6:{value:'待送店'},time30:{value:localTime}}});if(response&&Number(response.errCode||response.errcode||0)!==0)throw new Error('send failed');sent++;}catch(e){}}
  return sent?'sent':'failed';
 }catch(e){return 'failed';}
}
async function prepareItems(requested){
 if(!Array.isArray(requested)||!requested.length||requested.length>50) throw new Error('请选择衣物');
 const all=await catalog(), seen=new Set();
 return requested.map(i=>{let id=clean(i.id,100), p=all.find(x=>x._id===id && x.enabled===true);if(!p||seen.has(id)||!integer(i.qty,1,99))throw new Error('服务已停用或数量有误，请返回重新选择');if(i.expectedPrice!==undefined&&i.expectedPrice!==p.price)throw new Error('服务价格已变化，请返回重新确认');seen.add(id);return {id:p._id,name:p.name,unit:p.unit,price:p.price,qty:i.qty};});
}
async function change(o, from, patch, text, internal=false){
 const result=await orders.where({_id:o._id,status:from,version:o.version}).update({data:{...patch,events:history(o,text,internal),version:o.version+1,updatedAt:now()}});
 if(!result.stats.updated) throw new Error('订单状态已变化，请刷新后重试');
}
exports.main=async(event)=>{
 try{
  const {OPENID:id}=cloud.getWXContext(); if(!id) throw new Error('无法识别微信身份');
  const action=event.action, data=event.data||{};
  const extra=await operations(action,data,id,{orders,stores,products,admins,db,mustAdmin,findOrder,change,checkVersion,now,getStore});
  if(extra!==null)return {ok:true,data:extra};
  if(action==='identity') return {ok:true,data:{openid:id,admin:await isAdmin(id)}};
  if(action==='catalog'){ const [s,ps]=await Promise.all([getStore(),catalog()]); return {ok:true,data:{store:await displayStore(s),products:await displayProducts(ps.filter(p=>p.enabled===true))}}; }
  if(action==='adminCatalog'){await mustAdmin(id);const all=await catalog(),categories=await categoryCatalog(all);return {ok:true,data:{store:await displayStore(await getStore()),products:await displayProducts(all),categoryNames:categories.names}};}
  if(action==='saveCategory'){
   await mustAdmin(id);const name=String(data.name||'').trim();
   if(!name||name.length>30)throw new Error('请填写1至30字的类目名称');
   if(name==='全部')throw new Error('类目名称不能使用“全部”');
   const categories=await categoryCatalog(await catalog());
   if(!categories.names.includes(name)&&categories.names.length>=100)throw new Error('类目已达100项上限');
   await persistCategories([...new Set([...categories.missing,name])]);return {ok:true,data:{name}};
  }
  if(action==='workbench'){
   await mustAdmin(id);
   const [pending,processing,ready,unnotified]=await Promise.all([
    orders.where({status:'pending'}).count(),
    orders.where({status:'processing'}).count(),
    orders.where({status:'ready'}).count(),
    orders.where({status:'ready',notice:db.command.neq('已通知')}).count()
   ]);
   return {ok:true,data:{pending:pending.total,processing:processing.total,ready:ready.total,unnotified:unnotified.total}};
  }
  if(action==='list'){
   const admin=!!data.admin;if(admin)await mustAdmin(id);let query=admin?{}:{owner:id};
   if(data.status)query.status=clean(data.status,20);
   if(!admin&&data.group==='active')query.status=db.command.in(['pending','processing','ready']);
   if(!admin&&data.group==='ended')query.status=db.command.in(['completed','cancelled']);
   if(admin&&data.noticeOnly===true){query.status='ready';query.notice=db.command.neq('已通知');}
   if(admin&&data.overdue===true){query.status='processing';query.dueDate=db.command.lt(domain.today()).and(db.command.gt(''));}
   if(admin&&data.exceptions===true)query.exceptionOpen=true;
   if(admin&&data.search){const search=clean(data.search,120);if(/^1\d{10}$/.test(search))query.phone=search;else if(/^L[A-F0-9]{12}$/i.test(search))query.businessNumber=search.toUpperCase();else if(/^[a-zA-Z0-9]{8}$/.test(search))query._id=db.RegExp({regexp:search+'$',options:''});else query._id=search;}
   const q=Object.keys(query).length?orders.where(query):orders;const page=integer(data.page,0,10000)?data.page:0;
   const rows=(await q.orderBy('createdAt','desc').skip(page*20).limit(20).get()).data;
   return {ok:true,data:admin?rows:rows.map(domain.publicOrder)};
  }
  if(action==='detail'){
   const o=await findOrder(data.id),admin=await isAdmin(id);if(o.owner!==id&&!admin)throw Error('没有店主权限');
   if(!admin)return {ok:true,data:domain.publicOrder(o)};
   if(o.cases){const files=[...new Set(o.cases.flatMap(entry=>entry.photos||[]))];const links=await displayProducts(files.map(image=>({image})));const map=Object.fromEntries(links.map(row=>[row.image,row.imageUrl]));o.cases=o.cases.map(entry=>({...entry,photoUrls:(entry.photos||[]).map(file=>map[file]).filter(Boolean)}));}
   return {ok:true,data:o};
  }
  if(action==='create'){
    let guest=data.guest===true;if(guest)await mustAdmin(id);
    let name=clean(data.name,30),phone=clean(data.phone,11),note=clean(data.note,200),requestId=clean(data.requestId,80);
    if(!name||!validPhone(phone))throw new Error('请填写联系人和11位手机号');
    if(!/^[a-zA-Z0-9_-]{16,80}$/.test(requestId)||!Array.isArray(data.items)||!data.items.length||data.items.length>50)throw new Error('请求无效，请重新提交');
    let docId=id+'_'+requestId, signature=requestSignature(guest,name,phone,note,data.items);
    if(data.confirmed)signature+='|'+JSON.stringify({confirmed:data.confirmed,reason:clean(data.reason,100),intake:domain.intake(data.intake)});
    const checkExisting = existing => {if(existing.requestSignature!==signature)throw new Error('提交内容与原请求不一致，请查看订单后重新操作');return {ok:true,data:{id:docId}};};
    try {let existing=(await orders.doc(docId).get()).data;if(existing)return checkExisting(existing);} catch(e) {if(!/not exist|不存在|DOCUMENT_NOT_EXIST/i.test(String(e)))throw e;}
    let s=await getStore();if(!guest&&!s.open)throw new Error('门店暂不接单');
    let items=await prepareItems(data.items), amount=total(items);
    const confirmed=guest?(data.confirmed?domain.confirmItems(data.confirmed,items,await catalog()):items):null;
    const reason=clean(data.reason,100);if(guest&&domain.itemsChanged(confirmed,items)&&!reason)throw Error('修改数量或单价时请填写原因');
    let o={businessNumber:domain.businessNumber(docId),...(guest?{...domain.intake(data.intake),receivedAt:now()}:{}),source:guest?'guest':'customer',owner:guest?'':id,name,phone,note,items,requestSignature:signature,confirmed,estimate:amount,actual:guest?total(confirmed):null,status:guest?'processing':'pending',notice:'未通知',notifyState:guest?'not_applicable':'waiting',events:[{time:now(),text:guest?'店主代客开单，已确认收衣，金额 ¥'+(total(confirmed)/100).toFixed(2)+(reason?'；原因：'+reason:''):'顾客提交送洗订单'}],createdAt:now(),updatedAt:now(),version:1};
    try {await orders.add({data:{...o,_id:docId}});} catch(e) {let existing;try{existing=(await orders.doc(docId).get()).data;}catch(ignore){throw e;}if(!existing)throw e;return checkExisting(existing);}
    if(!guest){let notifyState=await notifyOwner({...o,_id:docId});try{await orders.where({_id:docId,status:'pending',version:1}).update({data:{notifyState}});}catch(e){}}
    return {ok:true,data:{id:docId}};
  }
  if(action==='cancel'){let o=await findOrder(data.id);if(o.owner!==id)await mustAdmin(id);checkVersion(o,data.version);if(o.status!=='pending')throw new Error('当前订单不能取消');await change(o,'pending',{status:'cancelled'},'订单已取消');return {ok:true};}
  if(action==='accept'||action==='revise'){
   await mustAdmin(id);const o=await findOrder(data.id);checkVersion(o,data.version);
   if(action==='accept'&&o.status!=='pending'||action==='revise'&&!['processing','ready'].includes(o.status))throw Error('订单状态已变化');
   if(data.agreed!==true)throw Error('请先与顾客确认衣物和金额');
   const before=o.confirmed||o.items,items=domain.confirmItems(data.items,before,await catalog()),reason=clean(data.reason,200);
   if((action==='revise'||domain.itemsChanged(items,before))&&!reason)throw Error('修改数量或单价时请填写原因');
   const amount=total(items);const patch={confirmed:items,actual:amount,...(action==='accept'?{status:'processing',receivedAt:now(),...domain.intake(data.intake||o)}:{})};
   await change(o,o.status,patch,(action==='accept'?'确认收衣':'调整已确认衣物')+'，金额 ¥'+(amount/100).toFixed(2)+(reason?'；原因：'+reason:''));return {ok:true};
  }
  if(action==='transition'){
   await mustAdmin(id);let o=await findOrder(data.id),op=data.op, patch={},text='';checkVersion(o,data.version);
   if(op==='ready'&&o.status==='processing'){patch={status:'ready',notice:'未通知',readyAt:now(),onTime:o.dueDate?domain.today()<=o.dueDate:null};text='标记洗好，等待电话通知';}
   else if(op==='complete'&&o.status==='ready'){if((o.cases||[]).some(entry=>!entry.resolved))throw Error('请先记录未处理异常的处理结果');patch={status:'completed',exceptionOpen:false,completedAt:now()};text='登记已取件';}
   else if(op==='correct'&&['ready','completed'].includes(o.status)){let reason=clean(data.reason,100);if(!reason)throw new Error('请填写纠正原因');patch={status:o.status==='ready'?'processing':'ready'};if(o.status==='ready')patch.notice='未通知';text='状态纠正：'+(o.status==='ready'?'待取件 → 洗护中':'已完成 → 待取件')+'；原因：'+reason;}
   else if(op==='notice'&&o.status==='ready'&&['已通知','未接通'].includes(data.notice)){patch={notice:data.notice};text='通知记录：'+data.notice;}
   else throw new Error('订单状态已变化');await change(o,o.status,patch,text);return {ok:true};
  }
  if(action==='saveStore'){
   await mustAdmin(id);if(data.retentionDays!==undefined&&!integer(Number(data.retentionDays),30,3650))throw Error('请填写30至3650天的保存期限');if(data.storefrontImage&&!String(data.storefrontImage).startsWith('cloud://'))throw Error('图片地址无效');let s={name:clean(data.name,60),address:clean(data.address,150),phone:clean(data.phone,30),hours:clean(data.hours,60),open:data.open===true,operatorName:clean(data.operatorName,100),privacyPhone:clean(data.privacyPhone||data.phone,30),retentionDays:integer(Number(data.retentionDays),30,3650)?Number(data.retentionDays):365,latitude:typeof data.latitude==='number'&&Math.abs(data.latitude)<=90?data.latitude:null,longitude:typeof data.longitude==='number'&&Math.abs(data.longitude)<=180?data.longitude:null,storefrontImage:clean(data.storefrontImage,500)};if(!s.name||!s.address||!s.phone||!s.hours)throw new Error('请填写完整门店信息');if(s.open && !(await catalog()).some(p=>p.enabled===true))throw new Error('请先添加并启用服务价目');await stores.doc('main').set({data:s});return {ok:true};
  }
  if(action==='saveProduct'){
   await mustAdmin(id);const all=await catalog();
   if(!data.id&&all.length>=100)throw new Error('服务项目已达100项上限，请先联系技术支持');
   if(data.id&&!all.some(product=>product._id===data.id))throw new Error('单品不存在，请刷新价目');
   let name=clean(data.name,60),category=clean(data.category,30),unit=clean(data.unit,10),price=data.price,image=clean(data.image,500);
   if(!name||!category||!unit||!integer(price,0,10000000))throw new Error('请填写完整商品信息');
   if(image&&!image.startsWith('cloud://'))throw new Error('图片地址无效');
   const categories=await categoryCatalog(all);
   if(!categories.names.includes(category))throw new Error('请先添加类目，再添加单品');
   await persistCategories(categories.missing);
   let product={name,category,unit,price,image,description:clean(data.description,300),enabled:data.enabled===true};
   if(data.id)await products.doc(clean(data.id,100)).set({data:product});else if(/^[a-zA-Z0-9_-]{16,80}$/.test(String(data.requestId||''))){const productId='p_'+createHash('sha256').update(id+'_'+data.requestId).digest('hex');await products.doc(productId).set({data:product});}else await products.add({data:product});return {ok:true};
  }
  throw new Error('未知操作');
 }catch(e){let message=String(e.message||'');if(!/^(没有店主权限|无法识别微信身份|订单不存在|单品不存在|类目|认领|此订单|备份|衣物照片|异常记录|请选择衣物|请保留|服务已停用|服务价格已变化|请填写|请求无效|提交内容|门店暂不接单|当前订单|订单状态|请先|修改数量|商品已变动|图片地址|服务项目已达|未知操作)/.test(message))message='操作暂未完成，请稍后重试或联系门店';return {ok:false,error:clean(message,200)};}
};
