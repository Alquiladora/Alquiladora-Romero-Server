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
const { obtenerFechaMexico } = require("./clsUsuarios")
const Stripe = require('stripe');
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
const axios = require("axios");
const router = require("../rutas");
const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
const { verifyToken } = require("./clsUsuarios");

const routerPedidos = express.Router();
routerPedidos.use(express.json());
routerPedidos.use(cookieParser());

//Cache de predicciones
const predictionCache = new Map();
const CACHE_TTL =5 * 60 * 1000;

const PREDICTION_TIMEOUT = 5000;




routerPedidos.get("/pedidosmanuales/:correo", csrfProtection, async (req, res) => {
  const correoUsuario = req.params.correo;
  console.log("Datos de correo elnpoy pedido", correoUsuario)
  try {
    const [rows] = await pool.query(
      `
SELECT
    us.idUsuarios, 
    us.correo,
    us.rol,
    us.nombre,
    us.apellidoP,
    us.apellidoM,
    us.telefono,
    dir.idDireccion,
    dir.nombre AS nombreDireccion,
    dir.apellido AS apellidoDireccion,
    dir.telefono AS telefonoDireccion,
    dir.codigoPostal,
    dir.pais,
    dir.estado,
    dir.municipio,
    dir.localidad,
    dir.direccion,
    dir.referencias,
    dir.predeterminado
FROM tblusuarios us
LEFT JOIN tbldireccioncliente dir
  ON us.idUsuarios = dir.idUsuario
WHERE us.correo = ?;
`,
      [correoUsuario]
    );
    res.json(rows);
  } catch (err) {
    console.error("Error en pedidosmanuales", err);
    res.status(500).json({ error: "Error al obtener los datos" });
  }
});



routerPedidos.post("/crear-pedido-no-cliente", csrfProtection, async (req, res) => {
  try {
    const {
      nombre,
      apellido,
      telefono,
      correo,
      esClienteExistente,
      selectedDireccionId,
      codigoPostal,
      pais,
      estado,
      municipio,
      localidad,
      direccion,
      referencia,
      fechaInicio,
      fechaEntrega,
      horaAlquiler,
      formaPago,
      detallesPago,
      total,
      lineItems,
      trackingId
    } = req.body;





    let crearDireccion = 0;
    let idDireccionExistente = null;

    if (!selectedDireccionId) {
      crearDireccion = 1;
    } else {
      crearDireccion = 0;
      idDireccionExistente = selectedDireccionId;
    }



    const currentDateTime = moment()
      .tz("America/Mexico_City")
      .format("YYYY-MM-DD HH:mm:ss");

    let idCliente = null;

    let correoValido = correo && correo.trim() !== "" ? correo.trim() : null;
    let telefonoValido = telefono && telefono.trim() !== "" ? telefono.trim() : null;

    if (esClienteExistente) {
      let query = "SELECT idNoClientes AS id FROM tblnoclientes WHERE ";
      let params = [];

      if (correoValido && telefonoValido) {
        query += "(correo = ? OR telefono = ?)";
        params = [correoValido, telefonoValido];
      } else if (correoValido) {
        query += "correo = ?";
        params = [correoValido];
      } else if (telefonoValido) {
        query += "telefono = ?";
        params = [telefonoValido];
      } else {
        console.log("❌ No hay correo ni teléfono válidos para buscar cliente existente");
      }

      if (params.length > 0) {
        const [clienteRows] = await pool.query(query + " LIMIT 1", params);
        if (clienteRows.length > 0) {
          idCliente = clienteRows[0].id;
        }
      }
    } else {
      let query = "SELECT idNoClientes AS id FROM tblnoclientes WHERE ";
      let params = [];

      if (correoValido && telefonoValido) {
        query += "(correo = ? OR telefono = ?)";
        params = [correoValido, telefonoValido];
      } else if (correoValido) {
        query += "correo = ?";
        params = [correoValido];
      } else if (telefonoValido) {
        query += "telefono = ?";
        params = [telefonoValido];
      } else {
        console.log("❌ No hay datos válidos para buscar no cliente");
      }

      if (params.length > 0) {
        const [noClienteRows] = await pool.query(query + " LIMIT 1", params);

        if (noClienteRows.length > 0) {
          idCliente = noClienteRows[0].id;
        }
      }
    }




    if (idCliente) {
      const [pedidosActivos] = await pool.query(
        `
        SELECT COUNT(*) AS total
        FROM tblpedidos
        WHERE (idUsuarios = ? OR idNoClientes = ?)
        AND LOWER(estadoActual) NOT IN ('Finalizado', 'Cancelado')
        `,
        [idCliente, idCliente]
      );



      if (pedidosActivos[0].total >= 5) {
        return res.status(400).json({
          success: false,
          error: "No puedes realizar más de 5 pedidos activos. Debes completar o cancelar pedidos anteriores antes de hacer uno nuevo."
        });
      }
    }



    const query = `
      CALL sp_crearPedidoBasico(
        ?, ?, ?, ?, ?,       
        ?, ?,               
        ?, ?, ?, ?, ?, ?, ?,  
        ?, ?, ?, ?, ?, ?,?,?      
      )
    `;
    const values = [
      esClienteExistente ? 1 : 0,
      nombre,
      apellido,
      telefono,
      correo,
      crearDireccion,
      idDireccionExistente || 0,
      codigoPostal,
      pais,
      estado,
      municipio,
      localidad,
      direccion,
      referencia,
      fechaInicio,
      fechaEntrega,
      horaAlquiler,
      formaPago,
      detallesPago,
      total,
      trackingId,
      currentDateTime
    ];






    const [rows] = await pool.query(query, values);


    const result = rows[0][0];



    const newIdPedido = result.newIdPedido;



    for (const item of lineItems) {




      const insertDetalle = `
          INSERT INTO tblpedidodetalles (
            idPedido, idProductoColores, cantidad, precioUnitario, diasAlquiler, subtotal
          ) VALUES (?, ?, ?, ?, ?, ?)
        `;
      await pool.query(insertDetalle, [
        newIdPedido,
        item.idProductoColores,
        item.cantidad,
        item.unitPrice,
        item.days,
        item.subtotal,
      ]);
    }

    const updateInventario = `
      UPDATE tblinventario i
      JOIN tblproductoscolores pc ON i.idProductoColor = pc.idProductoColores
      JOIN tblpedidodetalles pd ON pc.idProductoColores = pd.idProductoColores
      SET i.stock = GREATEST(i.stock - pd.cantidad, 0)  
      WHERE pd.idPedido = ?;
  `;
    await pool.query(updateInventario, [newIdPedido]);


    return res.json({
      success: true,
      message: "Pedido creado con éxito",
      idPedido: newIdPedido,
    });
  } catch (error) {
    console.error("Error al crear pedido no-cliente:", error);
    return res.status(500).json({
      success: false,
      error: "Ocurrió un error al crear el pedido.",
    });
  }
});





//Enpot de pagos
routerPedidos.post("/pagos/registrar", csrfProtection, async (req, res) => {
  try {
    const { idPedido, monto, formaPago, metodoPago, detallesPago } = req.body;


    if (!idPedido || !monto || !formaPago || !metodoPago) {
      return res.status(400).json({
        success: false,
        message: "Faltan datos requeridos (idPedido, monto, formaPago, metodoPago)",
      });
    }

    // Buscar un pago pendiente (monto NULL o 0) para ese pedido
    const [pagosPendientes] = await pool.query(
      `SELECT idPago FROM tblpagos WHERE idPedido = ? AND (monto IS NULL OR monto = 0) LIMIT 1`,
      [idPedido]
    );

    if (pagosPendientes.length > 0) {
      // Actualizar el primer pago pendiente
      const idPago = pagosPendientes[0].idPago;

      await pool.query(
        `UPDATE tblpagos 
         SET monto = ?, formaPago = ?, metodoPago = ?, detallesPago = ?, estadoPago = 'completado', fechaActualizacion = ? 
         WHERE idPago = ?`,
        [monto, formaPago, metodoPago, detallesPago, obtenerFechaMexico(), idPago]
      );

      return res.json({
        success: true,
        message: "Pago actualizado correctamente",
      });
    } else {
      // Insertar nuevo pago (segundo o siguientes pagos)
      await pool.query(
        `INSERT INTO tblpagos 
         (idPedido, monto, formaPago, metodoPago, detallesPago, estadoPago, fechaPago) 
         VALUES (?, ?, ?, ?, ?, 'completado', ?)`,
        [idPedido, monto, formaPago, metodoPago, detallesPago, obtenerFechaMexico()]
      );

      return res.json({
        success: true,
        message: "Nuevo pago registrado correctamente",
      });
    }
  } catch (error) {
    console.error("Error en registrar/actualizar pago:", error);
    return res.status(500).json({
      success: false,
      message: "Error interno al registrar el pago",
      error: error.message,
    });
  }
});



