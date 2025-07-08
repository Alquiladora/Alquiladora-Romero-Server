const express = require("express");
const argon2 = require("argon2");
const cookieParser = require("cookie-parser");
const jwt = require("jsonwebtoken");
const { v4: uuidv4 } = require("uuid");
const rateLimit = require("express-rate-limit");
const winston = require("winston");
const crypto = require("crypto");
const { pool } = require("../connectBd");
const { csrfProtection } = require("../config/csrf");
const { getIO } = require("../config/socket");
const moment = require("moment-timezone");
const { listeners } = require("process");
const { route } = require("./clssesiones");
const { obtenerFechaMexico } = require("./clsUsuarios");
const { verifyToken } = require("./clsUsuarios");

function todayMx() {
  return moment.tz("America/Mexico_City").startOf("day");
}

function nowMx() {
  return moment.tz("America/Mexico_City");
}

const routerRepartidorPedidos = express.Router();
routerRepartidorPedidos.use(express.json());
routerRepartidorPedidos.use(cookieParser());

routerRepartidorPedidos.get(
  "/repartidores",
  verifyToken,
  csrfProtection,
  async (req, res, next) => {
    try {
      const [rows] = await pool.query(
        `
        SELECT 
          u.idUsuarios,
          u.nombre,
          u.apellidoP,
          u.correo,
          u.telefono,
          p.fotoPerfil,
          r.activo,
          r.fechaAlta
        FROM tblusuarios AS u
        INNER JOIN tblrepartidores AS r
          ON u.idUsuarios = r.idUsuario
        LEFT JOIN tblperfilusuarios AS p
          ON u.idUsuarios = p.idUsuarios
        WHERE u.rol = 'repartidor'
          AND r.activo = 1
        ORDER BY r.fechaAlta DESC;
        `
      );

      return res.json({
        success: true,
        repartidores: rows,
      });
    } catch (err) {
      console.error("Error al obtener repartidores:", err);
      return res.status(500).json({
        success: false,
        message: "Error interno al consultar repartidores",
      });
    }
  }
);

//cONSULTA DE CUANDOS PEDIDOS TOTALES HAY PARA HOY
async function countByDate(date) {
  try {
    const [[{ v }]] = await pool.query(
      `SELECT COUNT(*) AS v FROM tblpedidos WHERE DATE(CONVERT_TZ(fechaInicio, '+00:00', '-06:00')) = ?`,
      [date]
    );
    return v;
  } catch (err) {
    console.error("Error en countByDate:", err);
    throw err;
  }
}

async function getEntregaReal(fechaInicio, fechaRegistro) {
  const inicio = moment.tz(fechaInicio, "America/Mexico_City").startOf("day");
  const registro = moment.tz(fechaRegistro, "America/Mexico_City").startOf("day");
  const today = todayMx();
  const dia = inicio.day();
  if (inicio.isSame(registro, "day") && inicio.isSame(today, "day")) {
    return today;
  }

  if (dia >= 2 && dia <= 6) {
    return moment(inicio).subtract(1, "day");
  }

  if (dia === 1) {
    const viernes = moment(inicio).day(-2);
    const sabado = moment(inicio).day(6);
    const cargaViernes = await countByDate(viernes.format("YYYY-MM-DD"));
    const cargaSabado = await countByDate(sabado.format("YYYY-MM-DD"));
    return cargaViernes <= cargaSabado ? viernes : sabado;
  }

  return null; // Casos no válidos
}

