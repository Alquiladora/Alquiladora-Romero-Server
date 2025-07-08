const mysql = require('mysql2/promise');
require('dotenv').config();



const pool = mysql.createPool({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    waitForConnections: true, 
    connectionLimit: 15,
    queueLimit: 0,
    connectTimeout: 30000,
    acquireTimeout: 30000,    
    enableKeepAlive: true,
    keepAliveInitialDelay: 0, 
    multipleStatements: true,
  
});


const connect = async () => {
    let connection;
    try {
        connection = await pool.getConnection();
        console.log('Conexión exitosa a la base de datos');
    } catch (error) {
        console.error('Error al conectar a la base de datos:', error);
        throw error;
    } finally {
        if (connection) {
            connection.release(); 
        }
    }
};


module.exports = {
    pool,
    connect,
};
