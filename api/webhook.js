const crypto = require('crypto');
const { redisCommand } = require('./_redis');
const { sendEmail } = require('./_email');

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
  if (n.includes('أسبوع') || n.includes('اسبوع')) return { cap: 30, plan: 'أسبوعي' };
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

function buildWelcomeEmailHtml({ code, plan, cap }) {
  return `
  <div dir="rtl" style="font-family:'IBM Plex Sans Arabic',Arial,sans-serif;max-width:520px;margin:0 auto;padding:32px 24px;background:#ffffff;">
    <div style="text-align:center;margin-bottom:24px;">
      <span style="font-size:28px;font-weight:900;color:#E94548;">وصّاف</span>
    </div>
    <h2 style="color:#1E1B2E;font-size:20px;">أهلاً فيك بوصّاف 👋</h2>
    <p style="color:#6B6785;font-size:15px;line-height:1.8;">
      اشتراكك بباقة <strong>${plan}</strong> نجح، وهذا كود الوصول الخاص فيك — استخدمه مباشرة بالموقع عشان تبدأ تولّد أوصاف منتجاتك.
    </p>
    <div style="background:#F7F6FB;border:1px solid #E7E4F0;border-radius:10px;padding:20px;text-align:center;margin:24px 0;">
      <div style="font-size:12px;color:#6E5BC7;font-weight:700;margin-bottom:8px;">كود الوصول</div>
      <div style="font-family:monospace;font-size:28px;font-weight:900;color:#E94548;letter-spacing:4px;">${code}</div>
      <div style="font-size:13px;color:#6B6785;margin-top:10px;">حد ${cap} وصف بالشهر</div>
    </div>
    <a href="https://www.wassaf.space" style="display:block;text-align:center;background:#E94548;color:#ffffff;text-decoration:none;font-weight:700;padding:14px;border-radius:8px;font-size:15px;">
      ابدأ التوليد الآن
    </a>
    <p style="color:#6B6785;font-size:13px;line-height:1.8;margin-top:24px;">
      حط الكود بصندوق "كود الوصول" أول ما تفتح الموقع، وبيتذكره تلقائياً بعد كذا. أي استفسار راسلنا على واتساب أو إيميل، إحنا حاضرين.
    </p>
  </div>`;
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

    let emailSent = false;
    let emailError = null;
    if (email) {
      try {
        await sendEmail({
          to: email,
          subject: 'كود الوصول لوصّاف جاهز 🎉',
          html: buildWelcomeEmailHtml({ code, plan: planInfo.plan, cap: planInfo.cap })
        });
        emailSent = true;
      } catch (mailErr) {
        emailError = mailErr.message;
      }
    }

    // نسجلها بقائمة الانتظار دايماً (حتى لو الإيميل نجح) — نسخة احتياطية لك تراجعها، وتوثيق كامل
    await redisCommand(['HSET', 'pending:notify', notifyId, JSON.stringify({
      code,
      email,
      plan: planInfo.plan,
      cap: planInfo.cap,
      createdAt: new Date().toISOString(),
      emailSent,
      emailError
    })]);

    res.status(200).json({ received: true, code, emailSent });
  } catch (err) {
    res.status(500).json({ error: 'Webhook error', detail: err.message });
  }
};
