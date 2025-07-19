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

const routerPedidos = express.Router();
routerPedidos.use(express.json());
routerPedidos.use(cookieParser());

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


      console.log("DATOS RECIBIDOS", esClienteExistente, selectedDireccionId)
  
   
      let crearDireccion = 0;
      let idDireccionExistente = null;

      if (!selectedDireccionId) {
        crearDireccion = 1;
      } else {
        crearDireccion = 0;
        idDireccionExistente = selectedDireccionId;
      }

      console.log("dirrecion crear", crearDireccion)
  

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
        console.log("🔎 Datos recibidos de no cliente (no es cliente registrado):", noClienteRows);
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

      console.log("pedidos activos", pedidosActivos)
      
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

  


       console.log("datos de cls sp_crearpedido basico",values )
  
      const [rows] = await pool.query(query, values);
      console.log("datos recibidos", rows)
      
      const result = rows[0][0];

      console.log("resulatdos de resultados", result)

      const newIdPedido = result.newIdPedido;
       console.log("resulatdos de newIdPedido", newIdPedido)
  
      
      for (const item of lineItems) {


        console.log(item);

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
    console.log("Datos recibidos pagos", idPedido);

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
    await pool.query("SET SESSION group_concat_max_len = 1000000;");

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
GROUP BY p.idPedido
ORDER BY p.fechaRegistro DESC;

    `;

    const [results] = await pool.query(query);

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
      total: response.length,
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

      console.log('productosAlquilados:', pedido.productosAlquilados); // Para depuración
      console.log('imagenesProductos:', pedido.imagenesProductos); // Para depuración

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
        COALESCE(CONCAT(u.nombre, ' ', u.apellidoP, ' ', u.apellidoM), CONCAT(d.nombre, ' ', d.apellido)) AS nombreCliente,
       弄

System: COALESCE(u.telefono, d.telefono) AS telefono,
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
        GROUP_CONCAT(
          (SELECT urlFoto FROM tblfotosproductos fp 
           WHERE fp.idProducto = prod.idProducto 
           ORDER BY fp.idFoto ASC LIMIT 1)
        ) AS imagenesProductos,
        pagos.pagosRealizados,
        pagos.totalPagado,
        pagos.formaPago,
        CONCAT(r_usuario.nombre, ' ', r_usuario.apellidoP, ' ', r_usuario.apellidoM) AS nombreRepartidor,
        r_usuario.telefono AS telefonoRepartidor
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
      WHERE LOWER(p.estadoActual) = 'devuelto'
      GROUP BY p.idPedido, p.idRastreo, nombreCliente, telefono, direccionCompleta, p.fechaInicio, p.fechaEntrega, p.horaAlquiler, p.estadoActual, p.totalPagar, tipoCliente, pagos.pagosRealizados, pagos.totalPagado, pagos.formaPago, nombreRepartidor, telefonoRepartidor
      ORDER BY p.fechaRegistro DESC;
    `;

    const [results] = await pool.query(query);

    const response = results.map(pedido => {
      const productosStrArray = pedido.productosAlquilados ? pedido.productosAlquilados.split(' | ') : [];
      const imagenesStrArray = pedido.imagenesProductos ? pedido.imagenesProductos.split(',') : [];

      console.log('productosAlquilados:', pedido.productosAlquilados); 
      console.log('imagenesProductos:', pedido.imagenesProductos); 

      const productosParsed = productosStrArray.map((prodStr, index) => {
        const regex = /^(\d+)x\s+(.+?)\s+\((.+?)\)\s+-\s+([\d.]+)\s+c\/u,\s+Subtotal:\s+([\d.]+),\s+Estado Producto:\s*(.+?)?,\s+Observaciones:\s+(.+)$/;
        const match = prodStr.match(regex);

        if (match) {
          return {
            idProductoColores: null, 
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
            idProductoColores: null,
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
          : parseFloat(pedido.totalPagado) > 0
          ? 'parcial'
          : 'pendiente';

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
          totalPagado: parseFloat(pedido.totalPagado) || 0,
          estadoPago: estadoPago,
          formaPago: pedido.formaPago || 'N/A',
        },
        estado: pedido.estado || 'Devuelto',
        productos: productosParsed,
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


routerPedidos.get("/pedidos-cliente/:idUsuarios", csrfProtection, async (req, res) => {
  try {
  
    const { idUsuarios } = req.params;


    if (!idUsuarios || isNaN(idUsuarios)) {
      return res.status(400).json({
        success: false,
        message: "El idUsuarios proporcionado no es válido.",
      });
    }

    await pool.query("SET SESSION group_concat_max_len = 1000000;");

  
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
        p.formaPago,
        p.detallesPago,
        p.totalPagar,
        p.estado,
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
        ) AS productosAlquilados
      FROM tblpedidos p
      LEFT JOIN tblnoclientes nc ON p.idNoClientes = nc.idNoClientes
      LEFT JOIN tbldireccioncliente d ON p.idDireccion = d.idDireccion
      LEFT JOIN tblusuarios u ON p.idUsuarios = u.idUsuarios 
      LEFT JOIN tblpedidodetalles pd ON p.idPedido = pd.idPedido
      LEFT JOIN tblproductoscolores pc ON pd.idProductoColores = pc.idProductoColores
      LEFT JOIN tblcolores c ON pc.idColor = c.idColores
      LEFT JOIN tblproductos prod ON pc.idProducto = prod.idProducto
      WHERE p.idUsuarios = ?
      GROUP BY p.idPedido
      ORDER BY p.fechaRegistro DESC;
    `;

    const [results] = await pool.query(query);

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
      total: response.length,
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




routerPedidos.get("/check-id-rastreo/:idRastreo", csrfProtection, async (req, res) => {
  const { idRastreo } = req.params;

  try {
 
    const [rows] = await pool.query(
      `
      SELECT idPedido
      FROM tblpedidos
      WHERE idRastreo = ? and idNoClientes is not null
      LIMIT 1
      `,
      [idRastreo]
    );

    if (rows.length > 0) {

      return res.status(200).json({
        success: true,
        exists: true,
        idPedido: rows[0].idPedido,
      });
    } else {
      
      return res.status(200).json({
        success: true,
        exists: false,
      });
    }
  } catch (error) {
    console.error("Error al verificar idRastreo:", error);
    return res.status(500).json({
      success: false,
      message: "Error al verificar el ID de rastreo",
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

    // Obtener idPedido y estado actual
    const [orders] = await pool.query(
      `
      SELECT 
        idPedido,
        idRastreo,
        CONCAT(UCASE(LEFT(estadoActual,1)), LCASE(SUBSTRING(estadoActual,2))) AS estado,
        fechaInicio,
        fechaEntrega,
        detallesPago
      FROM tblpedidos
      WHERE idRastreo = ?
      `,
      [idRastreo]
    );

    if (orders.length === 0) {
      return res.status(404).json({
        success: false,
        message: "No se encontró un pedido con ese ID de rastreo",
      });
    }

    const order = orders[0];

    // Consultar historial en tblhistorialestados
    const [historyRows] = await pool.query(
      `
      SELECT 
        CONCAT(UCASE(LEFT(estadoNuevo,1)), LCASE(SUBSTRING(estadoNuevo,2))) AS state,
        DATE_FORMAT(fechaActualizacion, '%Y-%m-%d %H:%i:%s') AS date,
        CONCAT('El pedido cambió a ', CONCAT(UCASE(LEFT(estadoNuevo,1)), LCASE(SUBSTRING(estadoNuevo,2))), 
               COALESCE(CONCAT(' desde ', CONCAT(UCASE(LEFT(estadoAnterior,1)), LCASE(SUBSTRING(estadoAnterior,2)))), '')) AS description
      FROM tblhistorialestados
      WHERE idPedido = ?
      ORDER BY fechaActualizacion ASC
      `,
      [order.idPedido]
    );

    // Si no hay historial, devolver array vacío
    const history = historyRows.length > 0 ? historyRows : [];

    // Construir respuesta
    const response = {
      id: order.idRastreo,
      status: order.estado,
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
      `
      SELECT 
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




module.exports = routerPedidos;
