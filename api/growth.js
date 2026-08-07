const { checkAccessCode, addReferralBonus, incrementUsage } = require('./_access');
const { redisCommand } = require('./_redis');

// نسبة المكافأة من حد باقة المحيل الرئيسية (50%) — تُحسب ديناميكياً حسب باقة كل محيل
const REFERRAL_BONUS_RATIO = 0.5;
// مدة بقاء رابط المشاركة (30 يوم)
const SHARE_TTL_SECONDS = 30 * 24 * 60 * 60;

function generateShareId() {
  return Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-4);
}

// يولّد (أو يرجّع الموجود) توكن إحالة عشوائي مربوط بالكود — بدون ما يكشف الكود نفسه بالرابط المُشارك
async function getOrCreateReferralToken(accessCode) {
  const ownerKey = `reftoken_owner_by_code:${accessCode}`;
  const existing = await redisCommand(['GET', ownerKey]);
  if (existing) return existing;

  const token = Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
  await redisCommand(['SET', ownerKey, token]);
  await redisCommand(['SET', `reftoken_owner:${token}`, accessCode]);
  return token;
}

// ---------- بيانات الحساب: الباقة، الاستخدام، كود وعداد الإحالة ----------
async function handleAccountInfo(body, res) {
  const accessCode = (body.accessCode || '').toString().trim().toUpperCase();
  const deviceId = (body.deviceId || '').toString().trim();

  if (!accessCode) {
    res.status(400).json({ error: 'أدخل كود الوصول' });
    return;
  }

  const result = await checkAccessCode(accessCode, deviceId);
  if (!result.ok && result.reason !== 'exhausted') {
    res.status(200).json({ valid: false, message: 'كود الوصول غير صحيح' });
    return;
  }

  const referralCount = parseInt((await redisCommand(['GET', `referral_count:${accessCode}`])) || '0', 10);
  const referralToken = await getOrCreateReferralToken(accessCode);
  const cap = result.cap;
  const used = typeof result.used === 'number' ? result.used : (cap - (result.remaining || 0));
  const remaining = typeof result.remaining === 'number' ? result.remaining : Math.max(cap - used, 0);
  const estimatedReferralBonus = Math.max(Math.round(cap * REFERRAL_BONUS_RATIO), 3);

  res.status(200).json({
    valid: true,
    plan: result.plan || 'عام',
    cap,
    used,
    remaining,
    referralToken,
    referralCount,
    estimatedReferralBonus
  });
}

// ---------- تطبيق مكافأة الإحالة على الطرفين ----------
async function handleApplyReferral(body, res) {
  const newAccessCode = (body.newAccessCode || '').toString().trim().toUpperCase();
  const referrerToken = (body.referrerToken || '').toString().trim();

  if (!newAccessCode || !referrerToken) {
    res.status(400).json({ error: 'بيانات الإحالة ناقصة' });
    return;
  }

  const referrerCode = await redisCommand(['GET', `reftoken_owner:${referrerToken}`]);
  if (!referrerCode) {
    res.status(404).json({ error: 'رابط الإحالة غير صالح' });
    return;
  }

  if (newAccessCode === referrerCode) {
    res.status(400).json({ error: 'ما تقدر تحيل نفسك بنفسك' });
    return;
  }

  const guardKey = `referral_applied:${newAccessCode}`;
  const guardResult = await redisCommand(['SET', guardKey, referrerCode, 'NX']);
  if (guardResult !== 'OK') {
    res.status(200).json({ ok: true, alreadyApplied: true });
    return;
  }

  const referrerData = await redisCommand(['GET', `code:${referrerCode}`]);
  if (!referrerData) {
    await redisCommand(['DEL', guardKey]);
    res.status(404).json({ error: 'كود الإحالة غير موجود' });
    return;
  }

  let referrerParsed;
  try {
    referrerParsed = JSON.parse(referrerData);
  } catch (e) {
    await redisCommand(['DEL', guardKey]);
    res.status(500).json({ error: 'بيانات كود الإحالة تالفة' });
    return;
  }

  const referrerCap = referrerParsed.cap || 0;
  const bonus = Math.max(Math.round(referrerCap * REFERRAL_BONUS_RATIO), 3);

  const referredResult = await addReferralBonus(newAccessCode, bonus);
  const referrerResult = await addReferralBonus(referrerCode, bonus);
  await redisCommand(['INCR', `referral_count:${referrerCode}`]);

  res.status(200).json({
    ok: true,
    referredNewCap: referredResult.newCap,
    referrerNewCap: referrerResult.newCap,
    bonus
  });
}

