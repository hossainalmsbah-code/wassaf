const { checkAccessCode, addReferralBonus } = require('./_access');
const { redisCommand } = require('./_redis');

// نسبة المكافأة من حد باقة المحيل الرئيسية (50%) — تُحسب ديناميكياً حسب باقة كل محيل
const REFERRAL_BONUS_RATIO = 0.5;
// مدة بقاء رابط المشاركة (30 يوم)
const SHARE_TTL_SECONDS = 30 * 24 * 60 * 60;

function generateShareId() {
  return Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-4);
}

// يولّد (أو يرجّع الموجود) توكن إحالة عشوائي مربوط بالكود — بدون ما يكشف الكود نفسه بالرابط المُشارك
async function getOrCreateReferralToken(accessCode) {
  const ownerKey = `reftoken_owner_by_code:${accessCode}`;
  const existing = await redisCommand(['GET', ownerKey]);
  if (existing) return existing;

  const token = Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
  await redisCommand(['SET', ownerKey, token]);
  await redisCommand(['SET', `reftoken_owner:${token}`, accessCode]);
  return token;
}

// ---------- بيانات الحساب: الباقة، الاستخدام، كود وعداد الإحالة ----------
async function handleAccountInfo(body, res) {
  const accessCode = (body.accessCode || '').toString().trim().toUpperCase();
  const deviceId = (body.deviceId || '').toString().trim();

  if (!accessCode) {
    res.status(400).json({ error: 'أدخل كود الوصول' });
    return;
  }

  const result = await checkAccessCode(accessCode, deviceId);
  if (!result.ok && result.reason !== 'exhausted') {
    res.status(200).json({ valid: false, message: 'كود الوصول غير صحيح' });
    return;
  }

  const referralCount = parseInt((await redisCommand(['GET', `referral_count:${accessCode}`])) || '0', 10);
  const referralToken = await getOrCreateReferralToken(accessCode);
  const cap = result.cap;
  const used = typeof result.used === 'number' ? result.used : (cap - (result.remaining || 0));
  const remaining = typeof result.remaining === 'number' ? result.remaining : Math.max(cap - used, 0);
  const estimatedReferralBonus = Math.max(Math.round(cap * REFERRAL_BONUS_RATIO), 3);

  res.status(200).json({
    valid: true,
    plan: result.plan || 'عام',
    cap,
    used,
    remaining,
    referralToken,
    referralCount,
    estimatedReferralBonus
  });
}

// ---------- تطبيق مكافأة الإحالة على الطرفين ----------
async function handleApplyReferral(body, res) {
  const newAccessCode = (body.newAccessCode || '').toString().trim().toUpperCase();
  const referrerToken = (body.referrerToken || '').toString().trim();

  if (!newAccessCode || !referrerToken) {
    res.status(400).json({ error: 'بيانات الإحالة ناقصة' });
    return;
  }

  // نحل التوكن لكود الوصول الحقيقي — الكود نفسه ما يظهر أبداً بالرابط المُشارك
  const referrerCode = await redisCommand(['GET', `reftoken_owner:${referrerToken}`]);
  if (!referrerCode) {
    res.status(404).json({ error: 'رابط الإحالة غير صالح' });
    return;
  }

  if (newAccessCode === referrerCode) {
    res.status(400).json({ error: 'ما تقدر تحيل نفسك بنفسك' });
    return;
  }

  const guardKey = `referral_applied:${newAccessCode}`;
  const guardResult = await redisCommand(['SET', guardKey, referrerCode, 'NX']);
  if (guardResult !== 'OK') {
    res.status(200).json({ ok: true, alreadyApplied: true });
    return;
  }

  const referrerData = await redisCommand(['GET', `code:${referrerCode}`]);
  if (!referrerData) {
    await redisCommand(['DEL', guardKey]);
    res.status(404).json({ error: 'كود الإحالة غير موجود' });
    return;
  }

  let referrerParsed;
  try {
    referrerParsed = JSON.parse(referrerData);
  } catch (e) {
    await redisCommand(['DEL', guardKey]);
    res.status(500).json({ error: 'بيانات كود الإحالة تالفة' });
    return;
  }

  // المكافأة = 50% من حد باقة المحيل الرئيسية، بحد أدنى 3 أوصاف حتى لو كانت الباقة صغيرة
  const referrerCap = referrerParsed.cap || 0;
  const bonus = Math.max(Math.round(referrerCap * REFERRAL_BONUS_RATIO), 3);

  const referredResult = await addReferralBonus(newAccessCode, bonus);
  const referrerResult = await addReferralBonus(referrerCode, bonus);
  await redisCommand(['INCR', `referral_count:${referrerCode}`]);

  res.status(200).json({
    ok: true,
    referredNewCap: referredResult.newCap,
    referrerNewCap: referrerResult.newCap,
    bonus
  });
}

// ---------- إنشاء رابط مشاركة ----------
async function handleCreateShare(body, res) {
  const productName = (body.productName || '').toString().trim().slice(0, 200);
  const long = (body.long || '').toString().trim().slice(0, 4000);
  const short = (body.short || '').toString().trim().slice(0, 1000);
  const seo = (body.seo || '').toString().trim().slice(0, 300);

  if (!long && !short) {
    res.status(400).json({ error: 'ما فيه نص نشاركه' });
    return;
  }

  const shareId = generateShareId();
  const payload = JSON.stringify({ productName, long, short, seo, createdAt: Date.now() });
  await redisCommand(['SET', `share:${shareId}`, payload, 'EX', SHARE_TTL_SECONDS]);

  res.status(200).json({ ok: true, shareId, url: `/share.html?id=${shareId}` });
}

// ---------- جلب بيانات رابط مشاركة ----------
async function handleGetShare(body, res) {
  const id = (body.id || '').toString().trim();
  if (!id) {
    res.status(400).json({ error: 'معرّف غير صحيح' });
    return;
  }

  const raw = await redisCommand(['GET', `share:${id}`]);
  if (!raw) {
    res.status(404).json({ error: 'الرابط منتهي أو غير موجود' });
    return;
  }

  let data;
  try {
    data = JSON.parse(raw);
  } catch (e) {
    res.status(500).json({ error: 'بيانات تالفة' });
    return;
  }

  res.status(200).json({ ok: true, ...data });
}

// نقطة دخول واحدة لكل ميزات النمو (حساب، إحالة، مشاركة) — تفادياً لتجاوز حد الـ12 Serverless Function بباقة Vercel المجانية
module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  try {
    const body = req.body || {};
    const action = (body.action || '').toString().trim();

    switch (action) {
      case 'account_info':
        await handleAccountInfo(body, res);
        break;
      case 'apply_referral':
        await handleApplyReferral(body, res);
        break;
      case 'create_share':
        await handleCreateShare(body, res);
        break;
      case 'get_share':
        await handleGetShare(body, res);
        break;
      default:
        res.status(400).json({ error: 'action غير معروف' });
    }
  } catch (err) {
    res.status(500).json({ error: 'صار خطأ، جرب مرة ثانية' });
  }
};
