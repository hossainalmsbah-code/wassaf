const { redisCommand } = require('./_redis');

function currentMonthKey() {
  const now = new Date();
  const year = now.getUTCFullYear();
  const month = String(now.getUTCMonth() + 1).padStart(2, '0');
  return `${year}-${month}`;
}

// يتحقق من صلاحية كود الوصول وحده الشهري
async function checkAccessCode(code) {
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
    usageKey
  };
}

// تُستدعى فقط بعد نجاح التوليد فعلياً، عشان محاولة فاشلة ما تُحسب على رصيد التاجر
async function incrementUsage(usageKey) {
  const newValue = await redisCommand(['INCR', usageKey]);
  await redisCommand(['EXPIRE', usageKey, 45 * 24 * 60 * 60]);
  return newValue;
}

module.exports = { checkAccessCode, incrementUsage, currentMonthKey };
