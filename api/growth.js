const { checkAccessCode, addReferralBonus, incrementUsage, checkSallaMerchantSubscription, checkZidMerchantSubscription } = require('./_access');
const { redisCommand } = require('./_redis');
const { sendEmail } = require('./_email');
const {
  hashPassword, verifyPassword, isValidEmail, isStrongEnoughPassword,
  createSession, getSessionEmail, destroySession,
  parseCookies, setSessionCookie, clearSessionCookie, SESSION_COOKIE_NAME,
  createResetToken, consumeResetToken
} = require('./_auth');

// نسبة المكافأة من حد باقة المحيل الرئيسية (50%) — تُحسب ديناميكياً حسب باقة كل محيل
const REFERRAL_BONUS_RATIO = 0.5;
// مدة بقاء رابط المشاركة (30 يوم)
const SHARE_TTL_SECONDS = 30 * 24 * 60 * 60;

// ==================== [إضافة جديدة] منتجات زد — جلب القائمة وكتابة الوصف رجوع، بنفس فكرة سلة بالضبط ====================

// [مساعد] نداء موحّد لأي API عند زد، يجيب التوكن المخزّن للمتجر تلقائياً من Redis (بدل ما نكرر نفس الهيدرز بكل دالة)
// ⚠️ شكل الهيدرز مبني على أمثلة توثيق زد الرسمية (docs.zid.sa) — أول اختبار فعلي يثبته أو يحتاج تعديل بسيط
async function zidApiRequest(storeId, path, options = {}) {
  const raw = await redisCommand(['GET', `zid_store:${storeId}`]);
  if (!raw) {
    return { ok: false, notLinked: true };
  }
  let store;
  try {
    store = JSON.parse(raw);
  } catch (e) {
    return { ok: false, notLinked: true };
  }

  const response = await fetch(`https://api.zid.sa/v1${path}`, {
    method: options.method || 'GET',
    headers: {
      'Authorization': `Bearer ${store.accessToken}`,
      'X-Manager-Token': store.authorizationToken,
      'Store-Id': String(storeId),
      'Accept-Language': 'ar',
      'Content-Type': 'application/json',
      ...(options.headers || {})
    },
    body: options.body ? JSON.stringify(options.body) : undefined
  });

  let data;
  try {
    data = await response.json();
  } catch (e) {
    data = null;
  }
  return { ok: response.ok, status: response.status, data };
}

// [إضافة جديدة] يجيب قائمة منتجات متجر زد — تستخدمها index.html جوّا زد لعرض شبكة المنتجات (زي سلة بالضبط)
async function handleZidListProducts(body, res) {
  const storeId = (body.storeId || '').toString().trim();
  if (!storeId) {
    res.status(400).json({ error: 'رقم المتجر (storeId) مفقود' });
    return;
  }

  const result = await zidApiRequest(storeId, '/products/?page_size=30');
  if (result.notLinked) {
    res.status(401).json({ error: 'متجرك مو مربوط بوصّاف بعد — ثبّت التطبيق أول' });
    return;
  }
  if (!result.ok) {
    res.status(502).json({ error: 'تعذر جلب منتجات متجرك من زد', detail: result.data });
    return;
  }

  // [ملاحظة] شكل الاستجابة (results/data، وبنية الصور) مبني على النمط الشائع بتوثيق زد — نعدّله فور أول اختبار حقيقي لو اختلف
  const rawList = (result.data && (result.data.results || result.data.data)) || [];
  const products = rawList.map((p) => ({
    id: p.id,
    name: (p.name && (p.name.ar || p.name.en)) || p.name || '',
    price: p.price || p.formatted_price || '',
    image: (p.images && p.images[0] && p.images[0].image && p.images[0].image.url) || (p.thumbnail && p.thumbnail.url) || ''
  }));

  res.status(200).json({ ok: true, products });
}

