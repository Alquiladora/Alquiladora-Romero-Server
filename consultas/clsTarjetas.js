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
    console.error(`[URL] Error generando URL segura: ${err.message}`);
    return `http://localhost:3000/administrador?tab=${encodeURIComponent(fallbackPath)}`;
  }
};

// ================== 📩 WEBHOOK DE STRIPE ==================

router.post('/webhook', express.raw({ type: 'application/json' }), (req, res) => {
  console.log('[WEBHOOK] Solicitud recibida:', req.body.toString());
  res.json({ received: true });
});

// ================== 👤 CREAR CUENTA ==================
router.post('/cuentas', async (req, res) => {
  const { nombre, banco, notas } = req.body;
  if (!nombre) return res.status(400).json({ error: 'El nombre es requerido' });

  try {
    // Crea una cuenta en Stripe
    const account = await stripe.accounts.create({
      type: 'express',
      country: 'MX',
      capabilities: { transfers: { requested: true } },
    });

    // Crea un enlace para el onboarding
    const accountLink = await stripe.accountLinks.create({
      account: account.id,
      refresh_url: getSafeUrl(process.env.STRIPE_REFRESH_URL, 'gestion_de_pagos'),
      return_url: getSafeUrl(process.env.STRIPE_RETURN_URL, 'gestion_de_pagos'),
      type: 'account_onboarding',
    });

    // Verifica el estado del onboarding
    const accountDetails = await stripe.accounts.retrieve(account.id);
    const onboardingCompleted = accountDetails.details_submitted;

    // Inserta la cuenta en la base de datos
    await pool.query(
      `INSERT INTO tblCuentasReceptoras (stripe_account_id, nombre, banco, notas, onboarding_completed) VALUES (?, ?, ?, ?, ?)`,
      [account.id, nombre, banco || null, notas || null, onboardingCompleted ? 1 : 0]
    );

    res.status(201).json({
      message: 'Cuenta creada',
      stripe_account_id: account.id,
      onboarding_url: accountLink.url,
      onboarding_completed: onboardingCompleted,
    });
  } catch (error) {
    console.error(`[CUENTAS] Error creando cuenta: ${error.message}`);
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
    console.error(`[ONBOARDING] Error generando link: ${error.message}`);
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

    const { stripe_account_id, onboarding_completed } = cuentas[0];

    if (!onboarding_completed) {
      return res.status(400).json({ error: 'El onboarding no está completo en Stripe' });
    }

    await pool.query(`UPDATE tblCuentasReceptoras SET activa = 0`);
    await pool.query(`UPDATE tblCuentasReceptoras SET activa = 1 WHERE id = ?`, [id]);

    res.json({ message: 'Cuenta activada' });
  } catch (err) {
    console.error(`[ACTIVAR] Error activando cuenta: ${err.message}`);
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
    console.error(`[DESACTIVAR] Error desactivando cuenta: ${err.message}`);
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
    console.error(`[ELIMINAR] Error eliminando cuenta: ${err.message}`);
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
    console.error(`[LISTAR] Error obteniendo cuentas: ${err.message}`);
    res.status(500).json({ error: 'Error obteniendo cuentas' });
  }
});

module.exports = router;