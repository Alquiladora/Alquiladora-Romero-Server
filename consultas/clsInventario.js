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

const routerInventario = express.Router();
routerInventario.use(express.json());
routerInventario.use(cookieParser());

routerInventario.get("/", csrfProtection, async (req, res) => {
  const sql = `
     SELECT
  p.idProducto,
  p.nombre,
  p.detalles,
  p.material,
  
  sub.idSubCategoria,
  sub.nombre AS nombreSubcategoria,
  
  categ.idcategoria,
  categ.nombre AS nombreCategoria,
  
  usua.idUsuarios,
  usua.correo,
  
  pre.idPrecio,
  pre.precioAlquiler,
  bod.idBodega,
  bod.nombre AS nombreBodega,
  bod.es_principal,
  bod.ubicacion,
  inv.idInventario,
  inv.idProductoColor,
  inv.stockReal,
  inv.stock,
  inv.stockReservado,
  inv.estado,
  inv.notas,
  inv.fechaRegistro,
  MIN(
    (
      SELECT fp.urlFoto 
      FROM tblfotosproductos fp
      WHERE fp.idProducto = p.idProducto
      LIMIT 1
    )
  ) AS urlFoto,
  GROUP_CONCAT(DISTINCT c.color SEPARATOR ', ') AS colores
FROM tblinventario inv
LEFT JOIN tblproductoscolores pc
       ON inv.idProductoColor = pc.idProductoColores
LEFT JOIN tblproductos p
       ON pc.idProducto = p.idProducto
LEFT JOIN tblsubcategoria sub
       ON p.idSubcategoria = sub.idSubCategoria
LEFT JOIN tblcategoria categ
       ON sub.idCategoria = categ.idcategoria
LEFT JOIN tblusuarios usua
       ON p.idUsuarios = usua.idUsuarios
LEFT JOIN tblprecio pre
       ON p.idProducto = pre.idProducto
LEFT JOIN tblbodegas bod
       ON inv.idBodega = bod.idBodega
LEFT JOIN tblcolores c
       ON pc.idColor = c.idColores
GROUP BY
  p.idProducto,
  p.nombre,
  p.detalles,
  p.material,
  sub.idSubCategoria,
  sub.nombre,
  categ.idcategoria,
  categ.nombre,
  usua.idUsuarios,
  usua.correo,
  pre.idPrecio,
  pre.precioAlquiler,
  bod.idBodega,
  bod.nombre,
  bod.es_principal,
  bod.ubicacion,
  inv.idInventario,
  inv.stockReal,
  inv.stock,
  inv.stockReservado,
  inv.estado,
  inv.notas,
  inv.fechaRegistro;
    `;

  try {
    const [rows] = await pool.query(sql);
    res.json(rows);
  } catch (error) {
    console.log("Error al obtener inventario: ", error);
    res.status(500).json({ error: "Error al obtener inventario" });
  }
});

routerInventario.put(
  "/actualizarStock/:idInventario",
  csrfProtection,
  async (req, res) => {
    const { idInventario } = req.params;
    const { stock, allowZero } = req.body;
    const stockToAdd = parseInt(stock, 10);

    if (isNaN(stockToAdd) || (!allowZero && stockToAdd <= 0) || (allowZero && stockToAdd < 0)) {
      return res.status(400).json({
        success: false,
        message: "El valor de 'stock' debe ser un número mayor que 0.",
      });
    }
    try {
      const [rows] = await pool.query(
        "SELECT stockReal, stock FROM tblinventario WHERE idInventario = ?",
        [idInventario]
      );

      if (rows.length === 0) {
        return res.status(404).json({
          success: false,
          message: "No se encontró el inventario con ese ID.",
        });
      }

      const { stockReal, stock: currentStock } = rows[0];
      const updatedStockReal =
        stockReal === 0 ? stockToAdd : stockReal + stockToAdd;
      const updatedStock =
        currentStock === 0 ? stockToAdd : currentStock + stockToAdd;

      await pool.query(
        "UPDATE tblinventario SET stockReal = ?, stock = ? WHERE idInventario = ?",
        [updatedStockReal, updatedStock, idInventario]
      );
      return res.json({
        success: true,
        message: "Stock actualizado correctamente.",
        data: {
          idInventario,
          stockReal: updatedStockReal,
          stock: updatedStock,
        },
      });
    } catch (error) {
      console.error("Error al actualizar el stock:", error);
      return res.status(500).json({
        success: false,
        message: "Error interno al actualizar el stock.",
      });
    }
  }
);


routerInventario.get("/bodegas", async (req, res) => {
  try {
    const [rows] = await pool.query(`
SELECT  idBodega,nombre,es_principal,estado FROM tblbodegas;
      `);
    res.status(200).json({ success: true, bodegas: rows });
  } catch (error) {
    console.error("Error al obtener bodegas:", error);
    res.status(500).json({
      success: false,
      message: "Error interno del servidor",
    });
  }
});


routerInventario.post("/agregar-subbodega", csrfProtection, async (req, res) => {
  try {
    const {
      idProducto,
      idBodega,
      stockReal,
      stock,
      stockReservado,
      coloresSeleccionados,
    } = req.body;

    console.log("Este recibe de id colores inventario", coloresSeleccionados)

   
    if (
      !idProducto ||
      !idBodega ||
      stockReal === undefined ||
      stock === undefined ||
      stockReservado === undefined ||
      !Array.isArray(coloresSeleccionados) ||
      coloresSeleccionados.length === 0
    ) {
      return res.status(400).json({
        success: false,
        message: "Faltan campos obligatorios o no se seleccionó ningún color.",
      });
    }

  
    await pool.query("START TRANSACTION");

    const estado = "activo";
    const notas = "Registro subbodega";
    const currentDateTime = moment()
      .tz("America/Mexico_City")
      .format("YYYY-MM-DD HH:mm:ss");

   
    for (const idProdColor of coloresSeleccionados) {
     
      const checkSql = `
        SELECT 1
        FROM tblinventario
        WHERE idBodega = ?
          AND idProductoColor = ?
        LIMIT 1
      `;
      const [existe] = await pool.query(checkSql, [idBodega, idProdColor]);

      console.log("Este recibe de existe", existe)
      if (existe.length > 0) {
        
        await pool.query("ROLLBACK");
        return res.status(400).json({
          success: false,
          message: `El color de ese producto ya existe en esa bodega.`,
        });
      }

      const insertSql = `
        INSERT INTO tblinventario
          (idProductoColor, idBodega, stockReal, stock, stockReservado, estado, notas, fechaRegistro)
        VALUES
          (?, ?, ?, ?, ?, ?, ?, ?)
      `;
      await pool.query(insertSql, [
        idProdColor,
        idBodega,
        stockReal,
        stock,
        stockReservado,
        estado,
        notas,
        currentDateTime,
      ]);
    }

 
    await pool.query("COMMIT");

    return res.json({
      success: true,
      message: "Producto(s) agregado(s) correctamente a la bodega secundaria.",
    });
  } catch (error) {
   
    await pool.query("ROLLBACK");
    console.error("Error al insertar producto(s) en subbodega:", error);
    return res.status(500).json({
      success: false,
      message: "Error al insertar producto(s) en subbodega.",
    });
  }
});
;
  

module.exports = routerInventario;
