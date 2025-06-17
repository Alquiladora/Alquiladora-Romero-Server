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
const moment = require("moment");
const { listeners } = require("process");
const { route } = require("./clssesiones");
const {obtenerFechaMexico} = require("./clsUsuarios")
const {verifyToken}= require("./clsUsuarios")


const routerRepartidorPedidos = express.Router();
routerRepartidorPedidos.use(express.json());
routerRepartidorPedidos.use(cookieParser());


routerRepartidorPedidos.get("/repartidores", verifyToken,csrfProtection, async (req, res, next) => {
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
        repartidores: rows
      });
    } catch (err) {
      console.error("Error al obtener repartidores:", err);
      return res.status(500).json({
        success: false,
        message: "Error interno al consultar repartidores"
      });
    }
  }
);




async function countByDate(date) {
  const [[{ v }]] = await pool.query(
    `SELECT COUNT(*) AS v FROM tblpedidos WHERE DATE(fechaInicio)=?`,
    [date]
  );
  return v;
}

routerRepartidorPedidos.get("/pedidos",  async (req, res) => {
  try {
    const today     = moment().startOf("day");
    console.log("dIA hoy",today )
    const now       = moment();  
    console.log("Hora actual", now)
   
    const rawDates  = Array.from({ length: 6 }, (_, i) =>
      moment(today).add(i, "day")
    );
     console.log("RedDates", rawDates)
    const targetDates = await Promise.all(
      rawDates.map(async (d) => {
        if (d.day() === 0) {
          const fri = d.clone().day(5).format("YYYY-MM-DD");
          const sat = d.clone().day(6).format("YYYY-MM-DD");
          const [fc, sc] = await Promise.all([countByDate(fri), countByDate(sat)]);
          return fc < sc ? fri : sat;
        }
        return d.format("YYYY-MM-DD");
      })
    );
    const uniqueDates = Array.from(new Set(targetDates));
    console.log("UniqueDAtes", uniqueDates)

    // Traemos horaAlquiler además de los demás campos
    const [rows] = await pool.query(
      `
      SELECT
        p.idPedido,
        p.idUsuarios,
        p.idNoClientes,
        p.idRastreo,
        p.estadoActual,
        p.totalPagar,
        COALESCE(SUM(pg.monto),0)     AS totalPagado,
        (COALESCE(SUM(pg.monto),0)>=p.totalPagar) AS isFullyPaid,
        p.fechaInicio,
        p.fechaEntrega,
        p.horaAlquiler,              
        d.idDireccion,
        d.nombre,
        d.apellido,
        d.telefono,
        d.codigoPostal,
        d.estado   AS direccionEstado,
        d.municipio,
        d.localidad,
        d.direccion,
        d.referencias
      FROM tblpedidos p
      LEFT JOIN tblpagos pg ON p.idPedido = pg.idPedido
      INNER JOIN tbldireccioncliente d ON p.idDireccion = d.idDireccion
      WHERE DATE(p.fechaInicio) IN (?)
      GROUP BY p.idPedido
      `,
      [uniqueDates]
    );

    console.log(rows)

    // Clasificamos y marcamos sameDay
    const deliveries = [];
    const pickups    = [];

    rows.forEach((r) => {
      const isTodayOrder = moment(r.fechaInicio).isSame(today, "day");
      const entregaTime  = moment(r.horaAlquiler, "HH:mm:ss");
      const sameDay      = isTodayOrder && entregaTime.isAfter(now);
      const record       = { ...r, sameDay };

      if (r.estadoActual === "Confirmado") {
        deliveries.push(record);
      } else if (moment(r.fechaEntrega).isBefore(today)) {
        pickups.push(record);
      }
    });

    // Ordenamos: primero sameDay, luego el resto
    deliveries.sort((a, b) => {
      if (a.sameDay && !b.sameDay) return -1;
      if (!a.sameDay && b.sameDay) return 1;
      return 0;
    });

    // Totales por ubicación (solo para entregas)
    const totalsByLocation = {};
    deliveries.forEach((r) => {
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
    console.log("Datos de totals bylocation", totalsByLocation  )

    return res.json({
      success: true,
      days: uniqueDates,
      totalsByLocation: Object.values(totalsByLocation),
      deliveries,
      pickups,
    });
  } catch (err) {
    console.error("Error al obtener pedidos:", err);
    return res.status(500).json({
      success: false,
      message: "Error interno al consultar pedidos",
    });
  }
});




routerRepartidorPedidos.get('/wearOs/repartidores', async (req, res) => {
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
      repartidores: rows
    });
  } catch (error) {
    console.error('Error al obtener repartidores activos:', error);
    return res.status(500).json({
      success: false,
      message: 'Error interno del servidor'
    });
  }
});


module.exports= routerRepartidorPedidos;
