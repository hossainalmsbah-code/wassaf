const { checkAccessCode, incrementUsage, currentMonthKey, checkSallaMerchantSubscription, checkZidMerchantSubscription } = require('./_access');
const { redisCommand } = require('./_redis');

// [إضافة جديدة] نفس منطق حد SEO التفصيلي المستخدم بـgenerate.js بالضبط — سنوي/نصف سنوي بدون حد،
// شهري محدود بـ10 بالشهر (عداد مستقل)، باقي الباقات مقفولة
const SEO_UNLIMITED_PLANS = ['نصف سنوي', 'سنوي'];
const SEO_MONTHLY_PLAN_LIMIT = 10;

// نفس السجلين اللغويين المستخدمين بالتوليد النصي العادي — نعيد استخدامهم بالضبط عشان يطلع نفس أسلوب الكتابة
const SYSTEM_PROMPT_COLLOQUIAL = `أنت كاتب محتوى تسويقي متخصص في التجارة الإلكترونية الخليجية. التاجر بيعطيك اسم المنتج بالضبط، وصورة له. اسم المنتج هو المرجع الأساسي لنوع المنتج — الصورة تستخدمها بس لاستخراج التفاصيل البصرية الملموسة (اللون، الشكل، الخامة، أي تفاصيل تصميم ظاهرة) ومنها تكتب وصف تسويقي يحوّل الزائر لمشتري.

اكتب بلهجة خليجية بيضاء بسيطة ودافئة — جمل قصيرة، مباشرة، محكية.

ممنوع تماماً استخدام أي من هذي (فصحى رسمية تكسر اللهجة):
- تنوين على الصفات أو الأسماء
- المبني للمجهول (صُمِّم، صُنِع)
- كلمات فصيحة رسمية: (إنّ، ذلك، لأمثالك، بغية، سوف، ينبغي)
- جمل معقدة فيها أكثر من فكرة وحدة

# البنية
1. سؤال أو جملة تفتح بمشكلة/رغبة حقيقية (سطر وحد)
2. سطرين يوسّعون المشكلة
3. 3-4 نقاط: كل نقطة فايدة ملموسة مبنية على اللي تشوفه فعلياً بالصورة (لون، خامة، شكل، تفاصيل)
4. سطر ثقة لو مناسب
5. جملة ختامية قصيرة تدعو للفعل
`;

const SYSTEM_PROMPT_FORMAL = `أنت كاتب محتوى تسويقي محترف. التاجر بيعطيك اسم المنتج بالضبط، وصورة له. اسم المنتج هو المرجع الأساسي لنوع المنتج — الصورة تستخدمها بس لاستخراج التفاصيل البصرية الملموسة (اللون، الشكل، الخامة، أي تفاصيل تصميم ظاهرة) ومنها تكتب وصف تسويقي بلغة عربية مبسطة وسهلة — فصحى خفيفة قريبة من لغة الحديث اليومي، بدون لهجة عامية محكية وبدون مفردات رسمية ثقيلة.

# البنية
1. سؤال أو جملة افتتاحية بسيطة (سطر واحد)
2. سطرين يوضّحان الحاجة
3. 3-4 نقاط: كل نقطة فائدة ملموسة مبنية على اللي تشوفه فعلياً بالصورة (لون، خامة، شكل، تفاصيل)
4. سطر ثقة إن وُجد
5. جملة ختامية قصيرة تدعو للفعل
`;