routerRepartidorPedidos.get("/pedidos", async (req, res) => {
  try {
    const today = todayMx();

    const fechaMinimaEntrega = moment(today).subtract(14, "days").format("YYYY-MM-DD");
    const fechaMaximaEntrega = moment(today).add(8, "days").format("YYYY-MM-DD");
    const fechaEntregaRecogidaLimite = moment(today).format("YYYY-MM-DD"); 

    const [rows] = await pool.query(
      `
      SELECT
        p.idPedido,
        p.idUsuarios,
        p.idNoClientes,
        p.idRastreo,
        p.estadoActual,
        p.totalPagar,
        COALESCE(SUM(pg.monto), 0) AS totalPagado,
        (COALESCE(SUM(pg.monto), 0) >= p.totalPagar) AS isFullyPaid,
        p.fechaInicio,
        p.fechaEntrega,
        p.horaAlquiler,
        p.fechaRegistro,
        d.idDireccion,
        d.nombre,
        d.apellido,
        d.telefono,
        d.codigoPostal,
        d.estado AS direccionEstado,
        d.municipio,
        d.localidad,
        d.direccion,
        d.referencias
      FROM tblpedidos p
      LEFT JOIN tblpagos pg ON p.idPedido = pg.idPedido
      INNER JOIN tbldireccioncliente d ON p.idDireccion = d.idDireccion
      LEFT JOIN tblasignacionpedidos ap ON p.idPedido = ap.idPedido
      WHERE (
        (
          LOWER(p.estadoActual) IN ('confirmado')
          AND p.fechaInicio >= ?
          AND p.fechaInicio < ?
        )
        OR (
          LOWER(p.estadoActual) = 'en alquiler'
          AND (
            p.fechaEntrega <= ?
            OR ap.idAsignacion IS NULL
          )
        )
      )
      GROUP BY p.idPedido
      `,
      [fechaMinimaEntrega, fechaMaximaEntrega, fechaEntregaRecogidaLimite]
    );

    const deliveries = [];
    const lateDeliveries = [];
    const pickups = [];
    const daysSet = new Set();

    for (const r of rows) {
      const entregaReal = await getEntregaReal(r.fechaInicio, r.fechaRegistro);
      if (!entregaReal) continue;

      const entregaRealStr = entregaReal.format("YYYY-MM-DD");
      const dayOfWeek = entregaReal.day();

      const isUrgent =
        moment.tz(r.fechaRegistro, "America/Mexico_City").isSame(today, "day") &&
        moment.tz(r.fechaInicio, "America/Mexico_City").isSame(today, "day");

      if (r.estadoActual.toLowerCase() === "confirmado" || r.estadoActual.toLowerCase() === "enviando") {
        const esAtrasado = moment(r.fechaInicio).isBefore(today, "day") || (entregaReal && entregaReal.isBefore(today, "day"));

        const entregaObj = {
          ...r,
          entregaReal: entregaRealStr,
          isUrgent,
          sameDay: isUrgent,
          tipo: "entrega",
          atrasado: esAtrasado,
        };

        if (esAtrasado) {
          lateDeliveries.push(entregaObj);
          if (moment(r.fechaInicio).day() !== 0) {
            daysSet.add(moment(r.fechaInicio).format("YYYY-MM-DD"));
          }
        } else {
          deliveries.push(entregaObj);
          if (dayOfWeek !== 0) daysSet.add(entregaRealStr);
        }
        continue;
      }

      if (r.estadoActual.toLowerCase() === "en alquiler") {
        const fechaRecogida = moment.tz(r.fechaEntrega, "America/Mexico_City").add(1, "day");
        const fechaRecogidaStr = fechaRecogida.format("YYYY-MM-DD");

        if (fechaRecogida.isSameOrBefore(today)) {
          pickups.push({
            ...r,
            fechaRecogidaReal: fechaRecogidaStr,
            tipo: "recogida",
          });

          if (fechaRecogida.day() !== 0) {
            daysSet.add(fechaRecogidaStr);
          }
        }
      }
    }

    const days = Array.from(daysSet).sort();

    deliveries.sort((a, b) => {
      if (a.isUrgent && !b.isUrgent) return -1;
      if (!a.isUrgent && b.isUrgent) return 1;
      return 0;
    });

    const totalsByLocation = {};

  const todos = [...deliveries, ...lateDeliveries, ...pickups];

todos.forEach((r) => {
  const key = `${r.direccionEstado}||${r.municipio}||${r.localidad}`;
  if (!totalsByLocation[key]) {
    totalsByLocation[key] = {
      estado: r.direccionEstado,
      municipio: r.municipio,
      localidad: r.localidad,
      count: 0,
    };
  }
  totalsByLocation[key].count++;
});


    const [[{ totalPedidosHoy }]] = await pool.query(
      `
      SELECT COUNT(*) AS totalPedidosHoy
      FROM tblpedidos p
      LEFT JOIN tblasignacionpedidos ap ON p.idPedido = ap.idPedido
      WHERE (
        (
          LOWER(p.estadoActual) IN ('confirmado', 'enviando')
          AND DATE(CONVERT_TZ(p.fechaInicio, '+00:00', '-06:00')) = ?
        )
        OR (
          LOWER(p.estadoActual) = 'en alquiler'
          AND DATE(CONVERT_TZ(p.fechaEntrega, '+00:00', '-06:00')) = ?
        )
      )
      `,
      [today.format("YYYY-MM-DD"), moment(today).subtract(1, "day").format("YYYY-MM-DD")]
    );

    const [[{ totalPedidos }]] = await pool.query(
      "SELECT COUNT(*) AS totalPedidos FROM tblpedidos"
    );
    const [[{ totalRepartidores }]] = await pool.query(
      "SELECT COUNT(*) AS totalRepartidores FROM tblrepartidores"
    );
    const [[{ totalPedidosAsignados }]] = await pool.query(
      "SELECT COUNT(*) AS totalPedidosAsignados FROM tblasignacionpedidos"
    );

    return res.json({
      success: true,
      days,
      deliveries,
      lateDeliveries,
      pickups,
      totalsByLocation: Object.values(totalsByLocation),
      totalPedidos,
      totalRepartidores,
      totalPedidosAsignados,
      totalPedidosHoy,
    });
  } catch (err) {
    console.error("Error al obtener pedidos:", err);
    return res.status(500).json({
      success: false,
      message: "Error interno al consultar pedidos",
    });
  }
});




