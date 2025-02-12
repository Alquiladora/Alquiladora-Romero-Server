const express = require('express');
const axios = require('axios'); 
const {pool} = require ('../connectBd')
const {csrfProtection} = require ('../config/csrf.js')

const token = express.Router();
token.use(express.json());


//Creamos el enpoit de Token 
token.post('/create', async(req,res)=>{
    const { token } = req.body;
    console.log("Estos datos se recibiero de enpoit token create");
})

  //Obtenemos Todos Los Usuarios
  token.get("/", async (req, res, next) => {
    try {
      const [usuarios] = await pool.query("SELECT * FROM tbltokens");
      res.json(usuarios);
    } catch (error) {
      next(error);
    }
  });

  //Obtenemos el usuario solo con el correo
  token.get("/:correo", async (req, res, next) => {
    try {
      const [usuarios] = await pool.query("SELECT * FROM tbltokens");
      console.log("Correos obtenidos de los tokens", [usuarios])
      res.json(usuarios);
    } catch (error) {
      next(error);
    }
  });



  token.get("/correo/:correo", async (req, res, next) => {  
    const { correo } = req.params;  
    try {
        const [rows] = await pool.query("SELECT * FROM tbltokens WHERE correo = ?", [correo]);

        if (rows.length === 0) {
            return res.status(404).json({ message: "No se encontró un token para este correo" });
        }

        res.json(rows[0]); 
    } catch (error) {
        next(error);
    }
});





module.exports= token;