routerPedidos.get("/pedidos-manuales", csrfProtection, async (req, res) => {
  try {

    const query = `
    SELECT 
    p.idPedido,
    p.idRastreo,
    COALESCE(CONCAT(u.nombre, ' ', u.apellidoP, ' ', u.apellidoM), CONCAT(d.nombre, ' ', d.apellido)) AS nombreCliente,
    COALESCE(u.telefono, d.telefono) AS telefono,
    CONCAT(d.direccion, ', ', d.localidad, ', ', d.municipio, ', ', d.estado, ', ', d.pais, ' C.P. ', d.codigoPostal) AS direccionCompleta,
    p.fechaInicio,
    p.fechaEntrega,
    TIMESTAMPDIFF(DAY, p.fechaInicio, p.fechaEntrega) AS diasAlquiler,
    p.totalPagar,
    p.horaAlquiler,
    p.estadoActual AS estado, 
    CASE 
        WHEN u.idUsuarios IS NOT NULL THEN 'Cliente registrado'
        WHEN nc.idUsuario IS NOT NULL THEN 'Cliente convertido'
        ELSE 'No cliente'
    END AS tipoCliente,
    GROUP_CONCAT(
        CONCAT(pd.cantidad, 'x ', prod.nombre, ' (', c.color, ') - ', pd.precioUnitario, ' c/u, Subtotal: ', pd.subtotal) 
        SEPARATOR ' | '
    ) AS productosAlquilados,
    
    pagos.pagosRealizados,
    pagos.totalPagado,
    pagos.formaPago
FROM tblpedidos p
LEFT JOIN tblnoclientes nc ON p.idNoClientes = nc.idNoClientes
LEFT JOIN tbldireccioncliente d ON p.idDireccion = d.idDireccion
LEFT JOIN tblusuarios u ON p.idUsuarios = u.idUsuarios 
LEFT JOIN tblpedidodetalles pd ON p.idPedido = pd.idPedido
LEFT JOIN tblproductoscolores pc ON pd.idProductoColores = pc.idProductoColores
LEFT JOIN tblcolores c ON pc.idColor = c.idColores
LEFT JOIN tblproductos prod ON pc.idProducto = prod.idProducto

LEFT JOIN (
    SELECT 
        idPedido,
        GROUP_CONCAT(CONCAT(formaPago, ' / ', metodoPago, ' - $', monto, ' (', estadoPago, ')') SEPARATOR ' | ') AS pagosRealizados,
        COALESCE(SUM(CASE WHEN estadoPago = 'completado' THEN monto ELSE 0 END), 0) AS totalPagado,
        SUBSTRING_INDEX(GROUP_CONCAT(formaPago ORDER BY fechaPago DESC), ',', 1) AS formaPago
    FROM tblpagos
    GROUP BY idPedido
) pagos ON p.idPedido = pagos.idPedido

WHERE LOWER(p.estadoActual) NOT IN ('finalizado', 'cancelado')
GROUP BY p.idPedido
ORDER BY p.fechaRegistro DESC;

    `;

    const [results] = await pool.query(query);

    const response = results.map(pedido => {
      const productosStrArray = pedido.productosAlquilados ? pedido.productosAlquilados.split(' | ') : [];
      const productosParsed = productosStrArray.map(prodStr => {
        const regex = /^(\d+)x\s+(.+?)\s+\((.+?)\)\s+-\s+([\d.]+)\s+c\/u,\s+Subtotal:\s+([\d.]+)$/;
        const match = prodStr.match(regex);

        if (match) {
          return {
            cantidad: parseInt(match[1], 10),
            nombre: match[2].trim(),
            color: match[3].trim(),
            precioUnitario: parseFloat(match[4]),
            subtotal: parseFloat(match[5]),
          };
        } else {
          return {
            cantidad: null,
            nombre: prodStr,
            color: null,
            precioUnitario: null,
            subtotal: null,
          };
        }
      });

      const pagosResumen = pedido.pagosRealizados ? pedido.pagosRealizados.split(' | ') : [];

      const estadoPago =
        parseFloat(pedido.totalPagado) >= parseFloat(pedido.totalPagar)
          ? 'completado'
          : parseFloat(pedido.totalPagado) > 0
            ? 'parcial'
            : 'pendiente';

      return {
        idPedido: pedido.idPedido,
        idRastreo: pedido.idRastreo,
        cliente: {
          nombre: pedido.nombreCliente,
          telefono: pedido.telefono,
          direccion: pedido.direccionCompleta,
          tipoCliente: pedido.tipoCliente,
        },
        fechas: {
          inicio: pedido.fechaInicio,
          entrega: pedido.fechaEntrega,
          diasAlquiler: pedido.diasAlquiler,
          horaAlquiler: pedido.horaAlquiler,
        },
        pago: {
          resumen: pagosResumen,
          totalPagado: parseFloat(pedido.totalPagado),
          estadoPago: estadoPago,
          formaPago: pedido.formaPago,
        },
        estado: pedido.estado,
        productos: productosParsed,
        totalPagar: pedido.totalPagar
      };
    });

    res.status(200).json({
      success: true,
      data: response,
      total: response.length
    });

  } catch (error) {
    console.error('Error fetching manual pedidos:', error);
    res.status(500).json({
      success: false,
      message: 'Error al obtener los pedidos manuales',
      error: error.message
    });
  }
});



routerPedidos.get("/pedidos-general", csrfProtection, async (req, res) => {
  try {
    const { page = 1, limit = 50, estado, search, startDate, endDate } = req.query;
    const offset = (page - 1) * limit;

    await pool.query("SET SESSION group_concat_max_len = 1000000;");
    let conditions = [];
    let filterParams = [];
    if (estado && estado !== "Todos") {
      conditions.push("p.estadoActual = ?");
      filterParams.push(estado.toLowerCase());
    }

    if (search) {
      const searchLike = `%${search}%`;
      conditions.push(`(
    p.idRastreo COLLATE utf8mb4_unicode_ci LIKE ? OR
    COALESCE(CONCAT(u.nombre, ' ', u.apellidoP, ' ', u.apellidoM), CONCAT(d.nombre, ' ', d.apellido)) COLLATE utf8mb4_unicode_ci LIKE ? OR
    CONCAT(d.direccion, ', ', d.localidad, ', ', d.municipio, ', ', d.estado, ', ', d.pais, ' C.P. ', d.codigoPostal) COLLATE utf8mb4_unicode_ci LIKE ?
  )`);
      filterParams.push(searchLike, searchLike, searchLike);
    }

    if (startDate) {
      conditions.push("p.fechaInicio >= ?");
      filterParams.push(startDate);
    }

    if (endDate) {
      conditions.push("p.fechaInicio <= ?");
      filterParams.push(endDate);
    }
    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    //Total de pedidos filtrados
    const countQuery = `
    SELECT COUNT(DISTINCT p.idPedido) AS total
    FROM tblpedidos p
    LEFT JOIN tblnoclientes nc ON p.idNoClientes= nc.idNoClientes
    LEFT JOIN tbldireccioncliente d ON p.idDireccion= d.idDireccion
    LEFT JOIN tblusuarios u ON p.idUsuarios = u.idUsuarios
    ${whereClause}
    `
    const [countResult] = await pool.query(countQuery, filterParams);
    const totalPedidos = countResult[0].total;

    const query = `
     SELECT 
    p.idPedido,
    p.idRastreo,
    COALESCE(CONCAT(u.nombre, ' ', u.apellidoP, ' ', u.apellidoM), CONCAT(d.nombre, ' ', d.apellido)) AS nombreCliente,
    COALESCE(u.telefono, d.telefono) AS telefono,
    CONCAT(d.direccion, ', ', d.localidad, ', ', d.municipio, ', ', d.estado, ', ', d.pais, ' C.P. ', d.codigoPostal) AS direccionCompleta,
    p.fechaInicio,
    p.fechaEntrega,
    TIMESTAMPDIFF(DAY, p.fechaInicio, p.fechaEntrega) AS diasAlquiler,
    p.horaAlquiler,
    p.detallesPago,
    p.totalPagar,
    CONCAT(UCASE(LEFT(p.estadoActual,1)), LCASE(SUBSTRING(p.estadoActual,2))) AS estado,
    p.fechaRegistro,
    CASE 
        WHEN u.idUsuarios IS NOT NULL THEN 'Cliente registrado'
        WHEN nc.idNoClientes IS NOT NULL THEN 'Cliente convertido'
        ELSE 'No cliente'
    END AS tipoCliente,
    JSON_ARRAYAGG(
        JSON_OBJECT(
            'cantidad', pd.cantidad,
            'nombre', prod.nombre,
            'color', c.color,
            'precioUnitario', pd.precioUnitario,
            'subtotal', pd.subtotal
        )
    ) AS productosAlquilados,
    (
        SELECT JSON_ARRAYAGG(
            JSON_OBJECT(
                'formaPago', pg.formaPago,
                'metodoPago', pg.metodoPago,
                'monto', pg.monto,
                'estadoPago', pg.estadoPago,
                'fechaPago', DATE_FORMAT(pg.fechaPago, '%Y-%m-%d %H:%i:%s')
            )
        )
        FROM tblpagos pg
        WHERE pg.idPedido = p.idPedido
    ) AS pagos
FROM tblpedidos p
LEFT JOIN tblnoclientes nc ON p.idNoClientes = nc.idNoClientes
LEFT JOIN tbldireccioncliente d ON p.idDireccion = d.idDireccion
LEFT JOIN tblusuarios u ON p.idUsuarios = u.idUsuarios 
LEFT JOIN tblpedidodetalles pd ON p.idPedido = pd.idPedido
LEFT JOIN tblproductoscolores pc ON pd.idProductoColores = pc.idProductoColores
LEFT JOIN tblcolores c ON pc.idColor = c.idColores
LEFT JOIN tblproductos prod ON pc.idProducto = prod.idProducto
${whereClause}
GROUP BY p.idPedido
ORDER BY p.fechaRegistro DESC
LIMIT ? OFFSET ?;

    `;
    const [results] = await pool.query(query, [...filterParams, Number(limit), Number(offset)]);
    const response = results.map((pedido) => ({
      idPedido: pedido.idPedido,
      idRastreo: pedido.idRastreo,
      cliente: {
        nombre: pedido.nombreCliente,
        telefono: pedido.telefono,
        direccion: pedido.direccionCompleta,
        tipoCliente: pedido.tipoCliente,
      },
      fechas: {
        inicio: pedido.fechaInicio,
        entrega: pedido.fechaEntrega,
        diasAlquiler: pedido.diasAlquiler,
        horaAlquiler: pedido.horaAlquiler,
        registro: pedido.fechaRegistro,
      },
      pago: {
        detalles: pedido.detallesPago,
        total: pedido.totalPagar,
        pagosRealizados: pedido.pagos ? JSON.parse(pedido.pagos) : [],
      },
      estado: pedido.estado,
      productos: pedido.productosAlquilados ? JSON.parse(pedido.productosAlquilados) : [],
    }));
    res.status(200).json({
      success: true,
      data: response,
      totalPedidos,
      total: response.length,
      page: Number(page),
      limit: Number(limit),
      totalPages: Math.ceil(totalPedidos / limit),
    });
  } catch (error) {
    console.error("Error al obtener los pedidos generales:", error);
    res.status(500).json({
      success: false,
      message: "Error interno del servidor",
      error: error.message,
    });
  }
});