// [إضافة جديدة] يكتب الوصف المولّد رجوع لمنتج بمتجر زد — نفس فكرة "اكتب رجوع بسلة"
async function handleZidWriteBack(body, res) {
  const storeId = (body.storeId || '').toString().trim();
  const productId = (body.productId || '').toString().trim();
  const description = (body.description || '').toString();

  if (!storeId || !productId || !description) {
    res.status(400).json({ error: 'بيانات ناقصة (رقم المتجر أو المنتج أو الوصف)' });
    return;
  }

  const result = await zidApiRequest(storeId, `/products/${productId}/`, {
    method: 'PATCH',
    body: { description: { ar: description } }
  });

  if (result.notLinked) {
    res.status(401).json({ error: 'متجرك مو مربوط بوصّاف بعد — ثبّت التطبيق أول' });
    return;
  }
  if (!result.ok) {
    res.status(502).json({ error: 'تعذر تحديث المنتج بمتجر زد', detail: result.data });
    return;
  }

  res.status(200).json({ ok: true });
}

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

// ---------- سلة: التحقق من توكن الصفحة المضمنة (Embedded Page) عبر introspect API الرسمي ----------
// [إصلاح الثغرة الأمنية] المحاولة القديمة فشلت برسالة "Decryption failed" لأنها كانت ناقصة:
// هيدر S-Source (App ID) وحقول env/iss/subject بجسم الطلب — بدونهم سلة ما تعرف تتحقق من التوكن.
// هذا نفس الاستدعاء بالضبط اللي تسويه مكتبة @salla.sa/embedded-sdk الرسمية داخلياً (دالة auth.introspect())،
// يعني سلة نفسها تتحقق من صحة وتوقيع التوكن — ما نحتاج نبني تحقق Ed25519 يدوي ولا نلقى مفتاح عام.
const SALLA_INTROSPECT_URL = 'https://api.salla.dev/exchange-authority/v1/introspect';
const SALLA_APP_ID = process.env.SALLA_APP_ID || '1137247101'; // App ID الثابت لتطبيق وصّاف برو

async function introspectSallaToken(token) {
  const response = await fetch(SALLA_INTROSPECT_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'S-Source': SALLA_APP_ID
    },
    body: JSON.stringify({
      env: 'prod',
      token,
      iss: 'merchant-dashboard',
      subject: 'embedded-page'
    })
  });
  const data = await response.json();
  return data; // شكلها المتوقع: { success: true/false, data: { merchant_id, ... } }
}

async function handleSallaIntrospectToken(body, res) {
  const token = (body.token || '').toString().trim();
  if (!token) {
    res.status(400).json({ error: 'توكن الصفحة المضمنة مفقود' });
    return;
  }

  try {
    const result = await introspectSallaToken(token);
    if (!result || !result.success || !result.data || !result.data.merchant_id) {
      res.status(422).json({ error: 'تعذر التحقق من توكن سلة', detail: result });
      return;
    }
    res.status(200).json({ ok: true, merchant: String(result.data.merchant_id) });
  } catch (e) {
    res.status(500).json({ error: 'صار خطأ أثناء التحقق من توكن سلة', detail: e.message });
  }
}
// [مهم] لم أجد تأكيد 100% حرفي لهذا المسار بتوثيق سلة النصي رغم البحث، بس هو المسار القياسي بمعيار OAuth2
// وهو نفس القاعدة اللي عليها رابط التفويض المؤكد (accounts.salla.sa/oauth2/auth). أول اختبار فعلي يثبته أو ينفيه.

// [إضافة جديدة] يرجّع حالة اشتراك تاجر سلة (الفوترة الأصلية) — تستخدمها index.html جوّا سلة
// بدل ما التاجر يكتب كود وصول يدوي، نجيب باقته تلقائياً بناءً على merchant_id اللي طلع من introspect
async function handleSallaSubscriptionStatus(body, res) {
  const merchant = (body.merchant || '').toString().trim();
  if (!merchant) {
    res.status(400).json({ error: 'رقم المتجر (merchant) مفقود' });
    return;
  }

  const result = await checkSallaMerchantSubscription(merchant);
  if (!result.ok && result.reason !== 'exhausted') {
    res.status(200).json({ ok: true, hasSubscription: false });
    return;
  }

  res.status(200).json({
    ok: true,
    hasSubscription: true,
    plan: result.plan || 'عام',
    cap: result.cap,
    used: typeof result.used === 'number' ? result.used : null,
    remaining: result.remaining ?? 0
  });
}

