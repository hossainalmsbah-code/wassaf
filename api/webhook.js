const crypto = require('crypto');
const { redisCommand } = require('./_redis');

function generateRandomCode(length = 6) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < length; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return code;
}

// نحدد حد الأوصاف الشهري تلقائياً حسب اسم الباقة اللي جاية من Lemon Squeezy
// نفس الأرقام المستخدمة بلوحة الإدارة يدوياً، عشان التوليد الآلي يطابق اليدوي
function capFromVariantName(name) {
  const n = (name || '').toString();
  if (n.includes('نصف')) return { cap: 180, plan: 'نصف سنوي' };
  if (n.includes('سنوي')) return { cap: 300, plan: 'سنوي' };
  if (n.includes('شهري')) return { cap: 120, plan: 'شهري' };
  if (n.includes('أسبوع') || n.includes('اسبوع')) return { cap: 39, plan: 'أسبوعي' };
  if (n.includes('تجرب')) return { cap: 10, plan: 'تجربة' };
  return null;
}

// لازم نقرأ الـ body الخام (Raw Bytes) قبل أي تحويل، لأن التحقق من التوقيع يحتاج البيانات الأصلية بالضبط
async function readRawBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks);
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  try {
    const rawBody = await readRawBody(req);

    const secret = process.env.LEMONSQUEEZY_WEBHOOK_SECRET;
    if (!secret) {
      res.status(500).send('Webhook secret not configured');
      return;
    }

    const signatureHeader = (req.headers['x-signature'] || '').toString();
    const expectedSignature = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');

    let signatureValid = false;
    try {
      signatureValid = signatureHeader.length === expectedSignature.length &&
        crypto.timingSafeEqual(Buffer.from(expectedSignature, 'utf8'), Buffer.from(signatureHeader, 'utf8'));
    } catch (e) {
      signatureValid = false;
    }

    if (!signatureValid) {
      res.status(401).send('Invalid signature');
      return;
    }

    const event = JSON.parse(rawBody.toString('utf8'));
    const eventName = event.meta && event.meta.event_name;

    // نهتم بس بحدث اشتراك جديد ناجح — باقي الأحداث (إلغاء، تجديد...) نتجاهلها بهذا الإصدار المبسّط
    if (eventName !== 'subscription_created') {
      res.status(200).json({ received: true, ignored: eventName || 'unknown' });
      return;
    }

    const attrs = (event.data && event.data.attributes) || {};
    const email = attrs.user_email || '';
    const variantName = attrs.variant_name || attrs.product_name || '';

    const notifyId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const planInfo = capFromVariantName(variantName);

    if (!planInfo) {
      // ما قدرنا نحدد الباقة تلقائياً من الاسم — نسجلها "تحتاج مراجعة يدوية" بدل ما نتجاهلها بصمت
      await redisCommand(['HSET', 'pending:notify', notifyId, JSON.stringify({
        code: null,
        email,
        plan: variantName || 'غير معروف',
        cap: null,
        needsReview: true,
        createdAt: new Date().toISOString()
      })]);
      res.status(200).json({ received: true, needsReview: true });
      return;
    }

    const code = generateRandomCode();
    const codeValue = JSON.stringify({
      cap: planInfo.cap,
      plan: planInfo.plan,
      active: true,
      createdAt: new Date().toISOString(),
      source: 'webhook',
      email
    });
    await redisCommand(['SET', `code:${code}`, codeValue]);

    await redisCommand(['HSET', 'pending:notify', notifyId, JSON.stringify({
      code,
      email,
      plan: planInfo.plan,
      cap: planInfo.cap,
      createdAt: new Date().toISOString()
    })]);

    res.status(200).json({ received: true, code });
  } catch (err) {
    res.status(500).json({ error: 'Webhook error', detail: err.message });
  }
};
