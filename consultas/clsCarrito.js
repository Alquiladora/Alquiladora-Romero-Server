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
const moment = require("moment");
const { listeners } = require("process");
const { route } = require("./clssesiones");
const { getIO, getUserSockets } = require("../config/socket");
const { Console } = require("console");

const routerCarrito = express.Router();
routerCarrito.use(express.json());
routerCarrito.use(cookieParser());

routerCarrito.get("/carrito/:idUsuario", async (req, res) => {
    const { idUsuario } = req.params;

    if (!idUsuario) {
        return res.status(400).json({
            success: false,
            message: "El ID del usuario es requerido",
        });
    }
    let connection;
    try {
        connection = await pool.getConnection();
        await connection.beginTransaction();

        const [rows] = await connection.query(
            `
        SELECT 
    u.idUsuarios, 
    u.correo, 
    pc.idProductoColores, 
    pc.idColor, 
    c.color,
    p.idProducto, 
    p.nombre AS nombreProducto, 
    p.detalles, 
    p.material, 
    p.fechaCreacion AS fechaCreacionProducto, 
    ca.idCarrito, 
    ca.cantidad, 
    ca.precioAntes, 
    ca.precioProducto, 
    ca.fechaAgregado, 
    ca.fechaActualizacion,
    (SELECT urlFoto 
     FROM tblfotosproductos 
     WHERE idProducto = p.idProducto 
     LIMIT 1) AS imagenProducto,
    COALESCE(i.stock, 0) AS stockDisponible,
    COALESCE(i.stockReservado, 0) AS stockReservado
FROM tblcarrito ca
JOIN tblusuarios u ON ca.idUsuario = u.idUsuarios
JOIN tblproductoscolores pc ON ca.idProductoColor = pc.idProductoColores
JOIN tblproductos p ON pc.idProducto = p.idProducto
JOIN tblcolores c ON pc.idColor = c.idColores
LEFT JOIN tblinventario i ON pc.idProductoColores = i.idProductoColor
WHERE u.idUsuarios = ?
GROUP BY ca.idCarrito, p.idProducto, pc.idProductoColores, i.idProductoColor;

        `,
            [idUsuario]
        );

        if (rows.length === 0) {
            await connection.commit();
            return res.status(200).json({
                success: true,
                message: "El carrito está vacío",
                carrito: [],
                expiredCount: 0,
            });
        }

        const currentDate = new Date();

        const expiredItems = [];
        const validItems = [];

        for (const item of rows) {
            const fechaAgregado = new Date(item.fechaAgregado);
            const expirationDate = new Date(fechaAgregado);


            expirationDate.setFullYear(fechaAgregado.getFullYear() + 1);


            if (currentDate > expirationDate) {
                expiredItems.push(item);
            } else {
                validItems.push(item);
            }
        }

        for (const item of expiredItems) {
            const { idCarrito, idProductoColores, cantidad } = item;

            await connection.query("DELETE FROM tblcarrito WHERE idCarrito = ?", [
                idCarrito,
            ]);
            await connection.query(
                `UPDATE tblinventario i 
           JOIN tblbodegas b ON i.idBodega = b.idBodega   
               i.stockReservado = i.stockReservado - ? 
           WHERE i.idProductoColor = ? 
             AND b.es_principal = 1`,
                [cantidad, idProductoColores]
            );
        }

        await connection.commit();

        res.status(200).json({
            success: true,
            carrito: validItems,
            expiredCount: expiredItems.length,
        });
    } catch (error) {
        if (connection) {
            try {
                await connection.rollback();
            } catch (rollbackError) {
                console.error("Error during rollback:", rollbackError);
            }
        }

        console.error("❌ Error al obtener el carrito:", error.stack);
        res.status(500).json({
            success: false,
            message: "Error interno del servidor",
            error: error.message,
        });
    } finally {
        if (connection) {
            try {
                await connection.release();
            } catch (releaseError) {
                console.error("Error releasing connection:", releaseError);
            }
        }
    }
});

