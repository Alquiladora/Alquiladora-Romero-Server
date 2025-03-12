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

const routerDireccion = express.Router();
routerDireccion.use(express.json());
routerDireccion.use(cookieParser());


routerDireccion.get("/listar", csrfProtection, async (req, res) => {
    try {
      const { idUsuarios } = req.query;
  
      if (!idUsuarios) {
        return res.status(400).json({
          message: "El idUsuario es obligatorio para listar direcciones."
        });
      }
      const [rows] = await pool.query(
        "SELECT * FROM tbldireccioncliente WHERE idUsuario = ?",
        [idUsuarios]
      );

      return res.status(200).json(rows);
    } catch (error) {
      console.error("Error al listar direcciones:", error);
      return res.status(500).json({
        message: "Error interno al listar las direcciones."
      });
    }
  });
  
  function capitalize(str) {
    if (!str) return "";
    return str.charAt(0).toUpperCase() + str.slice(1).toLowerCase();
  }
  
  routerDireccion.post("/crear", csrfProtection, async (req, res) => {
    try {
      const {
        idUsuario,
        nombre,
        apellido,
        telefono,
        codigoPostal,
        pais,
        estado,
        municipio,
        localidad,
        direccion,
        referencias,
        predeterminado,
      } = req.body;
  
     
      if (!idUsuario) {
        return res.status(400).json({ message: "El idUsuario es obligatorio." });
      }
      if (
        !nombre ||
        !apellido ||
        !telefono ||
        !codigoPostal ||
        !pais ||
        !estado ||
        !municipio ||
        !localidad ||
        !direccion
      ) {
        return res.status(400).json({
          message:
            "Faltan campos obligatorios: nombre, apellido, teléfono, códigoPostal, pais, estado, municipio, localidad, direccion.",
        });
      }
  
      // Validar teléfono (10 dígitos)
      const telefonoString = String(telefono).trim();
      if (!/^\d{10}$/.test(telefonoString)) {
        return res.status(400).json({
          message: "El teléfono debe contener exactamente 10 dígitos numéricos.",
        });
      }
  
      // Capitalizar campos
      const nombreCap = capitalize(nombre.trim());
      const apellidoCap = capitalize(apellido.trim());
      const paisCap = capitalize(pais.trim());
      const estadoCap = capitalize(estado.trim());
      const municipioCap = capitalize(municipio.trim());
      const localidadCap = capitalize(localidad.trim());
      const direccionCap = capitalize(direccion.trim());
      const referenciasCap = referencias ? capitalize(referencias.trim()) : null;
  
      // Convertir a 1/0 la bandera de predeterminado
      const _predeterminado = predeterminado ? 1 : 0;
  
      // Verificar límite de direcciones para el usuario (máximo 6)
      const [countRows] = await pool.query(
        "SELECT COUNT(*) AS total FROM tbldireccioncliente WHERE idUsuario = ?",
        [idUsuario]
      );
      if (countRows[0].total >= 6) {
        return res.status(400).json({
          message: "El usuario ya tiene el máximo de 6 direcciones permitidas.",
        });
      }
  
    
      const selectQuery = `
        SELECT COUNT(*) AS count
        FROM tbldireccioncliente
        WHERE idUsuario = ?
          AND codigoPostal = ?
          AND estado = ?
          AND municipio = ?
          AND localidad = ?
      `;
      const [rows] = await pool.query(selectQuery, [
        idUsuario,
        codigoPostal.trim(),
        estadoCap,
        municipioCap,
        localidadCap,
      ]);
      if (rows[0].count > 0) {
        return res.status(400).json({
          message:
            "Ya existe una dirección con los mismos datos (código postal, estado, municipio, localidad) para este usuario.",
        });
      }
  
     
      if (_predeterminado === 1) {
        await pool.query(
          "UPDATE tbldireccioncliente SET predeterminado = 0 WHERE idUsuario = ?",
          [idUsuario]
        );
      }

         const currentDateTime = moment()
                  .tz("America/Mexico_City")
                  .format("YYYY-MM-DD HH:mm:ss");
  
      // Insertar la nueva dirección
      const insertQuery = `
        INSERT INTO tbldireccioncliente (
          idUsuario,
          nombre,
          apellido,
          telefono,
          codigoPostal,
          pais,
          estado,
          municipio,
          localidad,
          direccion,
          referencias,
          predeterminado,
          createdAt,
          updatedAt
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,?,?)
      `;
      const [result] = await pool.query(insertQuery, [
        idUsuario,
        nombreCap,
        apellidoCap,
        telefonoString,
        codigoPostal.trim(),
        paisCap,
        estadoCap,
        municipioCap,
        localidadCap,
        direccionCap,
        referenciasCap,
        _predeterminado,
        currentDateTime,
        currentDateTime
      ]);
  
      if (result.affectedRows === 0) {
        return res
          .status(500)
          .json({ message: "No se pudo crear la dirección." });
      }
  
      // Emitir evento de socket si lo deseas
      getIO().emit("direccionCreada", {
        idDireccion: result.insertId,
        idUsuario,
        nombre: nombreCap,
        apellido: apellidoCap,
      });
  
      return res.status(201).json({
        message: "Dirección creada correctamente.",
        idDireccion: result.insertId,
      });
    } catch (error) {
      console.error("Error al crear la dirección:", error);
      return res.status(500).json({
        message: "Error interno al crear la dirección.",
      });
    }
  });



  // Endpoint para actualizar una dirección
