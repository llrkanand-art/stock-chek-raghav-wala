const INVENTORY_API = 'https://api.croma.com/inventory/oms/v2/tms/details-pwa/';
const PRODUCT_API = 'https://api.croma.com/catalog/v1/product/detail';
const PROMOTION_API = 'https://api.tatadigital.com/getApplicablePromotion/getApplicationPromotionsForItemOffer';
const PROMOTION_PROGRAM = '01eae2ec-0576-1000-bbea-86e16dcb4b79';
const PROMOTION_AUTHORIZATION = '8Tksadcs85ad4vsasfasgf4sJHvfs4NiKNKLHKLH582546f646';
const { isAllowed } = require('../lib/access');

const list = value => Array.isArray(value) ? value : (value ? [value] : []);
const reply = (res, status, body) => res.status(status).json(body);
let cromaCookie = '';
let cromaCookieExpiresAt = 0;
let cromaCookiePromise = null;

function cookieHeader(headers) {
  const values = typeof headers.getSetCookie === 'function'
    ? headers.getSetCookie()
    : String(headers.get('set-cookie') || '').split(/,(?=[^;=]+=)/);
  return values.map(value => value.split(';', 1)[0]).filter(Boolean).join('; ');
}

async function getCromaCookie(force = false) {
  if (!force && cromaCookie && cromaCookieExpiresAt > Date.now()) return cromaCookie;
  if (cromaCookiePromise) return cromaCookiePromise;

  cromaCookiePromise = fetch('https://www.croma.com/', {
    headers: {
      Accept: 'text/html,application/xhtml+xml',
      'User-Agent': 'Mozilla/5.0 (Linux; Android 10) AppleWebKit/537.36 Chrome/120 Mobile Safari/537.36'
    }
  }).then(response => {
    const cookie = cookieHeader(response.headers);
    cromaCookie = cookie;
    cromaCookieExpiresAt = cookie ? Date.now() + 10 * 60 * 1000 : 0;
    return cookie;
  }).catch(() => '').finally(() => {
    cromaCookiePromise = null;
  });

  return cromaCookiePromise;
}

function line(type, itemID, pincode, categoryType) {
  return { fulfillmentType:type, mch:'', itemID, lineId:type === 'HDEL' ? '1' : '3', categoryType,
    reqEndDate:type === 'HDEL' ? '2500-01-01' : '', reqStartDate:'', requiredQty:'1',
    shipToAddress:{company:'',country:'',city:'',mobilePhone:'',state:'',zipCode:pincode,extn:{irlAddressLine1:'',irlAddressLine2:''}},
    extn:{widerStoreFlag:'N'} };
}

function body(productId, pincode, categoryType) {
  return { promise:{ allocationRuleID:'SYSTEM', checkInventory:'Y', organizationCode:'CROMA', sourcingClassification:'EC', promiseLines:{ promiseLine:[line('HDEL',productId,pincode,categoryType),line('SDEL',productId,pincode,categoryType)] } } };
}

function inventorySummary(data) {
  const available = list(data?.promise?.suggestedOption?.option?.promiseLines?.promiseLine);
  return { available:available.length > 0, homeDelivery:available.some(item => item.fulfillmentType === 'HDEL' || item.lineId === '1'), storePickup:available.some(item => item.fulfillmentType === 'SDEL' || item.lineId === '3') };
}

function compactName(value, productId) {
  const raw = String(value || '').replace(/\s+/g,' ').trim();
  if (!raw) return `Product ${productId}`;
  const details = raw.match(/\(([^)]*)\)/)?.[1] || '';
  const ram = details.match(/(\d+)\s*GB\s*RAM/i)?.[1];
  const storage = details.replace(/\d+\s*GB\s*RAM/i,'').match(/(\d+)\s*GB/i)?.[1];
  const base = raw.split('(')[0].replace(/\b\d+G\b/ig,'').replace(/[,-]\s*$/,'').replace(/\s+/g,' ').trim();
  return ram && storage ? `${base} ${ram}/${storage}` : base || `Product ${productId}`;
}

function offerText(offer) {
  return String(offer?.offerTitle || offer?.description || offer?.offerText || offer?.storeOfferLabel || '').replace(/\s+/g, ' ').trim();
}

function cromaDate(value) {
  const text = String(value || '').trim();
  if (!text) return 0;
  return Date.parse(/[zZ]|[+-]\d{2}:?\d{2}$/.test(text) ? text : `${text.replace(' ', 'T')}+05:30`);
}

function activePromotion(offer) {
  const now = Date.now();
  const from = cromaDate(offer?.offerStartDate), to = cromaDate(offer?.expiryDate);
  const status = Array.isArray(offer?.status) ? offer.status : [offer?.status];
  return (!status.filter(Boolean).length || status.includes('ACTIVE')) && (!from || from <= now) && (!to || to >= now);
}

