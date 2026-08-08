// دالة مشتركة لكل منطق الحسابات (إيميل + باسورد): تشفير، جلسات بكوكيز آمنة، وتوكنات استعادة كلمة المرور
// يبدأ اسم الملف بـ"_" عشان ما يُحسب من حد الـ12 Serverless Function بباقة Vercel المجانية
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { redisCommand } = require('./_redis');

const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60; // الجلسة تفضل فعّالة 30 يوم
const RESET_TTL_SECONDS = 60 * 60; // رابط استعادة كلمة المرور يصلح ساعة وحدة بس
const SESSION_COOKIE_NAME = 'wassaf_session';

function generateToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('hex');
}

async function hashPassword(password) {
  return bcrypt.hash(password, 10);
}

async function verifyPassword(password, hash) {
  return bcrypt.compare(password, hash);
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function isStrongEnoughPassword(password) {
  return typeof password === 'string' && password.length >= 8;
}

// ---------- جلسات الدخول ----------
async function createSession(email) {
  const token = generateToken();
  await redisCommand(['SET', `session:${token}`, email, 'EX', SESSION_TTL_SECONDS]);
  return token;
}

async function getSessionEmail(token) {
  if (!token) return null;
  return redisCommand(['GET', `session:${token}`]);
}

async function destroySession(token) {
  if (!token) return;
  await redisCommand(['DEL', `session:${token}`]);
}

// ---------- قراءة/كتابة الكوكيز يدوياً (بدون مكتبة خارجية) ----------
function parseCookies(req) {
  const header = (req.headers && req.headers.cookie) || '';
  const out = {};
  header.split(';').forEach((part) => {
    const idx = part.indexOf('=');
    if (idx === -1) return;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  });
  return out;
}

function setSessionCookie(res, token) {
  // Secure تُفعّل بس بالإنتاج (على دومين https) — محلياً بدونها الكوكي ما يشتغل
  const isProd = process.env.VERCEL_ENV === 'production' || process.env.NODE_ENV === 'production';
  const parts = [
    `${SESSION_COOKIE_NAME}=${token}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${SESSION_TTL_SECONDS}`
  ];
  if (isProd) parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
}

function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', `${SESSION_COOKIE_NAME}=; Path=/; HttpOnly; Max-Age=0`);
}

// ---------- توكنات استعادة كلمة المرور ----------
async function createResetToken(email) {
  const token = generateToken();
  await redisCommand(['SET', `reset:${token}`, email, 'EX', RESET_TTL_SECONDS]);
  return token;
}

async function consumeResetToken(token) {
  const email = await redisCommand(['GET', `reset:${token}`]);
  if (email) await redisCommand(['DEL', `reset:${token}`]);
  return email;
}

module.exports = {
  SESSION_COOKIE_NAME,
  hashPassword,
  verifyPassword,
  isValidEmail,
  isStrongEnoughPassword,
  createSession,
  getSessionEmail,
  destroySession,
  parseCookies,
  setSessionCookie,
  clearSessionCookie,
  createResetToken,
  consumeResetToken
};
