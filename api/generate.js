const { redisCommand } = require('./_redis');
const { checkAccessCode, incrementUsage } = require('./_access');

const FRAMEWORK_LABELS = {
  AIDA: 'AIDA (الانتباه ← الاهتمام ← الرغبة ← الفعل) — الأنسب للمنتجات العاطفية ولايف ستايل (عطور، إكسسوارات، هدايا)',
  PAS: 'PAS (المشكلة ← تضخيمها ← الحل) — الأنسب للمنتجات اللي تحل مشكلة وظيفية (أدوات، حلول تقنية، منتجات صحية)',
  BAB: 'BAB (قبل ← بعد ← الجسر) — الأنسب للمنتجات اللي تحسّن حالة حالية (تجميل، لياقة، تنظيم)'
};

// السجل اللغوي العامي — نقي بالكامل، بدون أي مزج مع الفصحى (يعتمد على أمثلة فعلية Few-shot)
const SYSTEM_PROMPT_COLLOQUIAL = `أنت كاتب محتوى تسويقي متخصص في التجارة الإلكترونية الخليجية، تكتب أوصاف منتجات تحوّل الزائر لمشتري.

# مثال 1 — بالضبط الأسلوب المطلوب منك (قلّده حرفياً بكل نص تكتبه)
"تعبت من نوم ما يريحك ولا يخليك تصحى نشيط؟
أغلب الوسائد إما طرية زيادة وتحس رقبتك معلقة، أو قاسية وتصحى وأنت متكسر.
وسادة الذاكرة هذي مختلفة:
- تتشكل على راحة رقبتك بالضبط، وترجع لشكلها كل مرة
- قماشها يسمح بمرور الهواء، فما تحس بالحر وانت نايم
- تناسب اللي ينامون على جنبهم أو على ظهرهم بنفس الراحة
جربها أسبوع، ولو ما حسيت بفرق نرجع لك فلوسك.
اطلبها الحين ونامك الليلة أحسن من كل مرة."

# مثال 2 — نفس الأسلوب بمنتج مختلف
"شنطتك الحالية بذمة تشيلها كل يوم؟
كثير الشنط تنقطع من أول شهرين، أو ما فيها مكان ترتب فيه أغراضك صح.
هذي الشنطة معمولة عشان تتحمل استخدامك اليومي بدون ما تشتكي:
- جلدها الأصلي يتحمل السنين، مو بس الشكل الأول
- فيها جيوب مرتبة تخليك تلقى كل شي بسرعة
- مقاسها يناسب اللابتوب والدفاتر مع بعض
سنة كاملة ضمان — إذا صار فيها أي خلل نبدلها لك.
خلها رفيقتك اليومية، واطلبها الحين."

# قواعد صارمة (بناءً على نفس أسلوب المثالين فوق)
اكتب بلهجة خليجية بيضاء بسيطة ودافئة، بالضبط زي المثالين — جمل قصيرة، مباشرة، محكية.

ممنوع تماماً استخدام أي من هذي (فصحى رسمية تكسر اللهجة):
- تنوين على الصفات أو الأسماء (شيئاً، جميلاً، رائعاً) — قله بدون تنوين
- المبني للمجهول (صُمِّم، صُنِع، أُعِدّ) — قول بدل كذا "صممناه لك" أو "مصمم يناسبك"
- كلمات فصيحة رسمية: (إنّ، ذلك، لأمثالك، بغية، سوف، قد يكون، ينبغي)
- أفعال أو كلمات مجازية ملخبطة بغير سياقها (متل "تشمّه" لمنتج ما له علاقة بالرائحة) — اذكر بس اللي ينطبق فعلياً على المنتج
- جمل معقدة فيها أكثر من فكرة وحدة — قسمها لجملتين قصار بدل جملة طويلة ملتوية

# البنية (اتبعها بنفس تسلسل المثالين)
1. سؤال أو جملة تفتح بمشكلة/رغبة حقيقية (سطر وحد)
2. سطرين يوسّعون المشكلة (ليش الحلول العادية ما تكفي)
3. 3-4 نقاط: كل نقطة فايدة ملموسة (مو خاصية تقنية جافة)
4. سطر ثقة (ضمان، تجربة، رقم) لو مناسب
5. جملة ختامية قصيرة تدعو للفعل`;