function todayMx() {
  return moment.tz("America/Mexico_City").startOf("day");
}



routerRepartidorPedidos.get("/wearOs/repartidores", async (req, res) => {
  try {
    const sql = `
      SELECT
        u.idUsuarios,
        u.nombre,
        u.apellidoP,
        u.apellidoM,
        u.correo,
        u.telefono
      FROM tblusuarios AS u
      JOIN tblrepartidores AS r ON r.idUsuario = u.idUsuarios
      WHERE u.rol = 'repartidor'
        AND r.activo = 1
      ORDER BY u.nombre, u.apellidoP;
    `;

    const [rows] = await pool.query(sql);

    // Si no hay repartidores activos, devolvemos array vacío
    if (!rows.length) {
      return res.status(200).json({ success: true, repartidores: [] });
    }

    // Respondemos con la lista de repartidores
    return res.status(200).json({
      success: true,
      repartidores: rows,
    });
  } catch (error) {
    console.error("Error al obtener repartidores activos:", error);
    return res.status(500).json({
      success: false,
      message: "Error interno del servidor",
    });
  }
});

//Obtener los repartidores para compenenete gestios repartidore

routerRepartidorPedidos.get("/administrar/repartidores",
  verifyToken,
  csrfProtection,
  async (req, res) => {
    try {
      const [rows] = await pool.query(`
    SELECT 
  r.idRepartidor,
  u.nombre,
  u.apellidoP,
  u.apellidoM,
  u.correo,
  u.telefono,
  u.fechaCreacion,
  r.activo AS estado,
  r.fechaAlta,
  r.fechaBaja,
  pu.fotoPerfil,

 
  (
    SELECT COUNT(*)
    FROM tblasignacionpedidos ap
    JOIN tblpedidos p ON ap.idPedido = p.idPedido
    WHERE ap.idRepartidor = r.idRepartidor
      AND LOWER(p.estadoActual) = 'finalizado'
  ) AS pedidosFinalizados,

  (
    SELECT COUNT(*)
    FROM tblasignacionpedidos ap
    JOIN tblpedidos p ON ap.idPedido = p.idPedido
    WHERE ap.idRepartidor = r.idRepartidor
      AND LOWER(p.estadoActual) = 'enviando'
  ) AS pedidosEnviando,
   (
    SELECT COUNT(*)
    FROM tblasignacionpedidos ap
    JOIN tblpedidos p ON ap.idPedido = p.idPedido
    WHERE ap.idRepartidor = r.idRepartidor
      AND LOWER(p.estadoActual) = 'incompleto'
  ) AS pedidosIncompleto,
   (
    SELECT COUNT(*)
    FROM tblasignacionpedidos ap
    JOIN tblpedidos p ON ap.idPedido = p.idPedido
    WHERE ap.idRepartidor = r.idRepartidor
      AND LOWER(p.estadoActual) = 'incidente'
  ) AS pedidosIncidente,

   (
          SELECT COUNT(*)
          FROM tblasignacionpedidos ap
          JOIN tblpedidos p ON ap.idPedido = p.idPedido
          WHERE ap.idRepartidor = r.idRepartidor
            AND LOWER(p.estadoActual) = 'recogiendo'
        ) AS pedidosRecogiendo,

         (
          SELECT COUNT(*)
          FROM tblasignacionpedidos ap
          JOIN tblpedidos p ON ap.idPedido = p.idPedido
          WHERE ap.idRepartidor = r.idRepartidor
            AND LOWER(p.estadoActual) = 'cancelado'
        ) AS pedidosCancelado,

  (
    SELECT ROUND(AVG(puntuacion), 1)
    FROM tblvaloracionesrepartidores v
    JOIN tblasignacionpedidos ap ON v.idAsignacion = ap.idAsignacion
    WHERE ap.idRepartidor = r.idRepartidor
  ) AS calificacionPromedio

FROM tblrepartidores r
JOIN tblusuarios u ON r.idUsuario = u.idUsuarios
LEFT JOIN tblperfilusuarios pu ON u.idUsuarios = pu.idUsuarios;

    `);
      const repartidores = rows.map((r) => ({
        idRepartidor: r.idRepartidor,
        nombre: `${r.nombre} ${r.apellidoP} ${r.apellidoM}`,
        correo: r.correo,
        telefono: r.telefono,
        estado: r.estado === 1 ? "activo" : "inactivo",
        fechaAlta: r.fechaAlta ? new Date(r.fechaAlta).toISOString() : null,
        fechaBaja: r.fechaBaja ? new Date(r.fechaBaja).toISOString() : null,
        fechaCreacion: r.fechaCreacion
          ? new Date(r.fechaCreacion).toISOString()
          : null,
        fotoPerfil: r.fotoPerfil || null,
        pedidosFinalizados: r.pedidosFinalizados || 0,
        pedidosEnviando: r.pedidosEnviando || 0,
        pedidosIncompleto: r.pedidosIncompleto || 0,
        pedidosIncidente: r.pedidosIncidente || 0,
        pedidosRecogiendo: r.pedidosRecogiendo|| 0,
        pedidosCancelado: r.pedidosCancelado || 0,
        calificacionPromedio: r.calificacionPromedio || null,
      }));

      res.status(200).json({ success: true, data: repartidores });
    } catch (error) {
      console.error("❌ Error al obtener repartidores:", error);
      res.status(500).json({
        success: false,
        message: "Error interno al obtener repartidores",
        error: error.message,
      });
    }
  }
);