routerDireccion.put("/actualizar", csrfProtection, async (req, res) => {
    try {
      const {
        idDireccion,
        idUsuario,
        nombre,
        apellido,
        telefono,
        codigoPostal,
        pais,
        estado,
        municipio,
        localidad,
        direccion,
        referencias,
        predeterminado,
      } = req.body;
  
      
      if (!idDireccion) {
        return res.status(400).json({ message: "El idDireccion es obligatorio." });
      }
      if (!idUsuario) {
        return res.status(400).json({ message: "El idUsuario es obligatorio." });
      }
      if (
        !nombre ||
        !apellido ||
        !telefono ||
        !codigoPostal ||
        !pais ||
        !estado ||
        !municipio ||
        !localidad ||
        !direccion
      ) {
        return res.status(400).json({
          message:
            "Faltan campos obligatorios: nombre, apellido, teléfono, códigoPostal, pais, estado, municipio, localidad y dirección.",
        });
      }
 
      const telefonoString = String(telefono).trim();
      if (!/^\d{10}$/.test(telefonoString)) {
        return res.status(400).json({
          message: "El teléfono debe contener exactamente 10 dígitos numéricos.",
        });
      }
  
      const nombreCap = capitalize(nombre.trim());
      const apellidoCap = capitalize(apellido.trim());
      const paisCap = capitalize(pais.trim());
      const estadoCap = capitalize(estado.trim());
      const municipioCap = capitalize(municipio.trim());
      const localidadCap = capitalize(localidad.trim());
      const direccionCap = capitalize(direccion.trim());
      const referenciasCap = referencias ? capitalize(referencias.trim()) : null;
  
    
      const _predeterminado = predeterminado ? 1 : 0;
  
      const selectQuery = `
        SELECT COUNT(*) AS count
        FROM tbldireccioncliente
        WHERE idUsuario = ?
          AND idDireccion <> ?
          AND codigoPostal = ?
          AND estado = ?
          AND municipio = ?
          AND localidad = ?
      `;
      const [rows] = await pool.query(selectQuery, [
        idUsuario,
        idDireccion,
        codigoPostal.trim(),
        estadoCap,
        municipioCap,
        localidadCap,
      ]);
      if (rows[0].count > 0) {
        return res.status(400).json({
          message:
            "Ya existe una dirección con los mismos datos (código postal, estado, municipio, localidad) para este usuario.",
        });
      }
  
     
      if (_predeterminado === 1) {
        await pool.query(
          "UPDATE tbldireccioncliente SET predeterminado = 0 WHERE idUsuario = ? AND idDireccion <> ?",
          [idUsuario, idDireccion]
        );
      }
  
      const currentDateTime = moment()
        .tz("America/Mexico_City")
        .format("YYYY-MM-DD HH:mm:ss");

      const updateQuery = `
        UPDATE tbldireccioncliente SET
          nombre = ?,
          apellido = ?,
          telefono = ?,
          codigoPostal = ?,
          pais = ?,
          estado = ?,
          municipio = ?,
          localidad = ?,
          direccion = ?,
          referencias = ?,
          predeterminado = ?,
          updatedAt = ?
        WHERE idDireccion = ? AND idUsuario = ?
      `;
      const [result] = await pool.query(updateQuery, [
        nombreCap,
        apellidoCap,
        telefonoString,
        codigoPostal.trim(),
        paisCap,
        estadoCap,
        municipioCap,
        localidadCap,
        direccionCap,
        referenciasCap,
        _predeterminado,
        currentDateTime,
        idDireccion,
        idUsuario,
      ]);
      if (result.affectedRows === 0) {
        return res.status(500).json({ message: "No se pudo actualizar la dirección." });
      }
  
    
      getIO().emit("direccionActualizada", {
        idDireccion,
        idUsuario,
        nombre: nombreCap,
        apellido: apellidoCap,
      });
  
      return res.status(200).json({ message: "Dirección actualizada correctamente." });
    } catch (error) {
      console.error("Error al actualizar la dirección:", error);
      return res.status(500).json({ message: "Error interno al actualizar la dirección." });
    }
  });


 

routerDireccion.delete("/eliminar", csrfProtection, async (req, res) => {
    try {
      const { idDireccion, idUsuario } = req.body;
      if (!idDireccion || !idUsuario) {
        return res.status(400).json({
          message: "Los campos idDireccion e idUsuario son obligatorios."
        });
      }
  
   
      const [result] = await pool.query(
        "DELETE FROM tbldireccioncliente WHERE idDireccion = ? AND idUsuario = ?",
        [idDireccion, idUsuario]
      );
  
      if (result.affectedRows === 0) {
        return res.status(404).json({
          message: "No se encontró la dirección para eliminar."
        });
      }
  
      
      getIO().emit("direccionEliminada", { idDireccion, idUsuario });
  
      return res.status(200).json({
        message: "Dirección eliminada correctamente."
      });
    } catch (error) {
      console.error("Error al eliminar la dirección:", error);
      return res.status(500).json({
        message: "Error interno al eliminar la dirección."
      });
    }
  });
  


module.exports= routerDireccion;
