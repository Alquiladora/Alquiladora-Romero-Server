const express = require("express");
const axios = require("axios");
const dns = require("dns").promises;
const { pool } = require("../connectBd");
const produtosRouter = express.Router();
produtosRouter.use(express.json());
const { csrfProtection } = require("../config/csrf");
const Queue = require("bull");
const now = new Date();
const crypto = require("crypto");
const { Console } = require("console");
const moment = require("moment");

produtosRouter.get("/products", async (req, res) => {
  try {
    const [rows] = await pool.query(`
     SELECT 
    p.idProducto,
    p.nombre AS NombreProducto,
    p.detalles AS DetallesProducto,
    p.color AS ColorProducto,
    p.material AS MaterialProducto,
    p.fechaCreacion AS FechaCreacionProducto,

    s.idSubcategoria,
    s.nombre AS NombreSubCategoria,
    c.nombre AS NombreCategoria,

   
    pr.precioAdquirido,

    u.nombre AS NombreUsuario,
    u.correo AS EmailUsuario,

    b.idBodega,
    b.nombre AS nombreBodega,

   
    COALESCE(
      GROUP_CONCAT(DISTINCT f.urlFoto ORDER BY f.urlFoto SEPARATOR ','),
      ''
    ) AS ImagenesProducto

FROM tblproductos p
LEFT JOIN tblprecio pr
     
       ON p.idProducto = pr.idProducto

LEFT JOIN tblsubcategoria s 
       ON p.idSubcategoria = s.idSubcategoria

LEFT JOIN tblcategoria c 
       ON s.idCategoria = c.idCategoria

LEFT JOIN tblusuarios u 
       ON p.idUsuarios = u.idUsuarios

LEFT JOIN tblinventario i 
       ON p.idProducto = i.idProducto

LEFT JOIN tblbodegas b 
       ON i.idBodega = b.idBodega

LEFT JOIN tblfotosproductos f 
       ON p.idProducto = f.idProducto

GROUP BY p.idProducto
ORDER BY p.idProducto DESC;

      `);

    res.status(200).json({ success: true, products: rows });
  } catch (error) {
    console.error("Error al obtener productos:", error);
    res.status(500).json({
      success: false,
      message: "Error interno del servidor",
    });
  }
});

produtosRouter.get("/bodegas", async (req, res) => {
  try {
    const [rows] = await pool.query(`
         SELECT *FROM tblbodegas;
        `);

    res.status(200).json({ success: true, bodegas: rows });
  } catch (error) {
    console.error("Error al obtener las bodegas", error);
    res.status(500).json({
      success: false,
      message: "Error interno del servidor",
    });
  }
});

produtosRouter.get("/subcategorias", async (req, res) => {
  try {
    const [rows] = await pool.query(`
        SELECT
          c.idCategoria,
          c.nombre AS categoryName,
          sc.idSubcategoria,
          sc.nombre AS subcatName
        FROM tblcategoria c
        JOIN tblsubcategoria sc ON c.idCategoria = sc.idCategoria
        ORDER BY c.nombre, sc.nombre
      `);

    const categoryMap = {};
    rows.forEach((row) => {
      const { idCategoria, categoryName, idSubcategoria, subcatName } = row;

      if (!categoryMap[idCategoria]) {
        categoryMap[idCategoria] = {
          categoryName,
          subcats: [],
        };
      }

      categoryMap[idCategoria].subcats.push({
        id: idSubcategoria,
        label: subcatName,
      });
    });

    const grouped = Object.values(categoryMap);

    res.status(200).json({
      success: true,
      subcategories: grouped,
    });
  } catch (error) {
    console.error("Error al obtener subcategorias:", error);
    res.status(500).json({
      success: false,
      message: "Error interno del servidor",
    });
  }
});

