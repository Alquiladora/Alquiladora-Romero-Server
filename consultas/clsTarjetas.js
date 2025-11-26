const express = require('express');
const router = express.Router();
const { pool } = require('../connectBd');
const Stripe = require('stripe');
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
const paymentWebhookSecret = process.env.STRIPE_PAYMENT_WEBHOOK_SECRET;

const jsonParser = express.json();

const getSafeUrl = (envUrl, fallbackPath) => {
  try {
    const encodedPath = encodeURIComponent(fallbackPath);
    
   // const url = new URL(envUrl || `https://alquiladoraromero.bina5.com/administrador?tab=${encodedPath}`);
    const url = new URL(envUrl || `http://localhost:3000/administrador?tab=${encodedPath}`);
    return url.toString();
  } catch (err) {
    console.error(`[URL] Error: ${err.message}`);
    //return `https://alquiladoraromero.bina5.com/administrador?tab=${encodeURIComponent(fallbackPath)}`;
    return `http://localhost:3000/administrador?tab=${encodeURIComponent(fallbackPath)}`;
  }
};

/**
 * Función central y ATÓMICA para establecer una única cuenta activa.
 * @param {number} accountIdToActivate - El ID de la tabla tblCuentasReceptoras.
 */
async function setUniqueActiveAccount(accountIdToActivate) {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const [rows] = await connection.query(
      `SELECT stripe_account_id, onboarding_completed FROM tblCuentasReceptoras WHERE id = ? FOR UPDATE`,
      [accountIdToActivate]
    );
    if (rows.length === 0) throw new Error('Cuenta no encontrada para activar.');
    const accountToActivate = rows[0];
    console.log(`[SET_ACTIVE] Activando cuenta: ${accountToActivate.stripe_account_id}`);

    if (!accountToActivate.onboarding_completed) {
      throw new Error('No se puede activar una cuenta que no ha completado el onboarding en Stripe.');
    }

    const [activeAccounts] = await connection.query(
      `SELECT id, stripe_account_id FROM tblCuentasReceptoras WHERE activa = 1 FOR UPDATE`
    );
    if (activeAccounts.length > 0 && activeAccounts[0].id !== accountIdToActivate) {
      const previouslyActiveAccount = activeAccounts[0];
      console.log(`[SET_ACTIVE] Desactivando cuenta previa: ${previouslyActiveAccount.stripe_account_id}`);
      const deactivated = await stripe.accounts.update(previouslyActiveAccount.stripe_account_id, {
        capabilities: {
          card_payments: { requested: false },
          link_payments: { requested: false },
        },
      });
      console.log(`[SET_ACTIVE] Estado después de desactivar: ${JSON.stringify(deactivated.capabilities)}`);
      // Verificar el estado real después de la actualización
      const updatedPrevAccount = await stripe.accounts.retrieve(previouslyActiveAccount.stripe_account_id);
      if (updatedPrevAccount.capabilities.card_payments === 'active' || updatedPrevAccount.capabilities.link_payments === 'active') {
        console.warn(`[SET_ACTIVE] Advertencia: No se pudieron desactivar las capacidades para ${previouslyActiveAccount.stripe_account_id}. Acción manual requerida.`);
        // Opcional: Notificar o registrar esto para acción manual
      }
    }

    const stripeAccount = await stripe.accounts.retrieve(accountToActivate.stripe_account_id);
    console.log(`[SET_ACTIVE] Capacidades actuales: ${JSON.stringify(stripeAccount.capabilities)}`);
    const capabilitiesToUpdate = {};
    if (!stripeAccount.capabilities.card_payments || !stripeAccount.capabilities.link_payments) {
      capabilitiesToUpdate.card_payments = { requested: true };
      capabilitiesToUpdate.link_payments = { requested: true };
      console.log(`[SET_ACTIVE] Activando capacidades para: ${accountToActivate.stripe_account_id}`);
    }
    if (Object.keys(capabilitiesToUpdate).length > 0) {
      const updatedAccount = await stripe.accounts.update(accountToActivate.stripe_account_id, {
        capabilities: capabilitiesToUpdate,
      });
      console.log(`[SET_ACTIVE] Estado después de activar: ${JSON.stringify(updatedAccount.capabilities)}`);
    }

    await connection.query(`UPDATE tblCuentasReceptoras SET activa = 0`);
    await connection.query(`UPDATE tblCuentasReceptoras SET activa = 1 WHERE id = ?`, [accountIdToActivate]);
    console.log(`[SET_ACTIVE] Cuenta ${accountIdToActivate} marcada como activa`);

    await connection.commit();
  } catch (error) {
    await connection.rollback();
    console.error('[SET_ACTIVE] Error en la transacción:', error.message, error.stack);
    throw error;
  } finally {
    connection.release();
  }
}