// [إضافة جديدة] نفس دالة سلة بالضبط، بس لتاجر زد — يستخدمها index.html جوّا زد
async function handleZidSubscriptionStatus(body, res) {
  const storeId = (body.storeId || '').toString().trim();
  if (!storeId) {
    res.status(400).json({ error: 'رقم المتجر (storeId) مفقود' });
    return;
  }

  const result = await checkZidMerchantSubscription(storeId);
  if (!result.ok && result.reason !== 'exhausted') {
    res.status(200).json({ ok: true, hasSubscription: false });
    return;
  }

  res.status(200).json({
    ok: true,
    hasSubscription: true,
    plan: result.plan || 'عام',
    cap: result.cap,
    used: typeof result.used === 'number' ? result.used : null,
    remaining: result.remaining ?? 0
  });
}

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
      currentDescription: p.description || '',
      image: (p.images && p.images[0] && (p.images[0].url || p.images[0].original)) || p.main_image || p.thumbnail || null
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
  const merchant = (body.merchant || '').toString().trim();

  if (!productName) {
    res.status(400).json({ error: 'اسم المنتج مطلوب' });
    return;
  }

  // [إضافة] تجربة مجانية 3 مرات للأبد لكل متجر — ما تحتاج كود وصول إطلاقاً
  const SALLA_TRIAL_LIMIT = 3;
  let usingTrial = false;
  let trialUsageKey = null;
  let trialUsedCount = 0;

  if (!accessCode) {
    if (!merchant) {
      res.status(400).json({ error: 'بيانات المتجر مفقودة' });
      return;
    }
    trialUsageKey = `salla_trial_used:${merchant}`;
    trialUsedCount = parseInt((await redisCommand(['GET', trialUsageKey])) || '0', 10);
    if (trialUsedCount >= SALLA_TRIAL_LIMIT) {
      res.status(403).json({
        error: `خلصت تجربتك المجانية (${SALLA_TRIAL_LIMIT} أوصاف). اشترك بأي باقة عشان تكمل التوليد.`,
        code: 'TRIAL_EXHAUSTED'
      });
      return;
    }
    usingTrial = true;
  }

  let accessCheck = null;
  if (!usingTrial) {
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
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    res.status(500).json({ error: 'Server misconfigured' });
    return;
  }

  const framework = (body.framework || 'AUTO').toString().trim().toUpperCase();
  const brandTone = (body.brandTone || '').toString().trim();

  const FRAMEWORK_LABELS = {
    AIDA: 'AIDA (انتباه، اهتمام، رغبة، فعل)',
    PAS: 'PAS (مشكلة، تحريض، حل)',
    BAB: 'BAB (قبل، بعد، جسر)'
  };
  const frameworkInstruction = (framework === 'AUTO' || !FRAMEWORK_LABELS[framework])
    ? `اختر أنت الإطار الأنسب لهذا المنتج من بين: ${FRAMEWORK_LABELS.AIDA}, ${FRAMEWORK_LABELS.PAS}, ${FRAMEWORK_LABELS.BAB}`
    : `استخدم إطار ${FRAMEWORK_LABELS[framework]} بالضبط.`;

  const systemPrompt = `أنت كاتب محتوى تسويقي محترف بالعربي، تكتب لمتاجر إلكترونية سعودية بسلة. بناءً على بيانات المنتج، اكتب 3 نسخ:
1. "long": وصف طويل متكامل (فقرتين لثلاث)، ${frameworkInstruction}
2. "short": نسخة قصيرة جداً (سطر أو سطرين) تصلح للسوشال ميديا
3. "seo": وصف محسّن لمحركات البحث (150-160 حرف تقريباً)، يحتوي كلمات مفتاحية طبيعية

${brandTone ? `نبرة العلامة التجارية المطلوبة: ${brandTone}` : 'استخدم فصحى سهلة احترافية.'}

أجب بصيغة JSON فقط بدون أي نص إضافي، بالضبط: {"long":"...","short":"...","seo":"..."}`;
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
        max_tokens: 1200,
        system: systemPrompt,
        messages: [{ role: 'user', content: userPrompt }]
      })
    });

    if (!aiResponse.ok) {
      res.status(502).json({ error: 'تعذر التوليد الآن، جرب بعد شوي' });
      return;
    }

    const data = await aiResponse.json();
    const rawText = (data.content || [])
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('\n')
      .trim();

    let parsed = null;
    try {
      const cleaned = rawText.replace(/^```(json)?/i, '').replace(/```$/i, '').trim();
      parsed = JSON.parse(cleaned);
    } catch (e) {
      const match = rawText.match(/\{[\s\S]*\}/);
      if (match) {
        try { parsed = JSON.parse(match[0]); } catch (e2) { parsed = null; }
      }
    }
    // احتياط: لو فك الـJSON فشل تماماً، نستخدم النص الخام كوصف طويل بدل ما نرجع فاضي
    if (!parsed) {
      parsed = { long: rawText, short: '', seo: '' };
    }

    // التوليد نجح فعلياً هنا — الحين بس نسجّله حسب المسار المستخدم
    let remainingAfter;
    let capValue;

    if (usingTrial) {
      const newTrialCount = trialUsedCount + 1;
      await redisCommand(['SET', trialUsageKey, String(newTrialCount)]);
      remainingAfter = SALLA_TRIAL_LIMIT - newTrialCount;
      capValue = SALLA_TRIAL_LIMIT;
    } else {
      remainingAfter = accessCheck.remaining - 1;
      try {
        await incrementUsage(accessCheck.usageKey);
      } catch (e) {
        remainingAfter = accessCheck.remaining - 1;
      }
      capValue = accessCheck.cap;
    }

    res.status(200).json({
      ok: true,
      long: parsed.long || '',
      short: parsed.short || '',
      seo: parsed.seo || '',
      remaining: remainingAfter,
      cap: capValue,
      usingTrial
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

// ---------- سلة: توليد وصف من صورة المنتج ----------
async function handleSallaGenerateFromImage(body, res) {
  const imageBase64 = (body.imageBase64 || '').toString();
  const imageMediaType = (body.imageMediaType || 'image/jpeg').toString();
  const audience = (body.audience || '').toString().trim();
  const price = (body.price || '').toString().trim();
  const accessCode = (body.accessCode || '').toString().trim().toUpperCase();
  const deviceId = (body.deviceId || '').toString().trim();
  const merchant = (body.merchant || '').toString().trim();

  if (!imageBase64) {
    res.status(400).json({ error: 'صورة المنتج مطلوبة' });
    return;
  }

  // [إضافة] توليد من صورة حصري لباقتي النصف سنوي والسنوي — نفس قيد الموقع الرئيسي بالضبط، ما يشتغل بالتجربة المجانية
  if (!accessCode) {
    res.status(401).json({ error: 'ميزة التوليد من صورة تحتاج كود وصول بباقة نصف سنوي أو سنوي', code: 'NO_ACCESS_CODE' });
    return;
  }

  let accessCheck;
  try {
    accessCheck = await checkAccessCode(accessCode, deviceId);
  } catch (e) {
    res.status(500).json({ error: 'صار خطأ بالتحقق من الكود' });
    return;
  }
  if (!accessCheck.ok) {
    res.status(403).json({ error: 'كود الوصول غير صحيح أو منتهي', code: 'INVALID_CODE' });
    return;
  }
  const IMAGE_ALLOWED_PLANS = ['نصف سنوي', 'سنوي'];
  if (!IMAGE_ALLOWED_PLANS.includes(accessCheck.plan)) {
    res.status(403).json({
      error: 'التوليد من صورة حصري لمشتركي الباقة النصف سنوية أو السنوية',
      code: 'PLAN_NOT_ALLOWED'
    });
    return;
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    res.status(500).json({ error: 'Server misconfigured' });
    return;
  }

  const systemPrompt = `أنت كاتب محتوى تسويقي محترف. انظر لصورة المنتج المرفقة، وحدد نوعه ومميزاته الظاهرة، واكتب 3 نسخ وصف بالعربي جاهزة للنشر بمتجر سلة:
1. "long": وصف طويل متكامل (فقرتين لثلاث) يبرز المميزات الظاهرة بالصورة
2. "short": نسخة قصيرة للسوشال ميديا
3. "seo": وصف محسّن لمحركات البحث (150-160 حرف)
${audience ? `الجمهور المستهدف: ${audience}` : ''}${price ? `\nالسعر: ${price}` : ''}
أجب بصيغة JSON فقط: {"long":"...","short":"...","seo":"..."}`;

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
        max_tokens: 1200,
        system: systemPrompt,
        messages: [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: imageMediaType, data: imageBase64 } },
            { type: 'text', text: 'ولّد لي وصف هذا المنتج.' }
          ]
        }]
      })
    });

    if (!aiResponse.ok) {
      res.status(502).json({ error: 'تعذر التوليد من الصورة، جرب مرة ثانية' });
      return;
    }

    const data = await aiResponse.json();
    const rawText = (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
    let parsed = null;
    try {
      const cleaned = rawText.replace(/^```(json)?/i, '').replace(/```$/i, '').trim();
      parsed = JSON.parse(cleaned);
    } catch (e) {
      const match = rawText.match(/\{[\s\S]*\}/);
      if (match) { try { parsed = JSON.parse(match[0]); } catch (e2) { parsed = null; } }
    }
    if (!parsed) parsed = { long: rawText, short: '', seo: '' };

    const remainingAfter = accessCheck.remaining - 1;
    try { await incrementUsage(accessCheck.usageKey); } catch (e) {}

    res.status(200).json({
      ok: true,
      long: parsed.long || '',
      short: parsed.short || '',
      seo: parsed.seo || '',
      remaining: remainingAfter,
      cap: accessCheck.cap
    });
  } catch (err) {
    res.status(500).json({ error: 'صار خطأ أثناء التوليد من الصورة' });
  }
}

