const { redisCommand } = require('./_redis');

// يولّد كود عشوائي واضح (بدون أحرف ملتبسة زي 0/O أو 1/I)
function generateRandomCode(length = 6) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < length; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return code;
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  try {
    const body = req.body || {};
    const adminSecret = (body.adminSecret || '').toString();
    const cap = parseInt(body.cap, 10);
    const plan = (body.plan || 'عام').toString().trim();
    const customCode = (body.code || '').toString().trim().toUpperCase();

    if (!process.env.ADMIN_SECRET || adminSecret !== process.env.ADMIN_SECRET) {
      res.status(401).json({ error: 'كلمة السر الإدارية غير صحيحة' });
      return;
    }

    if (!cap || cap <= 0) {
      res.status(400).json({ error: 'حدد حد أقصى شهري صحيح (رقم أكبر من صفر)' });
      return;
    }

    const code = customCode || generateRandomCode();

    // نتأكد الكود مو مستخدم قبل كذا (إلا لو كان تحديث متعمد لنفس الكود)
    const existing = await redisCommand(['GET', `code:${code}`]);

    const value = JSON.stringify({
      cap,
      plan,
      active: true,
      createdAt: new Date().toISOString()
    });

    await redisCommand(['SET', `code:${code}`, value]);

    res.status(200).json({
      code,
      cap,
      plan,
      wasExisting: !!existing
    });
  } catch (err) {
    res.status(500).json({ error: 'Server error', detail: err.message });
  }
};
