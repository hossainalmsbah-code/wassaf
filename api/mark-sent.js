const { redisCommand } = require('./_redis');

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  try {
    const body = req.body || {};
    const adminSecret = (body.adminSecret || '').toString();
    const id = (body.id || '').toString();

    if (!process.env.ADMIN_SECRET || adminSecret !== process.env.ADMIN_SECRET) {
      res.status(401).json({ error: 'غير مصرح' });
      return;
    }

    if (!id) {
      res.status(400).json({ error: 'حدد رقم الإشعار' });
      return;
    }

    await redisCommand(['HDEL', 'pending:notify', id]);

    res.status(200).json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Server error', detail: err.message });
  }
};
