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
    p.nombre               AS NombreProducto,
    p.detalles             AS DetallesProducto,
    p.material             AS MaterialProducto,
    p.fechaCreacion        AS FechaCreacionProducto,
    s.idSubcategoria,
    s.nombre               AS NombreSubCategoria,
    c.nombre               AS NombreCategoria,
    pr.precioAdquirido,
    u.nombre               AS NombreUsuario,
    u.correo               AS EmailUsuario,
    GROUP_CONCAT(DISTINCT col.color ORDER BY col.color SEPARATOR ', ') AS ColorProducto,
    COALESCE(
        GROUP_CONCAT(DISTINCT b.nombre ORDER BY b.nombre SEPARATOR ', '),
        ''
    ) AS BodegasProducto,
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
LEFT JOIN tblproductoscolores pc 
       ON p.idProducto = pc.idProducto

LEFT JOIN tblcolores col 
       ON pc.idColor = col.idColores

LEFT JOIN tblinventario i 
       ON pc.idProductoColores = i.idProductoColor

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

//Colores
produtosRouter.get("/colores", async (req, res) => {
  try {
    const [rows] = await pool.query(`
SELECT *FROM tblcolores;
        `);

    res.status(200).json({ success: true, colores: rows });
  } catch (error) {
    console.error("Error al obtener los colores", error);
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
          p.nombre            AS nombreProducto,
          p.detalles,
          p.idSubCategoria,
          p.material,
          sc.nombre           AS nombreSubcategoria,
          c.idCategoria,
          c.nombre           AS nombreCategoria,
          pr.precioAlquiler,
          COALESCE(SUM(i.stock), 0) AS stock,
          GROUP_CONCAT(DISTINCT col.color ORDER BY col.color SEPARATOR ', ') AS colores,
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
          ON p.idProducto = i.idProductoColor
      LEFT JOIN tblproductoscolores pc
          ON p.idProducto = pc.idProducto
      LEFT JOIN tblcolores col
          ON pc.idColor = col.idColores
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
    } = req.body;

   

    if (
      !nombre ||
      !detalles ||
      !idSubcategoria ||
      (!foto && (!imagenes || imagenes.length === 0)) ||
      !color ||
      !material ||
      !idUsuarios
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

    
    const [existingProducts] = await pool.query(
      `SELECT COUNT(*) as count FROM tblproductos 
       WHERE nombre = ? AND idSubcategoria = ?`,
      [nombre, idSubcategoria]
    );

    if (existingProducts[0].count > 0) {
    
      return res.status(400).json(
       {
        success: false,
        message: "Este producto ya está registrado en la misma categoría.",
      });
     
    }


    const currentDateTime = moment()
      .tz("America/Mexico_City")
      .format("YYYY-MM-DD HH:mm:ss");

    const [result] = await pool.query(
      `CALL InsertarProducto(?, ?, ?, ?, ?, ?, ?, ?, ?);`,
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
    console.log("Iamgenes" ,imagenes)
    console.log("Iamgenes eliminados" ,imagenesEliminar)

    

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
      await pool.query("DELETE FROM tblfotosproductos WHERE urlFoto IN (?)", [
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


  //===============================================COMPONENTES CATEGOSIAS -SUBCATEGORIAS ===================================================================
  produtosRouter.get("/categorias", async (req, res) => {
    try {
      const [rows] = await pool.query("SELECT  idcategoria AS id , nombre, fechaCreacion FROM tblcategoria;");
      res.status(200).json({
        success: true,
        categorias: rows,
      });
    } catch (error) {
      console.error("Error al obtener categorías:", error);
      res.status(500).json({
        success: false,
        message: "Error interno del servidor",
      });
    }
  });


  //CRear 
  // Endpoint para crear una nueva categoría
produtosRouter.post("/categoria", csrfProtection, async (req, res) => {
  try {
    let { nombre } = req.body;
    
    if (!nombre || !nombre.trim() || nombre.trim().length < 3) {
      return res.status(400).json({
        success: false,
        message: "El nombre de la categoría es requerido y debe tener al menos 3 caracteres."
      });
    }

    // Capitalizar el primer carácter (opcional)
    nombre = nombre.trim();
    nombre = nombre.charAt(0).toUpperCase() + nombre.slice(1).toLowerCase();

    const [existing] = await pool.query(
      "SELECT COUNT(*) as count FROM tblcategoria WHERE LOWER(nombre) = ?",
      [nombre.toLowerCase()]
    );
    if (existing[0].count > 0) {
      return res.status(400).json({
        success: false,
        message: "La categoría ya está registrada. Por favor, ingresa un nombre diferente."
      });
    }

    const currentDateTime = moment()
      .tz("America/Mexico_City")
      .format("YYYY-MM-DD HH:mm:ss");

    // Inserción en la tabla
    const [result] = await pool.query(
      "INSERT INTO tblcategoria (nombre, fechaCreacion) VALUES (?, ?)",
      [nombre, currentDateTime]
    );

    res.status(201).json({
      success: true,
      message: "Categoría creada correctamente.",
      idCategoria: result.insertId
    });
  } catch (error) {
    console.error("Error al crear categoría:", error);
    res.status(500).json({
      success: false,
      message: "Error interno del servidor."
    });
  }
});


// Endpoint para crear una nueva subcategoría
produtosRouter.post("/subcategoria", csrfProtection, async (req, res) => {
  try {
    let { idCategoria, nombre } = req.body;

    if (!idCategoria || !nombre || !nombre.trim()) {
      return res.status(400).json({
        success: false,
        message:
          "El id de la categoría y el nombre de la subcategoría son requeridos.",
      });
    }
    console.log("Id de categoria", idCategoria);
    nombre = nombre.trim();
    if (nombre.length < 3) {
      return res.status(400).json({
        success: false,
        message:
          "El nombre de la subcategoría debe tener al menos 3 caracteres.",
      });
    }
    const normalizedNombre =
      nombre.charAt(0).toUpperCase() + nombre.slice(1).toLowerCase();

    const [existing] = await pool.query(
      "SELECT COUNT(*) as count FROM tblsubcategoria WHERE idCategoria = ? AND LOWER(nombre) = ?",
      [idCategoria, normalizedNombre.toLowerCase()]
    );
    if (existing[0].count > 0) {
      return res.status(400).json({
        success: false,
        message:
          "La subcategoría ya está registrada en esta categoría. Por favor, ingresa un nombre diferente.",
      });
    }

    const currentDateTime = moment()
      .tz("America/Mexico_City")
      .format("YYYY-MM-DD HH:mm:ss");

    // Inserción en la tabla tblsubcategoria
    const [result] = await pool.query(
      "INSERT INTO tblsubcategoria (idCategoria, nombre, fechaCreacion) VALUES (?, ?, ?)",
      [idCategoria, normalizedNombre, currentDateTime]
    );

    res.status(201).json({
      success: true,
      message: "Subcategoría creada correctamente.",
      idSubcategoria: result.insertId,
    });
  } catch (error) {
    console.error("Error al crear subcategoría:", error);
    res.status(500).json({
      success: false,
      message: "Error interno del servidor.",
    });
  }
});

//ACtualizacion 
produtosRouter.put("/categoria/:id", csrfProtection, async (req, res) => {
  try {
    const { id } = req.params;
    let { nombre } = req.body; 
    console.log("Datsos recibidos de categroias", id, nombre)

    if (!nombre || !nombre.trim() || nombre.trim().length < 3) {
      return res.status(400).json({
        success: false,
        message: "El nombre es requerido y debe tener al menos 3 caracteres."
      });
    }

    nombre = nombre.trim();
    const normalizedNombre = nombre.charAt(0).toUpperCase() + nombre.slice(1).toLowerCase();
    const [existing] = await pool.query(
      "SELECT COUNT(*) AS count FROM tblcategoria WHERE LOWER(nombre) = ? AND idcategoria <> ?",
      [normalizedNombre.toLowerCase(), id]
    );
    if (existing[0].count > 0) {
      return res.status(400).json({
        success: false,
        message: "La categoría ya está registrada. Por favor, ingresa un nombre diferente."
      });
    }
    const [result] = await pool.query(
      "UPDATE tblcategoria SET nombre = ? WHERE idcategoria = ?",
      [normalizedNombre, id]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ success: false, message: "Categoría no encontrada" });
    }

    res.status(200).json({ success: true, message: "Categoría actualizada correctamente" });
  } catch (error) {
    console.error("Error al actualizar categoría:", error);
    res.status(500).json({ success: false, message: "Error interno del servidor" });
  }
});


produtosRouter.put("/subcategoria/:id", async (req, res) => {
  try {
    const { id } = req.params;
    let { nombre, idCategoria } = req.body;
    console.log("Datos recibidos de subcategorias actualizar", id, nombre, idCategoria)
   
    if (!nombre || !nombre.trim() || nombre.trim().length < 3 || !idCategoria) {
      return res.status(400).json({
        success: false,
        message: "El nombre (mínimo 3 caracteres) y el id de la categoría son requeridos."
      });
    }
  
    nombre = nombre.trim();
    const normalizedNombre = nombre.charAt(0).toUpperCase() + nombre.slice(1).toLowerCase();
    const [existing] = await pool.query(
      "SELECT COUNT(*) AS count FROM tblsubcategoria WHERE LOWER(nombre) = ? AND idCategoria = ? AND idSubCategoria <> ?",
      [normalizedNombre.toLowerCase(), idCategoria, id]
    );
    if (existing[0].count > 0) {
      return res.status(400).json({
        success: false,
        message: "La subcategoría ya está registrada en esta categoría. Por favor, ingresa un nombre diferente."
      });
    }
  
    const [result] = await pool.query(
      "UPDATE tblsubcategoria SET nombre = ?, idCategoria = ? WHERE idSubCategoria = ?",
      [normalizedNombre, idCategoria, id]
    );
    
    if (result.affectedRows === 0) {
      return res.status(404).json({
        success: false,
        message: "Subcategoría no encontrada"
      });
    }
    
    res.status(200).json({
      success: true,
      message: "Subcategoría actualizada correctamente"
    });
  } catch (error) {
    console.error("Error al actualizar subcategoría:", error);
    res.status(500).json({
      success: false,
      message: "Error interno del servidor"
    });
  }
});



//Elimina
produtosRouter.delete("/categoria/:id", async (req, res) => {
  try {
    const { id } = req.params;

    const [result] = await pool.query(
      "DELETE FROM tblcategoria WHERE idcategoria = ?",
      [id]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ success: false, message: "Categoría no encontrada" });
    }

    res.status(200).json({ success: true, message: "Categoría eliminada correctamente" });
  } catch (error) {
    console.error("Error al eliminar categoría:", error);
    res.status(500).json({ success: false, message: "Error interno del servidor" });
  }
});


produtosRouter.delete("/subcategoria/:id", async (req, res) => {
  try {
    const { id } = req.params;

    const [result] = await pool.query(
      "DELETE FROM tblsubcategoria WHERE idSubCategoria = ?",
      [id]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ success: false, message: "Subcategoría no encontrada" });
    }

    res.status(200).json({ success: true, message: "Subcategoría eliminada correctamente" });
  } catch (error) {
    console.error("Error al eliminar subcategoría:", error);
    res.status(500).json({ success: false, message: "Error interno del servidor" });
  }
});