//Enpoit para editar estado de repartidor para 0/ 1
routerRepartidorPedidos.patch("/administrar/repartidores/:id/estado",
  async (req, res) => {
    const { id } = req.params;
    const { activo } = req.body;

    try {
      const [pedidosActivos] = await pool.query(
      `SELECT p.estadoActual 
       FROM tblpedidos p
       JOIN tblasignacionpedidos ap ON p.idPedido = ap.idPedido
       WHERE ap.idRepartidor = ? 
      AND LOWER(p.estadoActual) IN ('recogiendo', 'enviando')`,
      [id]
    );
    if (activo === 0 && pedidosActivos.length > 0) {
      return res.status(400).json({
        success: false,
        message: "No se puede desactivar el repartidor porque tiene pedidos activos (recogiendo o entregando).",
      });
    }




      let fechaBaja = null;
      if (activo === 0) {
        fechaBaja = moment()
          .tz("America/Mexico_City")
          .format("YYYY-MM-DD HH:mm:ss");
      }
      await pool.query(
        "UPDATE tblrepartidores SET activo = ?, fechaBaja = ? WHERE idRepartidor = ?",
        [activo, fechaBaja, id]
      );

      res.json({
        success: true,
        estado: activo === 1 ? "activo" : "inactivo",
        fechaBaja,
      });
    } catch (error) {
      res
        .status(500)
        .json({ success: false, message: "Error al actualizar estado", error });
    }
  }
);

//Obtener detalles del pedido


