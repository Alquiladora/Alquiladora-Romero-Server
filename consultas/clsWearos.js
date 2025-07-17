const express = require("express");
const crypto = require("crypto");
const { pool } = require("../connectBd");

const routerWearOs = express.Router();
routerWearOs.use(express.json());

function generateRandomToken(length = 8) {
  return crypto.randomBytes(length)
    .toString('base64')
    .replace(/[^a-zA-Z0-9]/g, '')
    .substring(0, length);
}

async function getGlobalWearOsToken() {
  const [[row]] = await pool.query("SELECT token FROM wearos_tokens ORDER BY idToken DESC LIMIT 1");
  return row ? row.token : null;
}

async function saveGlobalWearOsToken(token) {
  const [[exists]] = await pool.query("SELECT idToken FROM wearos_tokens LIMIT 1");
  if (exists) {
    await pool.query(
      "UPDATE wearos_tokens SET token = ?, updated_at = NOW() WHERE idToken = ?",
      [token, exists.idToken]
    );
  } else {
    await pool.query(
      "INSERT INTO wearos_tokens (token, created_at, updated_at) VALUES (?, NOW(), NOW())",
      [token]
    );
  }
}

routerWearOs.get('/wearos/token', async (req, res) => {
  let token = await getGlobalWearOsToken();
  if (!token) {
    token = generateRandomToken();
    await saveGlobalWearOsToken(token);
  }
  res.json({ success: true, token });
});

routerWearOs.post('/wearos/token/update', async (req, res) => {
  const token = generateRandomToken();
  await saveGlobalWearOsToken(token);
  res.json({ success: true, token });
});


routerWearOs.post('/wearos/validate-token', async (req, res) => {
  const { token } = req.body;
  const storedToken = await getGlobalWearOsToken();
  if (token === storedToken) {
    res.json({ success: true });
  } else {
    res.status(401).json({ success: false, message: 'Invalid token' });
  }
});



routerWearOs.get('/wearos/token/:token', async (req, res, next) => {
  const { token } = req.params;

  try {
    const [rows] = await pool.query(
      'SELECT * FROM wearos_tokens WHERE token = ?',
      [token]
    );

    if (rows.length === 0) {
      return res.status(401).json({ success: false, message: 'Token inválido o no encontrado' });
    }

    res.json({ success: true, token: rows[0] });
  } catch (error) {
    next(error);
  }
});


module.exports = routerWearOs;
