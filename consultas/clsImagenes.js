//crud imagenes
const express = require('express');
const multer = require('multer');
const cloudinary = require('cloudinary').v2;
const streamifier = require('streamifier');


const upload = multer({ storage: multer.memoryStorage() });



cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET,
});

const imagenesRouter = express.Router();

//==============================PERFIL===============================================//

imagenesRouter.post('/upload',  upload.single('imagen'), (req, res) => {
  if (!req.file) {
      return res.status(400).send("No se ha subido ningún archivo.");
  }

  try {
      const cld_upload_stream = cloudinary.uploader.upload_stream(
          { folder: 'imagenes/Perfiles' }, 
          (error, result) => {
              if (error) {
                  return res.status(500).json({ error: error.message });
              }
              console.log("Resultado de la imagen ",result.secure_url )
              res.json({ url: result.secure_url });
          }
      );

      // Conectar el buffer del archivo a un stream de lectura para enviarlo a Cloudinary
      streamifier.createReadStream(req.file.buffer).pipe(cld_upload_stream);
  } catch (error) {
      console.error("Error al subir la imagen:", error);
      res.status(500).json({ message: "Error al subir la imagen." });
  }
});

//-------------------------------EVALUAR PEDIDO---------------
imagenesRouter.post('/calificar-pedido', upload.array('imagenes', 3), async (req, res) => {
  
  if (!req.files || req.files.length === 0) {
    return res.status(400).send("No se ha subido ningún archivo.");
  }
  if (req.files.length > 6) {
    console.log("Error a recibir Máximo de 3 imágenes permitidas")
    return res.status(400).json({ message: "Máximo de 3 imágenes permitidas." });
  }

  try {

    const uploadPromises = req.files.map((file) => {
      return new Promise((resolve, reject) => {
        const cld_upload_stream = cloudinary.uploader.upload_stream(
          { folder: 'imagenes/CalificacionPedidos' },
          (error, result) => {
            if (error) {
              reject(error);
            } else {
           
              resolve(result.secure_url);
            }
          }
        );
        streamifier.createReadStream(file.buffer).pipe(cld_upload_stream);
      });
    });
    const urls = await Promise.all(uploadPromises);
    console.log("rESULTADO DE URLS", urls)
    res.json({ urls });
  } catch (error) {
    console.error("Error al subir las imágenes:", error);
    res.status(500).json({ message: "Error al subir las imágenes." });
  }
});



//==============================PRODUCTOS===============================================//
imagenesRouter.post('/upload-multiple', upload.array('imagenes', 6), async (req, res) => {
  
  if (!req.files || req.files.length === 0) {
    return res.status(400).send("No se ha subido ningún archivo.");
  }
  if (req.files.length > 6) {
    console.log("Error a recibir Máximo de 6 imágenes permitidas")
    return res.status(400).json({ message: "Máximo de 6 imágenes permitidas." });
  }

  try {

    const uploadPromises = req.files.map((file) => {
      return new Promise((resolve, reject) => {
        const cld_upload_stream = cloudinary.uploader.upload_stream(
          { folder: 'imagenes/ProductosAlquiler' },
          (error, result) => {
            if (error) {
              reject(error);
            } else {
           
              resolve(result.secure_url);
            }
          }
        );
        streamifier.createReadStream(file.buffer).pipe(cld_upload_stream);
      });
    });
    const urls = await Promise.all(uploadPromises);
    console.log("rESULTADO DE URLS", urls)
    res.json({ urls });
  } catch (error) {
    console.error("Error al subir las imágenes:", error);
    res.status(500).json({ message: "Error al subir las imágenes." });
  }
});





//==============================IMAGENES===============================================//