// Endpoint de dashboard pedidos generales
routerPedidos.get("/dashboard-stats", csrfProtection, async (req, res) => {
  try {
    const { year = new Date().getFullYear(), estado, startDate, endDate } = req.query;

    let conditions = [];
    let filterParams = [];

    if (estado && estado !== "Todos") {
      conditions.push("p.estadoActual = ?");
      filterParams.push(estado);
    }

    if (startDate) {
      conditions.push("p.fechaInicio >= ?");
      filterParams.push(startDate);
    }

    if (endDate) {
      conditions.push("p.fechaInicio <= ?");
      filterParams.push(endDate);
    }

    // Añadir condición del año
    conditions.push("YEAR(p.fechaInicio) = ?");
    filterParams.push(year);

    // Construir la cláusula WHERE
    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

    // **CORRECCIÓN PRINCIPAL: Query única para estadísticas principales**
    const [mainStats] = await pool.query(`
      SELECT 
        COUNT(DISTINCT p.idPedido) as totalOrders,
        SUM(p.totalPagar) as totalRevenue,
        COUNT(DISTINCT CASE WHEN p.estadoActual = 'Cancelado' THEN p.idPedido END) as cancelled,
        COUNT(DISTINCT CASE WHEN p.estadoActual = 'Finalizado' THEN p.idPedido END) as finalizedCount,
        SUM(CASE WHEN p.estadoActual = 'Finalizado' THEN p.totalPagar ELSE 0 END) as totalRevenueFinalized,
        COUNT(DISTINCT COALESCE(u.idUsuarios, nc.idNoClientes)) as uniqueClients
      FROM tblpedidos p 
      LEFT JOIN tblusuarios u ON p.idUsuarios = u.idUsuarios 
      LEFT JOIN tblnoclientes nc ON p.idNoClientes = nc.idNoClientes 
      ${whereClause}
    `, filterParams);

    const mainStat = mainStats[0] || {};
    
    // **CÁLCULOS CORREGIDOS**
    const totalOrders = parseInt(mainStat.totalOrders) || 0;
    const totalRevenue = parseFloat(mainStat.totalRevenue) || 0;
    const cancelled = parseInt(mainStat.cancelled) || 0;
    const finalizedCount = parseInt(mainStat.finalizedCount) || 0;
    const totalRevenueFinalized = parseFloat(mainStat.totalRevenueFinalized) || 0;
    const uniqueClients = parseInt(mainStat.uniqueClients) || 0;
    const activeOrders = totalOrders - cancelled - finalizedCount;

    // **CORRECCIÓN: Estadísticas por estado (verificación de datos)**
    const [statusStats] = await pool.query(
      `SELECT 
        p.estadoActual AS estado, 
        COUNT(DISTINCT p.idPedido) AS count, 
        SUM(p.totalPagar) AS revenue 
       FROM tblpedidos p 
       ${whereClause} 
       GROUP BY p.estadoActual`,
      filterParams
    );

    console.log("🔍 Status Stats RAW:", statusStats); // Debug

    const statusMap = Object.fromEntries(
      statusStats.map((row) => [row.estado, { 
        count: parseInt(row.count) || 0, 
        revenue: parseFloat(row.revenue) || 0 
      }])
    );

    const statusCounts = Object.fromEntries(
      statusStats.map((row) => [row.estado, parseInt(row.count) || 0])
    );

    // **VERIFICACIÓN DE SUMA**
    const calculatedTotalRevenue = statusStats.reduce((sum, row) => {
      const revenue = parseFloat(row.revenue) || 0;
      console.log(`Sumando ${row.estado}: ${revenue}`); // Debug
      return sum + revenue;
    }, 0);

    console.log(`💰 Total Revenue: ${totalRevenue}, Calculado: ${calculatedTotalRevenue}`); // Debug

    // **QUERIES SECUNDARIAS EN PARALELO**
    const [
      [avgDuration],
      [clientTypeCounts],
      [revenueByMonth],
      [topProducts],
      [payCounts],
      [durationBins],
      [topClients]
    ] = await Promise.all([
      // Promedio de duración
      pool.query(
        `SELECT AVG(TIMESTAMPDIFF(DAY, p.fechaInicio, p.fechaEntrega)) AS avgDuration 
         FROM tblpedidos p ${whereClause} AND p.fechaEntrega IS NOT NULL`,
        filterParams
      ),
      
      // Tipos de cliente
      pool.query(
        `SELECT 
           SUM(CASE WHEN u.idUsuarios IS NOT NULL THEN 1 ELSE 0 END) AS 'Cliente registrado',
           SUM(CASE WHEN nc.idNoClientes IS NOT NULL AND nc.idUsuario IS NOT NULL THEN 1 ELSE 0 END) AS 'Cliente convertido',
           SUM(CASE WHEN nc.idNoClientes IS NOT NULL AND nc.idUsuario IS NULL THEN 1 ELSE 0 END) AS 'No cliente'
         FROM tblpedidos p
         LEFT JOIN tblusuarios u ON p.idUsuarios = u.idUsuarios
         LEFT JOIN tblnoclientes nc ON p.idNoClientes = nc.idNoClientes
         ${whereClause}`,
        filterParams
      ),
      
      // Ingresos por mes
      pool.query(
        `SELECT MONTH(p.fechaInicio) - 1 AS month, SUM(p.totalPagar) AS revenue 
         FROM tblpedidos p ${whereClause} 
         GROUP BY MONTH(p.fechaInicio)`,
        filterParams
      ),
      
      // Top productos
      pool.query(
        `SELECT prod.nombre, SUM(pd.cantidad) AS qty 
         FROM tblpedidos p 
         INNER JOIN tblpedidodetalles pd ON p.idPedido = pd.idPedido 
         LEFT JOIN tblproductoscolores pc ON pd.idProductoColores = pc.idProductoColores 
         LEFT JOIN tblproductos prod ON pc.idProducto = prod.idProducto 
         ${whereClause} 
         GROUP BY prod.nombre 
         HAVING qty > 0
         ORDER BY qty DESC 
         LIMIT 5`,
        filterParams
      ),
      
      // Estado de pagos
      pool.query(
        `SELECT 
           SUM(CASE WHEN pg.idPedido IS NOT NULL THEN 1 ELSE 0 END) AS pendiente,
           SUM(CASE WHEN pg.idPedido IS NULL THEN 1 ELSE 0 END) AS completado
         FROM tblpedidos p 
         LEFT JOIN (
           SELECT DISTINCT idPedido FROM tblpagos 
           WHERE estadoPago = 'pendiente'
         ) pg ON p.idPedido = pg.idPedido
         ${whereClause}`,
        filterParams
      ),
      
      // Duración bins
      pool.query(
        `SELECT 
           SUM(CASE WHEN TIMESTAMPDIFF(DAY, p.fechaInicio, p.fechaEntrega) = 1 THEN 1 ELSE 0 END) AS '1 día',
           SUM(CASE WHEN TIMESTAMPDIFF(DAY, p.fechaInicio, p.fechaEntrega) BETWEEN 2 AND 3 THEN 1 ELSE 0 END) AS '2–3 días',
           SUM(CASE WHEN TIMESTAMPDIFF(DAY, p.fechaInicio, p.fechaEntrega) BETWEEN 4 AND 7 THEN 1 ELSE 0 END) AS '4–7 días',
           SUM(CASE WHEN TIMESTAMPDIFF(DAY, p.fechaInicio, p.fechaEntrega) > 7 THEN 1 ELSE 0 END) AS '8+ días'
         FROM tblpedidos p ${whereClause} AND p.fechaEntrega IS NOT NULL`,
        filterParams
      ),
      
      // Top clientes
      pool.query(
        `SELECT 
           COALESCE(CONCAT(u.nombre, ' ', u.apellidoP, ' ', u.apellidoM), 
                    CONCAT(nc.nombre, ' ', nc.apellidoCompleto)) AS clientName,
           SUM(p.totalPagar) AS revenue 
         FROM tblpedidos p 
         LEFT JOIN tblusuarios u ON p.idUsuarios = u.idUsuarios 
         LEFT JOIN tblnoclientes nc ON p.idNoClientes = nc.idNoClientes 
         ${whereClause} 
         GROUP BY clientName 
         HAVING revenue > 0
         ORDER BY revenue DESC 
         LIMIT 5`,
        filterParams
      )
    ]);

    // Procesar ingresos mensuales
    const monthlyRevenue = Array(12).fill(0);
    revenueByMonth.forEach((row) => {
      monthlyRevenue[row.month] = parseFloat(row.revenue) || 0;
    });

    res.status(200).json({
      success: true,
      stats: {
        totalOrders,
        activeOrders,
        totalRevenue,
        totalRevenueFinalized,
        uniqueClients,
        avgDuration: parseFloat(avgDuration[0]?.avgDuration) || 0,
        cancelled,
        clientTypeCounts: clientTypeCounts[0] || { 
          "Cliente registrado": 0, 
          "Cliente convertido": 0, 
          "No cliente": 0 
        },
        revenueByMonth: monthlyRevenue,
        topProducts: topProducts || [],
        payCounts: payCounts[0] || { pendiente: 0, completado: 0 },
        statusCounts,
        durationBins: durationBins[0] || { 
          "1 día": 0, 
          "2–3 días": 0, 
          "4–7 días": 0, 
          "8+ días": 0 
        },
        topClients: topClients || [],
        // **DEBUG INFO**
        _debug: {
          calculatedTotalRevenue,
          statusStats: statusStats.map(row => ({
            estado: row.estado,
            count: row.count,
            revenue: row.revenue
          }))
        }
      },
    });
  } catch (error) {
    console.error("❌ Error al obtener estadísticas del dashboard:", error);
    res.status(500).json({
      success: false,
      message: "Error interno del servidor",
      error: error.message,
    });
  }
});



