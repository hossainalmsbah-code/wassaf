const { checkAccessCode } = require('./_access');

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

    if (!result.ok) {
      if (result.reason === 'exhausted') {
        res.status(200).json({
          valid: false,
          reason: 'exhausted',
          message: `هذا الكود خلص حده الشهري (${result.cap} وصف). جدد اشتراكك أو تواصل معنا.`
        });
      } else if (result.reason === 'device_mismatch') {
        res.status(200).json({
          valid: false,
          reason: 'device_mismatch',
          message: 'هذا الكود مستخدم فعلاً بجهاز ثاني. لو غيّرت جهازك، تواصل معنا نفعّله لك.'
        });
      } else {
        res.status(200).json({
          valid: false,
          reason: 'invalid',
          message: 'كود الوصول غير صحيح'
        });
      }
      return;
    }

    res.status(200).json({
      valid: true,
      remaining: result.remaining,
      cap: result.cap,
      plan: result.plan
    });
  } catch (err) {
    res.status(500).json({ error: 'صار خطأ أثناء التحقق، جرب مرة ثانية' });
  }
};
