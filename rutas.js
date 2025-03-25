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
const ClsEmpresa = require("./consultas/clsEmpresa")
const ClsPoliticas = require("./consultas/clsPoliticas")
const ClsTerminos= require("./consultas/clsTerminos")
const  ClsDeslindes= require("./consultas/clsDeslin")
const  ClsSobreNosotros= require("./consultas/clsSobreNosotros")
const ClsPrecios = require("./consultas/clsPrecios")
const ClsBodegas = require("./consultas/clsBodegas")
const ClsInventario = require("./consultas/clsInventario")
const ClsDirrecion= require("./consultas/clsDireccion")
const ClsPedidos = require("./consultas/clsPedidos")
const ClsCarrito= require("./consultas/clsCarrito")
const ClsColores = require('./consultas/clsColores')
const ClsHorario= require('./consultas/clsHorario')


router.get('/get-csrf-token',csrfProtection , (req, res) => {
    res.json({ csrfToken: req.csrfToken() });
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
router.use('/empresa',ClsEmpresa);
router.use('/politicas',ClsPoliticas);
router.use('/terminos',ClsTerminos);
router.use('/deslin',ClsDeslindes);
router.use('/sobrenosotros',ClsSobreNosotros);
router.use('/precios',ClsPrecios);
router.use('/bodegas',ClsBodegas);
router.use('/inventario', ClsInventario);
router.use('/direccion', ClsDirrecion);
router.use('/pedidos', ClsPedidos);
router.use('/carrito', ClsCarrito);
router.use('/colores',ClsColores)
router.use('/horario',ClsHorario)








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
