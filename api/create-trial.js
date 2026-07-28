const { redisCommand } = require('./_redis');

function generateRandomCode(length = 6) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < length; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return code;
}

const TRIAL_CAP = 10;
const TRIAL_DURATION_SECONDS = 10 * 24 * 60 * 60; // 10 أيام بالضبط — الكود ينتهي تلقائياً بعدها حتى لو ما استخدم كل الحصة

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  try {
    const body = req.body || {};
    const deviceId = (body.deviceId || '').toString().trim();

    if (!deviceId) {
      res.status(400).json({ error: 'تعذر تحديد الجهاز، جرب تحدّث الصفحة', code: 'NO_DEVICE_ID' });
      return;
    }

    // مرة وحدة فقط لكل جهاز، للأبد — بدون تصفير شهري
    const deviceKey = `trial_device:${deviceId}`;
    const alreadyUsed = await redisCommand(['GET', deviceKey]);
    if (alreadyUsed) {
      res.status(403).json({
        error: 'جرّبت وصّاف مجاناً من قبل على هالجهاز. تقدر تشترك بأي باقة عشان تكمل التوليد.',
        code: 'TRIAL_ALREADY_USED'
      });
      return;
    }

    const code = generateRandomCode();
    const value = JSON.stringify({
      cap: TRIAL_CAP,
      plan: 'تجربة',
      active: true,
      createdAt: new Date().toISOString(),
      source: 'self_serve_trial',
      deviceId
    });

    // EX هنا هو صلب الميزة: الكود نفسه يختفي من Redis تلقائياً بعد 10 أيام بالضبط،
    // فحتى لو التاجر ما استخدم كل العشر أوصاف، أي محاولة توليد بعدها تفشل تلقائياً بدون أي كود إضافي بـ_access.js
    await redisCommand(['SET', `code:${code}`, value, 'EX', TRIAL_DURATION_SECONDS]);

    // نسجل هالجهاز على إنه أخذ تجربته، للأبد بدون انتهاء صلاحية — يمنع أي محاولة ثانية من نفس الجهاز مستقبلاً
    await redisCommand(['SET', deviceKey, code]);

    res.status(200).json({ code, cap: TRIAL_CAP });
  } catch (err) {
    res.status(500).json({ error: 'صار خطأ أثناء إنشاء كود التجربة، جرب مرة ثانية' });
  }
};
