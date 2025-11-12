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
const dayjs = require('dayjs');
const utc   = require('dayjs/plugin/utc');
const tz    = require('dayjs/plugin/timezone');
const timezone = require('dayjs/plugin/timezone');


dayjs.extend(utc);
dayjs.extend(tz);



produtosRouter.get("/products", async (req, res) => {
  try {

     const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const offset = (page - 1) * limit;

    const search = req.query.search ? `%${req.query.search.toLowerCase()}%` : null;
    const category = req.query.category || null;

    // Build WHERE clause
    let whereClause = '';
    const params = [];
    
    if (search || category) {
      whereClause = 'WHERE ';
      if (search) {
        whereClause += 'LOWER(p.nombre) LIKE ? ';
        params.push(search);
        if (category) whereClause += 'AND ';
      }
      if (category) {
        whereClause += 'c.nombre = ? ';
        params.push(category);
      }
    }

   

      const [countResult] = await pool.query(`
      SELECT COUNT(*) as total
      FROM tblproductos p
      LEFT JOIN tblsubcategoria s ON p.idSubcategoria = s.idSubcategoria
      LEFT JOIN tblcategoria c ON s.idCategoria = c.idCategoria
      ${whereClause}
    `, params);
    const totalRecords = countResult[0].total;
    const totalPages = Math.ceil(totalRecords / limit);

    const queryParams = [...params, limit, offset];
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
${whereClause}
GROUP BY p.idProducto
ORDER BY p.idProducto DESC
LIMIT ? OFFSET ?
      `, queryParams);

    res.status(200).json({
      success: true,
      products: rows,
      pagination: {
        currentPage: page,
        totalPages: totalPages,
        totalRecords: totalRecords,
        limit: limit
      }
    });
  } catch (error) {
    console.error("Error al obtener productos:", error);
    res.status(500).json({
      success: false,
      message: "Error interno del servidor",
      error: error.message
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
    const connection = await pool.getConnection(); 
    const [rows] = await connection.query(`
      SELECT
        c.idCategoria,
        c.nombre AS categoryName,
        sc.idSubcategoria,
        sc.nombre AS subcatName
      FROM tblcategoria c
      JOIN tblsubcategoria sc ON c.idCategoria = sc.idCategoria
      ORDER BY c.nombre, sc.nombre
    `);
    connection.release(); 

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

    if (error.code === "ECONNRESET") {
      return res.status(500).json({
        success: false,
        message:
          "Se perdió la conexión con la base de datos. Inténtalo de nuevo.",
      });
    }

    res.status(500).json({
      success: false,
      message: "Error interno del servidor.",
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
          p.fechaCreacion,
          p.idSubCategoria,
          p.material,
          sc.nombre AS nombreSubcategoria,
          c.idCategoria,
          c.nombre AS nombreCategoria,
          pr.precioAlquiler,
          
          pc.idProductoColores AS idProductoColor,
          COALESCE(sub_inv.stock_total, 0) AS stock,
          col.color AS nombreColor,
          col.codigoH,
          (
          SELECT GROUP_CONCAT(f.urlFoto SEPARATOR ',')
          FROM tblfotosproductos f
          WHERE f.idProducto = p.idProducto
          )AS imagenes
        
          
        FROM tblproductos p
        
        JOIN tblsubcategoria sc 
          ON p.idSubCategoria = sc.idSubCategoria
        JOIN tblcategoria c 
          ON sc.idCategoria = c.idCategoria
        LEFT JOIN tblprecio pr 
          ON p.idProducto = pr.idProducto
          
        LEFT JOIN tblproductoscolores pc 
          ON p.idProducto = pc.idProducto
        LEFT JOIN tblcolores col 
          ON pc.idColor = col.idColores
          
        LEFT JOIN (
    SELECT 
        i.idProductoColor, 
        SUM(i.stock) AS stock_total 
    FROM tblinventario i
    GROUP BY i.idProductoColor
) AS sub_inv 
    ON pc.idProductoColores = sub_inv.idProductoColor
        WHERE p.idProducto = ?
       GROUP BY 
    p.idProducto, 
    pc.idProductoColores, 
    pr.precioAlquiler, 
    col.idColores, 
    sub_inv.stock_total;
      `;

      const [rows] = await pool.query(sql, [id]);
      if (!rows || rows.length === 0) {
        return res.status(404).json({
          success: false,
          message: "Producto no encontrado"
        });
      }
      
    
      const product = {
        idProducto: rows[0].idProducto,
        nombreProducto: rows[0].nombreProducto,
        fechaCreacion: rows[0].fechaCreacion,
        detalles: rows[0].detalles,
        idSubCategoria: rows[0].idSubCategoria,
        material: rows[0].material,
        nombreSubcategoria: rows[0].nombreSubcategoria,
        idCategoria: rows[0].idCategoria,
        nombreCategoria: rows[0].nombreCategoria,
        precioAlquiler: rows[0].precioAlquiler,
        
        imagenes: rows[0].imagenes,
        variantes: rows.map(row => ({
          nombreColor: row.nombreColor,
          colorH: row.codigoH,
          stock: row.stock,
          idProductoColor: row.idProductoColor,
        }))
      };
      
      res.status(200).json({
        success: true,
        product
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
    console.log("Datos de usuario", idUsuarios)

   

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

produtosRouter.delete("/products/delete/:id", csrfProtection, async (req, res) => {
  try {
    const { id } = req.params;
    await pool.query("CALL DeleteProductos(?)", [id]);

    return res.status(200).json({
      success: true,
      message: "Producto eliminado correctamente",
    });
  } catch (error) {
    console.error("Error al eliminar producto:", error);
    if (error.code === "ER_ROW_IS_REFERENCED_2") {
      return res.status(400).json({
        success: false,
        message:
          "No se puede eliminar el producto porque está asociado a otros registros (pedidos, carrito, etc.).",
      });
    }
    return res.status(500).json({
      success: false,
      message: "Error interno del servidor",
    });
  }
});



//Consulya de los productos pro categroiua
produtosRouter.get("/categoria/:nombreCategoria", async (req, res) => {
  const { nombreCategoria } = req.params;
  console.log("Parametro recibido", nombreCategoria);
  try {
    const sql = `
     SELECT
    p.idProducto,
    p.nombre AS nombreProducto,
    p.fechaCreacion,
    p.detalles,
    sc.idSubCategoria,
    sc.nombre AS nombreSubcategoria,
    c.idCategoria,
    c.nombre AS nombreCategoria,
    pr.precioAlquiler,
    pc.idProductoColores AS idProductoColor, 
    col.color AS nombreColor,
    COALESCE(sub_inv.stock_total, 0) AS stock, 
    sub_inv.estado_producto AS estadoProducto, 
    (
        SELECT GROUP_CONCAT(DISTINCT f.urlFoto SEPARATOR ',')
        FROM tblfotosproductos f
        WHERE f.idProducto = p.idProducto
    ) AS imagenes

FROM tblproductos p
JOIN tblsubcategoria sc
    ON p.idSubCategoria = sc.idSubCategoria
JOIN tblcategoria c
    ON sc.idCategoria = c.idCategoria
LEFT JOIN tblprecio pr
    ON p.idProducto = pr.idProducto
    
LEFT JOIN tblproductoscolores pc
    ON p.idProducto = pc.idProducto
LEFT JOIN tblcolores col
    ON pc.idColor = col.idColores
LEFT JOIN (
    SELECT
        i.idProductoColor,
        SUM(i.stock) AS stock_total,
        MAX(i.estado) AS estado_producto 
    FROM tblinventario i
    GROUP BY i.idProductoColor
) AS sub_inv
    ON pc.idProductoColores = sub_inv.idProductoColor

WHERE LOWER(c.nombre) = LOWER(?)

GROUP BY 
    p.idProducto,
    pc.idProductoColores,
    pr.precioAlquiler,
    col.idColores,
    sub_inv.stock_total,
    sub_inv.estado_producto; 
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
    p.nombre AS nombreProducto,
    p.fechaCreacion,
    p.detalles,
    sc.idSubCategoria,
    sc.nombre AS nombreSubcategoria,
    pr.precioAlquiler,
    col.color AS nombreColor,
    SUM(i.stock) AS stock,
    i.estado AS estadoProducto,
    GROUP_CONCAT(DISTINCT f.urlFoto SEPARATOR ',') AS imagenes
  FROM tblproductos p
  JOIN tblsubcategoria sc 
    ON p.idSubCategoria = sc.idSubCategoria
  LEFT JOIN tblprecio pr
    ON p.idProducto = pr.idProducto
  LEFT JOIN tblproductoscolores pc 
    ON p.idProducto = pc.idProducto
  LEFT JOIN tblcolores col 
    ON pc.idColor = col.idColores
  LEFT JOIN tblinventario i 
    ON pc.idProductoColores = i.idProductoColor
  LEFT JOIN tblfotosproductos f
    ON p.idProducto = f.idProducto
  WHERE sc.idSubCategoria =  ?
  GROUP BY p.idProducto, col.idColores;
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



//Seleccionar categorias en la parte publica
produtosRouter.get("/categrias/disponibles", async (req, res) => {
  try {
    const [rows] = await pool.query(`
         SELECT
  c.idCategoria,
  c.nombre AS nombreCategoria,
  (
    SELECT f.urlFoto
    FROM tblfotosproductos AS f
    JOIN tblproductos AS p2 ON p2.idProducto = f.idProducto
    JOIN tblsubcategoria AS sc2 ON sc2.idSubCategoria = p2.idSubCategoria
    WHERE sc2.idCategoria = c.idCategoria
    ORDER BY RAND()
    LIMIT 1
  ) AS fotoAleatoria
FROM tblcategoria AS c
WHERE EXISTS (
  SELECT 1
  FROM tblsubcategoria AS sc
  JOIN tblproductos AS p ON p.idSubCategoria = sc.idSubCategoria
  WHERE sc.idCategoria = c.idCategoria
);
        `);

    res.status(200).json({ success: true, categorias: rows });
  } catch (error) {
    console.error("Error al obtener las categorias", error);
    res.status(500).json({
      success: false,
      message: "Error interno del servidor",
    });
  }
});


produtosRouter.get("/pedidos-manual", csrfProtection, async (req, res) => {
   let connection;
  try {
   connection = await pool.getConnection(); 
    const [rows] = await connection.query(
      `
        SELECT
    p.idProducto,
    p.nombre,
    p.detalles,
     pc.idProductoColores, 
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
  
   } finally {
    if (connection) connection.release(); // <-- liberar siempre la conexión
  }
});




produtosRouter.get('/hoy', async (req, res) => {
  try {
    // --- 1) Calcula, en tu zona local, los límites de hoy y mañana ---
    const ahoraLocal     = dayjs().tz('America/Mexico_City');
    const inicioHoyLocal = ahoraLocal.startOf('day');         // 2025-06-17 00:00 (GMT-6)
    const inicioMananaLocal = inicioHoyLocal.add(1, 'day');   // 2025-06-18 00:00 (GMT-6)

    // Convierte esos instantes a UTC para pasarlos a MySQL
    const desdeUtc = inicioHoyLocal.utc().format('YYYY-MM-DD HH:mm:ss');
    const ahoraUtc = ahoraLocal.utc().format('YYYY-MM-DD HH:mm:ss');
    const hastaUtc = inicioMananaLocal.utc().format('YYYY-MM-DD HH:mm:ss');

    console.log('Parámetros UTC:', { desdeUtc, ahoraUtc, hastaUtc });

    // --- 2) Consulta única que engloba:
    //     - Pedidos hoy con horaAlquiler > ahoraLocal
    //     - Pedidos mañana (cualquier hora)
    const sql = `
      SELECT
        p.idRastreo,
        p.fechaInicio,
        p.horaAlquiler,
        p.estadoActual AS estado,
        p.totalPagar,
        d.cantidad,
        d.precioUnitario,
        pr.nombre      AS nombreProducto,
        fp.urlFoto     AS foto
      FROM tblpedidos AS p
      JOIN tblpedidodetalles   AS d  ON d.idPedido           = p.idPedido
      JOIN tblproductoscolores AS pc ON pc.idProductoColores = d.idProductoColores
      JOIN tblproductos        AS pr ON pr.idProducto        = pc.idProducto
      LEFT JOIN (
        SELECT idProducto, MIN(urlFoto) AS urlFoto
        FROM tblfotosproductos
        GROUP BY idProducto
      ) AS fp ON fp.idProducto = pr.idProducto
      WHERE LOWER(p.estadoActual) IN (
        'procesando', 'confirmado', 'enviando', 'en alquiler', 'cancelado'
      )
      AND (
        -- Sub-consulta para Hoy (UTC):
        (p.fechaInicio >= ? AND p.fechaInicio < ? AND p.horaAlquiler > TIME(?))
        -- Sub-consulta para Mañana (UTC):
        OR
        (p.fechaInicio >= ? AND p.fechaInicio < ?)
      )
      ORDER BY p.idPedido DESC;
    `;

    const params = [
      // Hoy: [desdeUtc, ahoraUtc, ahoraLocal.format('HH:mm:ss')]
      desdeUtc,     // p.fechaInicio >= inicioHoyLocal UTC
      ahoraUtc,     // p.fechaInicio <   ahoraLocal UTC
      ahoraLocal.format('HH:mm:ss'),

      // Mañana: [hastaUtc, nextDayUtc]
      ahoraUtc,     // reusamos para p.fechaInicio >= ahoraUtc (equivale a inicioMananaLocal UTC también)
      hastaUtc      // p.fechaInicio <  inicioMananaLocal UTC
    ];

    const [rows] = await pool.query(sql, params);
    console.log('Filas obtenidas tras SQL:', rows.length);

    // --- 3) Agrupa por idRastreo ---
    const mapPedidos = new Map();
    rows.forEach(r => {
      if (!mapPedidos.has(r.idRastreo)) {
        mapPedidos.set(r.idRastreo, {
          idRastreo:    r.idRastreo,
          fechaInicio:  r.fechaInicio,
          horaAlquiler: r.horaAlquiler,
          estado:       r.estado,
          totalPagar:   r.totalPagar,
          productos:    []
        });
      }
      mapPedidos.get(r.idRastreo).productos.push({
        nombreProducto: r.nombreProducto,
        foto:           r.foto,
        cantidad:       r.cantidad,
        precioUnitario: r.precioUnitario
      });
    });

    // --- 4) Responde ---
    res.json({
      success: true,
      rangeLocal: {
        today:    inicioHoyLocal.format(),
        tomorrow: inicioMananaLocal.format()
      },
      pedidos: [...mapPedidos.values()]
    });

  } catch (error) {
    console.error('Error al obtener pedidos:', error);
    res.status(500).json({
      success: false,
      message: 'Error interno del servidor'
    });
  }
});

module.exports = produtosRouter;

