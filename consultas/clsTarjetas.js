const express = require('express');
const router = express.Router();
const { pool } = require('../connectBd');
const Stripe = require('stripe');
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

// 🔐 Función segura para validar y codificar URLs
const getSafeUrl = (envUrl, fallbackPath) => {
  try {
    const encodedPath = encodeURIComponent(fallbackPath);
    const url = new URL(envUrl || `http://localhost:3000/administrador?tab=${encodedPath}`);
    return url.toString();
  } catch (err) {
    return `http://localhost:3000/administrador?tab=${encodeURIComponent(fallbackPath)}`;
  }
};

// ================== 📩 WEBHOOK DE STRIPE ==================
router.post('/webhook', async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;

  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
    console.log(`[WEBHOOK] ${event.type} recibido - Cuenta: ${event.data.object.id}`);
  } catch (err) {
    console.error(`[WEBHOOK] Error validando webhook: ${err.message}`);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === 'account.updated') {
    const account = event.data.object;
    const stripe_account_id = account.id;
    const onboardingCompleted = account.details_submitted;

    try {
      await pool.query(
        `UPDATE tblCuentasReceptoras SET onboarding_completed = ? WHERE stripe_account_id = ?`,
        [onboardingCompleted ? 1 : 0, stripe_account_id]
      );

      if (onboardingCompleted) {
        await pool.query(`UPDATE tblCuentasReceptoras SET activa = 0`);
        await pool.query(
          `UPDATE tblCuentasReceptoras SET activa = 1 WHERE stripe_account_id = ? AND onboarding_completed = 1`,
          [stripe_account_id]
        );
      }

      res.json({ received: true });
    } catch (dbErr) {
      console.error(`[WEBHOOK] Error en DB: ${dbErr.message}`);
      res.status(500).json({ error: 'Error en base de datos' });
    }
  } else {
    res.json({ received: true });
  }
});

// ================== 👤 CREAR CUENTA ==================
router.post('/cuentas', async (req, res) => {
  const { nombre, banco, notas } = req.body;
  if (!nombre) return res.status(400).json({ error: 'El nombre es requerido' });

  try {
    const account = await stripe.accounts.create({
      type: 'express',
      country: 'MX',
      capabilities: { transfers: { requested: true } },
    });

    const accountLink = await stripe.accountLinks.create({
      account: account.id,
      refresh_url: getSafeUrl(process.env.STRIPE_REFRESH_URL, 'gestion_de_pagos'),
      return_url: getSafeUrl(process.env.STRIPE_RETURN_URL, 'gestion_de_pagos'),
      type: 'account_onboarding',
    });

    const accountDetails = await stripe.accounts.retrieve(account.id);
    const onboardingCompleted = accountDetails.details_submitted;

    await pool.query(
      `INSERT INTO tblCuentasReceptoras (stripe_account_id, nombre, banco, notas, onboarding_completed) VALUES (?, ?, ?, ?, ?)`,
      [account.id, nombre, banco || null, notas || null, onboardingCompleted ? 1 : 0]
    );

    res.status(201).json({
      message: `Cuenta creada`,
      stripe_account_id: account.id,
      onboarding_url: accountLink.url,
      onboarding_completed: onboardingCompleted,
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Error creando cuenta' });
  }
});

// ================== 🔗 REGENERAR LINK DE ONBOARDING ==================
router.get('/cuentas/onboarding-link/:stripe_account_id', async (req, res) => {
  const { stripe_account_id } = req.params;
  try {
    const accountLink = await stripe.accountLinks.create({
      account: stripe_account_id,
      refresh_url: getSafeUrl(process.env.STRIPE_REFRESH_URL, 'gestion_de_pagos'),
      return_url: getSafeUrl(process.env.STRIPE_RETURN_URL, 'gestion_de_pagos'),
      type: 'account_onboarding',
    });
    res.json({ url: accountLink.url });
  } catch (error) {
    console.error('Error generando link de onboarding:', error.message);
    res.status(500).json({ error: 'No se pudo generar el link' });
  }
});

// ================== ✅ ACTIVAR CUENTA ==================
router.post('/cuentas/activar/:id', async (req, res) => {
  const { id } = req.params;

  try {
    const [cuentas] = await pool.query(
      `SELECT stripe_account_id, onboarding_completed FROM tblCuentasReceptoras WHERE id = ?`,
      [id]
    );
    if (cuentas.length === 0) return res.status(404).json({ error: 'Cuenta no encontrada' });

    const { stripe_account_id } = cuentas[0];

    const accountDetails = await stripe.accounts.retrieve(stripe_account_id);
    if (!accountDetails.details_submitted) {
      return res.status(400).json({ error: 'El onboarding no está completo en Stripe' });
    }

    await pool.query(`UPDATE tblCuentasReceptoras SET activa = 0`);
    const [result] = await pool.query(
      `UPDATE tblCuentasReceptoras SET activa = 1 WHERE id = ?`,
      [id]
    );

    res.json({ message: 'Cuenta activada' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error activando cuenta' });
  }
});

// ================== 🚫 DESACTIVAR CUENTA ==================
router.post('/cuentas/desactivar/:id', async (req, res) => {
  const { id } = req.params;

  try {
    const [result] = await pool.query(
      `UPDATE tblCuentasReceptoras SET activa = 0 WHERE id = ?`,
      [id]
    );
    if (result.affectedRows === 0) return res.status(404).json({ error: 'Cuenta no encontrada' });

    res.json({ message: 'Cuenta desactivada' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error desactivando cuenta' });
  }
});

// ================== ❌ ELIMINAR CUENTA ==================
router.delete('/cuentas/:id', async (req, res) => {
  const { id } = req.params;

  try {
    const [cuentas] = await pool.query(
      `SELECT stripe_account_id, activa FROM tblCuentasReceptoras WHERE id = ?`,
      [id]
    );
    if (cuentas.length === 0) return res.status(404).json({ error: 'Cuenta no encontrada' });

    if (cuentas[0].activa) {
      return res.status(400).json({ error: 'No se puede eliminar una cuenta activa' });
    }

    await stripe.accounts.update(cuentas[0].stripe_account_id, {
      metadata: { deleted: 'true' },
    });

    await pool.query(`DELETE FROM tblCuentasReceptoras WHERE id = ?`, [id]);

    res.json({ message: 'Cuenta eliminada' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error eliminando cuenta' });
  }
});

// ================== 📄 LISTAR CUENTAS ==================
router.get('/cuentas', async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT * FROM tblCuentasReceptoras ORDER BY fecha_creacion DESC`
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error obteniendo cuentas' });
  }
});

module.exports = router;
