const express = require('express');
const router = express.Router();
const {csrfProtection} =require('./config/csrf')

//=========================RUTAS=======================================

// 📌 **Definir Rutas**
const routes = {
  email: require('./consultas/clsCorreo'),
  usuarios: require('./consultas/clsUsuarios'),
  token: require('./consultas/clsToken'),
  auditoria: require('./consultas/clsAuditoria'),
  imagenes: require('./consultas/clsImagenes'),
  sesiones: require('./consultas/clssesiones'),
  productos: require('./consultas/clsProductos'),
  mfa: require('./consultas/mfa'),
  empresa: require('./consultas/clsEmpresa'),
  politicas: require('./consultas/clsPoliticas'),
  terminos: require('./consultas/clsTerminos'),
  deslindes: require('./consultas/clsDeslin'),
  sobreNosotros: require('./consultas/clsSobreNosotros'),
  precios: require('./consultas/clsPrecios'),
  bodegas: require('./consultas/clsBodegas'),
  inventario: require('./consultas/clsInventario'),
  direccion: require('./consultas/clsDireccion'),
  pedidos: require('./consultas/clsPedidos'),
  carrito: require('./consultas/clsCarrito'),
  colores: require('./consultas/clsColores'),
  horario: require('./consultas/clsHorario'),
};


router.get('/get-csrf-token',csrfProtection , (req, res) => {
    res.json({ csrfToken: req.csrfToken() });
  });

  Object.entries(routes).forEach(([path, routeHandler]) => {
    router.use(`/${path}`, routeHandler);
  });

//======================================================================

// 📌 **Middleware de Error 404 (Ruta No Encontrada)**
router.use((req, res) => {
  res.status(404).json({ 
    error: 'Ruta no encontrada', 
    path: req.originalUrl 
  });
});

// 📌 **Middleware para Capturar Errores en Rutas**
router.use((err, req, res, next) => {
  console.error(`⚠️ Error en ruta ${req.method} ${req.originalUrl}:`, err.stack);
  res.status(500).json({ 
    error: 'Error interno del servidor',
    ...(process.env.NODE_ENV !== 'production' && { message: err.message })
  });
});;


module.exports = router;