function buildUserText({ productName, audience, price, brandTone, style }) {
  const reviewLine = style === 'COLLOQUIAL'
    ? 'راجع نصك قبل ما ترسله: تأكد ما فيه أي كلمة من القائمة الممنوعة، وتأكد كل التفاصيل اللي ذكرتها موجودة فعلياً بالصورة مو مختلقة.'
    : 'راجع نصك قبل ما ترسله: تأكد ما فيه أي مفردة رسمية ثقيلة أو كلمة عامية متسربة، وتأكد كل التفاصيل اللي ذكرتها موجودة فعلياً بالصورة مو مختلقة.';

  return `# اسم المنتج (حدده التاجر بنفسه — اعتمد عليه حرفياً، لا تخمّن نوع منتج مختلف من الصورة حتى لو الشكل يوحي بغير ذلك)
${productName}

# بروفايل صوت المتجر
${brandTone ? brandTone : 'ما فيه تفضيل محدد — اختر نبرة مناسبة لطبيعة المنتج والجمهور.'}

# معلومات إضافية (اختيارية، استخدمها لو موجودة)
الجمهور المستهدف: ${audience || 'عام'}
${price ? 'السعر (للسياق فقط — يساعدك تحدد مستوى المنتج: اقتصادي أو متوسط أو فاخر، عشان تختار نبرة وكلمات مناسبة): ' + price : ''}

# قاعدة إلزامية بخصوص السعر
${price ? 'استخدم السعر بس كمعلومة خلفية لتحديد نبرة الكتابة — لا تذكر رقم السعر ولا كلمة "ريال" ولا أي إشارة صريحة للسعر داخل أي نص تكتبه (long, short, seo, seoMeta). السعر يظهر تلقائياً بصفحة المنتج، وذكره بالوصف يسبب تعارض لو غيّره التاجر لاحقاً.' : 'ما فيه سعر مُدخل — لا تخترع أو تفترض أي رقم سعر بالنص.'}

# المطلوب منك بالضبط
استخدم الصورة المرفقة بس لاستخراج التفاصيل البصرية الملموسة (اللون، الخامة، الشكل، أي تفاصيل تصميم ظاهرة) — مو لتحديد نوع المنتج، لأن نوع المنتج محدد فوق بالضبط باسم "${productName}". اكتب:
1. "long": نسخة وحدة قوية ومركّزة من الوصف الطويل، جاهزة للنشر مباشرة بصفحة منتج.
2. "short": نسخة مختصرة جداً (سطرين إلى ثلاثة كحد أقصى) تصلح كابشن إنستقرام.
3. "seo": جملة واحدة قصيرة (لا تتجاوز 160 حرف) محسّنة لظهور المنتج بجوجل.
4. "seoTitle": عنوان SEO منفصل ومختلف عن اسم المنتج الأصلي، بين 40 و60 حرف بالضبط.
5. "seoMeta": وصف Meta منفصل، بين 130 و160 حرف بالضبط، يشجع على الضغط عليه بنتائج البحث.
6. "seoKeywords": مصفوفة من 5 إلى 8 كلمات أو عبارات مفتاحية قصيرة يبحث فيها عميل يدور على هذا المنتج.

مهم جداً: أجب فقط بكائن JSON صحيح وخام بدون أي شيء آخر — بدون علامات كود، بدون شرح. الصيغة بالضبط:
{"long":"...","short":"...","seo":"...","seoTitle":"...","seoMeta":"...","seoKeywords":["...","..."]}

${reviewLine}`;
}

function safeParseModelJSON(text) {
  if (!text) return null;
  let cleaned = text.trim().replace(/^```(json)?/i, '').replace(/```$/i, '').trim();
  try {
    const parsed = JSON.parse(cleaned);
    if (typeof parsed === 'object' && parsed !== null) return parsed;
  } catch (e) {
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (match) {
      try { return JSON.parse(match[0]); } catch (e2) { return null; }
    }
  }
  return null;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function callAnthropicWithRetry(payload, apiKey, maxRetries = 3) {
  const baseDelayMs = 1000;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify(payload)
    });
    const isRetryable = response.status === 429 || response.status === 529;
    if (!isRetryable || attempt === maxRetries) return response;
    const retryAfterHeader = response.headers.get('retry-after');
    let delayMs = retryAfterHeader ? parseInt(retryAfterHeader, 10) * 1000 : baseDelayMs * Math.pow(2, attempt);
    if (Number.isNaN(delayMs) || delayMs <= 0) delayMs = baseDelayMs * Math.pow(2, attempt);
    delayMs += Math.floor(Math.random() * 300);
    await sleep(delayMs);
  }
}

