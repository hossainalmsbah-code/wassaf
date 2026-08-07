const { redisCommand } = require('./_redis');

// [مهم] القيمة اللي سلة ولّدتها تلقائياً بخانة "مفتاح التنبيهات السري" — انسخها بالضبط من هناك (زر العين 👁️)
const SALLA_WEBHOOK_SECRET = process.env.SALLA_WEBHOOK_SECRET;

function verifySallaToken(authorizationHeader) {
  if (!SALLA_WEBHOOK_SECRET || !authorizationHeader) return false;
  return authorizationHeader === SALLA_WEBHOOK_SECRET;
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  // مع استراتيجية Token، سلة ترسل المفتاح السري مباشرة برأس Authorization — نقارنه بالقيمة المخزّنة عندنا
  const authHeader = req.headers['authorization'];
  if (!verifySallaToken(authHeader)) {
    res.status(401).json({ error: 'Invalid token' });
    return;
  }

  const { event, merchant, data } = req.body || {};

  try {
    if (event === 'app.store.authorize') {
      // هذا الحدث يوصل تلقائياً أول ما تاجر يثبّت التطبيق (وضع Easy Mode) — يحتوي رمز الوصول ورمز التحديث
      const record = {
        accessToken: data.access_token,
        refreshToken: data.refresh_token,
        expiresAt: data.expires,
        scope: data.scope,
        installedAt: new Date().toISOString()
      };
      await redisCommand(['SET', `salla_store:${merchant}`, JSON.stringify(record)]);
      res.status(200).json({ ok: true });
      return;
    }

    res.status(200).json({ ok: true, ignored: event || 'unknown' });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
};
