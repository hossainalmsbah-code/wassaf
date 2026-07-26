const { redisCommand } = require('./_redis');

// يقرأ بيانات وصف مُشارك بمعرّفه — تستخدمه صفحة share.html العامة
module.exports = async (req, res) => {
  try {
    const id = ((req.query && req.query.id) || '').toString().trim();
    if (!id) {
      res.status(400).json({ error: 'معرّف غير صحيح' });
      return;
    }

    const raw = await redisCommand(['GET', `share:${id}`]);
    if (!raw) {
      res.status(404).json({ error: 'الرابط منتهي أو غير موجود' });
      return;
    }

    let data;
    try {
      data = JSON.parse(raw);
    } catch (e) {
      res.status(500).json({ error: 'بيانات تالفة' });
      return;
    }

    res.status(200).json({ ok: true, ...data });
  } catch (err) {
    res.status(500).json({ error: 'صار خطأ أثناء جلب المشاركة' });
  }
};