// الباقات المسموح لها فقط بهذي الميزة — نفس الأسماء المخزنة بـ webhook.js
const ALLOWED_PLANS = ['نصف سنوي', 'سنوي'];

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  try {
    const body = req.body || {};
    const imageBase64 = (body.imageBase64 || '').toString();
    const imageMediaType = (body.imageMediaType || 'image/jpeg').toString();
    const productName = (body.productName || '').toString().trim();
    const audience = (body.audience || '').toString().trim();
    const price = (body.price || '').toString().trim();
    const brandTone = (body.brandTone || '').toString().trim();
    const style = (body.style || 'FORMAL').toString().trim().toUpperCase();
    const accessCode = (body.accessCode || '').toString().trim().toUpperCase();
    const deviceId = (body.deviceId || '').toString().trim();
    const sallaMerchantId = (body.sallaMerchantId || '').toString().trim(); // [إضافة جديدة] نفس نمط generate.js بالضبط
    const zidMerchantId = (body.zidMerchantId || '').toString().trim();

    if (!productName) {
      res.status(400).json({ error: 'اكتب اسم المنتج أول — يساعد بتحديد نوعه بدقة بدل التخمين من الصورة بس' });
      return;
    }

    if (!imageBase64) {
      res.status(400).json({ error: 'ارفع صورة المنتج أول' });
      return;
    }

    // [إضافة جديدة] لو الطلب جاي من داخل سلة أو زد، نتحقق من اشتراك المتجر بدل كود الوصول العادي —
    // نفس المنطق بالضبط المستخدم بـgenerate.js، عشان الميزة تشتغل صح جوّا المنصتين
    let accessCheck;
    if (sallaMerchantId) {
      try {
        accessCheck = await checkSallaMerchantSubscription(sallaMerchantId);
      } catch (redisErr) {
        res.status(500).json({ error: 'صار خطأ بالتحقق من اشتراك متجرك، جرب مرة ثانية بعد شوي' });
        return;
      }
      if (!accessCheck.ok) {
        if (accessCheck.reason === 'exhausted') {
          res.status(403).json({ error: `خلصت حصتك الشهرية (${accessCheck.cap} وصف). جدد اشتراكك عبر سلة عشان تكمل التوليد.`, code: 'QUOTA_EXHAUSTED' });
        } else {
          res.status(403).json({ error: 'ما عندك اشتراك فعّال بوصّاف مرتبط بمتجرك — اشترك عبر سلة أول', code: 'NO_SALLA_SUBSCRIPTION' });
        }
        return;
      }
    } else if (zidMerchantId) {
      try {
        accessCheck = await checkZidMerchantSubscription(zidMerchantId);
      } catch (redisErr) {
        res.status(500).json({ error: 'صار خطأ بالتحقق من اشتراك متجرك، جرب مرة ثانية بعد شوي' });
        return;
      }
      if (!accessCheck.ok) {
        if (accessCheck.reason === 'exhausted') {
          res.status(403).json({ error: `خلصت حصتك الشهرية (${accessCheck.cap} وصف). جدد اشتراكك عبر زد عشان تكمل التوليد.`, code: 'QUOTA_EXHAUSTED' });
        } else {
          res.status(403).json({ error: 'ما عندك اشتراك فعّال بوصّاف مرتبط بمتجرك — اشترك عبر زد أول', code: 'NO_ZID_SUBSCRIPTION' });
        }
        return;
      }
    } else {
      if (!accessCode) {
        res.status(401).json({ error: 'أدخل كود الوصول أول', code: 'NO_ACCESS_CODE' });
        return;
      }
      try {
        accessCheck = await checkAccessCode(accessCode, deviceId);
      } catch (redisErr) {
        res.status(500).json({ error: 'صار خطأ بالتحقق من الكود، جرب مرة ثانية بعد شوي' });
        return;
      }
    }

    if (!accessCheck.ok) {
      if (accessCheck.reason === 'exhausted') {
        res.status(403).json({ error: `خلصت حصتك الشهرية (${accessCheck.cap} وصف).`, code: 'QUOTA_EXHAUSTED' });
      } else if (accessCheck.reason === 'device_mismatch') {
        res.status(403).json({ error: 'هذا الكود مستخدم فعلاً بجهاز ثاني.', code: 'DEVICE_MISMATCH' });
      } else {
        res.status(403).json({ error: 'كود الوصول غير صحيح', code: 'INVALID_CODE' });
      }
      return;
    }

    // بوابة الميزة: مقصورة على النصف سنوي والسنوي بس
    if (!ALLOWED_PLANS.includes(accessCheck.plan)) {
      res.status(403).json({
        error: 'ميزة التوليد من الصورة متاحة بس بالباقة النصف سنوية والسنوية. رقّي باقتك لتجربتها.',
        code: 'PLAN_NOT_ALLOWED'
      });
      return;
    }

    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      res.status(500).json({ error: 'Server misconfigured: missing API key' });
      return;
    }

    const systemPrompt = style === 'COLLOQUIAL' ? SYSTEM_PROMPT_COLLOQUIAL : SYSTEM_PROMPT_FORMAL;
    const userText = buildUserText({ productName, audience, price, brandTone, style });

    const anthropicResponse = await callAnthropicWithRetry(
      {
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1200,
        system: systemPrompt,
        messages: [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: imageMediaType, data: imageBase64 } },
            { type: 'text', text: userText }
          ]
        }]
      },
      apiKey
    );

    if (!anthropicResponse.ok) {
      if (anthropicResponse.status === 429 || anthropicResponse.status === 529) {
        res.status(503).json({ error: 'الخدمة مزدحمة حالياً، جرب مرة ثانية بعد شوي.' });
        return;
      }
      const errText = await anthropicResponse.text();
      res.status(502).json({ error: 'Upstream error', detail: errText });
      return;
    }

    const data = await anthropicResponse.json();
    const rawText = (data.content || [])
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('\n');

    const parsed = safeParseModelJSON(rawText);

    let remainingAfter = accessCheck.remaining - 1;
    try {
      await incrementUsage(accessCheck.usageKey);
    } catch (incrErr) {
      remainingAfter = accessCheck.remaining - 1;
    }

    if (parsed && (parsed.long || parsed.short || parsed.seo)) {
      // [إضافة جديدة] نفس منطق حد SEO التفصيلي المستخدم بـgenerate.js بالضبط
      let includeSeoDetails = false;
      let seoLimitReached = false;
      const plan = accessCheck.plan;
      if (SEO_UNLIMITED_PLANS.includes(plan)) {
        includeSeoDetails = true;
      } else if (plan === 'شهري' && accessCode) {
        const seoUsageKey = `seo_usage:${accessCode}:${currentMonthKey()}`;
        const seoUsedSoFar = parseInt((await redisCommand(['GET', seoUsageKey])) || '0', 10);
        if (seoUsedSoFar < SEO_MONTHLY_PLAN_LIMIT) {
          includeSeoDetails = true;
          await redisCommand(['INCR', seoUsageKey]);
          await redisCommand(['EXPIRE', seoUsageKey, 45 * 24 * 60 * 60]);
        } else {
          seoLimitReached = true;
        }
      }

      res.status(200).json({
        long: parsed.long || '',
        short: parsed.short || '',
        seo: parsed.seo || '',
        seoTitle: includeSeoDetails ? (parsed.seoTitle || '') : '',
        seoMeta: includeSeoDetails ? (parsed.seoMeta || '') : '',
        seoKeywords: includeSeoDetails && Array.isArray(parsed.seoKeywords) ? parsed.seoKeywords : [],
        seoLocked: !includeSeoDetails,
        seoLimitReached,
        remaining: remainingAfter,
        cap: accessCheck.cap
      });
    } else {
      res.status(200).json({
        long: rawText || 'ما قدرنا نحلل الصورة، جرب صورة أوضح.',
        short: '',
        seo: '',
        seoTitle: '',
        seoMeta: '',
        seoKeywords: [],
        remaining: remainingAfter,
        cap: accessCheck.cap
      });
    }
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
};