routerCarrito.post("/agregar", async (req, res) => {
    const { idUsuario, idProductoColor, cantidad, precioAlquiler } = req.body;


    if (
        !idUsuario ||
        !idProductoColor ||
        !cantidad ||
        cantidad <= 0 ||
        !precioAlquiler
    ) {
        return res.status(400).json({ mensaje: "Datos inválidos" });
    }

    const connection = await pool.getConnection();
    try {
        await connection.beginTransaction();

        const [inventario] = await connection.query(
            ` SELECT i.stock, i.stockReservado 
        FROM tblinventario i 
        JOIN tblbodegas b ON i.idBodega = b.idBodega  
        WHERE i.idProductoColor = ?
        AND b.es_principal = 1 
        FOR UPDATE; 
      `,
            [idProductoColor]
        );

        if (inventario.length === 0 || inventario[0].stock < cantidad) {
            await connection.rollback();
            return res.status(400).json({ mensaje: "Stock insuficiente" });
        }

        // await connection.query(
        //   "UPDATE tblinventario i JOIN tblbodegas b ON i.idBodega = b.idBodega SET i.stock = stock - ?, i.stockReservado = stockReservado + ? WHERE i.idProductoColor = ? AND b.es_principal = 1",
        //   [cantidad, cantidad, idProductoColor]
        // );

        await connection.query(
            "UPDATE tblinventario i JOIN tblbodegas b ON i.idBodega = b.idBodega SET  i.stockReservado = stockReservado + ? WHERE i.idProductoColor = ? AND b.es_principal = 1",
            [cantidad, idProductoColor]
        );



        await connection.query(
            "INSERT INTO tblcarrito (idUsuario, idProductoColor, cantidad, precioAntes,precioProducto, fechaAgregado) VALUES (?, ?, ?, ?,?, NOW())",
            [idUsuario, idProductoColor, cantidad, precioAlquiler, precioAlquiler]
        );

        await connection.commit();


        const userSockets = getUserSockets();
        console.log("Usuarios conectados:", Object.keys(userSockets));

        if (userSockets[idUsuario]) {
            console.log(`Emitiendo 'productoAgregadoCarrito' al usuario ${idUsuario}`);
            userSockets[idUsuario].emit("productoAgregadoCarrito", {
                idProductoColor,
                cantidad,
                precioAlquiler,
                mensaje: "✅ Producto agregado al carrito correctamente.",
            });
        } else {
            console.log(`Usuario ${idUsuario} no está conectado al socket`);
        }


        res
            .status(201)
            .json({ success: true, mensaje: "Producto agregado al carrito" });
    } catch (error) {
        await connection.rollback();
        console.error("Error al agregar al carrito:", error);
        res.status(500).json({ mensaje: "Error al agregar producto", error });
    } finally {
        connection.release();
    }
});

//Contar cuando productos tiene en el carrito 
routerCarrito.get("/count/:idUsuario", async (req, res) => {
    const { idUsuario } = req.params;
    try {
        const [rows] = await pool.query(
            "SELECT COUNT(*) as count FROM tblcarrito WHERE idUsuario = ?",
            [idUsuario]
        );
        res.json({ count: rows[0].count });
    } catch (error) {
        console.error("Error fetching cart count:", error);
        res.status(500).json({ mensaje: "Error al obtener el conteo del carrito" });
    }
});