produtosRouter.get("/pedidos-manual", csrfProtection, async (req, res) => {
  try {
    const [rows] = await pool.query(
      `
         SELECT
    p.idProducto,
    p.nombre,
    p.detalles,
    col.color AS color,         
    p.material,
    sub.idSubCategoria,
    sub.nombre AS nombreSubcategoria,
    categ.idcategoria,
    categ.nombre AS nombreCategoria,
    pre.idPrecio,
    pre.precioAlquiler,
    bod.idBodega,
    bod.nombre AS nombreBodega,
    bod.es_principal,
    bod.ubicacion,
    inv.idInventario,
    inv.stock,
    inv.stockReservado,
    inv.estado
FROM tblinventario inv
 
  LEFT JOIN tblproductoscolores pc 
    ON inv.idProductoColor = pc.idProductoColores

  
  LEFT JOIN tblproductos p 
    ON pc.idProducto = p.idProducto

  LEFT JOIN tblcolores col
    ON pc.idColor = col.idColores

  LEFT JOIN tblsubcategoria sub 
    ON p.idSubcategoria = sub.idSubCategoria

  LEFT JOIN tblcategoria categ
    ON sub.idCategoria = categ.idcategoria

  LEFT JOIN tblprecio pre
    ON p.idProducto = pre.idProducto

  LEFT JOIN tblbodegas bod
    ON inv.idBodega = bod.idBodega;

      `
    );
    res.json(rows);
  } catch (error) {
    console.error("Error en endpoint de inventario", error);
    res.status(500).json({ error: "Error al obtener los datos del inventario" });
  }
});


module.exports = produtosRouter;