// ---------- سلة: محتوى تسويقي جاهز (واتساب وإنستقرام) ----------
async function handleSallaGenerateMarketing(body, res) {
  const productName = (body.productName || '').toString().trim();
  const features = (body.features || '').toString().trim();
  const price = (body.price || '').toString().trim();
  const longDescription = (body.longDescription || '').toString().trim();
  const accessCode = (body.accessCode || '').toString().trim().toUpperCase();
  const deviceId = (body.deviceId || '').toString().trim();

  if (!productName) {
    res.status(400).json({ error: 'اسم المنتج مطلوب' });
    return;
  }
  if (!accessCode) {
    res.status(401).json({ error: 'محتوى تسويقي جاهز يحتاج كود وصول بباقة نصف سنوي أو سنوي', code: 'NO_ACCESS_CODE' });
    return;
  }

  let accessCheck;
  try {
    accessCheck = await checkAccessCode(accessCode, deviceId);
  } catch (e) {
    res.status(500).json({ error: 'صار خطأ بالتحقق من الكود' });
    return;
  }
  if (!accessCheck.ok) {
    res.status(403).json({ error: 'كود الوصول غير صحيح أو منتهي', code: 'INVALID_CODE' });
    return;
  }
  const MARKETING_ALLOWED_PLANS = ['نصف سنوي', 'سنوي'];
  if (!MARKETING_ALLOWED_PLANS.includes(accessCheck.plan)) {
    res.status(403).json({
      error: 'محتوى تسويقي جاهز حصري لمشتركي الباقة النصف سنوية أو السنوية',
      code: 'PLAN_NOT_ALLOWED'
    });
    return;
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    res.status(500).json({ error: 'Server misconfigured' });
    return;
  }

  const systemPrompt = `أنت مساعد تسويقي متخصص بكتابة محتوى بيعي جاهز للنشر، بلهجة سعودية خليجية ودودة، لتجار سلة.
اكتب قطعتين:
1. "whatsapp": رسالة واتساب مباشرة قصيرة (3-5 أسطر)، أسلوب بيعي ودود محادثي
2. "instagram": كابشن إنستقرام (3-6 أسطر) + سطر فاضي + 4-6 هاشتاقات مناسبة
أجب بصيغة JSON فقط: {"whatsapp":"...","instagram":"..."}`;
  const userPrompt = `اسم المنتج: ${productName}\nالمميزات: ${features || 'غير محددة'}${price ? `\nالسعر: ${price}` : ''}${longDescription ? `\nالوصف المُولّد مسبقاً: ${longDescription}` : ''}`;

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
        max_tokens: 1000,
        system: systemPrompt,
        messages: [{ role: 'user', content: userPrompt }]
      })
    });

    if (!aiResponse.ok) {
      res.status(502).json({ error: 'تعذر التوليد الآن، جرب بعد شوي' });
      return;
    }

    const data = await aiResponse.json();
    const rawText = (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
    let parsed = null;
    try {
      const cleaned = rawText.replace(/^```(json)?/i, '').replace(/```$/i, '').trim();
      parsed = JSON.parse(cleaned);
    } catch (e) {
      const match = rawText.match(/\{[\s\S]*\}/);
      if (match) { try { parsed = JSON.parse(match[0]); } catch (e2) { parsed = null; } }
    }
    if (!parsed) parsed = { whatsapp: rawText, instagram: '' };

    const remainingAfter = accessCheck.remaining - 1;
    try { await incrementUsage(accessCheck.usageKey); } catch (e) {}

    res.status(200).json({
      ok: true,
      whatsapp: parsed.whatsapp || '',
      instagram: parsed.instagram || '',
      remaining: remainingAfter,
      cap: accessCheck.cap
    });
  } catch (err) {
    res.status(500).json({ error: 'صار خطأ أثناء التوليد' });
  }
}

