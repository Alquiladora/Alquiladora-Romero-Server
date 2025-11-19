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
const admin = require('firebase-admin');

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
      `SELECT COUNT(*) AS v FROM tblpedidos WHERE DATE(CONVERT_TZ(fechaInicio, '+00:00', 'America/Mexico_City')) = ?`,
      [date]
    );
    return v;
  } catch (err) {
    console.error("Error en countByDate:", err);
    throw err;
  }
}

async function getEntregaReal(fechaInicio, fechaRegistro) {


  const inicio = moment(fechaInicio).tz("America/Mexico_City").startOf("day");

  const registro = moment.tz(fechaRegistro, "America/Mexico_City").startOf("day");
  const today = todayMx();
  const dia = inicio.day();
  console.log("getEntregaReal:", { fechaInicio, fechaRegistro, today: today.format("YYYY-MM-DD") });

  if (inicio.isSame(registro, "day") && inicio.isSame(today, "day")) {
    return today;
  }
  const isUrgent = registro.isSame(today, "day");
  if (isUrgent) return today;


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

    // 🚀 Subconsulta para pagos en vez de GROUP BY
    const [rows] = await pool.query(
      `
      SELECT
        p.idPedido,
        p.idUsuarios,
        p.idNoClientes,
        p.idRastreo,
        p.estadoActual,
        p.totalPagar,
        COALESCE(pg.totalPagado, 0) AS totalPagado,
        (COALESCE(pg.totalPagado, 0) >= p.totalPagar) AS isFullyPaid,
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
      LEFT JOIN (
        SELECT idPedido, SUM(monto) AS totalPagado
        FROM tblpagos
        GROUP BY idPedido
      ) pg ON p.idPedido = pg.idPedido
      INNER JOIN tbldireccioncliente d ON p.idDireccion = d.idDireccion
      LEFT JOIN tblasignacionpedidos ap ON p.idPedido = ap.idPedido
      WHERE (
        (
          LOWER(p.estadoActual) = 'confirmado'
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
      `,
      [fechaMinimaEntrega, fechaMaximaEntrega, fechaEntregaRecogidaLimite]
    );

    // 🚀 Procesamiento en Node
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

      if (["confirmado", "enviando"].includes(r.estadoActual.toLowerCase())) {
        const esAtrasado =
          moment(r.fechaInicio).isBefore(today, "day") ||
          (entregaReal && entregaReal.isBefore(today, "day"));

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

    for (const r of todos) {
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
    }

    // 🚀 Unificar conteos en una sola consulta
    const [[stats]] = await pool.query(
      `
      SELECT
        (SELECT COUNT(*) FROM tblpedidos) AS totalPedidos,
        (SELECT COUNT(*) FROM tblrepartidores) AS totalRepartidores,
        (SELECT COUNT(*) FROM tblasignacionpedidos) AS totalPedidosAsignados,
        (
          SELECT COUNT(*) 
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
        ) AS totalPedidosHoy
      `,
      [today.format("YYYY-MM-DD"), moment(today).subtract(1, "day").format("YYYY-MM-DD")]
    );

    return res.json({
      success: true,
      days,
      deliveries,
      lateDeliveries,
      pickups,
      totalsByLocation: Object.values(totalsByLocation),
      ...stats,
    });
  } catch (err) {
    console.error("Error al obtener pedidos:", err);
    return res.status(500).json({
      success: false,
      message: "Error interno al consultar pedidos",
    });
  }
});







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
    u.rol,
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
        rol: r.rol,
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
        pedidosRecogiendo: r.pedidosRecogiendo || 0,
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
        pedidosRecogiendo: r.pedidosRecogiendo || 0,
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
      //---------------------NOTIFICATION----------------
      try {
        const [tokenRow] = await pool.query(
          `SELECT fcmToken FROM tblnotificacionmovil 
           WHERE idUsuario = ? AND fcmToken IS NOT NULL 
           LIMIT 1`,
          [repartidorId]
        );

        if (tokenRow.length > 0 && tokenRow[0].fcmToken) {
          const fcmToken = tokenRow[0].fcmToken;
          const cantidad = pedidosIds.length;

       const mensaje = {
  token: fcmToken,
  notification: {
    title: cantidad === 1 ? "¡Nuevo pedido asignado!" : `¡${cantidad} nuevos pedidos!`,
    body: cantidad === 1 ? `Pedido #${pedidosIds[0]} listo para recoger` : "Tienes nuevos pedidos asignados",
  },
  data: {
    tipo: "nuevo_pedido",
    pedidoId: pedidosIds[0].toString(),
  },
  android: {
    priority: "high",
    notification: {
      channelId: "high_importance_channel",  
      sound: "nuevo_pedido",
      color: "#00AA00",
      clickAction: "FLUTTER_NOTIFICATION_CLICK"
    }
  }
};

          await admin.messaging().send(mensaje);
          console.log(`Notificación enviada al repartidor ${repartidorId} (${cantidad} pedidos)`);
        }
      } catch (fcmError) {
        console.error("Error enviando FCM (no rompe la asignación):", fcmError);
       
      }
      //-------------------------------------

      res.status(201).json({
        success: true,
        message: "Pedidos asignados y notificación enviada correctamente.",
      });
    } catch (error) {
      await connection.rollback();
      console.error("Error al asignar pedidos:", error);
      res.status(500).json({
        success: false,
        message: "Error interno del servidor al asignar los pedidos.",
      });
    } finally {
      connection.release();
    }
  }
);