routerPedidos.get("/pedidos-incidentes", csrfProtection, async (req, res) => {
  try {
    const query = `
      SELECT 
        p.idPedido,
        p.idRastreo,
        COALESCE(CONCAT(u.nombre, ' ', u.apellidoP, ' ', u.apellidoM), CONCAT(d.nombre, ' ', d.apellido)) AS nombreCliente,
        COALESCE(u.telefono, d.telefono) AS telefono,
        CONCAT(d.direccion, ', ', d.localidad, ', ', d.municipio, ', ', d.estado, ', ', d.pais, ' C.P. ', d.codigoPostal) AS direccionCompleta,
        p.fechaInicio,
        p.fechaEntrega,
        TIMESTAMPDIFF(DAY, p.fechaInicio, p.fechaEntrega) AS diasAlquiler,
        p.horaAlquiler,
        p.estadoActual AS estado,
        p.totalPagar,
        CASE 
          WHEN u.idUsuarios IS NOT NULL THEN 'Cliente registrado'
          WHEN nc.idNoClientes IS NOT NULL THEN 'Cliente convertido'
          ELSE 'No cliente'
        END AS tipoCliente,
        GROUP_CONCAT(
          CONCAT(
            pd.cantidad, 'x ', prod.nombre, ' (', c.color, ') - ',
            pd.precioUnitario, ' c/u, Subtotal: ', pd.subtotal, 
            ', Estado Producto: ', COALESCE(pd.estadoProducto, 'Sin estado'), 
            ', Observaciones: ', COALESCE(pd.observaciones, 'Sin observaciones')
          ) 
          SEPARATOR ' | '
        ) AS productosAlquilados,
        pagos.pagosRealizados,
        pagos.totalPagado,
        pagos.formaPago,
        CONCAT(r_usuario.nombre, ' ', r_usuario.apellidoP, ' ', r_usuario.apellidoM) AS nombreRepartidor,
        r_usuario.telefono AS telefonoRepartidor,
        GROUP_CONCAT(
          COALESCE(
            (SELECT urlFoto FROM tblfotosproductos fp 
             WHERE fp.idProducto = prod.idProducto 
             ORDER BY fp.idFoto ASC LIMIT 1),
            'Sin imagen'
          )
        ) AS imagenesProductos
      FROM tblpedidos p
      LEFT JOIN tblnoclientes nc ON p.idNoClientes = nc.idNoClientes
      LEFT JOIN tbldireccioncliente d ON p.idDireccion = d.idDireccion
      LEFT JOIN tblusuarios u ON p.idUsuarios = u.idUsuarios 
      LEFT JOIN tblpedidodetalles pd ON p.idPedido = pd.idPedido
      LEFT JOIN tblproductoscolores pc ON pd.idProductoColores = pc.idProductoColores
      LEFT JOIN tblcolores c ON pc.idColor = c.idColores
      LEFT JOIN tblproductos prod ON pc.idProducto = prod.idProducto
      LEFT JOIN tblasignacionpedidos ap ON p.idPedido = ap.idPedido
      LEFT JOIN tblrepartidores r ON ap.idRepartidor = r.idRepartidor
      LEFT JOIN tblusuarios r_usuario ON r.idUsuario = r_usuario.idUsuarios
      LEFT JOIN (
        SELECT 
          idPedido,
          GROUP_CONCAT(CONCAT(formaPago, ' / ', metodoPago, ' - $', COALESCE(monto, '0'), ' (', estadoPago, ')') SEPARATOR ' | ') AS pagosRealizados,
          COALESCE(SUM(CASE WHEN estadoPago = 'completado' THEN monto ELSE 0 END), 0) AS totalPagado,
          SUBSTRING_INDEX(GROUP_CONCAT(formaPago ORDER BY fechaPago DESC), ',', 1) AS formaPago
        FROM tblpagos
        GROUP BY idPedido
      ) pagos ON p.idPedido = pagos.idPedido
      WHERE LOWER(p.estadoActual) IN ('incidente', 'incompleto')
      GROUP BY p.idPedido
      ORDER BY p.fechaRegistro DESC;
    `;

    const [results] = await pool.query(query);

    const response = results.map(pedido => {
      const productosStrArray = pedido.productosAlquilados ? pedido.productosAlquilados.split(' | ') : [];
      const imagenesStrArray = pedido.imagenesProductos ? pedido.imagenesProductos.split(',') : [];


      const productosParsed = productosStrArray.map((prodStr, index) => {
        const regex = /^(\d+)x\s+(.+?)\s+\((.+?)\)\s+-\s+([\d.]+)\s+c\/u,\s+Subtotal:\s+([\d.]+),\s+Estado Producto:\s*(.+?)?,\s+Observaciones:\s+(.+)$/;
        const match = prodStr.match(regex);

        if (match) {
          return {
            cantidad: parseInt(match[1], 10),
            nombre: match[2].trim(),
            color: match[3].trim(),
            precioUnitario: parseFloat(match[4]),
            subtotal: parseFloat(match[5]),
            estadoProducto: match[6] ? match[6].trim() : 'Sin estado',
            observaciones: match[7].trim(),
            imagen: imagenesStrArray[index] || null,
          };
        } else {
          console.warn(`No se pudo parsear el producto: ${prodStr}`);
          return {
            cantidad: null,
            nombre: prodStr,
            color: null,
            precioUnitario: null,
            subtotal: null,
            estadoProducto: null,
            observaciones: null,
            imagen: null,
          };
        }
      });

      const pagosResumen = pedido.pagosRealizados ? pedido.pagosRealizados.split(' | ') : [];

      const estadoPago =
        parseFloat(pedido.totalPagado) >= parseFloat(pedido.totalPagar)
          ? 'completado'
          : parseFloat(pedido.totalPagar) > 0
            ? 'parcial'
            : 'pendiente';

      return {
        idPedido: pedido.idPedido,
        idRastreo: pedido.idRastreo,
        cliente: {
          nombre: pedido.nombreCliente,
          telefono: pedido.telefono,
          direccion: pedido.direccionCompleta,
          tipoCliente: pedido.tipoCliente,
        },
        repartidor: {
          nombre: pedido.nombreRepartidor || 'Sin repartidor asignado',
          telefono: pedido.telefonoRepartidor || 'N/A',
        },
        fechas: {
          inicio: pedido.fechaInicio,
          entrega: pedido.fechaEntrega,
          diasAlquiler: pedido.diasAlquiler,
          horaAlquiler: pedido.horaAlquiler,
        },
        pago: {
          resumen: pagosResumen,
          totalPagado: parseFloat(pedido.totalPagado),
          estadoPago: estadoPago,
          formaPago: pedido.formaPago,
        },
        estado: pedido.estado,
        productos: productosParsed,
        totalPagar: parseFloat(pedido.totalPagar),
      };
    });

    res.status(200).json({
      success: true,
      data: response,
      total: response.length,
    });
  } catch (error) {
    console.error('Error fetching pedidos incidentes:', error);
    res.status(500).json({
      success: false,
      message: 'Error al obtener los pedidos incidentes o incompletos',
      error: error.message,
    });
  }
});