function bankPromotion(offer) {
  const text = `${offerText(offer)} ${offer?.benefitType || ''}`;
  return ['EMI', 'CASHBACK'].includes(String(offer?.benefitType || '').toUpperCase()) || /\b(bank|credit|debit|card|emi|neucard|neu\s*coins?|cashback|sbi|icici|axis|hdfc|kotak|idfc|hsbc|indusind|yes bank)\b/i.test(text);
}

function ignoredPromotion(offer) {
  const text = offerText(offer);
  return /\btsss\b/i.test(text) || /flat\s*rs\.?\s*3999\b/i.test(text) || /meta\s+glasses/i.test(text);
}

function targetPromotions(list) {
  return list.filter(offer => activePromotion(offer) && !bankPromotion(offer) && !ignoredPromotion(offer) && offerText(offer)).map(offerText).filter((text, index, values) => values.indexOf(text) === index);
}

function activeOffer(data) {
  const now = Date.now();
  const datedOffer = list(data?.storeoffer).some(offer => {
    const from = cromaDate(offer?.fromDate), to = cromaDate(offer?.toDate);
    return (!from || from <= now) && (!to || to >= now) && !bankPromotion(offer);
  });
  return datedOffer;
}

async function promotions(productId) {
  const response = await fetch(PROMOTION_API, { method:'POST', headers:{Accept:'application/json, text/plain, */*','Content-Type':'application/x-www-form-urlencoded',client_id:'CROMA',Authorization:PROMOTION_AUTHORIZATION,Origin:'https://www.croma.com',Referer:'https://www.croma.com/'}, body:JSON.stringify({getApplicablePromotionsForItemRequest:{itemId:String(productId),programId:PROMOTION_PROGRAM,channelIds:['TCPCHS0003'],status:'ACTIVE'}}) });
  if (!response.ok) throw new Error(`Promotion lookup failed (${response.status}).`);
  const data = await response.json();
  return targetPromotions(data?.getApplicablePromotionsForItemResponse?.offerDetailsList || []);
}

async function productInfo(productId) {
  let data = {};
  let lookupError = '';
  try {
    const response = await fetch(`${PRODUCT_API}?productCode=${encodeURIComponent(productId)}`, { headers:{Accept:'application/json, text/plain, */*','User-Agent':'Mozilla/5.0 (Linux; Android 10) AppleWebKit/537.36 Chrome/120 Mobile Safari/537.36',Origin:'https://www.croma.com',Referer:'https://www.croma.com/'} });
    if (!response.ok) throw new Error(`Product lookup failed (${response.status}).`);
    data = await response.json();
  } catch (error) {
    lookupError = error.message;
  }
  let offerNames = [];
  try { offerNames = await promotions(productId); } catch (error) { lookupError ||= error.message; }
  return { name:compactName(data.name || data.productName || data.metatitle, productId), offerDetected:offerNames.length > 0 || activeOffer(data), offerName:offerNames.join(' | '), lookupError };
}

async function inventory(job, category) {
  try {
    const request = cookie => fetch(INVENTORY_API, {
      method:'POST',
      headers:{Accept:'application/json, text/plain, */*','Content-Type':'application/json','User-Agent':'Mozilla/5.0 (Linux; Android 10) AppleWebKit/537.36 Chrome/120 Mobile Safari/537.36',Origin:'https://www.croma.com',Referer:'https://www.croma.com/',...(cookie ? { Cookie: cookie } : {})},
      body:JSON.stringify(body(job.productId,job.pincode,category))
    });
    let response = await request(await getCromaCookie());
    if (response.status === 403) {
      await response.arrayBuffer().catch(() => {});
      cromaCookie = '';
      cromaCookieExpiresAt = 0;
      response = await request(await getCromaCookie(true));
    }
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(`Croma inventory request failed (${response.status}).`);
    return { ...job, ...inventorySummary(data) };
  } catch (error) {
    return { ...job, available:false, error:error.message || 'Inventory request failed.' };
  }
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Access-Control-Allow-Methods','POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers','Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return reply(res,405,{error:'Use POST.'});
  const deviceId = String(req.body?.deviceId || '').trim();
  if (!isAllowed(deviceId)) return reply(res,403,{error:'This device is not licensed.'});
  const jobs = Array.isArray(req.body?.jobs) ? req.body.jobs : [];
  const category = String(req.body?.category || 'mobile').trim() || 'mobile';
  if (!jobs.length || jobs.length > 50) return reply(res,400,{error:'Send 1 to 50 stock checks per request.'});
  if (!jobs.every(job => /^\d+$/.test(String(job.productId || '')) && /^\d{6}$/.test(String(job.pincode || '')))) return reply(res,400,{error:'Every product ID must contain digits and every pincode must contain six digits.'});
  const ids = [...new Set(jobs.map(job => String(job.productId)))];
  const info = new Map(await Promise.all(ids.map(async id => [id, await productInfo(id)])));
  const results = await Promise.all(jobs.map(job => { const item = info.get(String(job.productId)) || {}; return inventory({ ...job, productId:String(job.productId), pincode:String(job.pincode), name:item.name || `Product ${job.productId}`, offerDetected:item.offerDetected === true, offerName:item.offerName || '' }, category); }));
  return reply(res,200,{results});
};