// ==================== [إضافة جديدة] حسابات بإيميل وباسورد — بديل/رديف لنظام كود الوصول ====================
// تخزين: user:{email} -> {passwordHash, createdAt, accessCode}
// الجلسة تُحفظ بكوكي httpOnly (wassaf_session)، مو بـ localStorage — أأمن ضد سرقة عبر XSS

function buildResetEmailHtml(token) {
  const link = `https://www.wassaf.space/account.html?reset=${token}`;
  return `
  <div dir="rtl" style="font-family:'IBM Plex Sans Arabic',Arial,sans-serif;max-width:520px;margin:0 auto;padding:32px 24px;background:#ffffff;">
    <div style="text-align:center;margin-bottom:24px;">
      <span style="font-size:28px;font-weight:900;color:#E94548;">وصّاف</span>
    </div>
    <h2 style="color:#1E1B2E;font-size:20px;">طلب استعادة كلمة المرور</h2>
    <p style="color:#6B6785;font-size:15px;line-height:1.8;">
      إذا كنت أنت اللي طلب استعادة كلمة المرور، اضغط الزر تحت خلال ساعة وحدة. لو ما طلبت هذا، تجاهل الإيميل ولا شي بيتغيّر.
    </p>
    <a href="${link}" style="display:block;text-align:center;background:#E94548;color:#ffffff;text-decoration:none;font-weight:700;padding:14px;border-radius:8px;font-size:15px;">
      إعادة تعيين كلمة المرور
    </a>
  </div>`;
}