routerPedidos.get("/pedidos-devueltos", csrfProtection, async (req, res) => {
  try {
    const query = `
            SELECT 
        p.idPedido,
        p.idRastreo,
        COALESCE(CONCAT(u.nombre, ' ', u.apellidoP, ' ', u.apellidoM), CONCAT(d.nombre, ' ', d.apellido), 'No especificado') AS nombreCliente,
        COALESCE(u.telefono, d.telefono, 'N/A') AS telefono,
        COALESCE(CONCAT(d.direccion, ', ', d.localidad, ', ', d.municipio, ', ', d.estado, ', ', d.pais, ' C.P. ', d.codigoPostal), 'N/A') AS direccionCompleta,
        p.fechaInicio,
        p.fechaEntrega,
        TIMESTAMPDIFF(DAY, p.fechaInicio, p.fechaEntrega) AS diasAlquiler,
        p.horaAlquiler,
        p.detallesPago,
        p.totalPagar,
        CONCAT(UCASE(LEFT(p.estadoActual, 1)), LCASE(SUBSTRING(p.estadoActual, 2))) AS estado,
        p.fechaRegistro,
        CASE 
          WHEN u.idUsuarios IS NOT NULL THEN 'Cliente registrado'
          WHEN nc.idNoClientes IS NOT NULL THEN 'Cliente convertido'
          ELSE 'No cliente'
        END AS tipoCliente,
        COALESCE(CONCAT(r_usuario.nombre, ' ', r_usuario.apellidoP, ' ', r_usuario.apellidoM), 'Sin repartidor asignado') AS nombreRepartidor,
        COALESCE(r_usuario.telefono, 'N/A') AS telefonoRepartidor,
        JSON_ARRAYAGG(
          JSON_OBJECT(
            'idDetalle', pd.idDetalle,
            'cantidad', pd.cantidad,
            'idProductoColores', pd.idProductoColores,
            'nombre', prod.nombre,
            'color', COALESCE(c.color, 'Sin color'),
            'precioUnitario', pd.precioUnitario,
            'subtotal', pd.subtotal,
            'diasAlquiler', pd.diasAlquiler,
            'estadoProducto', COALESCE(pd.estadoProducto, 'Sin estado'),
            'observaciones', COALESCE(pd.observaciones, 'Sin observaciones'),
            'imagen', (
              SELECT urlFoto 
              FROM tblfotosproductos fp 
              WHERE fp.idProducto = prod.idProducto 
              ORDER BY fp.idFoto ASC LIMIT 1
            )
          )
        ) AS productosAlquilados,
        (
          SELECT JSON_ARRAYAGG(
            JSON_OBJECT(
              'formaPago', pg.formaPago,
              'metodoPago', pg.metodoPago,
              'monto', pg.monto,
              'estadoPago', pg.estadoPago,
              'fechaPago', DATE_FORMAT(pg.fechaPago, '%Y-%m-%d %H:%i:%s')
            )
          )
          FROM tblpagos pg
          WHERE pg.idPedido = p.idPedido
        ) AS pagos
      FROM tblpedidos p
      LEFT JOIN tblnoclientes nc ON p.idNoClientes = nc.idNoClientes
      LEFT JOIN tbldireccioncliente d ON p.idDireccion = d.idDireccion
      LEFT JOIN tblusuarios u ON p.idUsuarios = u.idUsuarios 
      LEFT JOIN tblpedidodetalles pd ON p.idPedido = pd.idPedido
      LEFT JOIN tblproductoscolores pc ON pd.idProductoColores = pc.idProductoColores
      LEFT JOIN tblcolores c ON pc.idColor = c.idColores
      LEFT JOIN tblproductos prod ON pc.idProducto = prod.idProducto
      LEFT JOIN tblasignacionpedidos ap ON p.idPedido = ap.idPedido
      LEFT JOIN tblrepartidores r ON ap.idRepartidor = r.idRepartidor
      LEFT JOIN tblusuarios r_usuario ON r.idUsuario = r_usuario.idUsuarios
      WHERE LOWER(p.estadoActual) IN ('devuelto')
      GROUP BY 
        p.idPedido,
        p.idRastreo,
        nombreCliente,
        telefono,
        direccionCompleta,
        p.fechaInicio,
        p.fechaEntrega,
        p.horaAlquiler,
        p.detallesPago,
        p.totalPagar,
        p.estadoActual,
        p.fechaRegistro,
        tipoCliente,
        nombreRepartidor,
        telefonoRepartidor
      ORDER BY p.fechaRegistro DESC;
    `;

    const [results] = await pool.query(query);

    const response = results.map(pedido => {
      // Parsear productosAlquilados (ya es un JSON array)
      const productosParsed = pedido.productosAlquilados && pedido.productosAlquilados !== '[]'
        ? JSON.parse(pedido.productosAlquilados)
        : [];

      // Eliminar productos duplicados basados en idPedidoDetalle
      const uniqueProductos = [];
      const seenIds = new Set();
      productosParsed.forEach(producto => {
        if (producto.idDetalle && !seenIds.has(producto.idDetalle)) {
          seenIds.add(producto.idDetalle);
          uniqueProductos.push({
            idProductoColores: producto.idProductoColores,
            idPedidoDetalle: producto.idDetalle,
            cantidad: producto.cantidad,
            nombre: producto.nombre,
            color: producto.color,
            precioUnitario: parseFloat(producto.precioUnitario),
            subtotal: parseFloat(producto.subtotal),
            diasAlquiler: producto.diasAlquiler,
            estadoProducto: producto.estadoProducto,
            observaciones: producto.observaciones,
            imagen: producto.imagen || null,
          });
        }
      });

      // Parsear pagos (ya es un JSON array)
      const pagosParsed = pedido.pagos && pedido.pagos !== '[]'
        ? JSON.parse(pedido.pagos)
        : [];

      // Calcular totalPagado y estadoPago
      const totalPagado = pagosParsed.reduce((sum, pago) => {
        return pago.estadoPago === 'completado' ? sum + parseFloat(pago.monto) : sum;
      }, 0);

      const estadoPago =
        totalPagado >= parseFloat(pedido.totalPagar)
          ? 'completado'
          : totalPagado > 0
            ? 'parcial'
            : 'pendiente';

      const pagosResumen = pagosParsed.map(pago =>
        `${pago.formaPago} / ${pago.metodoPago} - $${parseFloat(pago.monto).toFixed(2)} (${pago.estadoPago})`
      );

      return {
        idPedido: pedido.idPedido,
        idRastreo: pedido.idRastreo,
        cliente: {
          nombre: pedido.nombreCliente || 'No especificado',
          telefono: pedido.telefono || 'N/A',
          direccion: pedido.direccionCompleta || 'N/A',
          tipoCliente: pedido.tipoCliente || 'No cliente',
        },
        repartidor: {
          nombre: pedido.nombreRepartidor || 'Sin repartidor asignado',
          telefono: pedido.telefonoRepartidor || 'N/A',
        },
        fechas: {
          inicio: pedido.fechaInicio || null,
          entrega: pedido.fechaEntrega || null,
          diasAlquiler: pedido.diasAlquiler || 0,
          horaAlquiler: pedido.horaAlquiler || 'N/A',
        },
        pago: {
          resumen: pagosResumen,
          totalPagado: totalPagado,
          estadoPago: estadoPago,
          formaPago: pagosParsed.length > 0 ? pagosParsed[pagosParsed.length - 1].formaPago : 'N/A',
        },
        estado: pedido.estado || 'Devuelto',
        productos: uniqueProductos,
        totalPagar: parseFloat(pedido.totalPagar) || 0,
      };
    });

    res.status(200).json({
      success: true,
      data: response,
      total: response.length,
    });
  } catch (error) {
    console.error('Error fetching pedidos devueltos:', error);
    res.status(500).json({
      success: false,
      message: 'Error al obtener los pedidos devueltos',
      error: error.message,
    });
  }
});

//

//Actualizar pedidos ocn etsado incidente o incompleto
routerPedidos.put("/pedidos/actualizar-estado", csrfProtection, async (req, res) => {
  const { idPedido, newStatus, productUpdates } = req.body;

  // Iniciar una transacción para garantizar consistencia en la base de datos
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();

    // 1. Actualizar estado del pedido en tblpedidos
    await connection.query(
      `UPDATE tblpedidos SET estadoActual = ? WHERE idPedido = ?`,
      [newStatus, idPedido]
    );

    // 2. Actualizar estado de los productos si vienen actualizaciones
    if (Array.isArray(productUpdates) && productUpdates.length > 0) {
      for (const { idProductoColores, estadoProducto } of productUpdates) {
        await connection.query(
          `UPDATE tblpedidodetalles SET estadoProducto = ?, observaciones = NULL WHERE idPedido = ? AND idProductoColores = ?`,
          [estadoProducto, idPedido, idProductoColores]
        );
      }
    }

    // 3. Si el estado del pedido es "Finalizado" o "Cancelado", actualizar el inventario
    if (newStatus === "Finalizado" || newStatus === "Cancelado") {
      // Obtener los productos asociados al pedido desde tblpedidodetalles
      const [productos] = await connection.query(
        `SELECT idProductoColores, cantidad FROM tblpedidodetalles WHERE idPedido = ?`,
        [idPedido]
      );

      // Para cada producto, sumar la cantidad al stock en tblinventario
      for (const producto of productos) {
        const { idProductoColores, cantidad } = producto;

        // Verificar si el producto existe en tblinventario
        const [inventario] = await connection.query(
          `SELECT stock FROM tblinventario WHERE idProductoColor = ?`,
          [idProductoColores]
        );

        if (inventario.length === 0) {
          // Si el producto no existe en el inventario, lanzar un error o manejar según tu lógica
          throw new Error(`Producto con idProductoColor ${idProductoColores} no encontrado en el inventario`);
        }

        // Actualizar el stock sumando la cantidad
        await connection.query(
          `UPDATE tblinventario SET stock = stock + ? WHERE idProductoColor = ?`,
          [cantidad, idProductoColores]
        );
      }
    }

    // Confirmar la transacción
    await connection.commit();

    res.json({ success: true, message: "Estado actualizado correctamente y stock actualizado (si aplica)" });
  } catch (error) {
    // Revertir la transacción en caso de error
    await connection.rollback();
    console.error("Error al actualizar pedido:", error);
    res.status(500).json({ success: false, message: "Error al actualizar pedido", error: error.message });
  } finally {
    // Liberar la conexión
    connection.release();
  }
});


routerPedidos.get('/historial-pedidos',verifyToken, csrfProtection, async (req, res) => {
    const idUsuario = req.user?.id ;
  const pagina = parseInt(req.query.pagina, 10) || 1;
  const limite = parseInt(req.query.limite, 10) || 10;
  const offset = (pagina - 1) * limite;

   if (!idUsuario) {
      return res.status(401).json({ error: "ID de usuario no encontrado en el token" });
    }

  let connection;
  try {
    connection = await pool.getConnection();  
    const [pedidos] = await connection.query(
      `
      WITH FotosPedidosAleatorias AS (
    SELECT
        d.idPedido,
        f.urlFoto,
        ROW_NUMBER() OVER(PARTITION BY d.idPedido ORDER BY RAND()) AS rn
    FROM tblpedidodetalles d
    JOIN tblproductoscolores pc ON d.idProductoColores = pc.idProductoColores
    JOIN tblfotosproductos f ON pc.idProducto = f.idProducto
    GROUP BY d.idPedido, pc.idProducto
)
SELECT
    p.idPedido,
    p.idRastreo,
    p.estadoActual AS estado,
    p.fechaInicio,
    p.totalPagar,
    COUNT(d.idDetalle) AS numeroDeProductos,
   
    COALESCE(
        CONCAT(u.nombre, ' ', u.apellidoP, ' ', u.apellidoM),
        CONCAT(nc.nombre, ' ', nc.apellidoCompleto)
    ) AS nombreCliente,
  
    (
        SELECT JSON_ARRAYAGG(urlFoto)
        FROM FotosPedidosAleatorias
        WHERE idPedido = p.idPedido AND rn <= 2
    ) AS fotosProductos
FROM tblpedidos p
LEFT JOIN tblpedidodetalles d ON p.idPedido = d.idPedido

LEFT JOIN tblusuarios u ON p.idUsuarios = u.idUsuarios 
LEFT JOIN tblnoclientes nc ON p.idNoClientes = nc.idNoClientes
WHERE p.idUsuarios = ? 
GROUP BY p.idPedido, nombreCliente 
ORDER BY p.idPedido DESC

      LIMIT ? OFFSET ? -- Aplicamos la paginación
      `,
      [idUsuario, limite, offset] 
    );
    const [[{ totalPedidos }]] = await connection.query(
      "SELECT COUNT(*) as totalPedidos FROM tblpedidos WHERE idUsuarios = ?",
      [idUsuario]
    );
    res.json({
      success: true,
      data: pedidos,
      paginacion: {
        totalPedidos: totalPedidos,
        paginaActual: pagina,
        totalPaginas: Math.ceil(totalPedidos / limite)
      }
    });
    console.log("Resultado de lso pedidos osa historal de cliente",pedidos)

  } catch (error) {
    console.error("Error al obtener el historial de pedidos:", error.message);
    if (error.code === 'ECONNRESET') {
        return res.status(503).json({ success: false, error: 'Error de conexión con la base de datos, por favor intente de nuevo.' });
    }
    res.status(500).json({ success: false, error: 'Error interno del servidor.' });
  } finally {
    if (connection) connection.release();
  }
});