// ---------- إنشاء رابط مشاركة ----------
async function handleCreateShare(body, res) {
  const productName = (body.productName || '').toString().trim().slice(0, 200);
  const long = (body.long || '').toString().trim().slice(0, 4000);
  const short = (body.short || '').toString().trim().slice(0, 1000);
  const seo = (body.seo || '').toString().trim().slice(0, 300);

  if (!long && !short) {
    res.status(400).json({ error: 'ما فيه نص نشاركه' });
    return;
  }

  const shareId = generateShareId();
  const payload = JSON.stringify({ productName, long, short, seo, createdAt: Date.now() });
  await redisCommand(['SET', `share:${shareId}`, payload, 'EX', SHARE_TTL_SECONDS]);

  res.status(200).json({ ok: true, shareId, url: `/share.html?id=${shareId}` });
}

// ---------- جلب بيانات رابط مشاركة ----------
async function handleGetShare(body, res) {
  const id = (body.id || '').toString().trim();
  if (!id) {
    res.status(400).json({ error: 'معرّف غير صحيح' });
    return;
  }

  const raw = await redisCommand(['GET', `share:${id}`]);
  if (!raw) {
    res.status(404).json({ error: 'الرابط منتهي أو غير موجود' });
    return;
  }

  let data;
  try {
    data = JSON.parse(raw);
  } catch (e) {
    res.status(500).json({ error: 'بيانات تالفة' });
    return;
  }

  res.status(200).json({ ok: true, ...data });
}

// ==================== [إضافة جديدة] تكامل سلة — قراءة المنتجات وتوليد وصف وكتابته رجوع ====================
// ملاحظة تصميم: هذي مرحلة تجريبية، ما تستهلك من رصيد كود الوصول العادي حالياً — تُربط بنظام الاشتراك لاحقاً عند الإطلاق الفعلي

const SALLA_TOKEN_URL = 'https://accounts.salla.sa/oauth2/token';

// ---------- سلة: فك توكن الصفحة المضمنة (Embedded Page) مباشرة ----------
// [مهم] توكن v4.public موقّع فقط (Signed)، مو مشفّر — بياناته نص عادي مقروء بمجرد فك base64.
// اكتشفنا هذا بعد ما جربنا استدعاء introspect API الرسمي وطلع "Decryption failed" — لأنه غير مخصص لهالنوع من التوكن أصلاً.
// [تنويه أمني مهم] هذا الفك حالياً بدون تحقق من التوقيع (Signature) — يعني أي شخص يقدر نظرياً يزوّر توكن ببيانات مزيّفة.
// قبل أي استخدام حقيقي مع تجار فعليين، لازم نضيف تحقق توقيع Ed25519 باستخدام المفتاح العام لسلة (خطوة أمنية لاحقة، مو منفّذة الآن).
function decodeSallaEmbeddedToken(token) {
  const parts = token.split('.');
  if (parts.length < 3 || parts[0] !== 'v4' || parts[1] !== 'public') {
    return null;
  }
  const payloadB64 = parts[2];
  try {
    const raw = Buffer.from(payloadB64, 'base64url');
    // آخر 64 بايت هي توقيع Ed25519 المرفق بنفس الكتلة — الباقي قبلها هو الـJSON الفعلي
    const messageBytes = raw.subarray(0, raw.length - 64);
    const parsed = JSON.parse(messageBytes.toString('utf8'));
    return parsed;
  } catch (e) {
    return null;
  }
}

async function handleSallaIntrospectToken(body, res) {
  const token = (body.token || '').toString().trim();
  if (!token) {
    res.status(400).json({ error: 'توكن الصفحة المضمنة مفقود' });
    return;
  }

  const decoded = decodeSallaEmbeddedToken(token);
  if (!decoded || !decoded.data || !decoded.data.merchant_id) {
    res.status(422).json({ error: 'تعذر قراءة توكن سلة', detail: decoded });
    return;
  }

  // تحقق بسيط من انتهاء الصلاحية (exp) — التوكن نفسه يحمل وقت انتهاء صريح
  if (decoded.exp) {
    const expDate = new Date(decoded.exp);
    if (!isNaN(expDate.getTime()) && expDate.getTime() < Date.now()) {
      res.status(401).json({ error: 'انتهت صلاحية جلستك، أعد فتح الأداة من لوحة سلة' });
      return;
    }
  }

  res.status(200).json({ ok: true, merchant: String(decoded.data.merchant_id) });
}
// [مهم] لم أجد تأكيد 100% حرفي لهذا المسار بتوثيق سلة النصي رغم البحث، بس هو المسار القياسي بمعيار OAuth2
// وهو نفس القاعدة اللي عليها رابط التفويض المؤكد (accounts.salla.sa/oauth2/auth). أول اختبار فعلي يثبته أو ينفيه.

