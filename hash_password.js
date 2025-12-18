// hash_password.js
const bcrypt = require('bcrypt');

async function run() {
  const plainPassword = process.argv[2];

  if (!plainPassword) {
    console.error('Usage: node hash_password.js <password>');
    process.exit(1);
  }

  const saltRounds = 10;
  const hash = await bcrypt.hash(plainPassword, saltRounds);
  console.log('Plain password:', plainPassword);
  console.log('BCrypt hash   :', hash);
}

run().catch((err) => {
  console.error('Error while hashing:', err);
  process.exit(1);
});