//Eliminar del carrito
routerCarrito.delete("/eliminar/:idCarrito", async (req, res) => {
    const { idCarrito } = req.params;
    const {idUsuario}= req.body;

    console.log("Id del carrito a eliminar:", idCarrito);
    console.log("Id del usuario:", idUsuario);

    if (!idUsuario) {
        return res.status(400).json({ mensaje: "Falta el idUsuario en el cuerpo de la solicitud" });
      }

    let connection;
    try {
        connection = await pool.getConnection();

        await connection.beginTransaction();

        const [carritoItem] = await connection.query(
            "SELECT idProductoColor, cantidad FROM tblcarrito WHERE idCarrito = ?",
            [idCarrito]
        );

        if (carritoItem.length === 0) {
            return res
                .status(404)
                .json({ mensaje: "El producto no existe en el carrito" });
        }

        const { idProductoColor, cantidad } = carritoItem[0];

        const [inventario] = await connection.query(
            `SELECT i.stock, i.stockReservado 
         FROM tblinventario i
         JOIN tblbodegas b ON i.idBodega = b.idBodega
         WHERE i.idProductoColor = ? 
         AND b.es_principal = 1`,
            [idProductoColor]
        );

        if (inventario.length === 0) {
            throw new Error("Producto no encontrado en el inventario");
        }

        const { stock, stockReservado } = inventario[0];
        console.log("Datos del inventario:", { stock, stockReservado });

        // Validar que stockReservado no baje de 0
        if (stockReservado < cantidad) {
            return res.status(400).json({
                success: false,
                mensaje: "El stock reservado no puede ser menor a 0. Cantidad reservada insuficiente.",
            });
        }
        // await connection.query(
        //   `UPDATE tblinventario i 
        //      JOIN tblbodegas b ON i.idBodega = b.idBodega  
        //      SET i.stock = i.stock + ?, 
        //          i.stockReservado = i.stockReservado - ? 
        //      WHERE i.idProductoColor = ? 
        //      AND b.es_principal = 1;`,
        //   [cantidad, cantidad, idProductoColor]
        // );

        await connection.query("DELETE FROM tblcarrito WHERE idCarrito = ?", [
            idCarrito,
        ]);

        await connection.query(
            `UPDATE tblinventario i 
         JOIN tblbodegas b ON i.idBodega = b.idBodega   
         SET i.stockReservado = i.stockReservado - ? 
         WHERE i.idProductoColor = ? 
         AND b.es_principal = 1`,
            [cantidad, idProductoColor]
        );

        await connection.commit();

        const userSockets = getUserSockets();
        
       if (userSockets[idUsuario]) {
      userSockets[idUsuario].emit("productoEliminadoCarrito", {
        idProductoColor,
        cantidad,
        mensaje: "✅ Producto eliminado del carrito correctamente.",
      });
    } else {
      console.log(`No se encontró socket para el usuario ${idUsuario}`);
    }

        res
            .status(200)
            .json({ success: true, mensaje: "Producto eliminado del carrito" });
    } catch (error) {
        if (connection) {
            try {
                await connection.rollback();
            } catch (rollbackError) {
                console.error("Error during rollback:", rollbackError);
            }
        }
        console.error("Error al eliminar producto del carrito:", error);
        res.status(500).json({ mensaje: "Error al eliminar producto", error });
    } finally {
        if (connection) {
            try {
                await connection.release();
            } catch (releaseError) {
                console.error("Error releasing connection:", releaseError);
            }
        }
    }
});