//Verificar si otro componente ocupa este enpoit 
routerPedidos.get("/pedidos-cliente/:idUsuarios", csrfProtection, async (req, res) => {
  try {
    const { idUsuarios } = req.params;

    if (!idUsuarios || isNaN(idUsuarios)) {
      return res.status(400).json({
        success: false,
        message: "El idUsuarios proporcionado no es válido.",
      });
    }

    // Consulta SQL corregida y optimizada
    const query = `
      SELECT
          p.idPedido,
          p.idRastreo,
          p.totalPagar,
          p.estadoActual,
          p.fechaRegistro,
          p.fechaInicio,
          p.fechaEntrega,
          p.horaAlquiler,
          p.detallesPago,
          TIMESTAMPDIFF(DAY, p.fechaInicio, p.fechaEntrega) AS diasAlquiler,
          
          COALESCE(
              CONCAT(u.nombre, ' ', u.apellidoP, ' ', u.apellidoM), 
              CONCAT(nc.nombre, ' ', nc.apellidoCompleto)
          ) AS nombreCliente,
          
          COALESCE(u.correo, nc.correo) AS contactoCorreo,
          COALESCE(u.telefono, nc.telefono) AS contactoTelefono,
          
          CONCAT(
              d.direccion, ', ', 
              d.localidad, ', ', 
              d.municipio, ', ', 
              d.estado, ', C.P. ', 
              d.codigoPostal
          ) AS direccionCompleta,

          (
              SELECT JSON_ARRAYAGG(
                  JSON_OBJECT(
                      'cantidad', pd.cantidad,
                      'nombre', prod.nombre,
                      'color', c.color,
                      'precioUnitario', pd.precioUnitario,
                      'subtotal', pd.subtotal
                  )
              )
              FROM tblpedidodetalles pd
              JOIN tblproductoscolores pc ON pd.idProductoColores = pc.idProductoColores
              JOIN tblproductos prod ON pc.idProducto = prod.idProducto
              JOIN tblcolores c ON pc.idColor = c.idColores
              WHERE pd.idPedido = p.idPedido
          ) AS productosAlquilados

      FROM 
          tblpedidos p
      JOIN 
          tbldireccioncliente d ON p.idDireccion = d.idDireccion
      LEFT JOIN 
          tblusuarios u ON p.idUsuarios = u.idUsuarios
      LEFT JOIN 
          tblnoclientes nc ON p.idNoClientes = nc.idNoClientes
      WHERE 
          p.idUsuarios = ?
      ORDER BY 
          p.fechaRegistro DESC;
    `;

    const [results] = await pool.query(query, [idUsuarios]);

    const response = results.map((pedido) => {
      // El JSON ya viene agregado por la base de datos, solo necesitamos parsearlo.
      const productosParsed = pedido.productosAlquilados ? JSON.parse(pedido.productosAlquilados) : [];

      return {
        idPedido: pedido.idPedido,
        idRastreo: pedido.idRastreo,
        estado: pedido.estadoActual,
        fechas: {
          registro: pedido.fechaRegistro,
          inicioAlquiler: pedido.fechaInicio,
          entregaAlquiler: pedido.fechaEntrega,
          diasAlquiler: pedido.diasAlquiler,
          horaAlquiler: pedido.horaAlquiler,
        },
        pago: {
          total: parseFloat(pedido.totalPagar) || 0,
          detalles: pedido.detallesPago,
        },
        cliente: {
          nombre: pedido.nombreCliente,
          correo: pedido.contactoCorreo,
          telefono: pedido.contactoTelefono,
          direccion: pedido.direccionCompleta,
        },
        productos: productosParsed,
      };
    });

    res.status(200).json({
      success: true,
      data: response,
    });

  } catch (error) {
    console.error("Error al obtener el historial de pedidos del cliente:", {
      message: error.message,
      stack: error.stack,
    });
    res.status(500).json({
      success: false,
      message: "Error interno del servidor al obtener el historial de pedidos.",
      error: error.message,
    });
  }
});




routerPedidos.get("/rastrear/:idRastreo", csrfProtection, async (req, res) => {
  try {
    const { idRastreo } = req.params;

    // Validar idRastreo
    if (!idRastreo) {
      return res.status(400).json({
        success: false,
        message: "ID de rastreo inválido",
      });
    }

    // Verificar si el idRastreo existe
    const [checkRows] = await pool.query(
      `
      SELECT idPedido
      FROM tblpedidos
      WHERE idRastreo = ? AND (idNoClientes IS NOT NULL OR idUsuarios IS NOT NULL)
      LIMIT 1
      `,
      [idRastreo]
    );

    if (checkRows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "No se encontró un pedido con ese ID de rastreo",
      });
    }

    const order = checkRows[0];

    // Obtener detalles del pedido
    const [orderDetails] = await pool.query(
      `
      SELECT 
        idPedido,
        idRastreo,
        CONCAT(UCASE(LEFT(estadoActual, 1)), LCASE(SUBSTRING(estadoActual, 2))) AS estado,
        fechaInicio,
        fechaEntrega,
        detallesPago,
        totalPagar
      FROM tblpedidos
      WHERE idRastreo = ?
      `,
      [idRastreo]
    );

    if (orderDetails.length === 0) {
      return res.status(404).json({
        success: false,
        message: "No se encontraron detalles del pedido",
      });
    }

    const orderData = orderDetails[0];

    // Obtener historial completo
    const [historyRows] = await pool.query(
      `
  SELECT
    CONCAT(UCASE(LEFT(estadoNuevo, 1)), LCASE(SUBSTRING(estadoNuevo, 2))) AS estadoNuevo,
    CONCAT(UCASE(LEFT(estadoAnterior, 1)), LCASE(SUBSTRING(estadoAnterior, 2))) AS estadoAnterior,
    DATE_FORMAT(fechaActualizacion, '%Y-%m-%d %H:%i:%s') AS fecha,
    CONCAT('El pedido cambió a ',
           CONCAT(UCASE(LEFT(estadoNuevo, 1)), LCASE(SUBSTRING(estadoNuevo, 2))),
           COALESCE(CONCAT(' desde ',
           CONCAT(UCASE(LEFT(estadoAnterior, 1)), LCASE(SUBSTRING(estadoAnterior, 2)))), ''))
    AS descripcion
  FROM tblhistorialestados
  WHERE idPedido = ?
  ORDER BY fechaActualizacion ASC
  `,
      [order.idPedido]
    );


    const history = historyRows.length > 0 ? historyRows : [];

    // Respuesta con success explícito
    const response = {
      success: true,
      id: orderData.idRastreo,
      status: orderData.estado,
      trackingId: orderData.idRastreo,
      fechaInicio: orderData.fechaInicio,
      fechaEntrega: orderData.fechaEntrega,
      totalPagar: orderData.totalPagar,
      detallesPago: orderData.detallesPago,
      history: history,
    };

    res.status(200).json(response);
  } catch (error) {
    console.error("Error al rastrear pedido:", error);
    res.status(500).json({
      success: false,
      message: "Error al rastrear el pedido",
      error: error.message,
    });
  }
});


//Enpot de historial de pedidos
routerPedidos.get("/historial/:idPedido", csrfProtection, async (req, res) => {
  try {
    const { idPedido } = req.params;

    // Validar idPedido
    if (!idPedido || isNaN(idPedido)) {
      return res.status(400).json({
        success: false,
        message: "ID de pedido inválido",
      });
    }

    // Consultar historial en tblhistorialestados
    const [rows] = await pool.query(
      ` SELECT 
        idHistorial,
        idPedido,
        CONCAT(UCASE(LEFT(estadoAnterior,1)), LCASE(SUBSTRING(estadoAnterior,2))) AS estadoAnterior,
        CONCAT(UCASE(LEFT(estadoNuevo,1)), LCASE(SUBSTRING(estadoNuevo,2))) AS estadoNuevo,
        DATE_FORMAT(fechaActualizacion, '%Y-%m-%d %H:%i:%s') AS fechaActualizacion
      FROM tblhistorialestados
      WHERE idPedido = ?
      ORDER BY fechaActualizacion ASC
      `,
      [idPedido]
    );

    // Si no hay registros
    if (!rows || rows.length === 0) {
      return res.status(200).json({
        success: true,
        data: [],
        message: "No se encontró historial para este pedido",
      });
    }


    res.status(200).json({
      success: true,
      data: rows,
    });
  } catch (error) {
    console.error("Error al obtener historial:", error);
    res.status(500).json({
      success: false,
      message: "Error al obtener el historial del pedido",
      error: error.message,
    });
  }
});


routerPedidos.get("/productos/seleccion", csrfProtection, async (req, res) => {
  try {
    const query = `
      SELECT
        p.idProducto,
        p.nombre,
        p.detalles,
        p.idSubcategoria,
        p.material,
        p.fechaCreacion,
        p.fechaActualizacion,
        p.idUsuarios,
        IF(
          GREATEST(p.fechaCreacion, p.fechaActualizacion) >= DATE_SUB(NOW(), INTERVAL  30 DAY),
          TRUE,
          FALSE
        ) AS esNuevo,
        COUNT(pd.idProductoColores) AS demanda,
        COALESCE(
          (SELECT fp.urlFoto 
           FROM tblfotosproductos fp 
           WHERE fp.idProducto = p.idProducto 
           ORDER BY fp.idFoto ASC 
           LIMIT 1),
          'Sin imagen'
        ) AS urlFoto

      FROM tblproductos p
      JOIN tblproductoscolores pc ON p.idProducto = pc.idProducto
      JOIN tblpedidodetalles pd ON pc.idProductoColores = pd.idProductoColores

      GROUP BY p.idProducto
      ORDER BY demanda DESC, p.fechaActualizacion DESC
      LIMIT 8;
    `;
    const [productosDesdeDB] = await pool.query(query);

    const response = productosDesdeDB.map((cadaProducto) => ({
      idProducto: cadaProducto.idProducto,
      nombre: cadaProducto.nombre,
      detalles: cadaProducto.detalles || "Sin descripción",
      idSubcategoria: cadaProducto.idSubcategoria,
      material: cadaProducto.material || null,
      fechaCreacion: moment(cadaProducto.fechaCreacion)
        .tz("America/Mexico_City")
        .format("YYYY-MM-DD HH:mm:ss"),
      fechaActualizacion: moment(cadaProducto.fechaActualizacion)
        .tz("America/Mexico_City")
        .format("YYYY-MM-DD HH:mm:ss"),
      idUsuarios: cadaProducto.idUsuarios,
      urlFoto: cadaProducto.urlFoto,
      esNuevo: Boolean(cadaProducto.esNuevo),
      demanda: cadaProducto.demanda || 0,
    }));

    res.status(200).json({
      success: true,
      message: "Productos destacados recuperados exitosamente",
      data: response,
    });
  } catch (error) {
    console.error("Error al obtener productos destacados:", error);
    res.status(500).json({
      success: false,
      message: "Error interno al obtener los productos destacados",
      error: error.message,
    });
  }
});

