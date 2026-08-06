const { redisCommand } = require('./_redis');
const crypto = require('crypto');

const LIBRARY_LIST_KEY = 'library:log'; // سجل كامل بكل عملية توليد ناجحة — يكبر باستمرار، هو المرجع المستقبلي للتحليل
const LIBRARY_MAX_ENTRIES = 50000; // سقف احترازي بس (يحمي من نمو غير محدود) — لو قربنا منه لاحقاً ننقل لقاعدة بيانات حقيقية بدل Redis

// [مهم] نغيّر هالرقم يدوياً كل ما عدّلنا نص البرومبت الأساسي (buildPrompt بـgenerate.js) بشكل جوهري.
// كذا أي كاش قديم مبني على أسلوب كتابة سابق ما يُستخدم تلقائياً بعد تحديث البرومبت — يضمن الجودة دايماً محدّثة.
const PROMPT_VERSION = 'v1';

function normalize(str) {
  return (str || '').toString().trim().toLowerCase().replace(/\s+/g, ' ');
}

// نبني مفتاح كاش من نفس بيانات المنتج بالضبط — أي منتجين (حتى من تاجرين مختلفين) بنفس البيانات
// يرجعون نفس المفتاح، فنقدر نعيد استخدام نفس الوصف بدل ما نولّد من جديد
function buildCacheKey({ productName, audience, features, price, framework, brandTone, style }) {
  const signature = [
    normalize(productName),
    normalize(audience),
    normalize(features),
    normalize(price),
    (framework || '').toString().trim().toUpperCase(),
    normalize(brandTone),
    (style || '').toString().trim().toUpperCase(),
    PROMPT_VERSION
  ].join('|');
  return 'cache:desc:' + crypto.createHash('sha256').update(signature).digest('hex');
}

async function getCachedGeneration(cacheKey) {
  try {
    const raw = await redisCommand(['GET', cacheKey]);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch (e) {
    return null;
  }
}

async function setCachedGeneration(cacheKey, data) {
  try {
    await redisCommand(['SET', cacheKey, JSON.stringify(data)]);
  } catch (e) {
    // فشل حفظ الكاش مو حرج — التوليد الأصلي نجح والرد وصل للتاجر عادي
  }
}

// يسجّل كل عملية توليد بكامل تفاصيلها بسجل المكتبة — هذا هو "المرجع المستقبلي" اللي يتراكم للتحليل والتطوير
async function logGeneration(entry) {
  try {
    const record = JSON.stringify({ ...entry, loggedAt: new Date().toISOString() });
    await redisCommand(['LPUSH', LIBRARY_LIST_KEY, record]);
    await redisCommand(['LTRIM', LIBRARY_LIST_KEY, '0', String(LIBRARY_MAX_ENTRIES - 1)]);
  } catch (e) {
    // تسجيل المكتبة مو حرج لتجربة التاجر — أي فشل هنا ما يوقف أو يبطئ الرد الأساسي
  }
}

// تسترجع آخر N عملية توليد — تُستخدم لأي مراجعة يدوية أو صفحة عرض مستقبلية
async function getLatestEntries(count) {
  const limit = count || 30;
  try {
    const raw = await redisCommand(['LRANGE', LIBRARY_LIST_KEY, '0', String(limit - 1)]);
    return (raw || []).map((r) => {
      try { return JSON.parse(r); } catch (e) { return null; }
    }).filter(Boolean);
  } catch (e) {
    return [];
  }
}

module.exports = {
  buildCacheKey,
  getCachedGeneration,
  setCachedGeneration,
  logGeneration,
  getLatestEntries
};