routerRepartidorPedidos.get("/repartidores/:repartidorId/historial",
  verifyToken,
  async (req, res) => {
    const { repartidorId } = req.params;

    // Validar que repartidorId sea un número entero positivo
    if (!/^\d+$/.test(repartidorId)) {
      return res.status(400).json({
        success: false,
        message: "El ID del repartidor debe ser un número entero positivo.",
      });
    }

    try {
      // Consulta optimizada para obtener todos los pedidos asignados al repartidor
      const [rows] = await pool.query(
        `
        SELECT 
          ap.idAsignacion,
          ap.fechaAsignacion,
          p.idPedido,
          p.idRastreo,
          p.idUsuarios,
          p.idNoClientes,
          p.idDireccion,
          p.fechaInicio,
          p.fechaEntrega,
          p.horaAlquiler,
          p.detallesPago,
          p.totalPagar,
          p.fechaRegistro,
          p.FechaA AS fechaPedido,
          p.tipoPedido,
          p.estadoActual,
          COALESCE(CONCAT(u.nombre, ' ', u.apellidoP, ' ', u.apellidoM), nc.nombre) AS clienteNombre,
          COALESCE(u.correo, nc.correo) AS clienteCorreo,
          COALESCE(u.telefono, nc.telefono) AS clienteTelefono,
          COALESCE(SUM(pg.monto), 0) AS totalPagado,
          pd.idDetalle,
          pd.cantidad,
          pd.precioUnitario,
          pd.subtotal,
          pd.estadoProducto,
          pd.observaciones,
          pd.diasAlquiler,
          prod.nombre AS nombreProducto,
          prod.detalles AS detallesProducto,
          c.color AS colorProducto
        FROM tblasignacionpedidos ap
        INNER JOIN tblpedidos p ON ap.idPedido = p.idPedido
        LEFT JOIN tblpagos pg ON p.idPedido = pg.idPedido
        LEFT JOIN tblusuarios u ON p.idUsuarios = u.idUsuarios
        LEFT JOIN tblnoclientes nc ON p.idNoClientes = nc.idNoClientes
        LEFT JOIN tblpedidodetalles pd ON pd.idPedido = p.idPedido
        LEFT JOIN tblproductoscolores pc ON pd.idProductoColores = pc.idProductoColores
        LEFT JOIN tblproductos prod ON pc.idProducto = prod.idProducto
        LEFT JOIN tblcolores c ON pc.idColor = c.idColores
        WHERE ap.idRepartidor = ?
        GROUP BY 
          ap.idAsignacion,
          p.idPedido,
          p.idRastreo,
          p.idUsuarios,
          p.idNoClientes,
          p.idDireccion,
          p.fechaInicio,
          p.fechaEntrega,
          p.horaAlquiler,
          p.detallesPago,
          p.totalPagar,
          p.fechaRegistro,
          p.FechaA,
          p.tipoPedido,
          p.estadoActual,
          clienteNombre,
          clienteCorreo,
          clienteTelefono,
          pd.idDetalle,
          pd.cantidad,
          pd.precioUnitario,
          pd.subtotal,
          pd.estadoProducto,
          pd.observaciones,
          pd.diasAlquiler,
          nombreProducto,
          detallesProducto,
          colorProducto
        ORDER BY p.FechaA DESC
        `,
        [repartidorId]
      );

      console.log("Resultado del endpoint historial de pedidos:", rows);

      // Agrupar los resultados por pedido para evitar duplicados
      const pedidosMap = new Map();

      for (const row of rows) {
        const {
          idAsignacion,
          fechaAsignacion,
          idPedido,
          idRastreo,
          idUsuarios,
          idNoClientes,
          idDireccion,
          fechaInicio,
          fechaEntrega,
          horaAlquiler,
          detallesPago,
          totalPagar,
          fechaRegistro,
          fechaPedido,
          tipoPedido,
          estadoActual,
          clienteNombre,
          clienteCorreo,
          clienteTelefono,
          totalPagado,
          idDetalle,
          cantidad,
          precioUnitario,
          subtotal,
          estadoProducto,
          observaciones,
          diasAlquiler,
          nombreProducto,
          detallesProducto,
          colorProducto,
        } = row;

        if (!pedidosMap.has(idPedido)) {
          pedidosMap.set(idPedido, {
            idAsignacion,
            idPedido,
            idRastreo,
            idUsuarios,
            idNoClientes,
            idDireccion,
            fechaAsignacion,
            fechaInicio,
            fechaEntrega,
            horaAlquiler,
            detallesPago,
            totalPagar,
            totalPagado,
            fechaRegistro,
            fechaPedido,
            tipoPedido,
            estadoActual,
            cliente: {
              nombre: clienteNombre || "Sin nombre",
              correo: clienteCorreo || "Sin correo",
              telefono: clienteTelefono || "Sin teléfono",
            },
            productos: [],
          });
        }

        // Agregar productos solo si existen (evitar null/undefined)
        if (idDetalle) {
          pedidosMap.get(idPedido).productos.push({
            idDetalle,
            nombreProducto: nombreProducto || "Sin nombre",
            detallesProducto: detallesProducto || null,
            colorProducto: colorProducto || null,
            cantidad: cantidad || 0,
            precioUnitario: parseFloat(precioUnitario) || 0,
            subtotal: parseFloat(subtotal) || 0,
            estadoProducto: estadoProducto || "N/A",
            observaciones: observaciones || null,
            diasAlquiler: diasAlquiler || 0,
          });
        }
      }

      // Convertir el Map a un array
      const historial = Array.from(pedidosMap.values());

      // Responder con el historial
      res.status(200).json({
        success: true,
        total: historial.length,
        data: historial,
      });
    } catch (error) {
      console.error("❌ Error al obtener historial del repartidor:", error);
      res.status(500).json({
        success: false,
        message: "Error al obtener el historial de pedidos del repartidor.",
        error: error.message,
      });
    }
  }
);




