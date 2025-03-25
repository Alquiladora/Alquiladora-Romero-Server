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

      if (esClienteExistente) {
        const [clienteRows] = await pool.query(
          "SELECT idNoClientes AS id FROM tblnoclientes WHERE correo = ? OR telefono = ? LIMIT 1",
            [correo,telefono]
        );
        if (clienteRows.length > 0) {
            idCliente = clienteRows[0].id;
        }
    } else {
        const [noClienteRows] = await pool.query(
            "SELECT idNoClientes AS id FROM tblnoclientes WHERE correo = ?  OR telefono = ? LIMIT 1",
            [correo,telefono]
        );
        if (noClienteRows.length > 0) {
            idCliente = noClienteRows[0].id;
        }
    }

    if (idCliente) {
      const [pedidosActivos] = await pool.query(
        `
        SELECT COUNT(*) AS total
        FROM tblpedidos
        WHERE (idUsuarios = ? OR idNoClientes = ?)
        AND LOWER(estado) IN ('finalizado', 'cancelado')
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
    p.horaAlquiler,
    p.formaPago,
    p.totalPagar,
    p.estado,
    CASE 
        WHEN u.idUsuarios IS NOT NULL THEN 'Cliente registrado'
        WHEN nc.idUsuario IS NOT NULL THEN 'Cliente convertido'
        ELSE 'No cliente'
    END AS tipoCliente,
    GROUP_CONCAT(
        CONCAT(pd.cantidad, 'x ', prod.nombre, ' (', pc.idColor, ') - ', pd.precioUnitario, ' c/u, Subtotal: ', pd.subtotal) 
        SEPARATOR ' | '
    ) AS productosAlquilados
FROM tblpedidos p
LEFT JOIN tblnoclientes nc ON p.idNoClientes = nc.idNoClientes
LEFT JOIN tbldireccioncliente d ON p.idDireccion = d.idDireccion
LEFT JOIN tblusuarios u ON p.idUsuarios = u.idUsuarios 
LEFT JOIN tblpedidodetalles pd ON p.idPedido = pd.idPedido
LEFT JOIN tblproductoscolores pc ON pd.idProductoColores = pc.idProductoColores
LEFT JOIN tblproductos prod ON pc.idProducto = prod.idProducto
WHERE 
    (
        nc.idUsuario IS NULL
        OR (nc.idUsuario IS NOT NULL AND LOWER(p.estado) NOT IN ('finalizado', 'cancelado'))
    )
    AND (p.idUsuarios IS NULL OR LOWER(p.estado) NOT IN ('finalizado', 'cancelado'))
GROUP BY p.idPedido
ORDER BY p.fechaRegistro DESC;


        `;

        const [results] = await pool.query(query);

        // Format the response
        const response = results.map(pedido => ({
            idPedido: pedido.idPedido,
            idRastreo: pedido.idRastreo,
            cliente: {
                nombre: pedido.nombreCliente,
                telefono: pedido.telefono,
                direccion: pedido.direccionCompleta,
                tipoCliente: pedido.tipoCliente
            },
            fechas: {
                inicio: pedido.fechaInicio,
                entrega: pedido.fechaEntrega,
                diasAlquiler: pedido.diasAlquiler,
                horaAlquiler: pedido.horaAlquiler
            },
            pago: {
                formaPago: pedido.formaPago,
                total: pedido.totalPagar
            },
            estado: pedido.estado,
            productos: pedido.productosAlquilados ? pedido.productosAlquilados.split(' | ') : []
        }));

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


routerPedidos.get("/pedidos-general" , csrfProtection, async (req, res) => {
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
              p.formaPago,
              p.detallesPago,
              p.totalPagar,
              p.estado,
              p.fechaRegistro,
              CASE 
                  WHEN u.idUsuarios IS NOT NULL THEN 'Cliente registrado'
                  WHEN nc.idUsuario IS NOT NULL THEN 'Cliente convertido'
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
          GROUP BY p.idPedido
          ORDER BY p.fechaRegistro DESC;
      `;

      const [results] = await pool.query(query);

    
      const response = results.map(pedido => ({
          idPedido: pedido.idPedido,
          idRastreo: pedido.idRastreo,
          cliente: {
              nombre: pedido.nombreCliente,
              telefono: pedido.telefono,
              direccion: pedido.direccionCompleta,
              tipoCliente: pedido.tipoCliente
          },
          fechas: {
              inicio: pedido.fechaInicio,
              entrega: pedido.fechaEntrega,
              diasAlquiler: pedido.diasAlquiler,
              horaAlquiler: pedido.horaAlquiler,
              registro: pedido.fechaRegistro
          },
          pago: {
              formaPago: pedido.formaPago,
              detalles: pedido.detallesPago,
              total: pedido.totalPagar
          },
          estado: pedido.estado,
          productos: JSON.parse(pedido.productosAlquilados) 
      }));

      res.status(200).json({
          success: true,
          data: response,
          total: response.length
      });

  } catch (error) {
      console.error("Error al obtener los pedidos generales:", error);
      res.status(500).json({
          success: false,
          message: "Error interno del servidor",
          error: error.message
      });
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

    const [results] = await pool.query(query, [idUsuarios]);

  
    if (results.length === 0) {
      return res.status(200).json({
        success: true,
        data: [],
        total: 0,
        message: "No se encontraron pedidos para este cliente.",
      });
    }

  
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
        formaPago: pedido.formaPago,
        detalles: pedido.detallesPago,
        total: pedido.totalPagar,
      },
      estado: pedido.estado,
      productos: JSON.parse(pedido.productosAlquilados),
    }));

    res.status(200).json({
      success: true,
      data: response,
      total: response.length,
    });
  } catch (error) {
    console.error("Error al obtener los pedidos del cliente:", error);
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
  const { idRastreo } = req.params;

  try {
    // Query to fetch the order details from tblpedidos
    const [orders] = await pool.query(
      `
      SELECT 
        idRastreo,
        estado,
        fechaInicio,
        fechaEntrega,
        detallesPago
      FROM 
        tblpedidos
      WHERE 
        idRastreo = ?
      `,
      [idRastreo]
    );

    if (orders.length === 0) {
      return res.status(404).json({ message: "No se encontró un pedido con ese ID de rastreo." });
    }

    const order = orders[0];

    const history = [];
    const baseDate = new Date(order.fechaInicio);
    const deliveryDate = new Date(order.fechaEntrega);

    // Helper function to format dates
    const formatDate = (date) => {
      return date.toLocaleString("en-US", {
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hour12: true,
      });
    };

    // Add "Procesando" as the initial state
    history.push({
      state: "Procesando",
      date: formatDate(baseDate),
      description: "Estamos preparando tu pedido para el envío.",
    });

    // Add "Confirmado" (1 hour after Procesando)
    const confirmadoDate = new Date(baseDate.getTime() + 60 * 60 * 1000);
    history.push({
      state: "Confirmado",
      date: formatDate(confirmadoDate),
      description: "Tu pedido ha sido confirmado y está listo para enviarse.",
    });

    // Add "Enviando" (2 hours after Procesando)
    const enviandoDate = new Date(baseDate.getTime() + 2 * 60 * 60 * 1000);
    history.push({
      state: "Enviando",
      date: formatDate(enviandoDate),
      description: "El pedido ha sido enviado y está en camino.",
    });

    // Add "Entregado" (at fechaEntrega)
    history.push({
      state: "Entregado",
      date: formatDate(deliveryDate),
      description: "El pedido ha sido entregado exitosamente.",
    });

    // Add additional states based on the current estado
    if (order.estado === "En Alquiler") {
      const enAlquilerDate = new Date(deliveryDate.getTime() + 1 * 60 * 60 * 1000);
      history.push({
        state: "En Alquiler",
        date: formatDate(enAlquilerDate),
        description: "El producto está en uso por el cliente.",
      });
    } else if (order.estado === "Incompleto") {
      const enAlquilerDate = new Date(deliveryDate.getTime() + 1 * 60 * 60 * 1000);
      history.push({
        state: "En Alquiler",
        date: formatDate(enAlquilerDate),
        description: "El producto está en uso por el cliente.",
      });
      const incompletoDate = new Date(deliveryDate.getTime() + 24 * 60 * 60 * 1000);
      history.push({
        state: "Incompleto",
        date: formatDate(incompletoDate),
        description: "El producto fue devuelto, pero falta un elemento.",
      });
    } else if (order.estado === "Incidencia") {
      const enAlquilerDate = new Date(deliveryDate.getTime() + 1 * 60 * 60 * 1000);
      history.push({
        state: "En Alquiler",
        date: formatDate(enAlquilerDate),
        description: "El producto está en uso por el cliente.",
      });
      const incidenciaDate = new Date(deliveryDate.getTime() + 24 * 60 * 60 * 1000);
      history.push({
        state: "Incidencia",
        date: formatDate(incidenciaDate),
        description: order.detallesPago || "Se reportó un problema con el pedido.",
      });
    } else if (order.estado === "Devuelto") {
      const enAlquilerDate = new Date(deliveryDate.getTime() + 1 * 60 * 60 * 1000);
      history.push({
        state: "En Alquiler",
        date: formatDate(enAlquilerDate),
        description: "El producto está en uso por el cliente.",
      });
      const devueltoDate = new Date(deliveryDate.getTime() + 24 * 60 * 60 * 1000);
      history.push({
        state: "Devuelto",
        date: formatDate(devueltoDate),
        description: "El producto ha sido devuelto exitosamente.",
      });
    } else if (order.estado === "Finalizado") {
      const enAlquilerDate = new Date(deliveryDate.getTime() + 1 * 60 * 60 * 1000);
      history.push({
        state: "En Alquiler",
        date: formatDate(enAlquilerDate),
        description: "El producto está en uso por el cliente.",
      });
      const finalizadoDate = new Date(deliveryDate.getTime() + 24 * 60 * 60 * 1000);
      history.push({
        state: "Finalizado",
        date: formatDate(finalizadoDate),
        description: "El pedido ha sido finalizado.",
      });
    } else if (order.estado === "Cancelado") {
      const canceladoDate = new Date(baseDate.getTime() + 3 * 60 * 60 * 1000);
      history.push({
        state: "Cancelado",
        date: formatDate(canceladoDate),
        description: "El pedido ha sido cancelado.",
      });
    }

    // Construct the response
    const response = {
      id: order.idRastreo,
      status: order.estado,
      history: history,
    };

    res.status(200).json(response);
  } catch (error) {
    console.error("Error fetching order:", error);
    res.status(500).json({ message: "Error al rastrear el pedido. Intenta de nuevo más tarde." });
  }
});


module.exports = routerPedidos;