// Crear sesión de checkout

routerPedidos.post('/pagos/crear-checkout-session', async (req, res) => {
  try {
    const { amount, currency, successUrl, cancelUrl, idUsuario, idDireccion, fechaInicio, fechaEntrega, cartItems } = req.body;
    for (const item of cartItems) {
      const [inventario] = await pool.query(
        "SELECT stock FROM tblinventario WHERE idProductoColor = ?",
        [item.idProductoColor]
      );
      if (inventario.length === 0 || inventario[0].stock < item.cantidad) {
        const stockDisponible = inventario.length > 0 ? inventario[0].stock : 0;
        console.error(`Stock insuficiente para ${item.nombre} (ID: ${item.idProductoColor}). Solicitado: ${item.cantidad}, Disponible: ${stockDisponible}`);
        return res.status(400).json({
          error: `Lo sentimos, no hay stock suficiente para "${item.nombre}". Cantidad disponible: ${stockDisponible}.`
        });
      }
    }
    const tempPedidoId = `TEMP_${Date.now()}_${Math.floor(Math.random() * 1000)}`;


    await pool.query(
      'INSERT INTO tblPedidosTemporales (tempPedidoId, idUsuario, idDireccion, fechaInicio, fechaEntrega, cartItems, createdAt) VALUES (?, ?, ?, ?, ?, ?, NOW())',
      [tempPedidoId, idUsuario, idDireccion, fechaInicio, fechaEntrega, JSON.stringify(cartItems)]
    );

    const cuenta = await pool.query('SELECT stripe_account_id FROM tblCuentasReceptoras WHERE activa = 1 LIMIT 1');

    if (!cuenta || !cuenta[0] || !cuenta[0][0]) {
      return res.status(400).json({ error: 'No se encontró una cuenta receptora activa.' });
    }

    const stripeAccount = cuenta[0][0].stripe_account_id;

    console.log('>>> Se usará esta cuenta para la transferencia:', stripeAccount);

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: [{
        price_data: {
          currency: currency,
          product_data: {
            name: 'Renta Alquiladora Romero',
          },
          unit_amount: amount,
        },
        quantity: 1,
      }],
      mode: 'payment',
      success_url: successUrl,
      cancel_url: cancelUrl,
      metadata: {
        tempPedidoId,
        idUsuario,
        idDireccion,
        fechaInicio,
        fechaEntrega,
      },
      payment_intent_data: {
        transfer_data: {
          destination: stripeAccount,
        },
      },
    });

    res.json({ sessionId: session.id });
  } catch (error) {
    console.error("Error al crear la sesión de checkout:", error);
    res.status(500).json({ error: 'Error al crear la sesión de checkout' });
  }
});


// Verificar estado del pago y procesar pedido
routerPedidos.get('/pagos/verificar/:sessionId', async (req, res) => {
  const { sessionId } = req.params;

  try {
    const session = await stripe.checkout.sessions.retrieve(sessionId);
    console.log("Datos de sesion de stripe", session)

    if (session.payment_status === 'paid') {
      const { tempPedidoId, idUsuario, idDireccion, fechaInicio, fechaEntrega } = session.metadata;

      // Recuperar los detalles de cartItems desde tblPedidosTemporales
      const [rows] = await pool.query(
        'SELECT cartItems FROM tblPedidosTemporales WHERE tempPedidoId = ?',
        [tempPedidoId]
      );

       console.log("Datos de strpe", rows)

      if (rows.length === 0) {
        return res.status(400).json({ success: false, message: 'Pedido temporal no encontrado' });
      }
      const cartItemsParsed = JSON.parse(rows[0].cartItems);

       console.log("Datos de sesion de stripe-carteInterOParsed", cartItemsParsed)


      // Crear registro en tblpagos
      const pago = await pool.query(
        'INSERT INTO tblpagos (idPedido, formaPago, metodoPago, monto, estadoPago, detallesPago, fechaPago) VALUES (?, ?, ?, ?, ?, ?, NOW())',
        [null, 'Tarjeta', 'Stripe', session.amount_total / 100, 'confirmado', JSON.stringify(session), null]
      );
      const idPago = pago.insertId;

      // Crear pedido en tblpedidos
      const pedido = await pool.query(
        'INSERT INTO tblpedidos (idUsuarios, idNoClientes, idRastreo, idDireccion, fechaInicio, fechaEntrega, horaAlquiler, detallesPago, totalPagar, estadoActual, fechaRegistro, tipoPedido) VALUES (?, NULL, NULL, ?, ?, ?, NOW(), ?, ?, ?, NOW(), ?)',
        [idUsuario, idDireccion, fechaInicio, fechaEntrega, JSON.stringify(session), session.amount_total / 100, 'confirmado', 'Online']
      );
      const idPedido = pedido.insertId;

      // Actualizar tblpagos con idPedido
      await pool.query('UPDATE tblpagos SET idPedido = ? WHERE idPago = ?', [idPedido, idPago]);

      // Crear detalles en tblpedidodetalles
      const detalles = cartItemsParsed.map(item => [
        idPedido,
        item.idProductoColores,
        item.cantidad,
        item.precioPorDia,
        Math.ceil((new Date(fechaEntrega) - new Date(fechaInicio)) / (1000 * 60 * 60 * 24)),
        item.precioPorDia * item.cantidad,
        'disponible',
        null,
      ]);
      await pool.query(
        'INSERT INTO tblpedidodetalles (idPedido, idProductoColores, cantidad, precioUnitario, diasAlquiler, subtotal, estadoProducto, observaciones) VALUES ?',
        [detalles]
      );

      // Actualizar inventario
      for (const item of cartItemsParsed) {
        await pool.query(
          'UPDATE tblProductoColores SET cantidadDisponible = cantidadDisponible - ? WHERE idProductoColores = ?',
          [item.cantidad, item.idProductoColores]
        );
      }

      // Opcional: Eliminar el pedido temporal después de procesarlo
      await pool.query('DELETE FROM tblPedidosTemporales WHERE tempPedidoId = ?', [tempPedidoId]);

      res.json({ success: true, idPago, idPedido });
    } else {
      res.json({ success: false, message: 'Pago no completado' });
    }
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, message: 'Error al verificar el pago' });
  }
});



// Enpoit de predecir si el pedido sera cancelado
async function obtenerDatosParaPrediccionOptimizado(idPedido) {
    try {
        const queryCompleta = `
            SELECT 
                p.totalPagar AS total_a_pagar,
                p.idUsuarios,
                p.idNoClientes,
                p.tipoPedido,
                DATEDIFF(p.fechaInicio, p.fechaRegistro) AS dias_anticipacion,
                p.fechaRegistro,
                (
                    SELECT JSON_OBJECT(
                        'total_cantidad_productos', SUM(d.cantidad),
                        'total_productos_distintos', COUNT(DISTINCT p2.idProducto),
                        'stock_minimo_del_pedido', MIN(i.stock),
                        'total_categorias_distintas', COUNT(DISTINCT cat.idCategoria)
                    )
                    FROM tblpedidodetalles d
                    JOIN tblproductoscolores pc ON d.idProductoColores = pc.idProductoColores
                    JOIN tblinventario i ON pc.idProductoColores = i.idProductoColor
                    JOIN tblproductos p2 ON pc.idProducto = p2.idProducto
                    JOIN tblsubcategoria sc ON p2.idSubCategoria = sc.idSubCategoria
                    JOIN tblcategoria cat ON sc.idCategoria = cat.idCategoria
                    WHERE d.idPedido = p.idPedido
                ) AS metricas_productos,
                (
                    SELECT COALESCE(AVG(CASE WHEN p2.estadoActual = 'Cancelado' THEN 1.0 ELSE 0.0 END), 0) AS tasa
                    FROM tblpedidos p2
                    WHERE (p2.idUsuarios = p.idUsuarios OR p2.idNoClientes = p.idNoClientes)
                    AND p2.fechaRegistro < p.fechaRegistro
                ) AS tasa_cancelaciones,
                (
                    SELECT COUNT(*) 
                    FROM tblhistorialestados 
                    WHERE idPedido = p.idPedido
                ) AS total_cambios_estado
                
            FROM tblpedidos p
            WHERE p.idPedido = ?;
        `;

        const [rows] = await pool.query(queryCompleta, [idPedido]);
        
        if (rows.length === 0) {
            console.error(`No se encontró el pedido con ID: ${idPedido}`);
            return null;
        }

        const row = rows[0];
        const metricasProductos = JSON.parse(row.metricas_productos || '{}');

        
        const datosParaAPI = {
            cat__canal_pedido_Presencial: row.tipoPedido === 'Manual' ? 1 : 0,
            num__total_a_pagar: parseFloat(row.total_a_pagar) || 0,
            num__dias_anticipacion: parseInt(row.dias_anticipacion) || 0,
            num__total_cantidad_productos: parseInt(metricasProductos.total_cantidad_productos) || 0,
            num__total_productos_distintos: parseInt(metricasProductos.total_productos_distintos) || 0,
            num__stock_minimo_del_pedido: parseInt(metricasProductos.stock_minimo_del_pedido) || 0,
            num__total_categorias_distintas: parseInt(metricasProductos.total_categorias_distintas) || 0,
            num__tasa_cancelaciones_historicas_cliente: parseFloat(row.tasa_cancelaciones) || 0,
            num__total_cambios_estado: parseInt(row.total_cambios_estado) || 0
        };

        return datosParaAPI;

    } catch (error) {
        console.error(`❌ Error al obtener datos para la predicción del pedido ${idPedido}:`, error);
        return null;
    }
}

