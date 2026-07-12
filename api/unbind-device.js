const { unbindDevice } = require('./_access');

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  try {
    const body = req.body || {};
    const adminSecret = (body.adminSecret || '').toString();
    const code = (body.code || '').toString().trim().toUpperCase();

    if (!process.env.ADMIN_SECRET || adminSecret !== process.env.ADMIN_SECRET) {
      res.status(401).json({ error: 'غير مصرح' });
      return;
    }

    if (!code) {
      res.status(400).json({ error: 'حدد الكود اللي تبي تفك ربطه' });
      return;
    }

    await unbindDevice(code);

    res.status(200).json({ ok: true, code });
  } catch (err) {
    res.status(500).json({ error: 'Server error', detail: err.message });
  }
};
