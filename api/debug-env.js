// نقطة تشخيص مؤقتة — تساعدنا نعرف بالضبط وش المشكلة بمتغيرات البيئة بدون كشف القيم الحساسة كاملة
// احذف هذا الملف بعد ما تنحل المشكلة، ما يصير يبقى بالمشروع دائماً

function describeVar(name) {
  const value = process.env[name];
  if (value === undefined) {
    return { name, status: 'غير موجود إطلاقاً (undefined)' };
  }
  if (value === '') {
    return { name, status: 'موجود لكن فاضي تماماً (empty string)' };
  }
  const trimmed = value.trim();
  return {
    name,
    status: 'موجود',
    length: value.length,
    hasLeadingOrTrailingSpace: trimmed.length !== value.length,
    first4: value.slice(0, 4),
    last4: value.slice(-4),
    startsWithHttps: name.includes('URL') ? value.startsWith('https://') : undefined
  };
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const body = req.body || {};
  const adminSecret = (body.adminSecret || '').toString();

  if (!process.env.ADMIN_SECRET || adminSecret !== process.env.ADMIN_SECRET) {
    res.status(401).json({ error: 'غير مصرح' });
    return;
  }

  res.status(200).json({
    UPSTASH_REDIS_REST_URL: describeVar('UPSTASH_REDIS_REST_URL'),
    UPSTASH_REDIS_REST_TOKEN: describeVar('UPSTASH_REDIS_REST_TOKEN'),
    ADMIN_SECRET: describeVar('ADMIN_SECRET'),
    ANTHROPIC_API_KEY: describeVar('ANTHROPIC_API_KEY')
  });
};