//==================================================MODULO DE ASIGANCION DE PEDIDOS============
//Repartidores con activo ===1
routerRepartidorPedidos.get("/administrar/activos/repartidores",
  csrfProtection,
  async (req, res) => {
    try {
      const [rows] = await pool.query(`
      SELECT 
        r.idRepartidor,
        u.nombre,
        u.apellidoP,
        u.apellidoM,
        u.correo,
        u.telefono,
        u.fechaCreacion,
        r.activo AS estado,
        r.fechaAlta,
        r.fechaBaja,
        pu.fotoPerfil,


        (
          SELECT ROUND(AVG(puntuacion), 1)
          FROM tblvaloracionesrepartidores v
          JOIN tblasignacionpedidos ap ON v.idAsignacion = ap.idAsignacion
          WHERE ap.idRepartidor = r.idRepartidor
        ) AS calificacionPromedio

      FROM tblrepartidores r
      JOIN tblusuarios u ON r.idUsuario = u.idUsuarios
      LEFT JOIN tblperfilusuarios pu ON u.idUsuarios = pu.idUsuarios

      WHERE r.activo = 1 
    AND NOT EXISTS (
    SELECT 1
    FROM tblasignacionpedidos ap
    JOIN tblpedidos p ON ap.idPedido = p.idPedido
    WHERE ap.idRepartidor = r.idRepartidor
      AND LOWER(p.estadoActual) IN ('enviando', 'recogiendo')
  );

    `);

      const repartidores = rows.map((r) => ({
        idRepartidor: r.idRepartidor,
        nombre: `${r.nombre} ${r.apellidoP} ${r.apellidoM}`,
        correo: r.correo,
        telefono: r.telefono,
        estado: r.estado === 1 ? "activo" : "inactivo",
        fechaAlta: r.fechaAlta ? new Date(r.fechaAlta).toISOString() : null,
        fechaBaja: r.fechaBaja ? new Date(r.fechaBaja).toISOString() : null,
        fechaCreacion: r.fechaCreacion
          ? new Date(r.fechaCreacion).toISOString()
          : null,
        fotoPerfil: r.fotoPerfil || null,
        pedidosFinalizados: r.pedidosFinalizados || 0,
        pedidosEnviando: r.pedidosEnviando || 0,
        pedidosIncompleto: r.pedidosIncompleto || 0,
        pedidosIncidente: r.pedidosIncidente || 0,
        pedidosRecogiendo: r.pedidosRecogiendo|| 0,
        pedidosCancelado: r.pedidosCancelado || 0,
        calificacionPromedio: r.calificacionPromedio || null,
      }));

      res.status(200).json({ success: true, data: repartidores });
    } catch (error) {
      console.error("❌ Error al obtener repartidores:", error);
      res.status(500).json({
        success: false,
        message: "Error interno al obtener repartidores",
        error: error.message,
      });
    }
  }
);

routerRepartidorPedidos.post("/pedidos/asignar",
  verifyToken,
  csrfProtection,
  async (req, res) => {
    const { repartidorId, pedidosIds } = req.body;

    console.log("Datos recibidos para asignación:", {
      repartidorId,
      pedidosIds,
    });

    if (
      !repartidorId ||
      !Array.isArray(pedidosIds) ||
      pedidosIds.length === 0
    ) {
      return res.status(400).json({
        success: false,
        message:
          "Faltan datos obligatorios para la asignación (repartidorId, pedidosIds).",
      });
    }

    const fechaAsignacion = obtenerFechaMexico();

    const connection = await pool.getConnection();

    try {
      await connection.beginTransaction();

     
      const [currentStates] = await connection.query(
        `SELECT idPedido, estadoActual FROM tblpedidos WHERE idPedido IN (?)`,
        [pedidosIds]
      );

      const stateMap = currentStates.reduce((acc, row) => {
        acc[row.idPedido] = row.estadoActual;
        return acc;
      }, {});

      const updateValues = pedidosIds.map((idPedido) => {
        const currentState = stateMap[idPedido] || "Confirmado"; 
        let newState;
        if (currentState === "Confirmado") {
          newState = "Enviando";
        } else if (currentState === "En alquiler") {
          newState = "Recogiendo";
        } else {
          newState = currentState;
        }
        return [idPedido, newState, fechaAsignacion];
      });

    
      const updateQuery = `
        UPDATE tblpedidos 
        SET estadoActual = ?, FechaA = ? 
        WHERE idPedido = ?
      `;
      for (const [idPedido, newState, fecha] of updateValues) {
        await connection.query(updateQuery, [newState, fecha, idPedido]);
      }

     
      const insertValues = pedidosIds.map((idPedido) => [
        idPedido,
        repartidorId,
        fechaAsignacion,
      ]);
      await connection.query(
        `INSERT INTO tblasignacionpedidos (idPedido, idRepartidor, fechaAsignacion) VALUES ?`,
        [insertValues]
      );

      await connection.commit();

      res.status(201).json({
        success: true,
        message: "Pedidos asignados y actualizados correctamente.",
      });
    } catch (error) {
      await connection.rollback();
      console.error("❌ Error al asignar pedidos:", error);

      res.status(500).json({
        success: false,
        message: "Error interno del servidor al asignar los pedidos.",
        error: error.message,
        code: error.code || "UNKNOWN",
      });
    } finally {
      if (connection) {
        connection.release();
      }
    }
  }
);

