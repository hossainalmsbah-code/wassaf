const { checkAccessCode, incrementUsage } = require('./_access');

// نفس قيد الواجهة الأمامية — تحقق مضاعف إلزامي بالخادم (الواجهة وحدها غير كافية أمنياً، أي حد يقدر يتلاعب بها من المتصفح)
const ALLOWED_PLANS = ['نصف سنوي', 'سنوي'];

const SYSTEM_PROMPT = `أنت مساعد تسويقي متخصص بكتابة محتوى بيعي جاهز للنشر مباشرة، بلهجة سعودية خليجية ودودة، لتجار متاجر إلكترونية سعودية (سلة، شوبيفاي، زد).

بناءً على بيانات المنتج المعطاة، اكتب قطعتين محتوى:

1. "whatsapp": رسالة واتساب مباشرة قصيرة (3-5 أسطر بحد أقصى)، بأسلوب بيعي ودود مباشر، مناسبة يرسلها التاجر لعميل مهتم أو ينشرها بحالة واتساب. أسلوب طبيعي محادثي، بدون علامات ترقيم رسمية زيادة.

2. "instagram": منشور إنستقرام جاهز — كابشن جذاب (3-6 أسطر) يبرز أهم ميزة أو فايدة بالمنتج، متبوع بسطر فاضي ثم 4-6 هاشتاقات مناسبة (مزيج عربي وإنجليزي، مرتبطة بالمنتج ونوع المتجر).

مهم جداً: أجب فقط بكائن JSON صحيح وخام بدون أي شيء آخر — بدون علامات كود، بدون شرح، بدون مقدمة. الصيغة يجب أن تكون بالضبط:
{"whatsapp":"...","instagram":"..."}`;

function safeParseModelJSON(text) {
  if (!text) return null;
  let cleaned = text.trim();
  cleaned = cleaned.replace(/^```(json)?/i, '').replace(/```$/i, '').trim();
  try {
    const parsed = JSON.parse(cleaned);
    if (typeof parsed === 'object' && parsed !== null) return parsed;
  } catch (e) {
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (match) {
      try {
        return JSON.parse(match[0]);
      } catch (e2) {
        return null;
      }
    }
  }
  return null;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// نفس آلية إعادة المحاولة الموجودة بـgenerate.js بالضبط (429/529 مع Exponential Backoff + Jitter)
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
    if (!isRetryable || attempt === maxRetries) {
      return response;
    }

    const retryAfterHeader = response.headers.get('retry-after');
    let delayMs = retryAfterHeader ? parseInt(retryAfterHeader, 10) * 1000 : baseDelayMs * Math.pow(2, attempt);
    if (Number.isNaN(delayMs) || delayMs <= 0) {
      delayMs = baseDelayMs * Math.pow(2, attempt);
    }
    delayMs += Math.floor(Math.random() * 300);
    await sleep(delayMs);
  }
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  try {
    const body = req.body || {};
    const productName = (body.productName || '').toString().trim();
    const audience = (body.audience || '').toString().trim();
    const features = (body.features || '').toString().trim();
    const price = (body.price || '').toString().trim();
    const brandTone = (body.brandTone || '').toString().trim();
    const longDescription = (body.longDescription || '').toString().trim();
    const accessCode = (body.accessCode || '').toString().trim().toUpperCase();
    const deviceId = (body.deviceId || '').toString().trim();

    if (!productName || !features) {
      res.status(400).json({ error: 'اسم المنتج والمميزات مطلوبة' });
      return;
    }

    if (!accessCode) {
      res.status(401).json({ error: 'أدخل كود الوصول أول عشان تقدر تولّد', code: 'NO_ACCESS_CODE' });
      return;
    }

    let accessCheck;
    try {
      accessCheck = await checkAccessCode(accessCode, deviceId);
    } catch (redisErr) {
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
          error: 'هذا الكود مستخدم فعلاً بجهاز ثاني. لو غيّرت جهازك، تواصل معنا نفعّله لك بالجهاز الجديد.',
          code: 'DEVICE_MISMATCH'
        });
      } else {
        res.status(403).json({ error: 'كود الوصول غير صحيح، تأكد منه أو تواصل معنا', code: 'INVALID_CODE' });
      }
      return;
    }

    // الميزة حصرية لباقتي النصف سنوي والسنوي بس — تحقق إلزامي بالخادم بعد التحقق من صلاحية الكود نفسه
    if (!ALLOWED_PLANS.includes(accessCheck.plan)) {
      res.status(403).json({
        error: 'محتوى تسويقي جاهز حصري لمشتركي الباقة النصف سنوية أو السنوية — رقّي باقتك عشان تستخدم هالميزة',
        code: 'PLAN_NOT_ALLOWED'
      });
      return;
    }

    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      res.status(500).json({ error: 'Server misconfigured: missing API key' });
      return;
    }

    const userPrompt = [
      `اسم المنتج: ${productName}`,
      `الجمهور المستهدف: ${audience || 'عام'}`,
      `الخصائص: ${features}`,
      price ? `السعر: ${price}` : '',
      `نبرة العلامة التجارية: ${brandTone || 'ما فيه تفضيل محدد — اختر نبرة مناسبة لطبيعة المنتج والجمهور.'}`,
      longDescription ? `الوصف الطويل المُولّد مسبقاً لنفس المنتج (استخدمه كمرجع للتفاصيل والأسلوب): ${longDescription}` : ''
    ].filter(Boolean).join('\n');

    const anthropicResponse = await callAnthropicWithRetry(
      {
        model: 'claude-sonnet-4-6',
        max_tokens: 1000,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: userPrompt }]
      },
      apiKey
    );

    if (!anthropicResponse.ok) {
      if (anthropicResponse.status === 429 || anthropicResponse.status === 529) {
        res.status(503).json({ error: 'الخدمة مزدحمة حالياً، جرب تولّد مرة ثانية بعد شوي.' });
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

    // التوليد نجح فعلياً هنا، فالحين بس نحسبه على رصيد الكود — usageKey مو accessCode (فرق مهم)
    let remainingAfter = accessCheck.remaining - 1;
    try {
      await incrementUsage(accessCheck.usageKey);
    } catch (incrErr) {
      remainingAfter = accessCheck.remaining - 1;
    }

    if (parsed && (parsed.whatsapp || parsed.instagram)) {
      res.status(200).json({
        whatsapp: parsed.whatsapp || '',
        instagram: parsed.instagram || '',
        remaining: remainingAfter,
        cap: accessCheck.cap
      });
    } else {
      res.status(200).json({
        whatsapp: rawText || 'ما رجع نص، جرب مرة ثانية.',
        instagram: '',
        remaining: remainingAfter,
        cap: accessCheck.cap
      });
    }
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
};