//Consulta de subcategroias respecto ala categroia
produtosRouter.get("/subcategorias/:subcategoria", async (req, res) => {
    try {
      const { subcategoria } = req.params;
  
      const [rows] = await pool.query(
        `
          SELECT
              c.idCategoria,
              c.nombre AS categoryName,
              sc.idSubcategoria,
              sc.nombre AS subcatName
          FROM tblcategoria c
          JOIN tblsubcategoria sc 
              ON c.idCategoria = sc.idCategoria
          WHERE LOWER(c.nombre) = LOWER(?)
          ORDER BY sc.nombre;
        `,
        [subcategoria] 
      );
  
      const categoryMap = {};
      rows.forEach((row) => {
        const { idCategoria, categoryName, idSubcategoria, subcatName } = row;
  
        if (!categoryMap[idCategoria]) {
          categoryMap[idCategoria] = {
            categoryName,
            subcats: [],
          };
        }
  
        categoryMap[idCategoria].subcats.push({
          id: idSubcategoria,
          label: subcatName,
        });
      });
  
      const grouped = Object.values(categoryMap);
  
      res.status(200).json({
        success: true,
        subcategories: grouped,
      });
    } catch (error) {
      console.error("Error al obtener subcategorias:", error);
      res.status(500).json({
        success: false,
        message: "Error interno del servidor",
      });
    }
  });
  

  //Cosnul de lso productos detalles
  produtosRouter.get("/producto/:id", async (req, res) => {
    try {
      const { id } = req.params;
      const sql = `
        SELECT
    p.idProducto,
    p.nombre AS nombreProducto,
    p.detalles,
    p.idSubCategoria,
    p.color,
    p.material,
    sc.nombre AS nombreSubcategoria,
    c.idCategoria,
    c.nombre AS nombreCategoria,
    pr.precioAlquiler,
   
    COALESCE(SUM(i.stock), 0) AS stock,
    GROUP_CONCAT(DISTINCT f.urlFoto SEPARATOR ',') AS imagenes
FROM tblproductos p
JOIN tblsubcategoria sc 
    ON p.idSubCategoria = sc.idSubCategoria
JOIN tblcategoria c
    ON sc.idCategoria = c.idCategoria
LEFT JOIN tblprecio pr
    ON p.idProducto = pr.idProducto
LEFT JOIN tblfotosproductos f
    ON p.idProducto = f.idProducto

LEFT JOIN tblinventario i
    ON p.idProducto = i.idProducto
WHERE p.idProducto = ?
GROUP BY p.idProducto;
      `;
  
      const [rows] = await pool.query(sql, [id]);
      if (!rows || rows.length === 0) {
        return res.status(404).json({
          success: false,
          message: "Producto no encontrado"
        });
      }
      res.status(200).json({
        success: true,
        product: rows[0]
      });
    } catch (error) {
      console.error("Error al obtener el producto:", error);
      res.status(500).json({
        success: false,
        message: "Error interno del servidor"
      });
    }
  });




function capitalizeFirstLetter(str) {
  if (!str) return "";
  const cleanStr = str.trim();
  return cleanStr.charAt(0).toUpperCase() + cleanStr.slice(1).toLowerCase();
}

//Creamos productos
produtosRouter.post("/products", csrfProtection, async (req, res) => {
  try {
    let {
      nombre,
      detalles,
      idSubcategoria,
      foto,
      imagenes,
      color,
      material,
      idUsuarios,
      idBodega,
    } = req.body;

    console.log(
      "Campos recubidos",
      nombre,
      detalles,
      idSubcategoria,
      foto,
      imagenes,
      color,
      material,
      idUsuarios,
      idBodega
    );

    if (
      !nombre ||
      !detalles ||
      !idSubcategoria ||
      (!foto && (!imagenes || imagenes.length === 0)) ||
      !color ||
      !material ||
      !idUsuarios ||
      !idBodega
    ) {
      return res.status(400).json({
        success: false,
        message: "Todos los campos son requeridos.",
      });
    }

    nombre = capitalizeFirstLetter(nombre);
    detalles = capitalizeFirstLetter(detalles);
    color = capitalizeFirstLetter(color);
    material = capitalizeFirstLetter(material);

    const currentDateTime = moment()
      .tz("America/Mexico_City")
      .format("YYYY-MM-DD HH:mm:ss");

    const [result] = await pool.query(
      `CALL InsertarProducto(?, ?, ?, ?, ?, ?, ?, ?, ?, ?);`,
      [
        nombre,
        detalles,
        idSubcategoria,
        imagenes,
        color,
        material,
        currentDateTime,
        currentDateTime,
        idUsuarios,
        idBodega,
      ]
    );
    res.status(201).json({
      success: true,
      message: "Producto insertado correctamente",
      idProducto: result.insertId,
    });
  } catch (error) {
    console.error("Error al insertar producto:", error);
    res.status(500).json({
      success: false,
      message: "Error interno del servidor",
    });
  }
});