routerPedidos.get("/predecir-pedido/:idPedido", csrfProtection, async (req, res) => {
    
  const startTime = Date.now();
  const { idPedido } = req.params;
  
  try {
        const cacheKey = `prediction_${idPedido}`;
        const cached = predictionCache.get(cacheKey);
        
        if (cached && (Date.now() - cached.timestamp < CACHE_TTL)) {
            console.log(`✅ Cache hit para pedido ${idPedido}`);
            return res.json({ 
                success: true, 
                data: cached.data,
                fromCache: true,
                responseTime: Date.now() - startTime
            });
        }

     
        const [pedidoQuery, datosPrediccion] = await Promise.all([
         
            pool.query(`
                SELECT p.idPedido, p.idRastreo, p.totalPagar, p.estadoActual,
                       COALESCE(CONCAT(u.nombre, ' ', u.apellidoP), CONCAT(d.nombre, ' ', d.apellido)) AS nombreCliente
                FROM tblpedidos p
                LEFT JOIN tblusuarios u ON p.idUsuarios = u.idUsuarios
                LEFT JOIN tblnoclientes nc ON p.idNoClientes = nc.idNoClientes
                LEFT JOIN tbldireccioncliente d ON p.idDireccion = d.idDireccion
                WHERE p.idPedido = ? AND LOWER(p.estadoActual) NOT IN ('finalizado', 'cancelado');
            `, [idPedido]),
           
            obtenerDatosParaPrediccionOptimizado(idPedido)
        ]);

        const [pedidoRows] = pedidoQuery;

        if (pedidoRows.length === 0) {
            return res.status(404).json({
                success: false,
                error: `No se encontró un pedido activo con ID: ${idPedido}.`
            });
        }

        const pedido = pedidoRows[0];
        let prediccion = { error: "No se pudieron recopilar los datos para la predicción." };

        
        if (datosPrediccion) {
            try {
                const source = axios.CancelToken.source();
                const timeout = setTimeout(() => {
                    source.cancel('Timeout de predicción');
                }, PREDICTION_TIMEOUT);

                const response = await axios.post(
                    'https://predicion-de-peididos-calcelados.onrender.com/predecir', 
                    datosPrediccion, 
                    {
                        headers: { 'Content-Type': 'application/json' },
                        cancelToken: source.token,
                        timeout: PREDICTION_TIMEOUT
                    }
                );

                clearTimeout(timeout);
                prediccion = response.data;
                
            } catch (apiError) {
                if (axios.isCancel(apiError)) {
                    console.error(`⏰ Timeout en API de predicción para pedido ${idPedido}`);
                    prediccion = { error: "Timeout en la predicción." };
                } else {
                    console.error(`⚠️ Error en API para pedido ${idPedido}:`, apiError.message);
                    prediccion = { error: "Error en servicio de predicción." };
                }
            }
        }

      
        const pedidoConPrediccion = {
            idPedido: pedido.idPedido,
            idRastreo: pedido.idRastreo,
            totalPagar: pedido.totalPagar,
            estadoActual: pedido.estadoActual,
            nombreCliente: pedido.nombreCliente,
            prediccion
        };

        if (!prediccion.error) {
            predictionCache.set(cacheKey, {
                data: pedidoConPrediccion,
                timestamp: Date.now()
            });
        }

        console.log(`✅ Predicción completada en ${Date.now() - startTime}ms`);
        
        res.json({ 
            success: true, 
            data: pedidoConPrediccion,
            fromCache: false,
            responseTime: Date.now() - startTime
        });

    } catch (error) {
        console.error(`❌ Error en /predecir-pedido/${idPedido}:`, error);
        res.status(500).json({ 
            success: false, 
            error: "Error interno al procesar la predicción.",
            responseTime: Date.now() - startTime
        });
    }
});




routerPedidos.get("/pedidos/detalles/pagos", csrfProtection, async (req, res) => {
  try {
    const page = parseInt(req.query.page, 10) || 1;
    const limit = 15;
    const offset = (page - 1) * limit;

    const [[{ totalItems }]] = await pool.query(`SELECT COUNT(*) as totalItems FROM tblpedidos`);
    const totalPages = Math.ceil(totalItems / limit);

    await pool.query("SET SESSION group_concat_max_len = 1000000;");

    const query = `
      SELECT 
        p.idPedido,
        p.idRastreo,
        p.totalPagar,
        p.tipoPedido,
        p.estadoActual,
        p.fechaRegistro,
        p.fechaInicio,
        p.fechaEntrega,
        COALESCE(
          CONCAT(u.nombre, ' ', u.apellidoP, ' ', COALESCE(u.apellidoM, '')),
          CONCAT(nc.nombre, ' ', nc.apellidoCompleto),
          'No especificado'
        ) AS nombreCliente,
       COALESCE(u.correo, nc.correo, u.telefono, nc.telefono, 'N/A') AS contacto,
        CASE 
          WHEN u.idUsuarios IS NOT NULL AND nc.idUsuario IS NOT NULL THEN 'Cliente convertido'
          WHEN u.idUsuarios IS NOT NULL THEN 'Cliente registrado'
          WHEN nc.idNoClientes IS NOT NULL THEN 'No cliente'
          ELSE 'Desconocido'
        END AS tipoCliente,
        (
          SELECT COUNT(*) 
          FROM tblpagos pg 
          WHERE pg.idPedido = p.idPedido
        ) AS numeroPagos,
        (
          SELECT GROUP_CONCAT(
            JSON_OBJECT(
              'idPago', pg.idPago,
              'formaPago', pg.formaPago,
              'metodoPago', pg.metodoPago,
              'monto', pg.monto,
              'estadoPago', pg.estadoPago,
              'fechaPago', DATE_FORMAT(pg.fechaPago, '%Y-%m-%d %H:%i:%s')
            )
            SEPARATOR ','
          )
          FROM tblpagos pg
          WHERE pg.idPedido = p.idPedido
        ) AS pagos,
        (
          SELECT COALESCE(SUM(CASE WHEN pg.estadoPago = 'completado' THEN pg.monto ELSE 0 END), 0)
          FROM tblpagos pg
          WHERE pg.idPedido = p.idPedido
        ) AS totalPagado,
        (
          SELECT COALESCE(
            SUM(
              CASE 
                WHEN pg.estadoPago = 'completado' AND pg.formaPago = 'Tarjeta' 
                THEN pg.monto - (pg.monto * 0.029 + 0.30) 
                WHEN pg.estadoPago = 'completado' THEN pg.monto 
                ELSE 0 
              END
            ), 0)
          FROM tblpagos pg
          WHERE pg.idPedido = p.idPedido
        ) AS totalRecibido
      FROM tblpedidos p
      LEFT JOIN tblnoclientes nc ON p.idNoClientes = nc.idNoClientes
      LEFT JOIN tblusuarios u ON p.idUsuarios = u.idUsuarios OR nc.idUsuario = u.idUsuarios
      GROUP BY p.idPedido
      ORDER BY p.fechaRegistro DESC
      LIMIT ? 
      OFFSET ?;
    `;

    // MODIFICADO: Pasamos los parámetros de paginación a la consulta.
    const [results] = await pool.query(query, [limit, offset]);

    // El resto del mapeo de datos se queda igual...
    const response = results.map((pedido) => {
      // ... tu lógica de mapeo existente ...
      const pagosParsed = pedido.pagos && pedido.pagos !== '[]' && pedido.pagos !== '' ? JSON.parse(`[${pedido.pagos}]`) : [];
      const totalPagado = parseFloat(pedido.totalPagado) || 0;
      const totalPagar = parseFloat(pedido.totalPagar) || 0;
      const estadoPago = totalPagado >= totalPagar ? 'completado' : totalPagado > 0 ? 'parcial' : 'pendiente';
      return {
        idPedido: pedido.idPedido,
        idRastreo: pedido.idRastreo || 'N/A',
        cliente: { nombre: pedido.nombreCliente, contacto: pedido.contacto, tipoCliente: pedido.tipoCliente },
        totalPagar: totalPagar.toFixed(2),
        tipoPedido: pedido.tipoPedido,
        recibido: ['Entregado', 'Finalizado'].includes(pedido.estadoActual),
        estadoActual: pedido.estadoActual,
        fechaRegistro: pedido.fechaRegistro,
        fechaInicio: pedido.fechaInicio,
        fechaEntrega: pedido.fechaEntrega,
        pagos: {
          numeroPagos: parseInt(pedido.numeroPagos) || 0,
          listaPagos: pagosParsed.map((pago) => ({
            idPago: pago.idPago,
            formaPago: pago.formaPago || 'N/A',
            metodoPago: pago.metodoPago || 'N/A',
            monto: parseFloat(pago.monto) || 0,
            estadoPago: pago.estadoPago || 'pendiente',
            fechaPago: pago.fechaPago || null,
          })),
          totalPagado: totalPagado.toFixed(2),
          totalRecibido: parseFloat(pedido.totalRecibido).toFixed(2),
          estadoPago,
        },
      };
    });


    res.status(200).json({
      success: true,
      message: "Pedidos recuperados exitosamente",
      data: response,
      pagination: {
        currentPage: page,
        totalPages: totalPages,
        totalItems: totalItems
      }
    });

  } catch (error) {
    console.error("Error al obtener detalles de pedidos:", {
      message: error.message,
      stack: error.stack,
    });
    res.status(500).json({
      success: false,
      message: "Error interno al obtener los detalles de los pedidos",
      error: error.message,
    });
  }
});






module.exports = routerPedidos;