//Checar movil
//Enpoit para cancelar pedido
routerRepartidorPedidos.put("/pedidos/:id", verifyToken, csrfProtection,
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
      // await connection.query(
      //   `DELETE FROM tblasignacionpedidos WHERE idPedido = ?`,
      //   [id]
      // );

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

//enpoit de cancelar movil
routerRepartidorPedidos.put("/pedidos-movil/:id", verifyToken,
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


routerRepartidorPedidos.get("/repartidores/historial/:idPedido/detalles", async (req, res) => {
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
      diasAlquiler: 0,
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
        pedido.diasAlquiler = parseInt(row.diasAlquiler) || 0;
        pedido.tipoPedido = row.tipoPedido;
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





routerRepartidorPedidos.get("/repartidor/datos", verifyToken, csrfProtection, async (req, res) => {
  try {
    const idUsuario = req.user?.id;
    console.log("Datos de topken", idUsuario)


    if (!idUsuario) {
      return res.status(401).json({ error: "ID de usuario no encontrado en el token" });
    }

    const [rows] = await pool.query(
      `
      SELECT 
          u.idUsuarios,
          COALESCE(u.nombre, 'Sin nombre') AS nombre,
          COALESCE(u.apellidoP, '') AS apellidoP,
          COALESCE(u.apellidoM, '') AS apellidoM,
          COALESCE(u.correo, '') AS correo,
          COALESCE(u.telefono, '') AS telefono,
          r.idRepartidor,
          COALESCE(r.activo, 0) AS cuentaActiva,
          r.fechaAlta,
          r.fechaBaja,
          COALESCE(COUNT(DISTINCT CASE WHEN LOWER(p.estadoActual) = 'recogiendo' THEN p.idPedido END), 0) AS totalRecogiendo,
          COALESCE(COUNT(DISTINCT CASE WHEN LOWER(p.estadoActual) = 'en alquiler' THEN p.idPedido END), 0) AS totalEnAlquiler,
          COALESCE(COUNT(DISTINCT CASE WHEN LOWER(p.estadoActual) = 'enviando' THEN p.idPedido END), 0) AS totalEnviando,
          COALESCE(COUNT(DISTINCT CASE WHEN LOWER(p.estadoActual) = 'finalizado' THEN p.idPedido END), 0) AS totalFinalizado,
          COALESCE(AVG(v.puntuacion), 0) AS promedioValoracion,
          COALESCE(
              JSON_ARRAYAGG(
                  CASE 
                      WHEN p.estadoActual = 'finalizado' THEN 
                          JSON_OBJECT(
                              'mes', CONCAT(MONTHNAME(p.fechaInicio), ' ', YEAR(p.fechaInicio)),
                              'completados', 1
                          )
                  END
              ), '[]'
          ) AS pedidosFinalizadosPorMes
      FROM 
          tblusuarios u
      INNER JOIN 
          tblrepartidores r ON u.idUsuarios = r.idUsuario
      LEFT JOIN 
          tblasignacionpedidos ap ON r.idRepartidor = ap.idRepartidor
      LEFT JOIN 
          tblpedidos p ON ap.idPedido = p.idPedido
      LEFT JOIN 
          tblusuarios c ON p.idUsuarios = c.idUsuarios
      LEFT JOIN 
          tblvaloracionesrepartidores v ON ap.idAsignacion = v.idAsignacion
      WHERE 
          u.idUsuarios = ?
      GROUP BY 
          u.idUsuarios, u.nombre, u.apellidoP, u.apellidoM, u.correo, u.telefono,
          r.idRepartidor, r.activo, r.fechaAlta, r.fechaBaja
      `,
      [idUsuario]
    );

    if (!rows || rows.length === 0) {
      return res.status(404).json({ error: "Repartidor no encontrado" });
    }

    const rawPedidosPorMes = JSON.parse(rows[0].pedidosFinalizadosPorMes || "[]").filter(p => p !== null);
    const pedidosPorMes = rawPedidosPorMes.reduce((acc, curr) => {
      const existing = acc.find(item => item.mes === curr.mes);
      if (existing) {
        existing.completados += curr.completados;
      } else {
        acc.push({ mes: curr.mes, completados: curr.completados });
      }
      return acc;
    }, []);

    const result = {
      ...rows[0],
      pedidosFinalizadosPorMes: pedidosPorMes,
    };

    res.json(result);
  } catch (error) {
    console.error("Error fetching repartidor data:", error);
    res.status(500).json({ error: "Error interno del servidor" });
  }
});


routerRepartidorPedidos.get('/repartidor/estadisticas', verifyToken, async (req, res) => {
  try {
    const idUsuario = req.user?.id;

    if (!idUsuario) {
      return res.status(400).json({ error: 'Falta idUsuario en la petición' });
    }

    const sql = `
      SELECT
        SUM(CASE WHEN LOWER(p.estadoActual) IN ('recogiendo', 'enviando') THEN 1 ELSE 0 END) AS entregasPendientes,
        SUM(CASE WHEN LOWER(p.estadoActual) = 'finalizado' THEN 1 ELSE 0 END) AS entregasFinalizadas,
        COUNT(DISTINCT COALESCE(p.idUsuarios, CONCAT('NC-', p.idNoClientes))) AS clientesAtendidos
      FROM tblrepartidores r
      INNER JOIN tblasignacionpedidos ap ON r.idRepartidor = ap.idRepartidor
      INNER JOIN tblpedidos p ON ap.idPedido = p.idPedido
      WHERE r.idUsuario = ?;
    `;

    const [rows] = await pool.execute(sql, [idUsuario]);

    if (rows.length === 0) {
      return res.status(404).json({ error: 'No se encontraron datos para el repartidor' });
    }

    res.json(rows[0]);
  } catch (error) {
    console.error('Error en /repartidor/estadisticas:', error);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});




routerRepartidorPedidos.get('/repartidor/estadistica-movil', verifyToken, async (req, res) => {
  try {
    const idUsuario = req.user?.id;

    if (!idUsuario) {
      return res.status(400).json({ error: 'Falta idUsuario en la petición' });
    }

    const sql = `
    SELECT
   
    (    
        CAST(SUM(CASE 
            WHEN P.estadoActual = 'Entregado' 
            AND A.fechaAsignacion >= DATE_SUB(CURDATE(), INTERVAL 30 DAY) 
            THEN 1 ELSE 0 
        END) AS DECIMAL(5,2)) * 100 
    ) / 
   
    NULLIF(SUM(CASE 
        WHEN A.fechaAsignacion >= DATE_SUB(CURDATE(), INTERVAL 30 DAY) 
        THEN 1 ELSE 0 
    END), 0) AS Rendimiento_Mensual_Porcentaje, 
    (   
        CAST(SUM(CASE 
            WHEN P.estadoActual = 'Entregado' 
            AND A.fechaAsignacion >= DATE_SUB(CURDATE(), INTERVAL 7 DAY) 
            THEN 1 ELSE 0 
        END) AS DECIMAL(5,2)) * 100 
    ) / 
    NULLIF(SUM(CASE 
        WHEN A.fechaAsignacion >= DATE_SUB(CURDATE(), INTERVAL 7 DAY) 
        THEN 1 ELSE 0 
    END), 0) AS Rendimiento_Semanal_Porcentaje
FROM
    tblasignacionpedidos A
JOIN
    tblpedidos P ON A.idPedido = P.idPedido
JOIN
    tblrepartidores R ON A.idRepartidor = R.idRepartidor 
WHERE
    R.idUsuario = ?; 
    `;
    const [rows] = await pool.execute(sql, [idUsuario]);
    if (rows.length === 0) {
      return res.status(404).json({ error: 'No se encontraron datos para el repartidor' });
    }
    res.json(rows[0]);
  } catch (error) {
    console.error('Error en /repartidor/estadisticas-movil:', error);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});



//Chacra para movil
routerRepartidorPedidos.get('/repartidor/pedidos-hoy', verifyToken, async (req, res) => {
  try {
    const idUsuario = req.user?.id;
    if (!idUsuario) {
      return res.status(400).json({ error: 'Falta idUsuario en la petición' });
    }

    // Obtener ID de repartidor
    const [[repartidor]] = await pool.execute(
      'SELECT idRepartidor FROM tblrepartidores WHERE idUsuario = ?',
      [idUsuario]
    );

    if (!repartidor) {
      return res.status(404).json({ error: 'No se encontró repartidor para este usuario' });
    }

    const idRepartidor = repartidor.idRepartidor;

    // Obtener fecha actual México en formato YYYY-MM-DD
    const fechaCompletaMX = obtenerFechaMexico(); // 'YYYY-MM-DD HH:mm:ss'
    const fechaHoyMX = fechaCompletaMX.split(' ')[0]; // 'YYYY-MM-DD'

    console.log({ idUsuario, idRepartidor, fechaHoyMX });

    const [rows] = await pool.execute(
      `
      SELECT 
    p.idPedido AS id,
    p.tipoPedido AS tipo_pedido,
    IFNULL(p.estadoActual, 'sin_estado') AS estado_pedido,

    CASE 
        WHEN p.idUsuarios IS NOT NULL THEN 
            CONCAT(u.nombre, ' ', u.apellidoP, ' - Pedido #', p.idPedido)
        ELSE 
            CONCAT(nc.nombre, ' ', nc.apellidoCompleto, ' - Pedido #', p.idPedido)
    END AS descripcion,

    CASE
        WHEN p.idUsuarios IS NOT NULL THEN 
            CONCAT(u.nombre, ' ', u.apellidoP)
        ELSE 
            CONCAT(nc.nombre, ' ', nc.apellidoCompleto)
    END AS cliente,

    CASE
        WHEN p.idUsuarios IS NOT NULL THEN u.telefono
        ELSE nc.telefono
    END AS telefono_cliente,

    dc.localidad,
    dc.municipio,
    dc.estado,
    dc.direccion,
    p.fechaInicio AS fecha_entrega,
    p.totalPagar AS total_a_pagar,
    COALESCE(pg.total_pagado, 0) AS total_pagado,
    pd.diasAlquiler,

    CASE 
        WHEN DATE(p.fechaRegistro) = ? AND DATE(p.fechaInicio) = ? THEN TRUE 
        ELSE FALSE 
    END AS urgente,

    JSON_ARRAYAGG(
        DISTINCT JSON_OBJECT(
            'id'       , pd.idDetalle,
            'nombre'   , pr.nombre,
            'cantidad' , pd.cantidad,
            'precio'   , pd.precioUnitario,
            'subtotal' , pd.subtotal,
            'color'    , c.color,
            'estado'   , pd.estadoProducto,
            'nota'     , pd.observaciones,
            'foto'     , (
                SELECT fp.urlFoto 
                FROM tblfotosproductos fp 
                WHERE fp.idProducto = pr.idProducto 
                ORDER BY fp.fechaCreacion DESC 
                LIMIT 1
            )
        )
    ) AS productos

FROM tblasignacionpedidos ap
JOIN tblpedidos p ON ap.idPedido = p.idPedido
JOIN tbldireccioncliente dc ON p.idDireccion = dc.idDireccion
LEFT JOIN tblusuarios u ON p.idUsuarios = u.idUsuarios
LEFT JOIN tblnoclientes nc ON p.idNoClientes = nc.idNoClientes

-- Subquery de pagos con alias único (pg)
LEFT JOIN (
    SELECT idPedido, SUM(monto) AS total_pagado
    FROM tblpagos
    WHERE estadoPago = 'completado'
    GROUP BY idPedido
) pg ON pg.idPedido = p.idPedido

LEFT JOIN tblpedidodetalles pd ON p.idPedido = pd.idPedido
LEFT JOIN tblproductoscolores pc ON pd.idProductoColores = pc.idProductoColores
LEFT JOIN tblproductos pr ON pc.idProducto = pr.idProducto
LEFT JOIN tblcolores c ON pc.idColor = c.idColores

WHERE ap.idRepartidor = (
    SELECT idRepartidor FROM tblrepartidores WHERE idUsuario = ?
)
AND LOWER(p.estadoActual) IN ('enviando','recogiendo')

GROUP BY p.idPedido
ORDER BY urgente DESC, p.idPedido;
      `,
      [fechaHoyMX, fechaHoyMX, idUsuario]
    );

    const pedidos = rows.map(row => ({
      ...row,
      productos: JSON.parse(row.productos)
    }));

    res.json({
      fechaConsulta: fechaHoyMX,
      repartidor: idRepartidor,
      totalPedidos: pedidos.length,
      pedidos
    });

  } catch (error) {
    console.error('Error en /repartidor/pedidos-hoy:', error);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});



//------------------------ENPOIT ALEXA-------------
routerRepartidorPedidos.get("/repartidor/todos-pedidos", async (req, res) => {
  try {
    const today = moment().tz("America/Mexico_City").startOf("day").format("YYYY-MM-DD");

    const [rows] = await pool.query(
      `
      SELECT
        p.idPedido,
        p.idUsuarios,
        p.idNoClientes,
        p.idRastreo,
        p.estadoActual,
        p.tipoPedido,
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
        d.referencias,

        ap.idAsignacion,
        ap.idRepartidor AS asignacion_idRepartidor,
        ap.fechaAsignacion,

        r.idRepartidor,
        u.nombre AS nombreRepartidor,
        u.apellidoP AS apellidoPRepartidor,
        u.apellidoM AS apellidoMRepartidor,
        u.telefono AS telefonoRepartidor

      FROM tblpedidos p
      LEFT JOIN tblpagos pg ON p.idPedido = pg.idPedido
      INNER JOIN tbldireccioncliente d ON p.idDireccion = d.idDireccion
      LEFT JOIN tblasignacionpedidos ap ON p.idPedido = ap.idPedido
      LEFT JOIN tblrepartidores r ON ap.idRepartidor = r.idRepartidor
      LEFT JOIN tblusuarios u ON r.idUsuario = u.idUsuarios

      WHERE (
        LOWER(p.estadoActual) IN ('confirmado', 'enviando')
        AND DATE(CONVERT_TZ(p.fechaInicio, '+00:00', '-06:00')) >= ?
      )

      GROUP BY p.idPedido
      ORDER BY p.fechaInicio ASC
      `,
      [today]
    );

    const pedidos = rows.map((p) => ({
      idPedido: p.idPedido,
      idRastreo: p.idRastreo,
      estado: p.estadoActual,
      tipoPedido: p.tipoPedido,
      totalPagar: p.totalPagar,
      totalPagado: p.totalPagado,
      isFullyPaid: !!p.isFullyPaid,
      fechaInicio: moment(p.fechaInicio).tz("America/Mexico_City").format("YYYY-MM-DD HH:mm:ss"),
      fechaEntrega: moment(p.fechaEntrega).tz("America/Mexico_City").format("YYYY-MM-DD HH:mm:ss"),
      horaAlquiler: p.horaAlquiler,
      fechaRegistro: moment(p.fechaRegistro).tz("America/Mexico_City").format("YYYY-MM-DD HH:mm:ss"),

      direccion: {
        idDireccion: p.idDireccion,
        nombre: p.nombre,
        apellido: p.apellido,
        telefono: p.telefono,
        codigoPostal: p.codigoPostal,
        estado: p.direccionEstado,
        municipio: p.municipio,
        localidad: p.localidad,
        direccion: p.direccion,
        referencias: p.referencias,
      },

      asignado: !!p.idAsignacion,
      esClienteRegistrado: p.idUsuarios !== null,

      repartidor: p.idRepartidor
        ? {
          idRepartidor: p.idRepartidor,
          nombre: p.nombreRepartidor,
          apellidoP: p.apellidoPRepartidor,
          apellidoM: p.apellidoMRepartidor,
          telefono: p.telefonoRepartidor,
          fechaAsignacion: moment(p.fechaAsignacion).tz("America/Mexico_City").format("YYYY-MM-DD HH:mm:ss"),
        }
        : null,
    }));

    res.json({
      success: true,
      pedidos,
    });
  } catch (err) {
    console.error("Error al obtener todos los pedidos:", err);
    res.status(500).json({
      success: false,
      message: "Error interno al obtener pedidos",
    });
  }
});



//Checar enpoit para movil

// GET: Detalles de un pedido por su ID
routerRepartidorPedidos.get("/repartidor/pedido/:idPedido", async (req, res) => {
  const { idPedido } = req.params;

  try {
    // Consulta principal del pedido
    const [pedido] = await pool.query(
      `
      SELECT 
        p.idPedido,
        p.estadoActual
      FROM tblpedidos p
      INNER JOIN tbldireccioncliente d ON p.idDireccion = d.idDireccion
      WHERE p.idPedido = ?
      LIMIT 1
      `,
      [idPedido]
    );

    if (pedido.length === 0) {
      return res.status(404).json({ success: false, message: "Pedido no encontrado" });
    }

    // Consulta de detalles con foto (una por producto)
    const [detalles] = await pool.query(
      `
      SELECT 
        pd.idDetalle,
        pd.cantidad,
        pd.precioUnitario,
        pd.diasAlquiler,
        pd.subtotal,
        pd.estadoProducto,
        pd.observaciones,
        pc.idProductoColores,
        c.color,
        pr.idProducto,
        pr.nombre AS nombreProducto,
        pr.detalles AS descripcionProducto,
        pr.material,
        (
          SELECT fp.urlFoto
          FROM tblfotosproductos fp
          WHERE fp.idProducto = pr.idProducto
          ORDER BY fp.fechaCreacion ASC
          LIMIT 1
        ) AS fotoProducto
      FROM tblpedidodetalles pd
      INNER JOIN tblproductoscolores pc ON pd.idProductoColores = pc.idProductoColores
      INNER JOIN tblproductos pr ON pc.idProducto = pr.idProducto
      INNER JOIN tblcolores c ON pc.idColor = c.idColores
      WHERE pd.idPedido = ?
      `,
      [idPedido]
    );

    // Estructura de respuesta
    res.json({
      success: true,
      pedido: {
        idPedido: pedido[0].idPedido,
        estado: pedido[0].estadoActual,
        productos: detalles.map((d) => ({
          idDetalle: d.idDetalle,
          cantidad: d.cantidad,
          diasAlquiler: d.diasAlquiler,
          precioUnitario: d.precioUnitario,
          subtotal: d.subtotal,
          estadoProducto: d.estadoProducto,
          observaciones: d.observaciones,
          producto: {
            idProducto: d.idProducto,
            nombre: d.nombreProducto,
            descripcion: d.descripcionProducto,
            material: d.material,
            color: d.color,
            foto: d.fotoProducto || null
          },
        })),
      },
    });
  } catch (err) {
    console.error("Error al obtener detalles del pedido:", err);
    res.status(500).json({ success: false, message: "Error interno del servidor" });
  }
});




//Enpoit de pedidos asigandos de repartidor
routerRepartidorPedidos.post('/pedidos/:idPedido/incidente', verifyToken, csrfProtection, async (req, res) => {
  const { idPedido } = req.params;
  const { entireOrderIssue, orderObservations, productIssues, estado_pedido } = req.body;
  console.log("Datos recibidso idPEDIDO", idPedido)


  console.log("Datos recibidso", entireOrderIssue, orderObservations, productIssues, estado_pedido)
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();

    // Validar datos de entrada
    if (!estado_pedido || !['Incompleto', 'Incidente'].includes(estado_pedido)) {
      return res.status(400).json({
        success: false,
        message: 'El estado del pedido debe ser "Incompleto" o "Incidente".',
      });
    }

    // Verificar si el pedido existe
    const [existingPedido] = await connection.query(
      'SELECT idPedido, estadoActual FROM tblpedidos WHERE idPedido = ?',
      [idPedido]
    );

    if (existingPedido.length === 0) {
      await connection.rollback();
      return res.status(404).json({
        success: false,
        message: 'Pedido no encontrado.',
      });
    }

    const pedido = existingPedido[0];
    const fechaModificacion = obtenerFechaMexico();

    // Actualizar el estado del pedido
    await connection.query(
      'UPDATE tblpedidos SET estadoActual = ?, FechaA = ? WHERE idPedido = ?',
      [
        estado_pedido,     // nuevo estado
        fechaModificacion, // nueva fecha
        idPedido           // id del pedido a actualizar
      ]
    );


    // Caso 1: Incidente afecta todo el pedido
    if (entireOrderIssue) {
      await connection.query(
        'UPDATE tblpedidodetalles SET estadoProducto = ?, observaciones = ? WHERE idPedido = ?',
        [estado_pedido, orderObservations, idPedido]
      );
    } else {
      // Caso 2: Incidente afecta productos específicos
      if (!Array.isArray(productIssues) || productIssues.length === 0) {
        await connection.rollback();
        return res.status(400).json({
          success: false,
          message: 'Debe especificar al menos un producto afectado.',
        });
      }

      for (const issue of productIssues) {
        const { id, estado, cantidad_afectada, nota } = issue;

        // Validar que el producto exista en el pedido
        const [detalle] = await connection.query(
          'SELECT cantidad FROM tblpedidodetalles WHERE idDetalle = ? AND idPedido = ?',
          [id, idPedido]
        );

        if (detalle.length === 0) {
          await connection.rollback();
          return res.status(404).json({
            success: false,
            message: `Detalle de producto con id ${id} no encontrado.`,
          });
        }

        const cantidadDisponible = detalle[0].cantidad;
        if (estado === 'Incompleto' && (cantidad_afectada <= 0 || cantidad_afectada > cantidadDisponible)) {
          await connection.rollback();
          return res.status(400).json({
            success: false,
            message: `La cantidad afectada (${cantidad_afectada}) debe estar entre 1 y ${cantidadDisponible}.`,
          });
        }

        // Actualizar el estado y observaciones del producto
        await connection.query(
          'UPDATE tblpedidodetalles SET estadoProducto = ?, observaciones = ?  WHERE idDetalle = ?',
          [
            estado,
            nota,
            id,
          ]
        );


      }
    }

    await connection.commit();

    res.status(200).json({
      success: true,
      message: 'Incidente reportado y estados actualizados correctamente.',
      data: { idPedido, estado_pedido },
    });
  } catch (error) {
    await connection.rollback();
    console.error('❌ Error al reportar incidente:', error);
    res.status(500).json({
      success: false,
      message: 'Error interno al reportar el incidente.',
      error: error.message,
    });
  } finally {
    if (connection) connection.release();
  }
});

//Movil
routerRepartidorPedidos.post('/pedidos/:idPedido/incidente-movil', verifyToken, async (req, res) => {
  const { idPedido } = req.params;
  const { entireOrderIssue, orderObservations, productIssues, estado_pedido } = req.body;
  console.log("Datos recibidso idPEDIDO", idPedido)


  console.log("Datos recibidso", entireOrderIssue, orderObservations, productIssues, estado_pedido)
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();

    // Validar datos de entrada
    if (!estado_pedido || !['Incompleto', 'Incidente'].includes(estado_pedido)) {
      return res.status(400).json({
        success: false,
        message: 'El estado del pedido debe ser "Incompleto" o "Incidente".',
      });
    }

    // Verificar si el pedido existe
    const [existingPedido] = await connection.query(
      'SELECT idPedido, estadoActual FROM tblpedidos WHERE idPedido = ?',
      [idPedido]
    );

    if (existingPedido.length === 0) {
      await connection.rollback();
      return res.status(404).json({
        success: false,
        message: 'Pedido no encontrado.',
      });
    }

    const pedido = existingPedido[0];
    const fechaModificacion = obtenerFechaMexico();

    // Actualizar el estado del pedido
    await connection.query(
      'UPDATE tblpedidos SET estadoActual = ?, FechaA = ? WHERE idPedido = ?',
      [
        estado_pedido,     // nuevo estado
        fechaModificacion, // nueva fecha
        idPedido           // id del pedido a actualizar
      ]
    );


    // Caso 1: Incidente afecta todo el pedido
    if (entireOrderIssue) {
      await connection.query(
        'UPDATE tblpedidodetalles SET estadoProducto = ?, observaciones = ? WHERE idPedido = ?',
        [estado_pedido, orderObservations, idPedido]
      );
    } else {
      // Caso 2: Incidente afecta productos específicos
      if (!Array.isArray(productIssues) || productIssues.length === 0) {
        await connection.rollback();
        return res.status(400).json({
          success: false,
          message: 'Debe especificar al menos un producto afectado.',
        });
      }

      for (const issue of productIssues) {
        const { id, estado, cantidad_afectada, nota } = issue;

        // Validar que el producto exista en el pedido
        const [detalle] = await connection.query(
          'SELECT cantidad FROM tblpedidodetalles WHERE idDetalle = ? AND idPedido = ?',
          [id, idPedido]
        );

        if (detalle.length === 0) {
          await connection.rollback();
          return res.status(404).json({
            success: false,
            message: `Detalle de producto con id ${id} no encontrado.`,
          });
        }

        const cantidadDisponible = detalle[0].cantidad;
        if (estado === 'Incompleto' && (cantidad_afectada <= 0 || cantidad_afectada > cantidadDisponible)) {
          await connection.rollback();
          return res.status(400).json({
            success: false,
            message: `La cantidad afectada (${cantidad_afectada}) debe estar entre 1 y ${cantidadDisponible}.`,
          });
        }

        // Actualizar el estado y observaciones del producto
        await connection.query(
          'UPDATE tblpedidodetalles SET estadoProducto = ?, observaciones = ?  WHERE idDetalle = ?',
          [
            estado,
            nota,
            id,
          ]
        );


      }
    }

    await connection.commit();

    res.status(200).json({
      success: true,
      message: 'Incidente reportado y estados actualizados correctamente.',
      data: { idPedido, estado_pedido },
    });
  } catch (error) {
    await connection.rollback();
    console.error('❌ Error al reportar incidente:', error);
    res.status(500).json({
      success: false,
      message: 'Error interno al reportar el incidente.',
      error: error.message,
    });
  } finally {
    if (connection) connection.release();
  }
});




//Actualizar estadi acataul a en alquileer
routerRepartidorPedidos.put('/pedidos/:idPedido/status/en-alquiler', verifyToken, csrfProtection, async (req, res) => {
  const { idPedido } = req.params;

  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();

    // Verificar si el pedido existe y está en estado "Enviando"
    const [existingPedido] = await connection.query(
      'SELECT idPedido, estadoActual FROM tblpedidos WHERE idPedido = ?',
      [idPedido]
    );

    if (existingPedido.length === 0) {
      await connection.rollback();
      return res.status(404).json({
        success: false,
        message: 'Pedido no encontrado.',
      });
    }

    const pedido = existingPedido[0];
    if (pedido.estadoActual !== 'Enviando') {
      await connection.rollback();
      return res.status(400).json({
        success: false,
        message: 'El pedido debe estar en estado "Enviando" para marcarlo como "En alquiler".',
      });
    }

    // Actualizar estado y registrar fecha de inicio de alquiler
    const fechaModificacion = obtenerFechaMexico();
    await connection.query(
      'UPDATE tblpedidos SET estadoActual = ?, FechaA = ? WHERE idPedido = ?',
      ['En alquiler', fechaModificacion, idPedido]
    );

    await connection.commit();

    res.status(200).json({
      success: true,
      message: 'Pedido marcado como "En alquiler" correctamente.',
      data: { idPedido, estadoActual: 'En alquiler' },
    });
  } catch (error) {
    await connection.rollback();
    console.error('❌ Error al marcar pedido como "En alquiler":', error);
    res.status(500).json({
      success: false,
      message: 'Error interno al actualizar el estado del pedido.',
      error: error.message,
    });
  } finally {
    if (connection) connection.release();
  }
});

//Movil
routerRepartidorPedidos.put('/pedidos/:idPedido/status-movil/en-alquiler', verifyToken, async (req, res) => {
  const { idPedido } = req.params;

  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();

    // Verificar si el pedido existe y está en estado "Enviando"
    const [existingPedido] = await connection.query(
      'SELECT idPedido, estadoActual FROM tblpedidos WHERE idPedido = ?',
      [idPedido]
    );

    if (existingPedido.length === 0) {
      await connection.rollback();
      return res.status(404).json({
        success: false,
        message: 'Pedido no encontrado.',
      });
    }

    const pedido = existingPedido[0];
    if (pedido.estadoActual !== 'Enviando') {
      await connection.rollback();
      return res.status(400).json({
        success: false,
        message: 'El pedido debe estar en estado "Enviando" para marcarlo como "En alquiler".',
      });
    }

    // Actualizar estado y registrar fecha de inicio de alquiler
    const fechaModificacion = obtenerFechaMexico();
    await connection.query(
      'UPDATE tblpedidos SET estadoActual = ?, FechaA = ? WHERE idPedido = ?',
      ['En alquiler', fechaModificacion, idPedido]
    );

    await connection.commit();

    res.status(200).json({
      success: true,
      message: 'Pedido marcado como "En alquiler" correctamente.',
      data: { idPedido, estadoActual: 'En alquiler' },
    });
  } catch (error) {
    await connection.rollback();
    console.error('❌ Error al marcar pedido como "En alquiler":', error);
    res.status(500).json({
      success: false,
      message: 'Error interno al actualizar el estado del pedido.',
      error: error.message,
    });
  } finally {
    if (connection) connection.release();
  }
});




//Enpoit devuelto
routerRepartidorPedidos.put('/pedidos/:idPedido/status/devuelto', verifyToken, csrfProtection, async (req, res) => {
  const { idPedido } = req.params;

  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();

    // Verificar si el pedido existe y está en estado válido
    const [existingPedido] = await connection.query(
      'SELECT idPedido, estadoActual FROM tblpedidos WHERE idPedido = ?',
      [idPedido]
    );

    if (existingPedido.length === 0) {
      await connection.rollback();
      return res.status(404).json({
        success: false,
        message: 'Pedido no encontrado.',
      });
    }

    const pedido = existingPedido[0];
    if (!['Recogiendo', 'En alquiler'].includes(pedido.estadoActual)) {
      await connection.rollback();
      return res.status(400).json({
        success: false,
        message: 'El pedido debe estar en estado "Recogiendo" o "En alquiler" para marcarlo como "Devuelto".',
      });
    }


    // Actualizar estado del pedido
    const fechaModificacion = obtenerFechaMexico();
    await connection.query(
      'UPDATE tblpedidos SET estadoActual = ?, FechaA = ? WHERE idPedido = ?',
      ['Devuelto', fechaModificacion, idPedido]
    );


    await connection.commit();

    res.status(200).json({
      success: true,
      message: 'Pedido marcado como "Devuelto" y productos devueltos al inventario.',
      data: { idPedido, estadoActual: 'Devuelto' },
    });
  } catch (error) {
    await connection.rollback();
    console.error('❌ Error al marcar pedido como "Devuelto":', error);
    res.status(500).json({
      success: false,
      message: 'Error interno al actualizar el estado del pedido.',
      error: error.message,
    });
  } finally {
    if (connection) connection.release();
  }
});

//Mopvil
routerRepartidorPedidos.put('/pedidos/:idPedido/status-movil/devuelto', verifyToken, async (req, res) => {
  const { idPedido } = req.params;

  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();

    // Verificar si el pedido existe y está en estado válido
    const [existingPedido] = await connection.query(
      'SELECT idPedido, estadoActual FROM tblpedidos WHERE idPedido = ?',
      [idPedido]
    );

    if (existingPedido.length === 0) {
      await connection.rollback();
      return res.status(404).json({
        success: false,
        message: 'Pedido no encontrado.',
      });
    }

    const pedido = existingPedido[0];
    if (!['Recogiendo', 'En alquiler'].includes(pedido.estadoActual)) {
      await connection.rollback();
      return res.status(400).json({
        success: false,
        message: 'El pedido debe estar en estado "Recogiendo" o "En alquiler" para marcarlo como "Devuelto".',
      });
    }


    // Actualizar estado del pedido
    const fechaModificacion = obtenerFechaMexico();
    await connection.query(
      'UPDATE tblpedidos SET estadoActual = ?, FechaA = ? WHERE idPedido = ?',
      ['Devuelto', fechaModificacion, idPedido]
    );


    await connection.commit();

    res.status(200).json({
      success: true,
      message: 'Pedido marcado como "Devuelto" y productos devueltos al inventario.',
      data: { idPedido, estadoActual: 'Devuelto' },
    });
  } catch (error) {
    await connection.rollback();
    console.error('❌ Error al marcar pedido como "Devuelto":', error);
    res.status(500).json({
      success: false,
      message: 'Error interno al actualizar el estado del pedido.',
      error: error.message,
    });
  } finally {
    if (connection) connection.release();
  }
});



routerRepartidorPedidos.put(
  "/pedidos/:id",
  verifyToken,
  csrfProtection,
  async (req, res) => {
    const { id } = req.params;
    const { estadoActual } = req.body;

    console.log("Datos recibidos", id, estadoActual);
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

      // Actualizar el estado del pedido
      const fechaModificacion = obtenerFechaMexico();
      await connection.query(
        `UPDATE tblpedidos SET estadoActual = ?, FechaA = ? WHERE idPedido = ?`,
        [estadoActual, fechaModificacion, id]
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


routerRepartidorPedidos.get('/repartidor/pedidos-historico', verifyToken, async (req, res) => {
  try {
    const idUsuario = req.user?.id;
    if (!idUsuario) {
      return res.status(400).json({ error: 'Falta idUsuario en la petición' });
    }

    // Obtener ID de repartidor
    const [[repartidor]] = await pool.execute(
      'SELECT idRepartidor FROM tblrepartidores WHERE idUsuario = ?',
      [idUsuario]
    );

    if (!repartidor) {
      return res.status(404).json({ error: 'No se encontró repartidor para este usuario' });
    }

    const idRepartidor = repartidor.idRepartidor;

    // Obtener fecha actual México para registro (aunque no filtraremos por fecha)
    const fechaCompletaMX = obtenerFechaMexico(); // 'YYYY-MM-DD HH:mm:ss'
    const fechaHoyMX = fechaCompletaMX.split(' ')[0]; // 'YYYY-MM-DD'

    console.log({ idUsuario, idRepartidor, fechaHoyMX });

    const [rows] = await pool.execute(
      `
      SELECT 
        p.idPedido AS id,
        p.tipoPedido AS tipo_pedido,
        IFNULL(p.estadoActual, 'sin_estado') AS estado_pedido,
        CASE 
          WHEN p.idUsuarios IS NOT NULL THEN 
            CONCAT(u.nombre, ' ', u.apellidoP, ' - Pedido #', p.idPedido)
          ELSE 
            CONCAT(nc.nombre, ' ', nc.apellidoCompleto, ' - Pedido #', p.idPedido)
        END AS descripcion,
        CASE
          WHEN p.idUsuarios IS NOT NULL THEN 
            CONCAT(u.nombre, ' ', u.apellidoP)
          ELSE 
            CONCAT(nc.nombre, ' ', nc.apellidoCompleto)
        END AS cliente,
        CASE
          WHEN p.idUsuarios IS NOT NULL THEN u.telefono
          ELSE nc.telefono
        END AS telefono_cliente,
        dc.localidad,
        dc.municipio,
        dc.estado,
        dc.direccion,
        p.fechaInicio AS fecha_entrega,
        p.totalPagar AS total_a_pagar,
        COALESCE(SUM(pg.monto), 0) AS total_pagado,
        pd.diasAlquiler,
        CASE 
          WHEN DATE(p.fechaRegistro) = DATE(p.fechaInicio) THEN TRUE 
          ELSE FALSE 
        END AS urgente,
        JSON_ARRAYAGG(
          DISTINCT JSON_OBJECT(
            'id'       , pd.idDetalle,
            'nombre'   , pr.nombre,
            'cantidad' , pd.cantidad,
            'precio'   , pd.precioUnitario,
            'subtotal' , pd.subtotal,
            'color'    , c.color,
            'estado'   , pd.estadoProducto,
            'nota'     , pd.observaciones,
            'foto'     , (
              SELECT fp.urlFoto 
              FROM tblfotosproductos fp 
              WHERE fp.idProducto = pr.idProducto 
              ORDER BY fp.fechaCreacion DESC 
              LIMIT 1
            )
          )
        ) AS productos
      FROM tblasignacionpedidos ap
      JOIN tblpedidos p ON ap.idPedido = p.idPedido AND p.estadoActual = 'En alquiler' || p.estadoActual = 'Devuelto' || p.estadoActual = 'Finalizado'
      JOIN tbldireccioncliente dc ON p.idDireccion = dc.idDireccion
      LEFT JOIN tblusuarios u ON p.idUsuarios = u.idUsuarios
      LEFT JOIN tblnoclientes nc ON p.idNoClientes = nc.idNoClientes
      LEFT JOIN tblpagos pg ON p.idPedido = pg.idPedido AND pg.estadoPago = 'completado'
      LEFT JOIN tblpedidodetalles pd ON p.idPedido = pd.idPedido
      LEFT JOIN tblproductoscolores pc ON pd.idProductoColores = pc.idProductoColores
      LEFT JOIN tblproductos pr ON pc.idProducto = pr.idProducto
      LEFT JOIN tblcolores c ON pc.idColor = c.idColores
      WHERE ap.idRepartidor = (
        SELECT idRepartidor FROM tblrepartidores WHERE idUsuario = ?
      )
      GROUP BY p.idPedido
      ORDER BY p.fechaInicio DESC, p.idPedido;
      `,
      [idUsuario]
    );

    const pedidos = rows.map(row => ({
      ...row,
      productos: JSON.parse(row.productos)
    }));

    res.json({
      fechaConsulta: fechaHoyMX,
      repartidor: idRepartidor,
      totalPedidos: pedidos.length,
      pedidos
    });

  } catch (error) {
    console.error('Error en /repartidor/pedidos-historico:', error);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});



module.exports = routerRepartidorPedidos;
