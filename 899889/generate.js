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

    const anthropicResponse = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 1200,
        messages: [{ role: 'user', content: prompt }]
      })
    });

    if (!anthropicResponse.ok) {
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
