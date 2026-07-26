const { redisCommand } = require('./_redis');

const SHARE_TTL_SECONDS = 30 * 24 * 60 * 60; // الرابط يبقى شغال 30 يوم من إنشائه

function generateShareId() {
  return Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-4);
}

// يخزّن نسخة من الوصف المولّد مؤقتاً، ويرجّع معرّف قصير تُبنى منه صفحة مشاركة عامة
module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  try {
    const body = req.body || {};
    const productName = (body.productName || '').toString().trim().slice(0, 200);
    const long = (body.long || '').toString().trim().slice(0, 4000);
    const short = (body.short || '').toString().trim().slice(0, 1000);

    if (!long && !short) {
      res.status(400).json({ error: 'ما فيه نص نشاركه' });
      return;
    }

    const shareId = generateShareId();
    const payload = JSON.stringify({ productName, long, short, createdAt: Date.now() });
    await redisCommand(['SET', `share:${shareId}`, payload, 'EX', SHARE_TTL_SECONDS]);

    res.status(200).json({ ok: true, shareId, url: `/share.html?id=${shareId}` });
  } catch (err) {
    res.status(500).json({ error: 'صار خطأ أثناء إنشاء رابط المشاركة' });
  }
};
