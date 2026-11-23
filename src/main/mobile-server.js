const express = require('express');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { app } = require('electron');
const QRCode = require('qrcode');

// Resolve paths that work in both dev and production (asar) builds
function getResourcePath(relativePath) {
  // In production, check extraResources first
  if (app.isPackaged) {
    const resourcePath = path.join(process.resourcesPath, relativePath);
    if (fs.existsSync(resourcePath)) return resourcePath;
  }
  // Fallback to __dirname-relative path (dev mode)
  return path.join(__dirname, relativePath);
}

let server;
const expressApp = express();
const port = 3030;

function getLocalIpAddress() {
    const interfaces = os.networkInterfaces();
    for (const devName in interfaces) {
        const iface = interfaces[devName];
        for (let i = 0; i < iface.length; i++) {
            const alias = iface[i];
            if (alias.family === 'IPv4' && alias.address !== '127.0.0.1' && !alias.internal) {
                return alias.address;
            }
        }
    }
    return '127.0.0.1';
}

function initMobileServer(db) {
    const userDataPath = app.getPath('userData');
    const imagesDir = path.join(userDataPath, 'product_images');
    if (!fs.existsSync(imagesDir)) {
        fs.mkdirSync(imagesDir, { recursive: true });
    }

    expressApp.use(cors());
    expressApp.use(express.json());
    expressApp.use('/images', express.static(imagesDir));

    // Serve translations.js — in production it's inside the asar but readable via require
    const translationsPath = path.join(__dirname, '../renderer/translations.js');
    expressApp.get('/translations.js', (req, res) => {
      try {
        // Read from asar-compatible path
        const content = fs.readFileSync(translationsPath, 'utf-8');
        res.type('application/javascript').send(content);
      } catch (e) {
        console.error('[Mobile] Failed to serve translations.js:', e);
        res.status(404).send('// translations not found');
      }
    });

    const storage = multer.diskStorage({
        destination: function (req, file, cb) {
            const productId = req.params.productId;
            const productDir = path.join(imagesDir, productId);
            if (!fs.existsSync(productDir)) {
                fs.mkdirSync(productDir, { recursive: true });
            }
            cb(null, productDir);
        },
        filename: function (req, file, cb) {
            const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
            cb(null, uniqueSuffix + path.extname(file.originalname));
        }
    });

    const upload = multer({ storage: storage });

    // API to get all products
    expressApp.get('/api/products', (req, res) => {
        try {
            const products = db.prepare('SELECT id, name FROM products WHERE deleted = 0 ORDER BY name ASC').all();
            res.json(products);
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    // API to get product by id
    expressApp.get('/api/products/:productId', (req, res) => {
        try {
            const product = db.prepare('SELECT id, name FROM products WHERE id = ? AND deleted = 0').get(req.params.productId);
            if (!product) return res.status(404).json({ error: 'Product not found' });
            res.json(product);
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    // API to get images for a product
    expressApp.get('/api/products/:productId/images', (req, res) => {
        const productId = req.params.productId;
        const productDir = path.join(imagesDir, productId);
        if (!fs.existsSync(productDir)) {
            return res.json([]);
        }
        try {
            const files = fs.readdirSync(productDir);
            const images = files.filter(file => /\.(jpg|jpeg|png|gif|webp)$/i.test(file)).map(file => ({
                name: file,
                url: `/images/${productId}/${file}`
            }));
            res.json(images);
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    // API to upload image for a product
    expressApp.post('/api/products/:productId/images', upload.single('image'), (req, res) => {
        res.json({ success: true, file: req.file.filename });
    });

    // API to delete image for a product
    expressApp.delete('/api/products/:productId/images/:filename', (req, res) => {
        const productId = req.params.productId;
        const filename = req.params.filename;
        const filePath = path.join(imagesDir, productId, filename);
        if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
            res.json({ success: true });
        } else {
            res.status(404).json({ error: 'File not found' });
        }
    });

    // Serve HTML page
    expressApp.get('/', (req, res) => {
      const mobilePath = getResourcePath('mobile.html');
      res.sendFile(mobilePath);
    });

    server = expressApp.listen(port, '0.0.0.0', () => {
        console.log(`Mobile server running on http://0.0.0.0:${port}`);
    });
}

async function getQrCodeForProduct(productId, lang = 'fr') {
    const ip = getLocalIpAddress();
    const url = `http://${ip}:${port}/?productId=${productId}&lang=${lang}`;
    try {
        const qrCodeDataUrl = await QRCode.toDataURL(url, { width: 300, margin: 2 });
        return { url, qrCodeDataUrl };
    } catch (e) {
        throw e;
    }
}

async function getGeneralQrCode(lang = 'fr') {
    const ip = getLocalIpAddress();
    const url = `http://${ip}:${port}/?lang=${lang}`;
    try {
        const qrCodeDataUrl = await QRCode.toDataURL(url, { width: 300, margin: 2 });
        return { url, qrCodeDataUrl };
    } catch (e) {
        throw e;
    }
}

function stopMobileServer() {
    if (server) {
        server.close();
    }
}

module.exports = {
    initMobileServer,
    getQrCodeForProduct,
    getGeneralQrCode,
    stopMobileServer
};
