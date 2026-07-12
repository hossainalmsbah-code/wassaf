// دالة مشتركة لإرسال أوامر Redis عبر REST API الخاص بـ Upstash
// كل أمر يُرسل كمصفوفة، مثال: redisCommand(['GET', 'code:ABC123'])
async function redisCommand(command) {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;

  if (!url || !token) {
    throw new Error('Redis غير مُعد: تأكد من إضافة UPSTASH_REDIS_REST_URL و UPSTASH_REDIS_REST_TOKEN بإعدادات Vercel');
  }

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(command)
  });

  const data = await response.json();

  if (data.error) {
    throw new Error('Redis error: ' + data.error);
  }

  return data.result;
}

module.exports = { redisCommand };
