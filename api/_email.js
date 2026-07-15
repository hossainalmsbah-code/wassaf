// دالة مشتركة لإرسال إيميلات عبر Resend REST API
async function sendEmail({ to, subject, html }) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    throw new Error('RESEND_API_KEY غير مُعد بإعدادات Vercel');
  }

  const fromAddress = process.env.RESEND_FROM_EMAIL || 'وصّاف <hello@wassaf.space>';

  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      from: fromAddress,
      to: [to],
      subject,
      html
    })
  });

  const data = await response.json();

  if (!response.ok) {
    throw new Error('فشل إرسال الإيميل: ' + (data.message || JSON.stringify(data)));
  }

  return data;
}

module.exports = { sendEmail };