// ---------- تسجيل حساب جديد ----------
async function handleAuthSignup(req, res, body) {
  const email = (body.email || '').toString().trim().toLowerCase();
  const password = (body.password || '').toString();

  if (!isValidEmail(email)) {
    res.status(400).json({ error: 'أدخل إيميل صحيح' });
    return;
  }
  if (!isStrongEnoughPassword(password)) {
    res.status(400).json({ error: 'كلمة المرور لازم تكون 8 أحرف على الأقل' });
    return;
  }

  const userKey = `user:${email}`;
  const existing = await redisCommand(['GET', userKey]);
  if (existing) {
    res.status(409).json({ error: 'فيه حساب مسجّل بهذا الإيميل من قبل، جرب تسجّل دخول' });
    return;
  }

  const passwordHash = await hashPassword(password);

  // لو نفس الإيميل عنده كود وصول من اشتراك سابق (Lemon Squeezy)، نربطه تلقائياً بالحساب الجديد
  const linkedCode = await redisCommand(['GET', `email_code:${email}`]);

  const userValue = JSON.stringify({
    passwordHash,
    createdAt: new Date().toISOString(),
    accessCode: linkedCode || null
  });
  await redisCommand(['SET', userKey, userValue]);

  const token = await createSession(email);
  setSessionCookie(res, token);

  res.status(200).json({ ok: true, email, linkedSubscription: !!linkedCode });
}