//Enpoit para cancelar pedido
routerRepartidorPedidos.put(
  "/pedidos/:id",
  verifyToken,
  csrfProtection,
  async (req, res) => {
    const { id } = req.params;
    const { estadoActual } = req.body;

    console.log("Datos recibidos", id, estadoActual)
    if (estadoActual !== "Cancelado") {
      return res.status(400).json({
        success: false,
        message: "El estado debe ser 'Cancelado' para esta operación.",
      });
    }

    const connection = await pool.getConnection();

    try {
      await connection.beginTransaction();

      // Verificar si el pedido existe
      const [existingPedido] = await connection.query(
        `SELECT idPedido, estadoActual FROM tblpedidos WHERE idPedido = ?`,
        [id]
      );

      if (existingPedido.length === 0) {
        await connection.rollback();
        return res.status(404).json({
          success: false,
          message: "Pedido no encontrado.",
        });
      }

      const pedido = existingPedido[0];
      if (pedido.estadoActual === "Cancelado") {
        await connection.rollback();
        return res.status(400).json({
          success: false,
          message: "El pedido ya está cancelado.",
        });
      }

      // Obtener los detalles de los productos asociados al pedido, excluyendo los ya cancelados
      const [pedidoDetalles] = await connection.query(
        `SELECT idProductoColores, cantidad FROM tblpedidodetalles WHERE idPedido = ?`,
        [id]
      );

      // Actualizar el inventario para cada producto
      for (const detalle of pedidoDetalles) {
        const { idProductoColores, cantidad } = detalle;

        // Verificar si el producto existe en el inventario
        const [inventario] = await connection.query(
          `SELECT stock, stockReal FROM tblinventario WHERE idProductoColor = ? AND estado = 'Activo'`,
          [idProductoColores]
        );

        if (inventario.length === 0) {
          await connection.rollback();
          return res.status(404).json({
            success: false,
            message: `Producto con idProductoColores ${idProductoColores} no encontrado en el inventario.`,
          });
        }

        const { stock, stockReal } = inventario[0];

        // Validar que el nuevo stock no exceda stockReal
        const newStock = stock + cantidad;
        if (newStock > stockReal) {
          await connection.rollback();
          return res.status(400).json({
            success: false,
            message: `La devolución de ${cantidad} unidades para el producto con idProductoColores ${idProductoColores} excede el stock real (${stockReal}).`,
          });
        }

        // Actualizar el stock (solo stock, no stockReservado)
        await connection.query(
          `UPDATE tblinventario SET stock = ? WHERE idProductoColor = ?`,
          [newStock, idProductoColores]
        );

       
     
      }

      // Actualizar el estado del pedido
      const fechaModificacion = obtenerFechaMexico();
      await connection.query(
        `UPDATE tblpedidos SET estadoActual = ?, FechaA = ? WHERE idPedido = ?`,
        [estadoActual, fechaModificacion, id]
      );

      // Eliminar la asignación del pedido (si aplica)
      await connection.query(
        `DELETE FROM tblasignacionpedidos WHERE idPedido = ?`,
        [id]
      );

      await connection.commit();

      res.status(200).json({
        success: true,
        message: "Pedido cancelado exitosamente y productos devueltos al inventario.",
        data: { id, estadoActual },
      });
    } catch (error) {
      await connection.rollback();
      console.error("❌ Error al cancelar el pedido:", error);
      res.status(500).json({
        success: false,
        message: "Error interno del servidor al cancelar el pedido.",
        error: error.message,
        code: error.code || "UNKNOWN",
      });
    } finally {
      if (connection) {
        connection.release();
      }
    }
  }
);




