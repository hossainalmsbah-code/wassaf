const FRAMEWORK_LABELS = {
  AIDA: 'AIDA (الانتباه ← الاهتمام ← الرغبة ← الفعل)',
  PAS: 'PAS (المشكلة ← تضخيمها ← الحل)',
  BAB: 'BAB (قبل ← بعد ← الجسر)'
};

function buildPrompt({ productName, audience, features, price, framework, brandTone }) {
  const fwKey = FRAMEWORK_LABELS[framework] ? framework : 'AIDA';
  const fwLabel = FRAMEWORK_LABELS[fwKey];

  return `اكتب أوصاف منتج تسويقية احترافية باللهجة السعودية/الخليجية البيضاء المناسبة للتجارة الإلكترونية، باستخدام إطار ${fwLabel} بالضبط.

اسم المنتج: ${productName}
الجمهور المستهدف: ${audience || 'عام'}
المميزات: ${features}
${price ? 'السعر: ' + price : ''}
${brandTone ? 'نبرة العلامة التجارية المطلوبة: ' + brandTone : ''}

المطلوب منك ثلاث نسخ مختلفة من الوصف:
1. "long": وصف كامل جاهز للنشر مباشرة في صفحة منتج بمتجر إلكتروني، بفقرات قصيرة وسطور نقطية إن لزم، يطبّق إطار ${fwKey} بوضوح.
2. "short": نسخة مختصرة جداً (سطرين إلى ثلاثة كحد أقصى) تصلح كابشن إنستقرام أو نص إعلان قصير، بنفس نبرة المنتج.
3. "seo": جملة واحدة قصيرة (لا تتجاوز 160 حرف) محسّنة لظهور المنتج في نتائج جوجل، تتضمن اسم المنتج وأهم ميزة فيه.

مهم جداً: أجب فقط بكائن JSON صحيح وخام بدون أي شيء آخر — بدون علامات كود، بدون شرح، بدون مقدمة. الصيغة يجب أن تكون بالضبط:
{"long":"...","short":"...","seo":"..."}

لا تستخدم أي كلمات إنجليزية داخل النصوص الثلاثة إلا لو ضرورية لاسم تقني.`;
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

    if (!productName || !features) {
      res.status(400).json({ error: 'اسم المنتج والمميزات مطلوبة' });
      return;
    }

    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      res.status(500).json({ error: 'Server misconfigured: missing API key' });
      return;
    }

    const prompt = buildPrompt({ productName, audience, features, price, framework, brandTone });

    const anthropicResponse = await callAnthropicWithRetry(
      {
        model: 'claude-sonnet-4-6',
        max_tokens: 1200,
        messages: [{ role: 'user', content: prompt }]
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

    if (parsed && (parsed.long || parsed.short || parsed.seo)) {
      res.status(200).json({
        long: parsed.long || '',
        short: parsed.short || '',
        seo: parsed.seo || ''
      });
    } else {
      // fallback: لو المودل ما رجع JSON صحيح لأي سبب، نرجع النص كامل كوصف طويل بدل ما نفشل بالكامل
      res.status(200).json({
        long: rawText || 'ما رجع نص، جرب مرة ثانية.',
        short: '',
        seo: ''
      });
    }
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
};