// ---------- دخول ----------
async function handleAuthLogin(req, res, body) {
  const email = (body.email || '').toString().trim().toLowerCase();
  const password = (body.password || '').toString();

  if (!email || !password) {
    res.status(400).json({ error: 'أدخل الإيميل وكلمة المرور' });
    return;
  }

  const raw = await redisCommand(['GET', `user:${email}`]);
  if (!raw) {
    res.status(401).json({ error: 'الإيميل أو كلمة المرور غير صحيحة' });
    return;
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    res.status(500).json({ error: 'صار خطأ، جرب مرة ثانية' });
    return;
  }

  const passwordOk = await verifyPassword(password, parsed.passwordHash);
  if (!passwordOk) {
    res.status(401).json({ error: 'الإيميل أو كلمة المرور غير صحيحة' });
    return;
  }

  const token = await createSession(email);
  setSessionCookie(res, token);
  res.status(200).json({ ok: true, email });
}

// ---------- خروج ----------
async function handleAuthLogout(req, res) {
  const cookies = parseCookies(req);
  const token = cookies[SESSION_COOKIE_NAME];
  await destroySession(token);
  clearSessionCookie(res);
  res.status(200).json({ ok: true });
}

// ---------- بيانات الحساب الحالي حسب الجلسة (بدل كود الوصول اليدوي) ----------
async function handleAuthMe(req, res) {
  const cookies = parseCookies(req);
  const token = cookies[SESSION_COOKIE_NAME];
  const email = await getSessionEmail(token);
  if (!email) {
    res.status(401).json({ error: 'ما فيه جلسة دخول فعّالة' });
    return;
  }

  const raw = await redisCommand(['GET', `user:${email}`]);
  if (!raw) {
    res.status(404).json({ error: 'الحساب غير موجود' });
    return;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    parsed = {};
  }

  if (!parsed.accessCode) {
    // [إصلاح] لو الحساب اتسجّل قبل الاشتراك (أو قبل ما يوصل حدث Lemon Squeezy)،
    // نتحقق من فهرس الإيميل مرة ثانية كل ما يفتح صفحة "حسابي" — ولو لقينا كود جديد، نربطه فوراً بدل ما يفضل فاضي للأبد
    const linkedCode = await redisCommand(['GET', `email_code:${email}`]);
    if (linkedCode) {
      parsed.accessCode = linkedCode;
      await redisCommand(['SET', `user:${email}`, JSON.stringify(parsed)]);
    }
  }

  if (!parsed.accessCode) {
    res.status(200).json({ ok: true, email, hasSubscription: false });
    return;
  }

  const accessResult = await checkAccessCode(parsed.accessCode, null);
  if (!accessResult.ok && accessResult.reason !== 'exhausted') {
    res.status(200).json({ ok: true, email, hasSubscription: false });
    return;
  }

  // [إصلاح] رابط ونسبة الإحالة كانوا يُحسبون بس بمسار كود الوصول القديم — إضافتهم هنا عشان حسابات الإيميل/الباسورد تشتغل بنفس الميزة
  const referralCount = parseInt((await redisCommand(['GET', `referral_count:${parsed.accessCode}`])) || '0', 10);
  const referralToken = await getOrCreateReferralToken(parsed.accessCode);
  const estimatedReferralBonus = Math.max(Math.round((accessResult.cap || 0) * REFERRAL_BONUS_RATIO), 3);

  res.status(200).json({
    ok: true,
    email,
    hasSubscription: true,
    plan: accessResult.plan || 'عام',
    cap: accessResult.cap,
    used: typeof accessResult.used === 'number' ? accessResult.used : null,
    remaining: accessResult.remaining,
    referralToken,
    referralCount,
    estimatedReferralBonus
  });
}