// نجدد التوكن قبل انتهائه بـ5 دقايق احتياطية (300 ثانية) بدل ما ننتظر لين اللحظة الأخيرة بالضبط
const TOKEN_REFRESH_MARGIN_SECONDS = 300;

async function refreshSallaToken(merchant, store) {
  const clientId = process.env.SALLA_CLIENT_ID;
  const clientSecret = process.env.SALLA_CLIENT_SECRET;

  if (!clientId || !clientSecret || !store.refreshToken) {
    return null;
  }

  try {
    const response = await fetch(SALLA_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: store.refreshToken,
        client_id: clientId,
        client_secret: clientSecret
      }).toString()
    });

    if (!response.ok) {
      return null;
    }

    const data = await response.json();
    if (!data.access_token) {
      return null;
    }

    // [مهم] سلة توثيقها يقول صراحة: لازم نستخدم آخر refresh_token يرجع لنا بكل مرة — نحدّثه كامل، مو بس access_token
    const updatedStore = {
      ...store,
      accessToken: data.access_token,
      refreshToken: data.refresh_token || store.refreshToken,
      expiresAt: Math.floor(Date.now() / 1000) + (data.expires_in || 7200),
      refreshedAt: new Date().toISOString()
    };

    await redisCommand(['SET', `salla_store:${merchant}`, JSON.stringify(updatedStore)]);
    return updatedStore;
  } catch (e) {
    return null;
  }
}

// يرجّع توكن صالح للاستخدام دايماً — يجدده تلقائياً بالخلفية لو قرب ينتهي أو انتهى فعلاً
async function getSallaStoreToken(merchant) {
  const raw = await redisCommand(['GET', `salla_store:${merchant}`]);
  if (!raw) return null;

  let store;
  try {
    store = JSON.parse(raw);
  } catch (e) {
    return null;
  }

  const nowSeconds = Math.floor(Date.now() / 1000);
  const isExpiringSoon = !store.expiresAt || (store.expiresAt - nowSeconds) <= TOKEN_REFRESH_MARGIN_SECONDS;

  if (isExpiringSoon) {
    const refreshed = await refreshSallaToken(merchant, store);
    if (refreshed) return refreshed;
    // فشل التحديث (يمكن refresh token نفسه انتهى بعد شهر) — نرجّع القديم ونخلي الخطوة اللي بعده تتعامل مع الخطأ
    return store;
  }

  return store;
}

// ---------- سلة: جلب قائمة منتجات المتجر ----------
async function handleSallaListProducts(body, res) {
  const merchant = (body.merchant || '').toString().trim();
  if (!merchant) {
    res.status(400).json({ error: 'رقم المتجر مطلوب' });
    return;
  }

  const store = await getSallaStoreToken(merchant);
  if (!store) {
    res.status(404).json({ error: 'المتجر غير مربوط بوصّاف — تأكد التطبيق مثبّت' });
    return;
  }

  try {
    const response = await fetch('https://api.salla.dev/admin/v2/products?per_page=50', {
      headers: { Authorization: `Bearer ${store.accessToken}` }
    });
    const data = await response.json();
    if (!response.ok) {
      // 401 هنا غالباً معناه التوكن انتهى (صلاحيته ساعتين بس) — لسا ما بنينا آلية تحديث تلقائي، نوضحها كخطوة تالية
      res.status(response.status).json({ error: 'تعذر جلب المنتجات من سلة — يمكن التوكن منتهي', detail: data });
      return;
    }
    const products = (data.data || []).map((p) => ({
      id: p.id,
      name: p.name,
      price: p.price && p.price.amount,
      currentDescription: p.description || ''
    }));
    res.status(200).json({ ok: true, products });
  } catch (err) {
    res.status(500).json({ error: 'صار خطأ أثناء الاتصال بسلة' });
  }
}

