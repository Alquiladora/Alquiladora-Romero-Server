const express = require('express');
const router = express.Router();
const email= require('./consultas/clsCorreo');
const clsUsuarios=require('./consultas/clsUsuarios')
const clsToken= require('./consultas/clsToken');
const ClsAuditoria= require('./consultas/clsAuditoria')
const ClsImagenes= require("./consultas/clsImagenes")
const {csrfProtection} =require('../server/config/csrf')
const clsMfa= require("./consultas/mfa")





router.get('/get-csrf-token',csrfProtection , (req, res) => {
    res.json({ csrfToken: req.csrfToken() });
  });

//=========================RUTAS=======================================



router.use('/email', email);
router.use('/usuarios', clsUsuarios)
router.use('/token',clsToken);
router.use('/auditoria',ClsAuditoria);
router.use('/imagenes',ClsImagenes);
router.use('/mfa',clsMfa);




//======================================================================




module.exports = router;
