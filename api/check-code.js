const { checkAccessCode } = require('./_access');

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  try {
    const body = req.body || {};
    const accessCode = (body.accessCode || '').toString().trim().toUpperCase();

    if (!accessCode) {
      res.status(400).json({ error: 'أدخل كود الوصول' });
      return;
    }

    const result = await checkAccessCode(accessCode);

    if (!result.ok) {
      if (result.reason === 'exhausted') {
        res.status(200).json({
          valid: false,
          reason: 'exhausted',
          message: `هذا الكود خلص حده الشهري (${result.cap} وصف). جدد اشتراكك أو تواصل معنا.`
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
