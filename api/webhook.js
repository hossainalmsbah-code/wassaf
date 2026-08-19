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

// نحدد حد الأوصاف الشهري تلقائياً حسب رقم الباقة (variant_id) أو اسمها اللي جاية من Lemon Squeezy
// نفس الأرقام المستخدمة بلوحة الإدارة يدوياً، عشان التوليد الآلي يطابق اليدوي
// الأولوية لـ variant_id لأنه رقم ثابت ما يتغير، وبعده نطابق الاسم (عربي/إنجليزي) كخطة احتياطية

// عدّل الأرقام هذي بأرقام الـ variant IDs الحقيقية عندك (تحصلها من لوحة Lemon Squeezy أو API)
const VARIANT_ID_MAP = {
  '1913994': { cap: 180, plan: 'نصف سنوي' }, // تأكدنا منه باختبار حقيقي بتاريخ 16 يوليو 2026
  // 'رقم_الـ_variant': { cap: 30, plan: 'أسبوعي' },
  // 'رقم_الـ_variant': { cap: 120, plan: 'شهري' },
  // 'رقم_الـ_variant': { cap: 300, plan: 'سنوي' },
  // 'رقم_الـ_variant': { cap: 10, plan: 'تجربة' },
};

function capFromVariantId(variantId) {
  if (!variantId) return null;
  const key = variantId.toString();
  return VARIANT_ID_MAP[key] || null;
}

function capFromVariantName(name) {
  const n = (name || '').toString().toLowerCase();

  // مطابقة عربية (الأصلية)
  if (n.includes('نصف')) return { cap: 180, plan: 'نصف سنوي' };
  if (n.includes('سنوي')) return { cap: 300, plan: 'سنوي' };
  if (n.includes('شهري')) return { cap: 120, plan: 'شهري' };
  if (n.includes('أسبوع') || n.includes('اسبوع')) return { cap: 20, plan: 'أسبوعي' };
  if (n.includes('تجرب')) return { cap: 10, plan: 'تجربة' };

  // مطابقة إنجليزية (إضافة جديدة) — نتحقق من "نصف سنوي" قبل "سنوي" عشان ما يلخبط semi مع annual
  if (n.includes('semi') || n.includes('half') || n.includes('bi-annual') || n.includes('biannual')) return { cap: 180, plan: 'نصف سنوي' };
  if (n.includes('annual') || n.includes('year')) return { cap: 300, plan: 'سنوي' };
  if (n.includes('month')) return { cap: 120, plan: 'شهري' };
  if (n.includes('week')) return { cap: 20, plan: 'أسبوعي' };
  if (n.includes('trial') || n.includes('free')) return { cap: 10, plan: 'تجربة' };

  return null;
}

