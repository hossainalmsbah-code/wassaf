const { redisCommand } = require('./_redis');
const { addReferralBonus } = require('./_access');

// عدد الأوصاف الإضافية اللي ياخذها كل طرف (الداعي والمدعو) عند نجاح الإحالة
const REFERRAL_BONUS = 5;

// تُستدعى بعد نجاح إنشاء تجربة مجانية جديدة عبر رابط إحالة (?ref=CODE)
// تتحقق من عدم تكرار تطبيق نفس الإحالة على نفس الكود الجديد، ثم تزيد حد الاستخدام (cap) لكلا الكودين
module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  try {
    const body = req.body || {};
    const newAccessCode = (body.newAccessCode || '').toString().trim().toUpperCase();
    const referrerCode = (body.referrerCode || '').toString().trim().toUpperCase();

    if (!newAccessCode || !referrerCode) {
      res.status(400).json({ error: 'بيانات الإحالة ناقصة' });
      return;
    }

    if (newAccessCode === referrerCode) {
      res.status(400).json({ error: 'ما تقدر تحيل نفسك بنفسك' });
      return;
    }

    // حماية من تكرار التطبيق: أول محاولة تنجح تقفل المفتاح، أي محاولة ثانية لنفس الكود الجديد تُرفض بصمت
    const guardKey = `referral_applied:${newAccessCode}`;
    const guardResult = await redisCommand(['SET', guardKey, referrerCode, 'NX']);
    if (guardResult !== 'OK') {
      res.status(200).json({ ok: true, alreadyApplied: true });
      return;
    }

    // نتأكد إن كود الداعي فعلاً موجود قبل ما نمنحه مكافأة
    const referrerData = await redisCommand(['GET', `code:${referrerCode}`]);
    if (!referrerData) {
      await redisCommand(['DEL', guardKey]); // نفك القفل عشان ما نحرق فرصة تطبيق صحيح لاحقاً
      res.status(404).json({ error: 'كود الإحالة غير موجود' });
      return;
    }

    const referredResult = await addReferralBonus(newAccessCode, REFERRAL_BONUS);
    const referrerResult = await addReferralBonus(referrerCode, REFERRAL_BONUS);

    // عداد بسيط لعدد الأشخاص اللي دعاهم كل كود — نستخدمه بصفحة الحساب
    await redisCommand(['INCR', `referral_count:${referrerCode}`]);

    res.status(200).json({
      ok: true,
      referredNewCap: referredResult.newCap,
      referrerNewCap: referrerResult.newCap,
      bonus: REFERRAL_BONUS
    });
  } catch (err) {
    res.status(500).json({ error: 'صار خطأ أثناء تطبيق الإحالة' });
  }
};
