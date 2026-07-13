const { redisCommand } = require('./_redis');

function generateRandomCode(length = 6) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < length; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return code;
}

function currentMonthKey() {
  const now = new Date();
  const year = now.getUTCFullYear();
  const month = String(now.getUTCMonth() + 1).padStart(2, '0');
  return `${year}-${month}`;
}

// نستخرج IP الزائر الحقيقي من رؤوس الطلب (Vercel يمرره عبر x-forwarded-for)
function getClientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) {
    return forwarded.toString().split(',')[0].trim();
  }
  return (req.socket && req.socket.remoteAddress) || 'unknown';
}

const TRIAL_CAP = 10;
const MAX_TRIAL_MONTHS = 2; // بعد ما نفس الشبكة تاخذ تجربة بشهرين مختلفين (حتى لو مو متتاليين)، نوقفها

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  try {
    const ip = getClientIp(req);
    const trialKey = `trial_ip:${ip}:${currentMonthKey()}`;
    const countKey = `trial_count:${ip}`;

    const existing = await redisCommand(['GET', trialKey]);
    if (existing) {
      res.status(403).json({
        error: 'جرّبت وصّاف مجاناً هالشهر من قبل. تقدر تشترك بأي باقة عشان تكمل التوليد.',
        code: 'TRIAL_ALREADY_USED'
      });
      return;
    }

    // نتحقق من العداد الدائم (كم شهر مختلف استخدمت فيه هالشبكة تجربة مجانية)
    const usedMonths = parseInt((await redisCommand(['GET', countKey])) || '0', 10);
    if (usedMonths >= MAX_TRIAL_MONTHS) {
      res.status(403).json({
        error: 'هذه الشبكة استخدمت التجربة المجانية أكثر من مرة من قبل. تواصل معنا لو تحتاج مساعدة، أو اشترك بأي باقة.',
        code: 'TRIAL_LIMIT_REACHED'
      });
      return;
    }

    const code = generateRandomCode();
    const value = JSON.stringify({
      cap: TRIAL_CAP,
      plan: 'تجربة',
      active: true,
      createdAt: new Date().toISOString(),
      source: 'self_serve_trial'
    });

    await redisCommand(['SET', `code:${code}`, value]);

    // نربط هالـ IP بكود التجربة هذا الشهر، ونخليه ينتهي تلقائياً بعد 35 يوم
    await redisCommand(['SET', trialKey, code]);
    await redisCommand(['EXPIRE', trialKey, 35 * 24 * 60 * 60]);

    // نزيد العداد الدائم لهالشبكة (بدون انتهاء صلاحية — يفضل محفوظ لين نفكه يدوياً)
    await redisCommand(['SET', countKey, (usedMonths + 1).toString()]);

    res.status(200).json({ code, cap: TRIAL_CAP });
  } catch (err) {
    res.status(500).json({ error: 'صار خطأ أثناء إنشاء كود التجربة، جرب مرة ثانية' });
  }
};
