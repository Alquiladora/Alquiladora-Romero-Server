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


const routerEmpresa = express.Router();
routerEmpresa.use(express.json());
routerEmpresa.use(cookieParser());

//=====================================================================
// Crear un endpoint para obtener los datos de la empresa
routerEmpresa.get("/", async (req, res) => {
  try {
   
    const [empresa] = await pool.query("SELECT * FROM tbldatosempresa");

    if (empresa.length === 0) {
      return res.status(404).json({ message: "Datos de la empresa no encontrados." });
    }

    res.status(200).json(empresa[0]);
  } catch (error) {
   
    console.error("Error al obtener los datos de la empresa:", error);

    
    if (error.code === 'ECONNRESET') {
      res.status(500).json({ message: "Error de conexión con la base de datos, por favor intente nuevamente más tarde." });
    } else {
      res.status(500).json({ message: "Error al obtener los datos de la empresa." });
    }
  }
});

  //=====================================================================
// Crear un endpoint para insertar o actualizar los datos de la empresa
routerEmpresa.post("/actualizar", csrfProtection, async (req, res) => {
    try {
      const { nombreEmpresa, logoUrl, slogan, telefono,correo, ubicacion, redesSociales } = req.body;
      const redesSocialesJSON = redesSociales ? JSON.stringify(redesSociales) : null;
    
     
      const fecha_hora = new Date().toLocaleString("sv-SE", { timeZone: "America/Mexico_City" });
    
      const [empresa] = await pool.query(
        "SELECT idEmpresa FROM tbldatosempresa ORDER BY idEmpresa LIMIT 1"
      );

      if (empresa.length === 0) {
        const queryInsert = `
         INSERT INTO tbldatosempresa (nombreEmpresa,ubicacion, correo, telefono,slogan, redesSociales, logoUrl, creadoEn, actualizadoEn)
          VALUES (?, ?, ?, ?, ?, ?,?, NOW(), NOW())
        `;
        await pool.query(queryInsert, [
          nombreEmpresa,
          ubicacion,
          correo,
          slogan,
          redesSocialesJSON,
          logoUrl,
          fecha_hora,
          fecha_hora
        ]);
        return res.status(201).json({ message: "Datos de la empresa insertados correctamente." });
      } else {

        const idExistente = empresa[0].idEmpresa;
        const queryUpdate = `
          UPDATE tbldatosempresa
          SET nombreEmpresa = ?,ubicacion =?, correo=?, telefono=?,slogan=?, redesSociales=?, logoUrl=?,  actualizadoEn=?
          WHERE idEmpresa = ?
        `;
        await pool.query(queryUpdate, [
          nombreEmpresa,
          ubicacion,
          correo,
          telefono,
          slogan,
          redesSocialesJSON,
          logoUrl,
          fecha_hora,
          idExistente
        ]);
        return res.status(200).json({ message: "Datos de la empresa actualizados correctamente." });
      }
    } catch (error) {
      console.error("Error al actualizar los datos de la empresa:", error);
      res.status(500).json({ message: "Error al actualizar los datos de la empresa." });
    }
  });
  
  
  //=====================================================================
  

  routerEmpresa.patch("/:campo", csrfProtection, async (req, res) => {
    const { campo } = req.params;
    const { valor } = req.body;

    const camposPermitidos = ['ubicacion', 'correo', 'telefono', 'slogan', 'logoUrlUrl', 'redesSociales'];
  
    if (!camposPermitidos.includes(campo)) {
      return res.status(400).json({ message: "Campo no permitido para actualización." });
    }
  
    try {
      let valorFinal = valor;
      if (campo === 'redesSociales') {
        valorFinal = typeof valor === 'object' ? JSON.stringify(valor) : valor;
      }
      const queryUpdate = `
        UPDATE tbldatosempresa 
        SET ${campo} = ?, actualizadoEn = NOW() 
        WHERE idEmpresa = 1
      `;
      await pool.query(queryUpdate, [valorFinal]);
      res.status(200).json({ message: `Campo ${campo} actualizado correctamente.` });
    } catch (error) {
      console.error(`Error al actualizar ${campo}:`, error);
      res.status(500).json({ message: `Error al actualizar ${campo}.` });
    }
  });
  
//=============================ENPOIT DE SPINER

 routerEmpresa.get("/logo", async (req, res) => {
  try {

    const [empresa] = await pool.query("SELECT logoUrl FROM tbldatosempresa LIMIT 1");
    if (empresa.length === 0) {
      return res.status(404).json({ message: "Datos de la empresa no encontrados." });
    }
    res.status(200).json(empresa[0]);
  } catch (error) {
    console.error("Error al obtener los datos de la empresa:", error);
    res.status(500).json({ message: "Error al obtener los datos de la empresa." });
  }
});


routerEmpresa.get("/redesociales", async (req, res) => {
  try {

    const [empresa] = await pool.query("SELECT redesSociales FROM tbldatosempresa  LIMIT 1");
    if (empresa.length === 0) {
      return res.status(404).json({ message: "Datos de la empresa no encontrados." });
    }
    res.status(200).json(empresa[0]);
  } catch (error) {
    console.error("Error al obtener las redes Sociales:", error);
    res.status(500).json({ message: "Error al obtener las redes Sociales." });
  }
});



routerEmpresa.get("/sobreNosotros", async (req, res) => {
  try {

    const [empresa] = await pool.query("SELECT *FROM tblsobrenosotros LIMIT 1");
    if (empresa.length === 0) {
      return res.status(404).json({ message: "Datos de la empresa no encontrados." });
    }
    res.status(200).json(empresa[0]);
  } catch (error) {
    console.error("Error al obtener los datos de la empresa:", error);
    res.status(500).json({ message: "Error al obtener los datos de la empresa." });
  }
});






module.exports=routerEmpresa;
