const { checkAccessCode } = require('./_access');
const { redisCommand } = require('./_redis');

// يرجّع بيانات الحساب الكاملة لصفحة "حسابي": الباقة، الاستخدام، وكود/عداد الإحالة
module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  try {
    const body = req.body || {};
    const accessCode = (body.accessCode || '').toString().trim().toUpperCase();
    const deviceId = (body.deviceId || '').toString().trim();

    if (!accessCode) {
      res.status(400).json({ error: 'أدخل كود الوصول' });
      return;
    }

    const result = await checkAccessCode(accessCode, deviceId);

    // كود موجود لكن خلص رصيده — نعرض بياناته بدل ما نرفض الطلب بالكامل
    if (!result.ok && result.reason !== 'exhausted') {
      res.status(200).json({ valid: false, message: 'كود الوصول غير صحيح' });
      return;
    }

    const referralCount = parseInt((await redisCommand(['GET', `referral_count:${accessCode}`])) || '0', 10);

    const cap = result.cap;
    const used = typeof result.used === 'number' ? result.used : (cap - (result.remaining || 0));
    const remaining = typeof result.remaining === 'number' ? result.remaining : Math.max(cap - used, 0);

    res.status(200).json({
      valid: true,
      plan: result.plan || 'عام',
      cap,
      used,
      remaining,
      referralCode: accessCode,
      referralCount
    });
  } catch (err) {
    res.status(500).json({ error: 'صار خطأ أثناء جلب بيانات الحساب' });
  }
};