imagenesRouter.post('/uploadRestaurante',  upload.single('imagen'), async (req, res) => {
    if (!req.file) {
        return res.status(400).send("No se ha subido ningún archivo.");
    }
    const cld_upload_stream = cloudinary.uploader.upload_stream(
        { folder: 'imagenes/ProductosAlquiler' }, 
        async (error, result) => {
            if (error) {
                return res.status(500).json({ error: error.message });
            }

            try {
                const collection = req.db.collection('imagenes');
                const imagenData = {
                    url: result.secure_url,
                    createdAt: new Date()
                };

                await collection.insertOne(imagenData);

                res.json({ url: result.secure_url });
            } catch (dbError) {
                res.status(500).json({ error: dbError.message });
            }
        }
    );

    
    streamifier.createReadStream(req.file.buffer).pipe(cld_upload_stream);
});


imagenesRouter.post('/web',  upload.single('imagen'), async (req, res, next) => {
    const { tema, fondoColor, fechaInicio, fechaFin } = req.body;
    const imagen = req.file ? req.file.buffer : null;
    const collection = req.db.collection("fondosDePagina");

    if (fondoColor && imagen) {
        return res.status(400).send("Solo puedes enviar un color de fondo o una imagen, no ambos.");
    }

    const fondosDePaginaData = {
        tema,
        fondoColor,
        fechaInicio,
        fechaFin,
        imagen_o_color: null
    };

    if (imagen) {
        try {
            const cld_upload_stream = cloudinary.uploader.upload_stream(
                { folder: 'imagenes/Fondos' },
                async (error, result) => {
                    if (error) {
                        return res.status(500).json({ error: error.message });
                    }
                    fondosDePaginaData.imagen_o_color = result.secure_url;
                    const insertResult = await collection.insertOne(fondosDePaginaData);
                    insertResult.acknowledged
                        ? res.status(201).send("Fondo creado con éxito.")
                        : res.status(400).send("No se pudo crear el Fondo.");
                }
            );
            streamifier.createReadStream(imagen).pipe(cld_upload_stream);
        } catch (error) {
            next(error);
        }
    } else {
        try {
            const result = await collection.insertOne(fondosDePaginaData);
            result.acknowledged
                ? res.status(201).send("Fondo creado con éxito.")
                : res.status(400).send("No se pudo crear el Fondo.");
        } catch (error) {
            next(error);
        }
    }
});
//Actualiar fondo
imagenesRouter.patch('/web/:id',  upload.single('imagen'), async (req, res, next) => {
    const { id } = req.params;
    const { tema, fondoColor, fechaInicio, fechaFin } = req.body;
    const imagen = req.file ? req.file.buffer : null;
    const collection = req.db.collection("fondosDePagina");
  
    if (fondoColor && imagen) {
      return res.status(400).send("Solo puedes enviar un color de fondo o una imagen, no ambos.");
    }
  
    const fondosDePaginaData = {};
    if (tema) fondosDePaginaData.tema = tema;
    if (fondoColor) fondosDePaginaData.fondoColor = fondoColor;
    if (fechaInicio) fondosDePaginaData.fechaInicio = fechaInicio;
    if (fechaFin) fondosDePaginaData.fechaFin = fechaFin;
  
    if (imagen) {
      try {
        const cld_upload_stream = cloudinary.uploader.upload_stream(
          { folder: 'imagenes/Fondos' },
          async (error, result) => {
            if (error) {
              return res.status(500).json({ error: error.message });
            }
            fondosDePaginaData.imagen_o_color = result.secure_url;
            try {
              const updateResult = await collection.updateOne(
                { _id: new ObjectId(id) },
                { $set: fondosDePaginaData }
              );
              updateResult.modifiedCount > 0
                ? res.status(200).send("Fondo actualizado con éxito.")
                : res.status(400).send("No se pudo actualizar el Fondo.");
            } catch (error) {
              next(error);
            }
          }
        );
        streamifier.createReadStream(imagen).pipe(cld_upload_stream);
      } catch (error) {
        next(error);
      }
    } else {
      try {
        const updateResult = await collection.updateOne(
          { _id: new ObjectId(id) },
          { $set: fondosDePaginaData }
        );
        updateResult.modifiedCount > 0
          ? res.status(200).send("Fondo actualizado con éxito.")
          : res.status(400).send("No se pudo actualizar el Fondo.");
      } catch (error) {
        next(error);
      }
    }
  });



module.exports = imagenesRouter;



