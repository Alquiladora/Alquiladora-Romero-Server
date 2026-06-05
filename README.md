# Alquiladora Romero Server

Backend desarrollado con **Node.js** y **JavaScript** para el ecosistema digital de **Alquiladora Romero**, orientado a la gestión de inventario, pedidos, usuarios, consultas operativas, comunicación por correo y procesos logísticos.

Este servidor forma parte de una solución Full Stack creada para apoyar la administración de una empresa de renta de mobiliario, conectando la plataforma web, módulos móviles y procesos internos del negocio.

---

## Objetivo del proyecto

El objetivo principal de este backend es centralizar la lógica del sistema y permitir que las aplicaciones del ecosistema Alquiladora Romero puedan consumir información de forma estructurada mediante rutas, consultas y servicios del lado del servidor.

Este proyecto permite administrar procesos como:

- Gestión de usuarios.
- Gestión de inventario.
- Registro y consulta de pedidos.
- Procesos logísticos.
- Consultas a base de datos.
- Comunicación por correo.
- Integración con otros módulos del sistema.

---

## ¿Qué problema resuelve?

En un negocio de renta de mobiliario, la operación puede involucrar inventario, clientes, pedidos, fechas, entregas, devoluciones, disponibilidad de productos y seguimiento interno.

Este backend ayuda a organizar esa información mediante una estructura centralizada, permitiendo que el frontend y otros módulos del ecosistema puedan consultar, registrar y actualizar datos de forma más ordenada.

---

## Funcionalidades principales

- Servidor backend desarrollado con Node.js.
- Definición de rutas para comunicación con el sistema.
- Conexión con base de datos.
- Consultas organizadas para operaciones del negocio.
- Módulo de envío de correos.
- Generación de información o documentos desde el servidor.
- Estructura modular para configuración, rutas, consultas y pruebas.
- Configuración de pruebas con Jest.
- Integración con flujos de GitHub Actions.
- Base para conectar plataforma web, app móvil y otros módulos del ecosistema.

---

## Tecnologías utilizadas

- Node.js
- JavaScript
- Express.js
- MySQL / Base de datos relacional
- Jest
- GitHub Actions
- npm
- API REST
- Nodemailer / Servicio de correo
- Arquitectura modular

---

## Arquitectura general

```txt
Cliente Web / App Móvil / Wear OS
        ↓
Rutas API
        ↓
Servidor Node.js
        ↓
Consultas y lógica de negocio
        ↓
Base de datos
        ↓
Respuesta al cliente
