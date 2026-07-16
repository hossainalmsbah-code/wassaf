const { redisCommand } = require('./_redis');

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  try {
    const body = req.body || {};
    const adminSecret = (body.adminSecret || '').toString();

    if (!process.env.ADMIN_SECRET || adminSecret !== process.env.ADMIN_SECRET) {
      res.status(401).json({ error: 'غير مصرح' });
      return;
    }

    const raw = await redisCommand(['HGETALL', 'pending:notify']);
    // Upstash يرجع مصفوفة متبادلة: [field1, value1, field2, value2, ...]
    const items = [];
    if (raw && raw.length) {
      for (let i = 0; i < raw.length; i += 2) {
        const id = raw[i];
        try {
          const data = JSON.parse(raw[i + 1]);

          // نعرض بس العناصر اللي فعلاً تحتاج تدخل يدوي:
          // - يحتاج مراجعة (ما قدرنا نحدد الباقة تلقائياً)، أو
          // - الإيميل التلقائي فشل إرساله
          // أي كود انبعث تلقائياً بنجاح (emailSent: true) ما نعرضه — لأنه ما يحتاج أي تدخل منك
          const needsAction = data.needsReview === true || data.emailSent === false;
          if (needsAction) {
            items.push({ id, ...data });
          }
        } catch (e) {
          // نتجاهل أي سجل تالف بدل ما نكسر الصفحة كلها
        }
      }
    }

    // الأحدث أول
    items.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

    res.status(200).json({ items });
  } catch (err) {
    res.status(500).json({ error: 'Server error', detail: err.message });
  }
};