// السجل اللغوي "الفصحى" — فصحى مبسطة خفيفة، بدون مفردات رسمية ثقيلة، وبدون الوصول للهجة محكية
const SYSTEM_PROMPT_FORMAL = `أنت كاتب محتوى تسويقي محترف، تكتب أوصاف منتجات بلغة عربية مبسطة وسهلة — فصحى خفيفة قريبة من لغة الحديث اليومي المتلفز أو الإعلاني، بدون الوصول للهجة عامية محكية.

# مثال — بالضبط الأسلوب المطلوب منك (قلّده حرفياً بكل نص تكتبه)
"تبحث عن راحة حقيقية بعد يوم طويل؟
كثير من الكراسي العادية لا تريح ظهرك، فتشعر بالتعب حتى وأنت جالس.
كرسي الاسترخاء هذا مختلف:
- يحتضن جسمك ويوزّع الضغط بشكل صحيح، فتشعر براحة من أول لحظة
- خامته الجلدية الفاخرة تضيف لمسة أناقة لأي مكان تضعه فيه
- متوفر بعدة ألوان تناسب ذوقك وديكور بيتك
جربه، وستشعر بالفرق من أول استخدام.
اختر لونك الآن، وامنح نفسك لحظة الراحة التي تستحقها."

# قواعد صارمة
- فصحى بسيطة وسهلة، بدون أي مفردة رسمية ثقيلة أو نادرة الاستخدام (تجنب: "يستوجب"، "بغية"، "سوف"، "إذ إنّ"، "ذو"، "أضحى")
- بدون مبني للمجهول ("صُمِّم") — استخدم "صممناه لك" أو صيغة مباشرة مشابهة
- جمل قصيرة جداً، مباشرة، بدون أي تعقيد نحوي (تجنب الجمل المركّبة بأكثر من فكرة)
- ممنوع أي كلمة أو تعبير عامي محكي (لا "يخليك"، لا "تحس فيه"، لا "عشان") — التزم بالفصحى النحوية، لكن ببساطة شديدة
- تخيل إنك تشرح لصديق بلغة عربية سليمة وسهلة، مو تكتب مقالاً رسمياً

# البنية
1. سؤال أو جملة افتتاحية بسيطة تلفت الانتباه (سطر واحد)
2. سطرين يوضّحان المشكلة أو الحاجة بشكل مباشر
3. 3-4 نقاط: كل نقطة فائدة ملموسة بجملة قصيرة
4. سطر ثقة (ضمان، تجربة، رقم) إن وُجد
5. جملة ختامية قصيرة تدعو للفعل`;

function buildFrameworkInstruction(framework) {
  if (framework === 'AUTO' || !FRAMEWORK_LABELS[framework]) {
    return `اختر أنت الإطار الأنسب لهذا المنتج تحديداً من بين الثلاثة التالية حسب طبيعته:
- ${FRAMEWORK_LABELS.AIDA}
- ${FRAMEWORK_LABELS.PAS}
- ${FRAMEWORK_LABELS.BAB}`;
  }
  return `استخدم إطار ${FRAMEWORK_LABELS[framework]} بالضبط.`;
}

function buildPrompt({ productName, audience, features, price, framework, brandTone, style }) {
  const frameworkInstruction = buildFrameworkInstruction(framework);

  let systemPrompt;
  let reviewLine;
  if (style === 'COLLOQUIAL') {
    systemPrompt = SYSTEM_PROMPT_COLLOQUIAL;
    reviewLine = 'راجع نصك قبل ما ترسله: تأكد ما فيه أي كلمة أو تركيب من القائمة الممنوعة فوق (تنوين، مبني للمجهول، كلمات فصيحة رسمية)، وتأكد كل جملة تقرأ بالضبط بنفس أسلوب المثالين المعطاة لك.';
  } else {
    // FORMAL هو الافتراضي — فصحى مبسطة وسهلة
    systemPrompt = SYSTEM_PROMPT_FORMAL;
    reviewLine = 'راجع نصك قبل ما ترسله: تأكد ما فيه أي مفردة رسمية ثقيلة أو نادرة، وما فيه أي كلمة عامية محكية متسربة — النص لازم يقرأ سهل وبسيط وسليم نحوياً بنفس الوقت.';
  }

  const user = `# بروفايل صوت المتجر
${brandTone ? brandTone : 'ما فيه تفضيل محدد — اختر نبرة مناسبة لطبيعة المنتج والجمهور.'}

# اختيار الإطار
${frameworkInstruction}

# بيانات المنتج
اسم المنتج: ${productName}
الجمهور المستهدف: ${audience || 'عام'}
الخصائص المُدخلة: ${features}
${price ? 'السعر: ' + price : ''}

# المطلوب منك بالضبط
1. "long": نسخة وحدة قوية ومركّزة من الوصف الطويل، جاهزة للنشر مباشرة بصفحة منتج، تتبع البنية الإلزامية كاملة.
2. "short": نسخة مختصرة جداً (سطرين إلى ثلاثة كحد أقصى) تصلح كابشن إنستقرام أو نص إعلان قصير.
3. "seo": جملة واحدة قصيرة (لا تتجاوز 160 حرف) محسّنة لظهور المنتج بجوجل، تتضمن اسم المنتج وأهم ميزة فيه.

مهم جداً: أجب فقط بكائن JSON صحيح وخام بدون أي شيء آخر — بدون علامات كود، بدون شرح، بدون مقدمة. الصيغة يجب أن تكون بالضبط:
{"long":"...","short":"...","seo":"..."}

${reviewLine}`;

  return { system: systemPrompt, user };
}

