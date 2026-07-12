module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const body = req.body || {};
  const adminSecret = (body.adminSecret || '').toString();

  if (!process.env.ADMIN_SECRET || adminSecret !== process.env.ADMIN_SECRET) {
    res.status(401).json({ ok: false });
    return;
  }

  res.status(200).json({ ok: true });
};