// ---------- طلب رابط استعادة كلمة المرور ----------
async function handleAuthRequestReset(req, res, body) {
  const email = (body.email || '').toString().trim().toLowerCase();
  if (!isValidEmail(email)) {
    res.status(400).json({ error: 'أدخل إيميل صحيح' });
    return;
  }

  const raw = await redisCommand(['GET', `user:${email}`]);
  // نرجع نفس الرسالة سواء الحساب موجود أو لا — عشان ما نكشف وجود إيميل معيّن بالنظام لطرف مو صاحبه
  if (raw) {
    const token = await createResetToken(email);
    try {
      await sendEmail({
        to: email,
        subject: 'استعادة كلمة المرور — وصّاف',
        html: buildResetEmailHtml(token)
      });
    } catch (e) {
      // فشل الإرسال هنا ما نكشفه للمستخدم، بس نتجاهله بصمت (نفس نمط باقي الملف)
    }
  }

  res.status(200).json({ ok: true, message: 'لو الإيميل مسجّل عندنا، بيوصلك رابط استعادة كلمة المرور خلال دقايق' });
}

// ---------- تنفيذ إعادة تعيين كلمة المرور بالتوكن ----------
async function handleAuthResetPassword(req, res, body) {
  const token = (body.token || '').toString().trim();
  const newPassword = (body.newPassword || '').toString();

  if (!token || !isStrongEnoughPassword(newPassword)) {
    res.status(400).json({ error: 'بيانات غير مكتملة، كلمة المرور لازم تكون 8 أحرف على الأقل' });
    return;
  }

  const email = await consumeResetToken(token);
  if (!email) {
    res.status(400).json({ error: 'رابط الاستعادة منتهي أو غير صحيح' });
    return;
  }

  const raw = await redisCommand(['GET', `user:${email}`]);
  if (!raw) {
    res.status(404).json({ error: 'الحساب غير موجود' });
    return;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    parsed = {};
  }
  parsed.passwordHash = await hashPassword(newPassword);
  await redisCommand(['SET', `user:${email}`, JSON.stringify(parsed)]);

  res.status(200).json({ ok: true });
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
      case 'salla_generate_from_image':
        await handleSallaGenerateFromImage(body, res);
        break;
      case 'salla_generate_marketing':
        await handleSallaGenerateMarketing(body, res);
        break;
      case 'salla_introspect_token':
        await handleSallaIntrospectToken(body, res);
        break;
      case 'salla_subscription_status':
        await handleSallaSubscriptionStatus(body, res);
        break;
      case 'zid_subscription_status':
        await handleZidSubscriptionStatus(body, res);
        break;
      case 'zid_list_products':
        await handleZidListProducts(body, res);
        break;
      case 'zid_write_back':
        await handleZidWriteBack(body, res);
        break;
      case 'auth_signup':
        await handleAuthSignup(req, res, body);
        break;
      case 'auth_login':
        await handleAuthLogin(req, res, body);
        break;
      case 'auth_logout':
        await handleAuthLogout(req, res);
        break;
      case 'auth_me':
        await handleAuthMe(req, res);
        break;
      case 'auth_request_reset':
        await handleAuthRequestReset(req, res, body);
        break;
      case 'auth_reset_password':
        await handleAuthResetPassword(req, res, body);
        break;
      default:
        res.status(400).json({ error: 'action غير معروف' });
    }
  } catch (err) {
    res.status(500).json({ error: 'صار خطأ، جرب مرة ثانية' });
  }
};