//actualziamo producto
produtosRouter.put("/products/:id", csrfProtection, async (req, res) => {
  try {
    const { id } = req.params;
    let {
      nombre,
      detalles,
      idSubcategoria,
      color,
      material,
      idUsuarios,
      idBodega,
      imagenes,
      imagenesEliminar,
    } = req.body;

    console.log(
      "Dats recibidos de productos",
      nombre,
      detalles,
      idSubcategoria,
      color,
      material,
      idUsuarios,
      idBodega,
      imagenes,
      imagenesEliminar
    );

    const currentDateTime = moment()
      .tz("America/Mexico_City")
      .format("YYYY-MM-DD HH:mm:ss");

    if (Array.isArray(imagenes)) {
      imagenes = imagenes.join(",");
    }

    await pool.query(`CALL ActualizarProducto(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
      id,
      nombre,
      detalles,
      idSubcategoria,
      color,
      material,
      idUsuarios,
      idBodega,
      null,
      currentDateTime,
    ]);

    if (imagenesEliminar && imagenesEliminar.length > 0) {
      await pool.query("DELETE FROM tblfotosproductos WHERE idFoto IN (?)", [
        imagenesEliminar,
      ]);
    }

    const [[{ total: totalActual }]] = await pool.query(
      "SELECT COUNT(*) as total FROM tblfotosproductos WHERE idProducto = ?",
      [id]
    );

    console.log("rESULTADO totak de iamgenes ECTULIZAR", totalActual);

    if (imagenes && imagenes.split(",").filter(Boolean).length > 0) {
      const imagenesArray = imagenes.split(",").filter(Boolean);

      if (totalActual + imagenesArray.length > 6) {
        return res.status(400).json({
          success: false,
          message: "No puedes superar las 6 imágenes permitidas.",
        });
      }

      // Obtener imágenes ya existentes en la base de datos
      const [imagenesExistentes] = await pool.query(
        "SELECT urlFoto FROM tblfotosproductos WHERE idProducto = ?",
        [id]
      );

      const urlsExistentes = imagenesExistentes.map((row) => row.urlFoto);

      // Filtrar solo las imágenes nuevas que no están en la BD
      const nuevasImagenes = imagenesArray.filter(
        (url) => !urlsExistentes.includes(url)
      );

      console.log("Imágenes nuevas a insertar:", nuevasImagenes);

      if (nuevasImagenes.length > 0) {
        const insertPromises = nuevasImagenes.map((url) =>
          pool.query(
            "INSERT INTO tblfotosproductos (idProducto, urlFoto, fechaCreacion) VALUES (?, ?, ?)",
            [id, url, currentDateTime]
          )
        );
        await Promise.all(insertPromises);
      }
    }

    res.status(200).json({
      success: true,
      message: "Producto actualizado correctamente.",
    });

    console.log("Producto actualizado correctamente.");
  } catch (error) {
    console.error("Error al actualizar producto:", error);
    res.status(500).json({
      success: false,
      message: "Error interno del servidor.",
    });
  }
});

produtosRouter.delete(
  "/products/delete/:id",
  csrfProtection,
  async (req, res) => {
    try {
      const { id } = req.params;

      const [result] = await pool.query(`CALL DeleteProductos (?);`, [id]);
      res.status(201).json({
        success: true,
        message: "Producto eliminado correcatamente",
        idProducto: result.insertId,
      });
    } catch (error) {
      console.error("Error al eliminar producto:", error);
      res.status(500).json({
        success: false,
        message: "Error interno del servidor",
      });
    }
  }
);

//Consulya de los productos pro categroiua
produtosRouter.get("/categoria/:nombreCategoria", async (req, res) => {
  const { nombreCategoria } = req.params;
  console.log("Parametro recibido", nombreCategoria);

  try {
    const sql = `
    SELECT 
    p.idProducto,
    p.nombre AS nombreProducto,
    p.detalles,
    p.idSubCategoria,
    p.color,
    p.material,
    sc.idSubCategoria AS subCategoriaID,
    sc.nombre AS nombreSubcategoria,
    c.idCategoria AS categoriaID,
    c.nombre AS nombreCategoria,
    pr.precioAlquiler, 
    SUM(i.stock) AS stock,
    GROUP_CONCAT(DISTINCT f.urlFoto) AS imagenes
FROM tblproductos p
JOIN tblsubcategoria sc 
  ON p.idSubCategoria = sc.idSubCategoria
JOIN tblcategoria c 
  ON sc.idCategoria = c.idCategoria
LEFT JOIN tblprecio pr
  ON p.idProducto = pr.idProducto
LEFT JOIN tblinventario i
  ON p.idProducto = i.idProducto
LEFT JOIN tblfotosproductos f
  ON p.idProducto = f.idProducto
WHERE LOWER(c.nombre) = LOWER(?)
GROUP BY p.idProducto;
      `;

    const [rows] = await pool.query(sql, [nombreCategoria]);
    console.log("Resultados de los productos: ", rows);

    return res.json({
      success: true,
      products: rows,
    });
  } catch (error) {
    console.error("Error al obtener productos por nombre de categoría:", error);
    return res.status(500).json({
      success: false,
      message: "Error al obtener productos de la categoría",
    });
  }
});


//Enpoit de productos relacionados 

produtosRouter.get("/productosRelacionado/:idSubCategoria", async (req, res) => {
    const { idSubCategoria } = req.params;
    try {
      const sql = `
        SELECT 
    p.idProducto,
    p.nombre,
    p.detalles,
    p.idSubCategoria,
    p.color,
    p.material,
    p.fechaCreacion,
    p.fechaActualizacion,
    sc.nombre AS nombreSubcategoria,
   
    GROUP_CONCAT(DISTINCT f.urlFoto SEPARATOR ',') AS imagenes
FROM tblproductos p
JOIN tblsubcategoria sc 
    ON p.idSubCategoria = sc.idSubCategoria
-- Incluye las fotos
LEFT JOIN tblfotosproductos f
    ON p.idProducto = f.idProducto
WHERE sc.idSubCategoria = ?
GROUP BY p.idProducto;
      `;
     
      const [rows] = await pool.query(sql, [idSubCategoria]);
  
      if (rows.length === 0) {
        return res.status(404).json({
          success: false,
          message: "No se encontraron productos para esta subcategoría",
        });
      }
  
      res.json({
        success: true,
        products: rows,
      });
    } catch (error) {
      console.error("Error al obtener productos por subcategoría:", error);
      res.status(500).json({
        success: false,
        message: "Error interno del servidor",
      });
    }
  });

module.exports = produtosRouter;