function safeParseModelJSON(text) {
  if (!text) return null;
  let cleaned = text.trim();
  // إزالة أي أسوار كود لو المودل حطها رغم التعليمات
  cleaned = cleaned.replace(/^```(json)?/i, '').replace(/```$/i, '').trim();
  try {
    const parsed = JSON.parse(cleaned);
    if (typeof parsed === 'object' && parsed !== null) return parsed;
  } catch (e) {
    // محاولة أخيرة: التقاط أول { ... } بالنص
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

// يحاول استدعاء Anthropic API، ولو رجع 429 (تجاوز حد الطلبات) أو 529 (تحميل زائد مؤقت)
// يعيد المحاولة تلقائياً مع فترة انتظار متزايدة (Exponential Backoff) بدل ما يفشل فوراً.
// يحترم رأس Retry-After لو Anthropic أرسلته، وإلا يستخدم فترات: 1 ثانية، 2 ثانية، 4 ثواني.
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

    // نحدد وقت الانتظار: نحترم Retry-After لو موجود، وإلا نضاعف الوقت كل محاولة
    const retryAfterHeader = response.headers.get('retry-after');
    let delayMs = retryAfterHeader ? parseInt(retryAfterHeader, 10) * 1000 : baseDelayMs * Math.pow(2, attempt);
    if (Number.isNaN(delayMs) || delayMs <= 0) {
      delayMs = baseDelayMs * Math.pow(2, attempt);
    }
    // نضيف Jitter بسيط عشان لو فيه عدة طلبات متزامنة ما تعيد المحاولة كلها بنفس اللحظة بالضبط
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
    const framework = (body.framework || 'AIDA').toString().trim();
    const brandTone = (body.brandTone || '').toString().trim();
    const style = (body.style || 'FORMAL').toString().trim().toUpperCase();
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

    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      res.status(500).json({ error: 'Server misconfigured: missing API key' });
      return;
    }

    const { system, user } = buildPrompt({ productName, audience, features, price, framework, brandTone, style });

    const anthropicResponse = await callAnthropicWithRetry(
      {
        model: 'claude-sonnet-4-6',
        max_tokens: 1200,
        system,
        messages: [{ role: 'user', content: user }]
      },
      apiKey
    );

    if (!anthropicResponse.ok) {
      if (anthropicResponse.status === 429 || anthropicResponse.status === 529) {
        // حتى بعد كل محاولات الـ retry، الضغط لسا مستمر — نطلب من التاجر يعيد المحاولة بنفسه بعد شوي
        res.status(503).json({
          error: 'الخدمة مزدحمة حالياً، جرب تولّد مرة ثانية بعد شوي.'
        });
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

    // التوليد نجح فعلياً هنا، فالحين بس نحسبه على رصيد الكود
    let remainingAfter = accessCheck.remaining - 1;
    try {
      await incrementUsage(accessCheck.usageKey);
    } catch (incrErr) {
      // حتى لو فشل تسجيل الاستخدام لأي سبب، ما نمنع التاجر من نتيجته اللي دفع/يستحقها
      remainingAfter = accessCheck.remaining - 1;
    }

    if (parsed && (parsed.long || parsed.short || parsed.seo)) {
      res.status(200).json({
        long: parsed.long || '',
        short: parsed.short || '',
        seo: parsed.seo || '',
        remaining: remainingAfter,
        cap: accessCheck.cap
      });
    } else {
      // fallback: لو المودل ما رجع JSON صحيح لأي سبب، نرجع النص كامل كوصف طويل بدل ما نفشل بالكامل
      res.status(200).json({
        long: rawText || 'ما رجع نص، جرب مرة ثانية.',
        short: '',
        seo: '',
        remaining: remainingAfter,
        cap: accessCheck.cap
      });
    }
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
};
