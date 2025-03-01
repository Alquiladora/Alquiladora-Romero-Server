require('dotenv').config();
const express = require('express');
const helmet = require('helmet');
const cookieParser = require('cookie-parser');
const cors = require("cors");
//=====================RUTAS==========================
const routers = require('./rutas');
const connect = require('./connectBd');

//==================================================

const app = express();
const port = process.env.PORT || 3001;

app.use(express.json());
app.use(helmet());
app.use(cookieParser());

// Configuración de CORS
const allowedOrigins = [
  'http://localhost:3001',
  'https://alquiladora-romero-server.onrender.com',
  'http://localhost:3000',
  'https://alquiladoraromero.bina5.com'
];

app.use(cors({
  origin: (origin, callback) => {
    if (allowedOrigins.includes(origin) || !origin) {
      callback(null, true);
    } else {
      callback(new Error('No permitido por CORS'));
    }
  },
  methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS', 'PUT'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-CSRF-Token'],
  credentials: true,
}));
app.options('*', cors());

// Conectar a la base de datos
(async () => {
  try {
    await connect.connect();
    console.log('✅ Conexión a la base de datos establecida');
  } catch (error) {
    console.error('❌ Fallo al conectar a la base de datos:', error);
  }
})();


//=================RUTAS DEFINIDOS=======================
app.use('/api', routers);

//=======================================================

// 📌 **Middleware Global para Manejo de Errores 500**
app.use((err, req, res, next) => {
  console.error("⚠️ Error detectado:", err.stack);
  res.status(500).json({ 
    error: "Error interno del servidor",
    message: err.message 
  });
});





app.listen(port, () => {
  console.log(`🚀Servidor en http://localhost:${port}`);
});
