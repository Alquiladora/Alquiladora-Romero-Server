const express = require('express');
const router = express.Router();
const { pool } = require('../connectBd');
const Stripe = require('stripe');
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;




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



// ================== 📩 WEBHOOK DE STRIPE (CORREGIDO Y SEGURO) ==================
router.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;

  try {
    event = stripe.webhooks.constructEvent(req.body, sig, webhookSecret);
  } catch (err) {
    console.log(`[WEBHOOK] ⚠️ Error en la firma: ${err.message}`);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === 'account.updated') {
    const account = event.data.object;
    const detailsSubmitted = account.details_submitted;
    const chargesEnabled = account.charges_enabled;
    const payoutsEnabled = account.payouts_enabled;
    try {
      await pool.query(
        `UPDATE tblCuentasReceptoras 
         SET 
           onboarding_completed = ?, 
           details_submitted = ?, 
           charges_enabled = ?, 
           payouts_enabled = ?
         WHERE stripe_account_id = ?`,
        [detailsSubmitted, detailsSubmitted, chargesEnabled, payoutsEnabled, account.id]
      );
      console.log(`[DB-WEBHOOK] Estado completo actualizado para ${account.id}`);
    } catch (dbError) {
      console.error(`[DB-WEBHOOK] Error: ${dbError.message}`);
      return res.status(500).json({ error: 'Error en base de datos' });
    }
  }

  res.json({ received: true });
});



// ================== CREAR CUENTA ==================
router.post('/cuentas', async (req, res) => {
  const { nombre, email, banco, notas } = req.body;
  if (!nombre || !email) {
    return res.status(400).json({ error: 'El nombre y el email son requeridos' });
  }

  try {
    const account = await stripe.accounts.create({
      type: 'express',
      country: 'MX',
      email: email, 
      business_type: 'individual',
      capabilities: {
        card_payments: { requested: true },
        transfers: { requested: true },
      },
      business_profile: {
        name: nombre,
      },
    });

    // El resto del código no cambia...
    const accountLink = await stripe.accountLinks.create({
      account: account.id,
      refresh_url: getSafeUrl(process.env.STRIPE_REFRESH_URL, 'gestion_de_pagos'),
      return_url: getSafeUrl(process.env.STRIPE_RETURN_URL, 'gestion_de_pagos'),
      type: 'account_onboarding',
    });

    await pool.query(
      `INSERT INTO tblCuentasReceptoras (stripe_account_id, nombre, email, banco, notas, onboarding_completed) VALUES (?, ?, ?, ?, ?, ?)`,
      [account.id, nombre, email, banco || null, notas || null, 0]
    );

    res.status(201).json({
      message: 'Cuenta creada. El usuario debe completar la configuración en Stripe.',
      stripe_account_id: account.id,
      onboarding_url: accountLink.url,
    });

  } catch (error) {
    console.error(`[CUENTAS] Error creando cuenta: ${error.message}`);
    res.status(500).json({ error: 'Error interno al crear la cuenta en Stripe.' });
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
    // 1. Buscar la cuenta a activar
    const [cuentas] = await pool.query(
      `SELECT id, stripe_account_id, onboarding_completed FROM tblCuentasReceptoras WHERE id = ?`,
      [id]
    );
    if (cuentas.length === 0) return res.status(404).json({ error: 'Cuenta no encontrada' });

    const { stripe_account_id, onboarding_completed } = cuentas[0];

    if (!onboarding_completed) {
      return res.status(400).json({ error: 'El onboarding no está completo en Stripe' });
    }

    // 2. Buscar la cuenta que está activa actualmente
    const [activas] = await pool.query(
      `SELECT id, stripe_account_id FROM tblCuentasReceptoras WHERE activa = 1 AND id != ?`,
      [id]
    );

    // 3. Desactivar en Stripe la cuenta que estaba activa antes (si hay una)
    for (const cuenta of activas) {
      await stripe.accounts.update(cuenta.stripe_account_id, {
        capabilities: {
          card_payments: { requested: false },
          transfers: { requested: false }
        }
      });
    }

    // 4. Activar en Stripe esta nueva cuenta
    await stripe.accounts.update(stripe_account_id, {
      capabilities: {
        card_payments: { requested: true },
        transfers: { requested: true }
      }
    });

    // 5. Actualizar la base de datos
    await pool.query(`UPDATE tblCuentasReceptoras SET activa = 0`);
    await pool.query(`UPDATE tblCuentasReceptoras SET activa = 1 WHERE id = ?`, [id]);

    res.json({ message: 'Cuenta activada correctamente y Stripe actualizado' });
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

// ================== ❌ ELIMINAR CUENTA (CORREGIDO) ==================
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

    // ✅ USA .del() PARA ELIMINAR LA CUENTA DE STRIPE
    await stripe.accounts.del(cuentas[0].stripe_account_id);

    // Después, elimínala de tu base de datos
    await pool.query(`DELETE FROM tblCuentasReceptoras WHERE id = ?`, [id]);

    res.json({ message: 'Cuenta eliminada de Stripe y de la plataforma' });
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



// ================== 🔄 SINCRONIZAR CUENTAS MANUALMENTE ==================
router.get('/sync-cuentas', async (req, res) => {
  try {
    // 1. Obtiene todas las cuentas de tu base de datos
    const [cuentasLocales] = await pool.query('SELECT stripe_account_id FROM tblCuentasReceptoras');
    console.log("CUENTAS A SICRONIZAR", cuentasLocales)
    if (cuentasLocales.length === 0) {
      return res.json({ message: 'No hay cuentas para sincronizar.' });
    }

    let cuentasActualizadas = 0;

    // 2. Itera sobre cada cuenta y pide su estado a Stripe
    for (const cuenta of cuentasLocales) {
      try {
        const stripeAccount = await stripe.accounts.retrieve(cuenta.stripe_account_id);
        
        // 3. Actualiza tu base de datos con los datos frescos de Stripe
        await pool.query(
          `UPDATE tblCuentasReceptoras 
           SET 
             onboarding_completed = ?, 
             details_submitted = ?, 
             charges_enabled = ?, 
             payouts_enabled = ?
           WHERE stripe_account_id = ?`,
          [
            stripeAccount.details_submitted,
            stripeAccount.details_submitted,
            stripeAccount.charges_enabled,
            stripeAccount.payouts_enabled,
            stripeAccount.id
          ]
        );
        cuentasActualizadas++;
      } catch (stripeError) {
        // Si una cuenta fue eliminada en Stripe, podría dar error. Lo ignoramos para seguir.
        console.error(`[SYNC] No se pudo sincronizar ${cuenta.stripe_account_id}: ${stripeError.message}`);
      }
    }

    res.json({ message: `Sincronización completa. Cuentas procesadas: ${cuentasActualizadas}` });

  } catch (err) {
    console.error(`[SYNC] Error general en sincronización: ${err.message}`);
    res.status(500).json({ error: 'Error durante la sincronización.' });
  }
});

module.exports = router;