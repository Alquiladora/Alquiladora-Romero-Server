const express = require('express');
const router = express.Router();
const email= require('./consultas/clsCorreo');
const clsUsuarios=require('./consultas/clsUsuarios')
const clsToken= require('./consultas/clsToken');
const ClsAuditoria= require('./consultas/clsAuditoria')
const ClsImagenes= require("./consultas/clsImagenes")
const ClsSesiones = require("./consultas/clssesiones")
const ClsProductos= require("./consultas/clsProductos")
const {csrfProtection} =require('./config/csrf')
const clsMfa= require("./consultas/mfa")

router.get('/get-csrf-token',csrfProtection , (req, res) => {
    res.json({ csrfToken: req.csrfToken() });
  });

  //Ping de conectividad
  router.get("/status", (req, res) => {
    res.status(200).json({ status: "ok" });
  });
  

//=========================RUTAS=======================================

// 📌 **Definir Rutas**
router.use('/email', email);
router.use('/usuarios', clsUsuarios)
router.use('/token',clsToken);
router.use('/auditoria',ClsAuditoria);
router.use('/imagenes',ClsImagenes);
router.use('/mfa',clsMfa);
router.use('/sesiones',ClsSesiones);
router.use('/productos',ClsProductos);




//======================================================================

// 📌 **Middleware de Error 404 (Ruta No Encontrada)**
router.use((req, res, next) => {
  res.status(404).json({ error: "Ruta no encontrada" });
});

// 📌 **Middleware para Capturar Errores en Rutas**
router.use((err, req, res, next) => {
  console.error("⚠️ Error en rutas:", err.message);
  next(err); 
});


module.exports = router;