//Acatualizar
routerCarrito.put("/actualizar/:idCarrito", async (req, res) => {
    const { idCarrito } = req.params;
    const { cantidad } = req.body;
    let connection;

    if (!cantidad || cantidad <= 0) {
        return res
            .status(400)
            .json({ success: false, mensaje: "La cantidad debe ser mayor a 0." });
    }

    try {
        connection = await pool.getConnection();

        await connection.beginTransaction();

        const [carritoItem] = await connection.query(
            "SELECT ca.idProductoColor, ca.cantidad FROM tblcarrito ca WHERE ca.idCarrito = ?",
            [idCarrito]
        );

        if (carritoItem.length === 0) {
            throw new Error("Producto no encontrado en el carrito");
        }

        const { idProductoColor, cantidad: cantidadActual } = carritoItem[0];
        console.log("Datos del carrito:", {
            idCarrito,
            idProductoColor,
            cantidadActual,
            nuevaCantidad: cantidad,
        });

        const [inventario] = await connection.query(
            `SELECT 
           i.stock, 
           i.stockReservado 
         FROM tblinventario i
         JOIN tblbodegas b ON i.idBodega = b.idBodega
         WHERE i.idProductoColor = ? 
           AND b.es_principal = 1`,
            [idProductoColor]
        );

        if (inventario.length === 0) {
            throw new Error("Producto no encontrado en el inventario");
        }

        const { stock, stockReservado } = inventario[0];

        console.log("Datos del inventario:", { stock, stockReservado });

        const stockDisponible = stock - stockReservado;

        console.log("Stok disponible", stockDisponible);
        console.log("Stok cantidad actual", cantidadActual);
        console.log("Stok cantidad a", cantidad);

        const diferenciaCantidad = cantidad - cantidadActual;
        if (diferenciaCantidad > 0 && diferenciaCantidad > stockDisponible) {
            await connection.rollback();
            return res.status(400).json({
                success: false,
                mensaje: "La cantidad solicitada excede el stock disponible.",
            });
        }

        await connection.query(
            "UPDATE tblcarrito SET cantidad = ? WHERE idCarrito = ?",
            [cantidad, idCarrito]
        );


        if (cantidad > cantidadActual) {
            const cantidadAAgregar = cantidad - cantidadActual;
            console.log("Datos de agregar cantidad disponible", cantidadAAgregar);

            if (cantidad > cantidadActual) {
                const cantidadAAgregar = cantidad - cantidadActual;
                console.log("Cantidad a agregar al stockReservado:", cantidadAAgregar);

                await connection.query(
                    `UPDATE tblinventario i
           JOIN tblbodegas b ON i.idBodega = b.idBodega
           SET i.stockReservado = i.stockReservado + ?
           WHERE i.idProductoColor = ?
           AND b.es_principal = 1`,
                    [cantidadAAgregar, idProductoColor]
                );
            }

            //       await connection.query(
            //         `UPDATE tblinventario i
            //           JOIN tblbodegas b ON i.idBodega = b.idBodega
            //           SET i.stock = i.stock - ?, 
            //           i.stockReservado = i.stockReservado + ?
            //           WHERE i.idProductoColor = ?
            //           AND b.es_principal = 1;
            //  `,
            //         [cantidadAAgregar, cantidadAAgregar, idProductoColor]
            //       );


        } else if (cantidad < cantidadActual) {
            const cantidadAReducir = cantidadActual - cantidad;

            console.log("Cantidad a reducir del stockReservado:", cantidadAReducir);

            await connection.query(
                `UPDATE tblinventario i
         JOIN tblbodegas b ON i.idBodega = b.idBodega
         SET i.stockReservado = i.stockReservado - ?
         WHERE i.idProductoColor = ?
         AND b.es_principal = 1`,
                [cantidadAReducir, idProductoColor]
            );
        }

        await connection.commit();
        res
            .status(200)
            .json({ success: true, mensaje: "Cantidad actualizada correctamente." });
    } catch (error) {
        if (connection) {
            try {
                await connection.rollback();
            } catch (rollbackError) {
                console.error("Error during rollback:", rollbackError);
            }
        }

        // Errores específicos
        if (error.message === "Producto no encontrado en el carrito") {
            return res.status(404).json({ success: false, mensaje: error.message });
        }
        if (error.message === "Producto no encontrado en el inventario") {
            return res.status(404).json({ success: false, mensaje: error.message });
        }
        if (error.message === "La cantidad solicitada excede el stock disponible.") {
            return res.status(400).json({ success: false, mensaje: error.message });
        }
        res
            .status(500)
            .json({
                success: false,
                mensaje: "Error interno del servidor",
                error: error.message,
            });
    } finally {
        if (connection) {
            try {
                await connection.release();
            } catch (releaseError) {
                console.error("Error releasing connection:", releaseError);
            }
        }
    }
});

module.exports = routerCarrito;