router.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, webhookSecret);
  } catch (err) {
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === 'account.updated') {
    const account = event.data.object;
    const detailsSubmitted = !!account.details_submitted;
    const chargesEnabled = !!account.charges_enabled;
    const payoutsEnabled = !!account.payouts_enabled;
    const isNowOnboardingComplete = detailsSubmitted && chargesEnabled && payoutsEnabled;

    try {
      const [localAccounts] = await pool.query(`SELECT id, onboarding_completed FROM tblCuentasReceptoras WHERE stripe_account_id = ?`, [account.id]);

      if (localAccounts.length > 0) {
        const localAccount = localAccounts[0];
        const wasPreviouslyOnboardingComplete = !!localAccount.onboarding_completed;

        await pool.query(
          `UPDATE tblCuentasReceptoras SET onboarding_completed = ?, details_submitted = ?, charges_enabled = ?, payouts_enabled = ? WHERE stripe_account_id = ?`,
          [isNowOnboardingComplete, detailsSubmitted, chargesEnabled, payoutsEnabled, account.id]
        );

        if (isNowOnboardingComplete && !wasPreviouslyOnboardingComplete) {
          console.log(`[WEBHOOK] Onboarding completo para ID local: ${localAccount.id}. Activando...`);
          await setUniqueActiveAccount(localAccount.id);
        }
      }
    } catch (polError) {
      console.error(`[DB-WEBHOOK] Error: ${dbError.message}`);
      return res.status(500).json({ error: 'Error de base de datos en el webhook.' });
    }
  }
  res.json({ received: true });
});






//_______________________________________________________________________________________________________________-
// CREAR CUENTA
router.post('/cuentas', jsonParser, async (req, res) => {
  const { nombre, email, banco, notas } = req.body;

  console.log("Datos recibidos para crea tarjeta ")
  if (!nombre || !email) return res.status(400).json({ error: 'El nombre y el email son requeridos' });
  try {
    const account = await stripe.accounts.create({
      type: 'express',
      country: 'MX',
      email,
      business_type: 'individual',
      capabilities: {
        card_payments: { requested: true },
        link_payments: { requested: true },
        transfers: { requested: true },
      },
      business_profile: { name: nombre },
    });
    const accountLink = await stripe.accountLinks.create({
      account: account.id,
      refresh_url: getSafeUrl(process.env.STRIPE_REFRESH_URL, 'gestion_de_pagos'),
      return_url: getSafeUrl(process.env.STRIPE_RETURN_URL, 'gestion_de_pagos'),
      type: 'account_onboarding',
    });
    await pool.query(
      `INSERT INTO tblCuentasReceptoras (stripe_account_id, nombre, email, banco, notas, activa) VALUES (?, ?, ?, ?, ?, ?)`,
      [account.id, nombre, email, banco || null, notas || null, 0]
    );
    res.status(201).json({
      message: 'Cuenta creada. Completa la configuración en Stripe.',
      stripe_account_id: account.id,
      onboarding_url: accountLink.url,
    });
  } catch (error) {
    console.error(`[CUENTAS] Error: ${error.message}`);
    res.status(500).json({ error: 'Error interno al crear la cuenta en Stripe.' });
  }
});