// الدالة الرئيسية: نجرب الـ variant_id أول، ولو ما لقينا نرجع للاسم
function resolvePlan(variantId, variantName) {
  return capFromVariantId(variantId) || capFromVariantName(variantName);
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

// [إضافة جديدة] بريد ترحيب خاص بتجار سلة تحديداً — مختلف عن بريد Lemon Squeezy فوق لأن تاجر سلة
// ما يحتاج كود وصول إطلاقاً، التطبيق يتعرف عليه تلقائياً بمجرد ما يفتحه من لوحة تحكمه
function buildSallaWelcomeEmailHtml({ storeName }) {
  return `
  <div dir="rtl" style="font-family:'IBM Plex Sans Arabic',Arial,sans-serif;max-width:520px;margin:0 auto;padding:32px 24px;background:#ffffff;">
    <div style="text-align:center;margin-bottom:24px;">
      <span style="font-size:28px;font-weight:900;color:#E94548;">وصّاف</span>
    </div>
    <h2 style="color:#1E1B2E;font-size:20px;">أهلاً فيك ${storeName ? 'يا ' + storeName : ''} 👋</h2>
    <p style="color:#6B6785;font-size:15px;line-height:1.8;">
      تم تثبيت وصّاف بنجاح على متجرك بسلة! ما تحتاج أي كود أو خطوة إضافية — بس افتح التطبيق من داخل لوحة تحكم متجرك بسلة، اختر منتجك، واضغط توليد.
    </p>
    <div style="background:#F7F6FB;border:1px solid #E7E4F0;border-radius:10px;padding:20px;margin:24px 0;">
      <div style="font-size:13px;color:#1E1B2E;line-height:2;">
        ✨ وصف طويل، وصف قصير، ووصف SEO — خلال ثواني<br>
        🛍️ انشر الوصف رجوع لمنتجك بضغطة وحدة<br>
        📸 أو ولّد الوصف من صورة المنتج مباشرة
      </div>
    </div>
    <p style="color:#6B6785;font-size:13px;line-height:1.8;margin-top:24px;">
      أي استفسار راسلنا على واتساب أو إيميل، إحنا حاضرين.
    </p>
  </div>`;
}

module.exports = async (req, res) => {
  // [إضافة جديدة] روابط تسجيل دخول زد (Redirect/Callback) تصل كـGET من متصفح التاجر مباشرة —
  // لازم تُفرز قبل فحص "POST بس" اللي تحت، لأنها مختلفة تماماً عن أحداث الاشتراك (اللي توصل POST من سيرفر زد)
  if (req.method === 'GET' && req.query && req.query.source === 'zid' && req.query.step === 'install') {
    await handleZidInstallRedirect(req, res);
    return;
  }
  if (req.method === 'GET' && req.query && req.query.source === 'zid' && req.query.step === 'callback') {
    await handleZidOAuthCallback(req, res);
    return;
  }
  // [إضافة جديدة] هذا هو "Application URL" الثابت اللي نحطه بلوحة تطوير زد — تفتحه زد تلقائياً بالـiframe
  if (req.method === 'GET' && req.query && req.query.source === 'zid' && req.query.step === 'embedded') {
    await handleZidEmbeddedEntry(req, res);
    return;
  }

  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  // [إضافة] أحداث سلة تُفرز فوراً بمعامل صريح بالرابط (source=salla) — قبل أي معالجة تخص Lemon Squeezy
  // هذا يفصل المسارين بشكل كامل، صفر تداخل بينهم حتى لو تشابهت أشكال البيانات مستقبلاً
  if (req.query && req.query.source === 'salla') {
    await handleSallaWebhook(req, res);
    return;
  }

  // [إضافة جديدة] نفس الفكرة بالضبط لأحداث اشتراك زد — مسار مستقل تماماً، صفر تداخل مع سلة أو Lemon Squeezy
  if (req.query && req.query.source === 'zid') {
    await handleZidWebhook(req, res);
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

    // [تعديل ضروري] نهتم الآن بحدثين: اشتراك جديد ناجح، وانتهاء الاشتراك فعلياً (subscription_expired)
    // subscription_expired يصير بالضبط بنهاية الفترة المدفوعة (نفس يوم الاشتراك بالشهر التالي) — سواء التاجر ألغى بنفسه أو فشل التجديد
    // ما نستمع لـ subscription_cancelled لأنه يصير وقت الإلغاء نفسه، بينما الاشتراك يفضل فعّال لين نهاية الفترة المدفوعة فعلياً
    if (eventName !== 'subscription_created' && eventName !== 'subscription_expired') {
      res.status(200).json({ received: true, ignored: eventName || 'unknown' });
      return;
    }

    // منع التكرار: Lemon Squeezy أحياناً يرسل نفس حدث الاشتراك أكثر من مرة (retry)
    // نستخدم معرّف الاشتراك الفريد كقفل بـ Redis — أول وحدة توصل تاخذ القفل وتكمل، أي تكرار بعدها يتجاهل فوراً
    const subscriptionId = event.data && event.data.id;
    if (subscriptionId) {
      // [تعديل ضروري] قفل التكرار صار مربوط باسم الحدث نفسه أيضاً، عشان حدث subscription_expired
      // ما ياخذ نفس قفل subscription_created لنفس الاشتراك (لأنه معرّف الاشتراك واحد لكن الحدث مختلف تماماً)
      const lockKey = `webhook:lock:${eventName}:${subscriptionId}`;
      // NX: يحط القيمة بس لو المفتاح مو موجود أصلاً | EX 2592000: القفل ينتهي تلقائياً بعد 30 يوم
      const lockResult = await redisCommand(['SET', lockKey, '1', 'NX', 'EX', '2592000']);
      if (lockResult !== 'OK') {
        // معناها فيه حدث سابق أخذ القفل قبلنا — هذا تكرار، نتجاهله
        res.status(200).json({ received: true, duplicate: true, subscriptionId });
        return;
      }
    }

    // [إضافة جديدة] معالجة حدث انتهاء الاشتراك فعلياً — نطفّي الكود المرتبط بالكامل بغض النظر عن أي أوصاف متبقية
    if (eventName === 'subscription_expired') {
      if (!subscriptionId) {
        res.status(200).json({ received: true, ignored: 'no subscription id' });
        return;
      }

      const linkedCode = await redisCommand(['GET', `subscription_code:${subscriptionId}`]);
      if (!linkedCode) {
        // اشتراك ما نعرف الكود المرتبط فيه (غالباً كان موجود قبل هالتحديث) — نسجله للمراجعة اليدوية بدل ما نتجاهله بصمت
        await redisCommand(['HSET', 'pending:review_expired', subscriptionId, JSON.stringify({
          subscriptionId,
          receivedAt: new Date().toISOString()
        })]);
        res.status(200).json({ received: true, codeNotFound: true, subscriptionId });
        return;
      }

      const raw = await redisCommand(['GET', `code:${linkedCode}`]);
      if (raw) {
        let parsed;
        try {
          parsed = JSON.parse(raw);
        } catch (e) {
          parsed = null;
        }
        if (parsed) {
          parsed.active = false;
          parsed.deactivatedAt = new Date().toISOString();
          parsed.deactivationReason = 'subscription_expired';
          await redisCommand(['SET', `code:${linkedCode}`, JSON.stringify(parsed)]);
        }
      }

      res.status(200).json({ received: true, deactivated: true, code: linkedCode, subscriptionId });
      return;
    }

    const attrs = (event.data && event.data.attributes) || {};
    const email = attrs.user_email || '';
    const variantId = attrs.variant_id;
    // product_name يحمل الاسم العربي الحقيقي للباقة (مثلاً "الباقة النصف السنوي")
    // variant_name غالباً "Default" لما يكون فيه variant وحيد بالمنتج — لهذا نجربه بعد product_name فقط
    const variantName = attrs.product_name || attrs.variant_name || '';

    const notifyId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const planInfo = resolvePlan(variantId, variantName);

    if (!planInfo) {
      // ما قدرنا نحدد الباقة تلقائياً لا من الـ variant_id ولا من الاسم — نسجلها "تحتاج مراجعة يدوية" بدل ما نتجاهلها بصمت
      await redisCommand(['HSET', 'pending:notify', notifyId, JSON.stringify({
        code: null,
        email,
        plan: variantName || 'غير معروف',
        variantId: variantId || null,
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
      email,
      subscriptionId: subscriptionId || null
    });
    await redisCommand(['SET', `code:${code}`, codeValue]);

    // [إضافة جديدة] نخزّن الربط بين معرّف الاشتراك والكود — أساسي عشان نقدر نطفّي الكود الصحيح عند subscription_expired لاحقاً
    if (subscriptionId) {
      await redisCommand(['SET', `subscription_code:${subscriptionId}`, code]);
    }

    // [إضافة جديدة] فهرس إيميل → كود — يستخدمه نظام تسجيل الحسابات (auth_signup) عشان يربط
    // أي حساب إيميل/باسورد جديد بآخر اشتراك فعّال لنفس الإيميل تلقائياً، بدون ربط يدوي
    if (email) {
      await redisCommand(['SET', `email_code:${email}`, code]);
    }

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

// ==================== [إضافة جديدة] استقبال أحداث تطبيق سلة — منفصلة تماماً عن منطق Lemon Squeezy فوق ====================
// رابط الاستقبال المسجّل بلوحة سلة: https://www.wassaf.space/api/webhook?source=salla
// خطة الحماية المختارة: Token — سلة ترسل المفتاح السري مباشرة برأس Authorization

// [إضافة جديدة] خريطة أسماء الباقات المسجّلة بلوحة شركاء سلة (تبويب Pricing) → الحد الشهري والاسم الداخلي
// ⚠️ لازم تطابق بالضبط أسماء الباقات اللي تكتبونها حرفياً بحقل "اسم الباقة" وقت التسجيل بلوحة الشركاء
const SALLA_PLAN_MAP = {
  'أسبوعي': { plan: 'أسبوعي', cap: 20 },
  'شهري': { plan: 'شهري', cap: 120 },
  'نصف سنوي': { plan: 'نصف سنوي', cap: 180 },
  'سنوي': { plan: 'سنوي', cap: 300 }
};

async function handleSallaWebhook(req, res) {
  const SALLA_WEBHOOK_SECRET = process.env.SALLA_WEBHOOK_SECRET;
  const authHeaderRaw = req.headers['authorization'];
  // [تعديل] بعض الأنظمة ترسل الرأس بصيغة "Bearer <token>" بدل التوكن مجرد لحاله — نتعامل مع الحالتين، ونتجاهل أي مسافات زائدة
  const authHeader = (authHeaderRaw || '').toString().replace(/^Bearer\s+/i, '').trim();
  const expectedSecret = (SALLA_WEBHOOK_SECRET || '').toString().trim();

  if (!expectedSecret || authHeader !== expectedSecret) {
    res.status(401).json({ error: 'Invalid token' });
    return;
  }

  const { event, merchant, data } = req.body || {};

  try {
    if (event === 'app.store.authorize') {
      // يوصل تلقائياً أول ما تاجر يثبّت التطبيق (وضع Easy Mode) — يحتوي رمز الوصول ورمز التحديث
      const record = {
        accessToken: data.access_token,
        refreshToken: data.refresh_token,
        expiresAt: data.expires, // unix timestamp
        scope: data.scope,
        installedAt: new Date().toISOString()
      };
      await redisCommand(['SET', `salla_store:${merchant}`, JSON.stringify(record)]);

      // [إضافة جديدة] حدث app.store.authorize ما يحتوي إيميل التاجر أبداً (تأكدنا من توثيق سلة الرسمي) —
      // نجيبه بطلب منفصل لمسار بيانات المتجر بنفس التوكن الجديد، ونرسل بريد ترحيب فوري
      try {
        const storeInfoRes = await fetch('https://api.salla.dev/admin/v2/store/info', {
          headers: { 'Authorization': `Bearer ${data.access_token}` }
        });
        if (storeInfoRes.ok) {
          const storeInfoData = await storeInfoRes.json();
          const storeEmail = storeInfoData && storeInfoData.data && storeInfoData.data.email;
          const storeName = storeInfoData && storeInfoData.data && storeInfoData.data.name;
          console.log('[SALLA_WELCOME] بيانات المتجر وصلت — الإيميل:', storeEmail || '(فاضي)', '- الاسم:', storeName || '(فاضي)');
          if (storeEmail) {
            await sendEmail({
              to: storeEmail,
              subject: 'أهلاً فيك مع وصّاف 🎉',
              html: buildSallaWelcomeEmailHtml({ storeName })
            });
            console.log('[SALLA_WELCOME] ✓ بريد الترحيب انرسل بنجاح لـ:', storeEmail);
          } else {
            console.log('[SALLA_WELCOME] ✗ ما فيه إيميل بالرد — ما قدرنا نرسل بريد ترحيب');
          }
        } else {
          console.log('[SALLA_WELCOME] ✗ فشل جلب بيانات المتجر — رمز الحالة:', storeInfoRes.status);
        }
      } catch (mailErr) {
        console.log('[SALLA_WELCOME] ✗ صار استثناء أثناء المحاولة:', mailErr.message);
        // فشل جلب الإيميل أو إرسال بريد الترحيب ما يوقف تخزين التوكن الأساسي — العملية الأهم نجحت فعلاً
      }

      res.status(200).json({ ok: true });
      return;
    }

    // [إضافة جديدة] اشتراك تاجر جديد بباقة مدفوعة عبر فوترة سلة الأصلية — نفعّل الباقة فوراً
    if (event === 'app.subscription.started') {
      const planNameRaw = (data && data.plan_name || '').toString().trim();
      const mapped = SALLA_PLAN_MAP[planNameRaw];

      if (!mapped) {
        // اسم باقة ما نعرفه — نسجله للمراجعة اليدوية بدل ما نتجاهله بصمت (نفس نمط pending:notify بالأعلى)
        await redisCommand(['HSET', 'pending:review_salla_plan', String(merchant), JSON.stringify({
          merchant,
          planNameRaw,
          subscriptionId: data && data.subscription_id,
          receivedAt: new Date().toISOString()
        })]);
        res.status(200).json({ ok: true, needsReview: true });
        return;
      }

      const record = {
        plan: mapped.plan,
        cap: mapped.cap,
        active: true,
        sallaPlanName: planNameRaw,
        subscriptionId: data && data.subscription_id,
        startDate: data && data.start_date,
        endDate: data && data.end_date,
        updatedAt: new Date().toISOString()
      };
      await redisCommand(['SET', `salla_subscription:${merchant}`, JSON.stringify(record)]);
      res.status(200).json({ ok: true });
      return;
    }

    // [إضافة جديدة] التاجر ألغى التجديد — الاشتراك يفضل شغّال لين نهاية الفترة المدفوعة (نفس منطق Lemon Squeezy فوق)
    // ما نطفّي شي هنا؛ التعطيل الفعلي يصير بحدث app.subscription.expired لمّن الفترة تخلص فعلياً
    if (event === 'app.subscription.canceled') {
      res.status(200).json({ ok: true, noted: 'will deactivate on expiry' });
      return;
    }

    // [إضافة جديدة] انتهت الفترة المدفوعة فعلياً — نطفّي الباقة
    if (event === 'app.subscription.expired') {
      const raw = await redisCommand(['GET', `salla_subscription:${merchant}`]);
      if (raw) {
        let parsed;
        try {
          parsed = JSON.parse(raw);
        } catch (e) {
          parsed = null;
        }
        if (parsed) {
          parsed.active = false;
          parsed.deactivatedAt = new Date().toISOString();
          await redisCommand(['SET', `salla_subscription:${merchant}`, JSON.stringify(parsed)]);
        }
      }
      res.status(200).json({ ok: true, deactivated: true });
      return;
    }

    // [إضافة جديدة] فك تثبيت التطبيق — نحذف كل بيانات التاجر فوراً (رمز الوصول، رمز التحديث، حالة الاشتراك)
    // هذا يضمن ما نحتفظ بأي بيانات وصول لمتجر بعد ما التاجر يفك التثبيت، بدون فترة انتظار
    if (event === 'app.uninstalled') {
      await redisCommand(['DEL', `salla_store:${merchant}`]);
      await redisCommand(['DEL', `salla_subscription:${merchant}`]);
      console.log('[SALLA_UNINSTALL] حذفنا بيانات المتجر رقم', merchant, 'بنجاح بعد فك التثبيت');
      res.status(200).json({ ok: true, deleted: true });
      return;
    }

    // [مكان جاهز للتوسعة] أحداث سلة الثانية (تركيب، إلغاء تركيب، تحديث منتج) تنضاف هنا مستقبلاً
    res.status(200).json({ ok: true, ignored: event || 'unknown' });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
}

// ==================== [إضافة جديدة] استقبال أحداث اشتراك زد ====================
// رابط الاستقبال المسجّل بلوحة شركاء زد: https://www.wassaf.space/api/webhook?source=zid
// موثّق رسمياً بـdocs.zid.sa/events — كل حدث يوصل ببيانات غنية (store_id, plan_name, plan_type, amount_paid...)

// [إضافة جديدة] خريطة أسماء الباقات المسجّلة بلوحة شركاء زد → الحد الشهري والاسم الداخلي
// ⚠️ لازم تطابق بالضبط أسماء الباقات اللي هتكتبونها حرفياً بخطوة "إدارة الخطط" بلوحة شركاء زد
const ZID_PLAN_MAP = {
  'أسبوعي': { plan: 'أسبوعي', cap: 20 },
  'شهري': { plan: 'شهري', cap: 120 },
  'نصف سنوي': { plan: 'نصف سنوي', cap: 180 },
  'سنوي': { plan: 'سنوي', cap: 300 }
};

async function handleZidWebhook(req, res) {
  try {
    // [إضافة جديدة] تحقق بسيط من سر مشترك — يمنع أي طرف غير زد يرسل إشعار اشتراك مزيّف
    // القيمة لازم تطابق بالضبط اللي بتحطها بحقل "العناوين" بلوحة شركاء زد (Header: X-Wassaf-Secret)
    const expectedSecret = process.env.ZID_WEBHOOK_SECRET;
    if (expectedSecret && req.headers['x-wassaf-secret'] !== expectedSecret) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const rawBody = await readRawBody(req);
    let payload;
    try {
      payload = JSON.parse(rawBody);
    } catch (e) {
      res.status(400).json({ error: 'Invalid JSON' });
      return;
    }

    const event = payload.event_name;
    const storeId = payload.store_id;
    const planNameRaw = (payload.plan_name || '').toString().trim();

    if (!storeId) {
      res.status(400).json({ error: 'store_id مفقود' });
      return;
    }

    // [إضافة جديدة] تفعيل الاشتراك — يشمل التثبيت الأول والتفعيل بعد الدفع، نفس المعالجة للاثنين
    if (event === 'app.market.subscription.active' || event === 'app.market.subscription.renew' || event === 'app.market.subscription.upgrade') {
      const mapped = ZID_PLAN_MAP[planNameRaw];

      if (!mapped) {
        // اسم باقة ما نعرفه — نسجله للمراجعة اليدوية بدل ما نتجاهله بصمت (نفس نمط سلة)
        await redisCommand(['HSET', 'pending:review_zid_plan', String(storeId), JSON.stringify({
          storeId,
          planNameRaw,
          eventName: event,
          amountPaid: payload.amount_paid,
          receivedAt: new Date().toISOString()
        })]);
        res.status(200).json({ ok: true, needsReview: true });
        return;
      }

      const record = {
        plan: mapped.plan,
        cap: mapped.cap,
        active: true,
        zidPlanName: planNameRaw,
        planType: payload.plan_type, // "Paid" أو "Free Trial"
        planId: payload.plan_id,
        startDate: payload.start_date,
        endDate: payload.end_date,
        amountPaid: payload.amount_paid,
        merchantEmail: payload.merchant_email,
        updatedAt: new Date().toISOString()
      };
      await redisCommand(['SET', `zid_subscription:${storeId}`, JSON.stringify(record)]);
      res.status(200).json({ ok: true });
      return;
    }

    // [إضافة جديدة] تعليق أو انتهاء الاشتراك — نطفّي الباقة
    if (event === 'app.market.subscription.suspended' || event === 'app.market.subscription.expired') {
      const raw = await redisCommand(['GET', `zid_subscription:${storeId}`]);
      if (raw) {
        let parsed;
        try {
          parsed = JSON.parse(raw);
        } catch (e) {
          parsed = null;
        }
        if (parsed) {
          parsed.active = false;
          parsed.deactivatedAt = new Date().toISOString();
          await redisCommand(['SET', `zid_subscription:${storeId}`, JSON.stringify(parsed)]);
        }
      }
      res.status(200).json({ ok: true, deactivated: true });
      return;
    }

    // [إضافة جديدة] إلغاء تثبيت التطبيق — نطفّي الباقة (نفس منطق الإيقاف، احتياط إضافي)
    if (event === 'app.market.application.uninstall') {
      const raw = await redisCommand(['GET', `zid_subscription:${storeId}`]);
      if (raw) {
        let parsed;
        try {
          parsed = JSON.parse(raw);
        } catch (e) {
          parsed = null;
        }
        if (parsed) {
          parsed.active = false;
          parsed.deactivatedAt = new Date().toISOString();
          parsed.uninstalled = true;
          await redisCommand(['SET', `zid_subscription:${storeId}`, JSON.stringify(parsed)]);
        }
      }
      res.status(200).json({ ok: true, uninstalled: true });
      return;
    }

    // [مكان جاهز للتوسعة] أحداث زد الثانية (تقييم، طلب باقة خاصة، رفض دفع) تنضاف هنا مستقبلاً
    res.status(200).json({ ok: true, ignored: event || 'unknown' });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
}

// ==================== [إضافة جديدة] تسجيل دخول تاجر زد (OAuth) — عنوانين مسجّلين بلوحة شركاء زد ====================
// عنوان إعادة التوجيه: https://www.wassaf.space/api/webhook?source=zid&step=install
// عنوان URL للرد (Callback):  https://www.wassaf.space/api/webhook?source=zid&step=callback

// [إضافة جديدة] خطوة 1: التاجر يضغط "تثبيت" بمتجر تطبيقات زد، وزد توديه لهنا — نحوّله فوراً لصفحة موافقة الصلاحيات الرسمية بزد
async function handleZidInstallRedirect(req, res) {
  const clientId = process.env.ZID_CLIENT_ID;
  if (!clientId) {
    res.status(500).send('ZID_CLIENT_ID غير مُعد بإعدادات Vercel');
    return;
  }
  const redirectUri = 'https://www.wassaf.space/api/webhook?source=zid&step=callback';
  const authorizeUrl = `https://oauth.zid.sa/oauth/authorize?client_id=${encodeURIComponent(clientId)}&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=code`;
  res.writeHead(302, { Location: authorizeUrl });
  res.end();
}

// دالة مساعدة صغيرة: تفك جزء الـpayload من توكن JWT (بدون تحقق توقيع — نستخدمها بس لقراءة رقم المتجر "sub")
function decodeJwtPayload(jwt) {
  try {
    const parts = jwt.replace(/^Bearer\s+/i, '').split('.');
    if (parts.length < 2) return null;
    const payload = Buffer.from(parts[1], 'base64url').toString('utf8');
    return JSON.parse(payload);
  } catch (e) {
    return null;
  }
}

// [إضافة جديدة] خطوة 2: زد ترجّع التاجر هنا مع "code" بعد ما يوافق — نبادله بتوكن حقيقي ونخزّنه
async function handleZidOAuthCallback(req, res) {
  const code = req.query && req.query.code;
  if (!code) {
    res.status(400).send('رمز التفويض (code) مفقود من طلب زد');
    return;
  }

  const clientId = process.env.ZID_CLIENT_ID;
  const clientSecret = process.env.ZID_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    res.status(500).send('ZID_CLIENT_ID أو ZID_CLIENT_SECRET غير معدّين بإعدادات Vercel');
    return;
  }

  const redirectUri = 'https://www.wassaf.space/api/webhook?source=zid&step=callback';

  try {
    const tokenRes = await fetch('https://oauth.zid.sa/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: redirectUri,
        code
      })
    });
    const tokenData = await tokenRes.json();

    if (!tokenRes.ok || !tokenData.access_token) {
      res.status(502).send('فشل تبادل رمز التفويض بتوكن — تحقق من صحة ZID_CLIENT_SECRET');
      return;
    }

    // [إصلاح جوهري نهائي] بعد تفعيل صلاحيات الحساب الإضافية، تأكدنا إن مسار بيانات الحساب
    // (managers/account/profile) يرجع رقم المتجر الحقيقي مباشرة بحقل user.store.id — هذا مسار موثوق
    // لأي متجر (خلاف محاولة تخمين رقم المتجر من مسار المنتجات اللي يحتاج Store-Id من الأساس)
    const decoded = decodeJwtPayload(tokenData.authorization || tokenData.access_token || '');
    const subFallback = decoded && decoded.sub;

    let storeId = null;
    try {
      const profileRes = await fetch('https://api.zid.sa/v1/managers/account/profile', {
        headers: {
          'Authorization': `Bearer ${tokenData.authorization}`,
          'x-manager-token': tokenData.access_token,
          'Accept-Language': 'ar'
        }
      });
      if (profileRes.ok) {
        const profileData = await profileRes.json();
        const realId = profileData && profileData.user && profileData.user.store && profileData.user.store.id;
        if (realId) storeId = String(realId);
      }
    } catch (e) { /* نكمل على الحل الاحتياطي تحت */ }

    // لو ما قدرنا نكتشف رقم المتجر الحقيقي تلقائياً لأي سبب، نرجع لـsub كحل احتياطي مؤقت
    if (!storeId) storeId = subFallback;

    if (!storeId) {
      // [تشخيص مؤقت] نعرض الرد الخام من زد وناتج فك التوكن مباشرة بالصفحة، عشان نشوف شكله الحقيقي ونصلح القراءة بدون تخمين — نحذف هذا بعد ما نحل المشكلة
      const debugInfo = {
        tokenDataKeys: Object.keys(tokenData || {}),
        tokenData: tokenData,
        decoded: decoded
      };
      res.status(502).send(`<pre dir="ltr" style="white-space:pre-wrap;font-family:monospace;padding:20px;">تعذر تحديد رقم المتجر — هذا الرد الفعلي من زد:\n\n${JSON.stringify(debugInfo, null, 2)}</pre>`);
      return;
    }

    await redisCommand(['SET', `zid_store:${storeId}`, JSON.stringify({
      accessToken: tokenData.access_token,
      authorizationToken: tokenData.authorization || null,
      refreshToken: tokenData.refresh_token || null,
      expiresIn: tokenData.expires_in || null,
      installedAt: new Date().toISOString()
    })]);

    // [إضافة جديدة] خطوة ٣ من دليل Embedded Apps الرسمي لزد — نولّد UUID ونسجّله عند زد،
    // عشان زد ترسله لنا تلقائياً بالـiframe URL كل مرة التاجر يفتح التطبيق (بدل الاعتماد على إدخال يدوي)
    const embeddedUuid = crypto.randomUUID();
    let registrationOk = false;
    try {
      const regRes = await fetch('https://api.zid.sa/v1/managers/embedded-apps-token', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${tokenData.authorization}`,
          'x-manager-token': tokenData.access_token,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ token: embeddedUuid })
      });
      registrationOk = regRes.ok;
    } catch (e) {
      registrationOk = false;
    }

    if (registrationOk) {
      // نربط الـUUID برقم المتجر عشان مسار step=embedded يقدر يدور عليه لما زد ترسله بالـiframe
      await redisCommand(['SET', `zid_embedded_token:${embeddedUuid}`, storeId]);
    }

    // نرجّع التاجر لصفحة نجاح بسيطة — يقدر يقفلها ويرجع للوحة زد
    res.status(200).send(`<!DOCTYPE html><html lang="ar" dir="rtl"><head><meta charset="UTF-8"><title>تم التفعيل</title></head>
      <body style="font-family:sans-serif;text-align:center;padding:60px 20px;">
        <h2 style="color:#16A34A;">✓ تم ربط وصّاف بمتجرك بنجاح</h2>
        <p>تقدر ترجع للوحة تحكم زد وتفتح التطبيق من هناك.</p>
        ${!registrationOk ? '<p style="color:#E8664A;font-size:13px;">ملاحظة: تسجيل التوصيل التلقائي ما اكتمل، بس التطبيق يشتغل عادي — لو ما ظهرت منتجاتك تلقائياً، أدخل رقم متجرك يدوياً مرة وحدة.</p>' : ''}
      </body></html>`);
  } catch (err) {
    res.status(500).send('صار خطأ أثناء تفعيل التطبيق، حاول مرة ثانية أو تواصل معنا');
  }
}

// [إضافة جديدة] خطوة ٦ من دليل Embedded Apps — هذا هو "Application URL" الثابت اللي نحدده بلوحة تطوير زد.
// زد تفتحه تلقائياً بالـiframe مع ?token=<UUID> كل مرة التاجر يفتح التطبيق من لوحته، بدون أي إدخال يدوي.
async function handleZidEmbeddedEntry(req, res) {
  const token = (req.query && req.query.token || '').toString().trim();
  if (!token) {
    res.status(400).send('رابط غير صالح — رجاءً افتح التطبيق من لوحة تحكم زد.');
    return;
  }
  const storeId = await redisCommand(['GET', `zid_embedded_token:${token}`]);
  if (!storeId) {
    res.status(404).send(`<!DOCTYPE html><html lang="ar" dir="rtl"><head><meta charset="UTF-8"><title>يحتاج إعادة تثبيت</title></head>
      <body style="font-family:sans-serif;text-align:center;padding:60px 20px;">
        <h2>الرابط منتهي أو غير معروف</h2>
        <p>جرب تفك تثبيت التطبيق من متجرك وتعيد تثبيته من جديد.</p>
      </body></html>`);
    return;
  }
  // نمرّر رقم المتجر لموقعنا الرئيسي عبر معامل الرابط — index.html أصلاً يقرأ هذا المعامل تلقائياً (محاولة الكشف رقم ١)
  res.writeHead(302, { Location: `https://www.wassaf.space/?store_id=${encodeURIComponent(storeId)}` });
  res.end();
}
