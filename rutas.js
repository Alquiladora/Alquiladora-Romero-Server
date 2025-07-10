const express = require('express');
const router = express.Router();
const {csrfProtection} =require('./config/csrf')
const { usuarioRouter } = require('./consultas/clsUsuarios');
//=========================RUTAS=======================================

// 📌 **Definir Rutas**
const routes = {
  email: require('./consultas/clsCorreo'),
  usuarios: usuarioRouter,
  token: require('./consultas/clsToken'),
  auditoria: require('./consultas/clsAuditoria'),
  imagenes: require('./consultas/clsImagenes'),
  sesiones: require('./consultas/clssesiones'),
  productos: require('./consultas/clsProductos'),
  mfa: require('./consultas/mfa'),
  empresa: require('./consultas/clsEmpresa'),
  politicas: require('./consultas/clsPoliticas'),
  terminos: require('./consultas/clsTerminos'),
  deslin: require('./consultas/clsDeslin'),
  sobreNosotros: require('./consultas/clsSobreNosotros'),
  precios: require('./consultas/clsPrecios'),
  bodegas: require('./consultas/clsBodegas'),
  inventario: require('./consultas/clsInventario'),
  direccion: require('./consultas/clsDireccion'),
  pedidos: require('./consultas/clsPedidos'),
  carrito: require('./consultas/clsCarrito'),
  colores: require('./consultas/clsColores'),
  horario: require('./consultas/clsHorario'),
  repartidor: require('./consultas/clsRepartidorPedidos'),
  wearos: require('./consultas/clsWearos'),
  tarjetas: require('./consultas/clsTarjetas')
};


router.get('/get-csrf-token',csrfProtection , (req, res) => {
    res.json({ csrfToken: req.csrfToken() });
  });

  Object.entries(routes).forEach(([path, routeHandler]) => {
    router.use(`/${path}`, routeHandler);
  });


router.use((req, res) => {
  res.status(404).json({ 
    error: 'Ruta no encontrada', 
    path: req.originalUrl 
  });
});


router.use((err, req, res, next) => {
  console.error(`⚠️ Error en ruta ${req.method} ${req.originalUrl}:`, err.stack);
  res.status(500).json({ 
    error: 'Error interno del servidor',
    ...(process.env.NODE_ENV !== 'production' && { message: err.message })
  });
});;


module.exports = router;