router.post('/cuentas/activar/:id', async (req, res) => {
  const { id } = req.params;
  try {
    await setUniqueActiveAccount(id);
    res.json({ message: 'Cuenta activada correctamente.' });
  } catch (err) {
    console.error(`[ACTIVAR] Error: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});


router.get('/cuentas', async (req, res) => {
  try {
    const [rows] = await pool.query(`SELECT id, stripe_account_id, nombre, email, banco, notas, onboarding_completed, details_submitted, charges_enabled, payouts_enabled, activa, fecha_creacion FROM tblCuentasReceptoras ORDER BY fecha_creacion DESC`);
    res.json(rows);
  } catch (err) {
    console.error(`[LISTAR] Error obteniendo cuentas: ${err.message}`);
    res.status(500).json({ error: 'Error obteniendo cuentas' });
  }
});

// OBTENER LINK DE ONBOARDING
router.get('/cuentas/onboarding-link/:stripe_account_id', async (req, res) => {
  const { stripe_account_id } = req.params;
  try {
    const accountLink = await stripe.accountLinks.create({
      account: stripe_account_id,
      refresh_url: getSafeUrl(process.env.STRIPE_REFRESH_URL, 'gestion_de_pagos'),
      return_url: getSafeUrl(process.env.STRIPE_RETURN_URL, 'gestion_de_pagos'),
      type: 'account_onboarding',
      // Opcional: Especificar capacidades explícitamente si es necesario
      // capabilities: { card_payments: { requested: true }, link_payments: { requested: true } },
    });
    res.json({ url: accountLink.url });
  } catch (error) {
    console.error(`[ONBOARDING] Error generando link: ${error.message}`);
    res.status(500).json({ error: 'No se pudo generar el link' });
  }
});



// SINCRONIZAR CUENTAS
router.get('/sync-cuentas', async (req, res) => {
  try {
    const [cuentasLocales] = await pool.query('SELECT id, stripe_account_id FROM tblCuentasReceptoras');
    if (cuentasLocales.length === 0) return res.json({ message: 'No hay cuentas para sincronizar.' });
    let cuentasActualizadas = 0;
    for (const cuenta of cuentasLocales) {
      try {
        const stripeAccount = await stripe.accounts.retrieve(cuenta.stripe_account_id);
        const detailsSubmitted = stripeAccount.details_submitted ? 1 : 0;
        const chargesEnabled = stripeAccount.charges_enabled ? 1 : 0;
        const payoutsEnabled = stripeAccount.payouts_enabled ? 1 : 0;
        const onboardingCompleted = (detailsSubmitted && chargesEnabled && payoutsEnabled) ? 1 : 0;
        await pool.query(`UPDATE tblCuentasReceptoras SET onboarding_completed = ?, details_submitted = ?, charges_enabled = ?, payouts_enabled = ? WHERE stripe_account_id = ?`, [onboardingCompleted, detailsSubmitted, chargesEnabled, payoutsEnabled, stripeAccount.id]);
        cuentasActualizadas++;
      } catch (stripeError) {
        if (stripeError.code === 'account_invalid') {
          console.warn(`[SYNC] La cuenta ${cuenta.stripe_account_id} no se encontró en Stripe. Eliminándola localmente.`);
          await pool.query(`DELETE FROM tblCuentasReceptoras WHERE stripe_account_id = ?`, [cuenta.stripe_account_id]);
        } else {
          console.error(`[SYNC] No se pudo sincronizar ${cuenta.stripe_account_id}: ${stripeError.message}`);
        }
      }
    }
    res.json({ message: `Sincronización completa. Cuentas procesadas: ${cuentasLocales.length}. Cuentas actualizadas/verificadas: ${cuentasActualizadas}` });
  } catch (err) {
    console.error(`[SYNC] Error general en sincronización: ${err.message}`);
    res.status(500).json({ error: 'Error durante la sincronización.' });
  }
});

// ELIMINAR CUENTA
router.delete('/cuentas/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const [cuentas] = await pool.query(`SELECT stripe_account_id, activa FROM tblCuentasReceptoras WHERE id = ?`, [id]);
    if (cuentas.length === 0) return res.status(404).json({ error: 'Cuenta no encontrada' });
    if (cuentas[0].activa) return res.status(400).json({ error: 'No se puede eliminar una cuenta que está activa.' });
    try {
      await stripe.accounts.del(cuentas[0].stripe_account_id);
    } catch (stripeError) {
      console.warn(`[ELIMINAR] No se pudo eliminar la cuenta ${cuentas[0].stripe_account_id} de Stripe (puede que ya no exista): ${stripeError.message}`);
    }
    await pool.query(`DELETE FROM tblCuentasReceptoras WHERE id = ?`, [id]);
    res.json({ message: 'Cuenta eliminada correctamente de la base de datos.' });
  } catch (err) {
    console.error(`[ELIMINAR] Error eliminando cuenta: ${err.message}`);
    res.status(500).json({ error: 'Error eliminando cuenta' });
  }
});



//==================================================PAGOS---------------------
const generateNumericTrackingId = () => {
  const timestamp = Date.now().toString();
  const randomDigits = Math.floor(Math.random() * 100).toString().padStart(2, "0");
  return "ROMERO-" + timestamp + randomDigits;
};

// NUEVO WEBHOOK PARA PAGOS COMPLETADOS

router.post('/notificar-pago', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, paymentWebhookSecret);
  } catch (err) {
    console.log(`Webhook de Pagos - Error de firma: ${err.message}`);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
   const { tempPedidoId, idUsuario, puntosUsados } = session.metadata;
    const connection = await pool.getConnection();
    try {
      console.log(`Procesando Pedido Temporal: ${tempPedidoId} para Usuario: ${idUsuario}`);
      const [tempOrders] = await connection.query(
        "SELECT * FROM tblPedidosTemporales WHERE tempPedidoId = ?",
        [tempPedidoId]
      );

      if (tempOrders.length === 0) {
        console.warn(`Webhook recibido para un pedido temporal no encontrado o ya procesado: ${tempPedidoId}`);
        return res.status(200).json({ received: true, message: 'Pedido no encontrado o ya procesado.' });
      }
      const tempOrder = tempOrders[0];
      const cartItems = JSON.parse(tempOrder.cartItems);


      for (const item of cartItems) {
        const [inventario] = await connection.query(
          "SELECT stock FROM tblinventario WHERE idProductoColor = ?",
          [item.idProductoColor]
        );
        if (inventario.length === 0 || inventario[0].stock < item.cantidad) {

          console.error(`Error de stock para producto ${item.idProductoColor}. Stock disponible: ${inventario[0]?.stock || 0}, solicitado: ${item.cantidad}`);

          return res.status(500).json({ error: 'Stock insuficiente.' });
        }
      }
      console.log('Stock verificado exitosamente.');
      await connection.beginTransaction();
      console.log('Transacción iniciada.');
      const idRastreo = generateNumericTrackingId();
      const totalPagar = session.amount_total / 100;

      const [pedidoResult] = await connection.query(
        `INSERT INTO tblpedidos (idUsuarios, idDireccion, fechaInicio, fechaEntrega, horaAlquiler, totalPagar, estadoActual, tipoPedido, idRastreo) VALUES (?, ?, ?, ?, CURTIME(), ?, ?, 'Online', ?)`,
        [idUsuario, tempOrder.idDireccion, tempOrder.fechaInicio, tempOrder.fechaEntrega, totalPagar, 'Confirmado', idRastreo]
      );
      const nuevoPedidoId = pedidoResult.insertId;
      console.log(`Pedido permanente creado con ID: ${nuevoPedidoId}`);

      for (const item of cartItems) {
        const diasAlquiler = (new Date(tempOrder.fechaEntrega) - new Date(tempOrder.fechaInicio)) / (1000 * 60 * 60 * 24);
        const subtotal = item.cantidad * item.precioPorDia * diasAlquiler;
        await connection.query(
          `INSERT INTO tblpedidodetalles (idPedido, idProductoColores, cantidad, precioUnitario, diasAlquiler, subtotal, estadoProducto) VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [nuevoPedidoId, item.idProductoColor, item.cantidad, item.precioPorDia, diasAlquiler, subtotal, 'Disponible']
        );
        await connection.query(
          "UPDATE tblinventario SET stock = stock - ?, stockReservado = stockReservado - ? WHERE idProductoColor = ?",
          [item.cantidad, item.cantidad, item.idProductoColor]
        );

      }
      console.log('Detalles de pedido creados y stock actualizado.');
      await connection.query(
        `INSERT INTO tblpagos (idPedido, formaPago, metodoPago, monto, estadoPago, detallesPago) VALUES (?, ?, ?, ?, ?, ?)`,
        [nuevoPedidoId, 'Tarjeta', session.payment_method_types[0], totalPagar, 'Completado', session.payment_intent]
      );
      console.log('Registro de pago creado.');


      await connection.query("DELETE FROM tblcarrito WHERE idUsuario = ?", [idUsuario]);
      await connection.query("DELETE FROM tblPedidosTemporales WHERE tempPedidoId = ?", [tempPedidoId]);
      console.log('Limpieza de carrito y pedido temporal completada.');

        const puntosGastados = parseInt(puntosUsados || 0);
            if (puntosGastados > 0) {
              console.log(`Registrando canje de ${puntosGastados} puntos para el pedido ${nuevoPedidoId}`);
              
              await pool.query(
                `INSERT INTO tblPuntos 
                 (idUsuario, tipoMovimiento, puntos, fechaMovimiento, idPedido) 
                 VALUES (?, ?, ?, NOW(), ?)`,
                [
                  idUsuario,           
                  'Canje por compra',  
                  -puntosGastados,     
                  nuevoPedidoId        
                ]
              );
            }
      


      await connection.commit();
      console.log(`✅ Transacción completada exitosamente para Pedido ID: ${nuevoPedidoId}.`);

    } catch (dbError) {

      await connection.rollback();
      console.error(`[DB-WEBHOOK-PAGO] Error en la transacción, se hizo ROLLBACK. Error: ${dbError.message}`);

      return res.status(500).json({ error: 'Error procesando el pedido.' });
    } finally {

      connection.release();
    }
  }
  res.json({ received: true });
});




module.exports = router;