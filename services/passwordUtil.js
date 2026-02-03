// services/passwordUtil.js
const crypto = require('crypto');

// Generate a random "complex" password:
// - length default 14
// - includes upper/lower/digit/symbol
function generateComplexPassword(length = 14) {
  const upper = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  const lower = 'abcdefghijkmnopqrstuvwxyz';
  const digits = '23456789';
  const symbols = '!@#$%^&*()-_=+[]{};:,.?';

  const all = upper + lower + digits + symbols;

  // ensure at least one from each class
  const pick = (s) => s[Math.floor(Math.random() * s.length)];
  const chars = [
    pick(upper),
    pick(lower),
    pick(digits),
    pick(symbols),
  ];

  // fill the rest
  for (let i = chars.length; i < length; i++) {
    chars.push(pick(all));
  }

  // shuffle (crypto-safe shuffle)
  for (let i = chars.length - 1; i > 0; i--) {
    const j = crypto.randomInt(0, i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }

  return chars.join('');
}

module.exports = {
  generateComplexPassword,
};
