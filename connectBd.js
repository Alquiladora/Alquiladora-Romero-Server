const mysql = require('mysql2/promise');
require('dotenv').config();



const pool = mysql.createPool({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,

    waitForConnections: true, 
    connectionLimit: 8,
    queueLimit: 0,
    connectTimeout: 60000,
    acquireTimeout: 60000,
    timeout: 60000,    
    enableKeepAlive: true,
    keepAliveInitialDelay: 10000, 
    multipleStatements: false,
     charset: 'utf8mb4',
    timezone: '+00:00',
    decimalNumbers: true

  
});


const connect = async () => {
    let connection;
    try {
        connection = await pool.getConnection();
        await connection.ping();
        console.log('✅ Conexión exitosa a la base de datos Hostinger');
    } catch (error) {
        console.error('Error al conectar a la base de datos:', error);
         if (error.code === 'ECONNRESET' || error.code === 'PROTOCOL_CONNECTION_LOST') {
            console.log('🔄 Conexión cerrada por Hostinger, reconectando...');
        }
        throw error;
    } finally {
        if (connection) {
            connection.release(); 
        }
    }
};


const startKeepAlive = () => {
    setInterval(async () => {
        try {
            const [result] = await pool.execute('SELECT 1');
            console.log('🔄 Keep-alive ejecutado - Conexión activa');
        } catch (error) {
            console.error('❌ Error en keep-alive:', error.message);
        }
    }, 30000); 
};


module.exports = {
    pool,
    connect,
    startKeepAlive
};
