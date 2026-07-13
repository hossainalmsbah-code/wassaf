const { redisCommand } = require('./_redis');

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  try {
    const body = req.body || {};
    const adminSecret = (body.adminSecret || '').toString();
    const ip = (body.ip || '').toString().trim();

    if (!process.env.ADMIN_SECRET || adminSecret !== process.env.ADMIN_SECRET) {
      res.status(401).json({ error: 'غير مصرح' });
      return;
    }

    if (!ip) {
      res.status(400).json({ error: 'حدد عنوان الشبكة (IP) اللي تبي تفك حظرها' });
      return;
    }

    await redisCommand(['DEL', `trial_count:${ip}`]);

    res.status(200).json({ ok: true, ip });
  } catch (err) {
    res.status(500).json({ error: 'Server error', detail: err.message });
  }
};
