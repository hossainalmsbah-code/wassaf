const { redisCommand } = require('./_redis');

function currentMonthKey() {
  const now = new Date();
  const year = now.getUTCFullYear();
  const month = String(now.getUTCMonth() + 1).padStart(2, '0');
  return `${year}-${month}`;
}

// يحاول ربط الكود بجهاز معيّن. لو الكود ما فيه جهاز مربوط بعد، يربطه بهالجهاز فوراً (أول جهاز يفوز).
// لو مربوط بجهاز آخر، يرفض. يستخدم SET...NX عشان يكون العملية آمنة حتى لو صار طلبين بنفس اللحظة بالضبط.
async function bindOrCheckDevice(code, deviceId) {
  if (!deviceId) {
    // ما فيه بصمة جهاز مرسلة (زيارة قديمة أو من أداة خارجية) — نتساهل بدل ما نمنعه بالكامل
    return { ok: true, boundNow: false };
  }

  const deviceKey = `device:${code}`;
  // NX يعني: خزّن بس لو المفتاح ما موجود أصلاً — لو موجود، ما يغيّره ويرجع null
  const setResult = await redisCommand(['SET', deviceKey, deviceId, 'NX']);

  if (setResult === 'OK') {
    // نجحنا نربطه أول مرة بهالجهاز
    return { ok: true, boundNow: true };
  }

  // الكود مربوط بجهاز من قبل — نتأكد هل هو نفس الجهاز الحالي أو جهاز غريب
  const boundDevice = await redisCommand(['GET', deviceKey]);
  if (boundDevice === deviceId) {
    return { ok: true, boundNow: false };
  }

  return { ok: false };
}

// يتحقق من صلاحية كود الوصول، حده الشهري، وربطه بالجهاز
async function checkAccessCode(code, deviceId) {
  const codeData = await redisCommand(['GET', `code:${code}`]);
  if (!codeData) {
    return { ok: false, reason: 'invalid' };
  }

  let parsed;
  try {
    parsed = JSON.parse(codeData);
  } catch (e) {
    return { ok: false, reason: 'invalid' };
  }

  if (!parsed.active || !parsed.cap) {
    return { ok: false, reason: 'invalid' };
  }

  const deviceCheck = await bindOrCheckDevice(code, deviceId);
  if (!deviceCheck.ok) {
    return { ok: false, reason: 'device_mismatch' };
  }

  const usageKey = `usage:${code}:${currentMonthKey()}`;
  const currentUsage = parseInt((await redisCommand(['GET', usageKey])) || '0', 10);

  if (currentUsage >= parsed.cap) {
    return { ok: false, reason: 'exhausted', cap: parsed.cap, used: currentUsage };
  }

  return {
    ok: true,
    remaining: parsed.cap - currentUsage,
    cap: parsed.cap,
    used: currentUsage,
    plan: parsed.plan || 'عام',
    usageKey,
    deviceBoundNow: deviceCheck.boundNow
  };
}

// تُستدعى فقط بعد نجاح التوليد فعلياً، عشان محاولة فاشلة ما تُحسب على رصيد التاجر
async function incrementUsage(usageKey) {
  const newValue = await redisCommand(['INCR', usageKey]);
  await redisCommand(['EXPIRE', usageKey, 45 * 24 * 60 * 60]);
  return newValue;
}

// تستخدمها لوحة الإدارة بس، لفك ربط كود من جهازه الحالي (لو التاجر غيّر جهازه)
async function unbindDevice(code) {
  await redisCommand(['DEL', `device:${code}`]);
}

module.exports = { checkAccessCode, incrementUsage, currentMonthKey, unbindDevice };