//Enpot de historial de pedido asignados 
routerRepartidorPedidos.get("/repartidores/historial", verifyToken, async (req, res) => {
  const { fecha } = req.query; // Filtrar por fecha de asignación (YYYY-MM-DD)
  const currentDate = moment.tz("America/Mexico_City").format("YYYY-MM-DD");
  console.log("Fecha de filtro:", fecha);

  try {
    const [rows] = await pool.query(
      `
        SELECT
          p.idPedido,
          p.idRastreo,
          p.tipoPedido,
          ap.fechaAsignacion,
          dc.estado AS direccionEstado,
          dc.municipio,
          dc.localidad,
          u.idUsuarios AS repartidorId,
          u.telefono,
          u.nombre AS repartidorNombre,
          u.correo AS repartidorCorreo,
          pu.fotoPerfil,
          p.estadoActual AS tipoPedidoEstado, 
          p.tipoPedido
      FROM tblpedidos p
      INNER JOIN tblasignacionpedidos ap ON p.idPedido = ap.idPedido
      LEFT JOIN tbldireccioncliente dc ON p.idDireccion = dc.idDireccion
      LEFT JOIN tblrepartidores r ON ap.idRepartidor = r.idRepartidor
      LEFT JOIN tblusuarios u ON r.idUsuario = u.idUsuarios
      LEFT JOIN tblperfilusuarios pu ON u.idUsuarios = pu.idUsuarios
      WHERE p.estadoActual != 'cancelado'
          AND (? IS NULL OR DATE(ap.fechaAsignacion) = ?)
      ORDER BY ap.fechaAsignacion DESC
      `,
      [fecha || null, fecha || null]
    );
    console.log("Resultado de mi endpoint historial:", rows);

    const historial = rows.map((row) => ({
      idPedido: row.idPedido,
      idRastreo: row.idRastreo,
      fechaAsignacion: row.fechaAsignacion,
      estado: row.direccionEstado,
      municipio: row.municipio,
      localidad: row.localidad,
      repartidor: {
        id: row.repartidorId,
        nombre: row.repartidorNombre,
        correo: row.repartidorCorreo,
        fotoPerfil: row.fotoPerfil,
        telefono: row.telefono
      },
      tipoPedidoEstado: row.tipoPedidoEstado, 
    }));

    res.status(200).json({
      success: true,
      total: historial.length,
      data: historial,
    });
  } catch (error) {
    console.error("❌ Error al obtener historial de repartidores:", error);
    res.status(500).json({
      success: false,
      message: "Error al obtener el historial de pedidos de los repartidores.",
      error: error.message,
    });
  }
});


routerRepartidorPedidos.get("/repartidores/historial/:idPedido/detalles",  async (req, res) => {
  const { idPedido } = req.params;
  console.log("ID del pedido para detalles:", idPedido);

  try {
    const [rows] = await pool.query(
      `
      SELECT
          p.idPedido,
          p.idRastreo,
          p.totalPagar,
          p.estadoActual,
          p.tipoPedido,
          COALESCE(SUM(pg.monto), 0) AS montoPagado,
          pd.cantidad,
          pd.precioUnitario,
          pd.subtotal,
          pd.estadoProducto,
          pd.diasAlquiler,
          pd.observaciones,
          pr.nombre AS nombreProducto,
          c.color
      FROM tblpedidos p
      LEFT JOIN tblpagos pg ON p.idPedido = pg.idPedido
      LEFT JOIN tblpedidodetalles pd ON p.idPedido = pd.idPedido
      LEFT JOIN tblproductoscolores pc ON pd.idProductoColores = pc.idProductoColores
      LEFT JOIN tblproductos pr ON pc.idProducto = pr.idProducto
      LEFT JOIN tblcolores c ON pc.idColor = c.idColores
      WHERE p.idPedido = ?
      GROUP BY
          p.idPedido,
          p.idRastreo,
          p.totalPagar,
          p.estadoActual,
          pd.cantidad,
          pd.precioUnitario,
          pd.subtotal,
          pd.estadoProducto,
          pd.observaciones,
          pr.nombre,
          c.color
      `,
      [idPedido]
    );
    console.log("Resultado de mi endpoint detalles:", rows);

    // Agrupar los detalles de productos y mantener la información general del pedido
    const pedido = {
      idPedido: null,
      idRastreo: null,
      totalPagar: 0,
      estadoActual: null,
      montoPagado: 0,
      diasAlquiler:0,
      tipoPedido: null,
      productos: [],
    };

    rows.forEach((row) => {
      if (!pedido.idPedido) {
        pedido.idPedido = row.idPedido;
        pedido.idRastreo = row.idRastreo;
        pedido.totalPagar = parseFloat(row.totalPagar) || 0;
        pedido.estadoActual = row.estadoActual;
        pedido.montoPagado = parseFloat(row.montoPagado) || 0;
        pedido.diasAlquiler= parseInt(row.diasAlquiler)|| 0;
        pedido.tipoPedido=row.tipoPedido ;
      }
      pedido.productos.push({
        cantidad: parseInt(row.cantidad) || 0,
        precioUnitario: parseFloat(row.precioUnitario) || 0,
        subtotal: parseFloat(row.subtotal) || 0,
        estadoProducto: row.estadoProducto,
        observaciones: row.observaciones,
        nombreProducto: row.nombreProducto,
        color: row.color,
      });
    });

    res.status(200).json({
      success: true,
      total: pedido.productos.length,
      data: pedido,
    });
  } catch (error) {
    console.error("❌ Error al obtener detalles del pedido:", error);
    res.status(500).json({
      success: false,
      message: "Error al obtener los detalles del pedido.",
      error: error.message,
    });
  }
});






module.exports = routerRepartidorPedidos;