// ---------- سلة: توليد وصف واحد متكامل لمنتج محدد ----------
async function handleSallaGenerateDescription(body, res) {
  const productName = (body.productName || '').toString().trim();
  const features = (body.features || '').toString().trim();
  const price = (body.price || '').toString().trim();
  const accessCode = (body.accessCode || '').toString().trim().toUpperCase();
  const deviceId = (body.deviceId || '').toString().trim();

  if (!productName) {
    res.status(400).json({ error: 'اسم المنتج مطلوب' });
    return;
  }

  // [إضافة] ربط الميزة برصيد كود الوصول العادي — نفس منطق generate.js بالضبط، بدل ما تكون مجانية بلا حدود
  if (!accessCode) {
    res.status(401).json({ error: 'أدخل كود الوصول أول عشان تقدر تولّد', code: 'NO_ACCESS_CODE' });
    return;
  }

  let accessCheck;
  try {
    accessCheck = await checkAccessCode(accessCode, deviceId);
  } catch (e) {
    res.status(500).json({ error: 'صار خطأ بالتحقق من الكود، جرب مرة ثانية بعد شوي' });
    return;
  }

  if (!accessCheck.ok) {
    if (accessCheck.reason === 'exhausted') {
      res.status(403).json({
        error: `خلصت حصتك الشهرية (${accessCheck.cap} وصف). جدد اشتراكك أو تواصل معنا لترقية باقتك.`,
        code: 'QUOTA_EXHAUSTED'
      });
    } else if (accessCheck.reason === 'device_mismatch') {
      res.status(403).json({
        error: 'هذا الكود مستخدم فعلاً بجهاز ثاني. تواصل معنا لو غيّرت جهازك.',
        code: 'DEVICE_MISMATCH'
      });
    } else {
      res.status(403).json({ error: 'كود الوصول غير صحيح، تأكد منه أو تواصل معنا', code: 'INVALID_CODE' });
    }
    return;
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    res.status(500).json({ error: 'Server misconfigured' });
    return;
  }

  const systemPrompt = 'أنت كاتب محتوى تسويقي محترف، تكتب وصف منتج واحد متكامل بالعربي (فصحى سهلة)، جاهز للنشر مباشرة بمتجر إلكتروني سعودي. اكتب فقرة أو فقرتين، أسلوب مقنع يبرز الفائدة، بدون عناوين أو تنسيق HTML زائد. أجب بالنص فقط بدون أي مقدمة.';
  const userPrompt = `اسم المنتج: ${productName}\nالمميزات: ${features || 'غير محددة'}${price ? `\nالسعر: ${price}` : ''}`;

  try {
    const aiResponse = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 600,
        system: systemPrompt,
        messages: [{ role: 'user', content: userPrompt }]
      })
    });

    if (!aiResponse.ok) {
      res.status(502).json({ error: 'تعذر التوليد الآن، جرب بعد شوي' });
      return;
    }

    const data = await aiResponse.json();
    const text = (data.content || [])
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('\n')
      .trim();

    // التوليد نجح فعلياً هنا — الحين بس نحسبه على رصيد الكود
    let remainingAfter = accessCheck.remaining - 1;
    try {
      await incrementUsage(accessCheck.usageKey);
    } catch (e) {
      remainingAfter = accessCheck.remaining - 1;
    }

    res.status(200).json({
      ok: true,
      description: text || 'ما رجع نص، جرب مرة ثانية.',
      remaining: remainingAfter,
      cap: accessCheck.cap
    });
  } catch (err) {
    res.status(500).json({ error: 'صار خطأ أثناء التوليد' });
  }
}

// ---------- سلة: كتابة الوصف رجوع بالمنتج مباشرة ----------
async function handleSallaWriteBack(body, res) {
  const merchant = (body.merchant || '').toString().trim();
  const productId = (body.productId || '').toString().trim();
  const description = (body.description || '').toString().trim();

  if (!merchant || !productId || !description) {
    res.status(400).json({ error: 'بيانات ناقصة' });
    return;
  }

  const store = await getSallaStoreToken(merchant);
  if (!store) {
    res.status(404).json({ error: 'المتجر غير مربوط بوصّاف' });
    return;
  }

  try {
    const response = await fetch(`https://api.salla.dev/admin/v2/products/${productId}`, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${store.accessToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ description })
    });
    const data = await response.json();
    if (!response.ok) {
      res.status(response.status).json({ error: 'تعذر تحديث المنتج بسلة', detail: data });
      return;
    }
    res.status(200).json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'صار خطأ أثناء الكتابة رجوع' });
  }
}

// نقطة دخول واحدة لكل ميزات النمو (حساب، إحالة، مشاركة، تكامل سلة) — تفادياً لتجاوز حد الـ12 Serverless Function بباقة Vercel المجانية
module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  try {
    const body = req.body || {};
    const action = (body.action || '').toString().trim();

    switch (action) {
      case 'account_info':
        await handleAccountInfo(body, res);
        break;
      case 'apply_referral':
        await handleApplyReferral(body, res);
        break;
      case 'create_share':
        await handleCreateShare(body, res);
        break;
      case 'get_share':
        await handleGetShare(body, res);
        break;
      case 'salla_list_products':
        await handleSallaListProducts(body, res);
        break;
      case 'salla_generate_description':
        await handleSallaGenerateDescription(body, res);
        break;
      case 'salla_write_back':
        await handleSallaWriteBack(body, res);
        break;
      case 'salla_introspect_token':
        await handleSallaIntrospectToken(body, res);
        break;
      default:
        res.status(400).json({ error: 'action غير معروف' });
    }
  } catch (err) {
    res.status(500).json({ error: 'صار خطأ، جرب مرة ثانية' });
  }
};
