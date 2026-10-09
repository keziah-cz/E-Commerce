
const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const db = require('../config/db');
const { requireAdmin } = require('../middleware/auth');

const router = express.Router();

// --------------------------------------------------
// Admin configuration
// --------------------------------------------------

const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'admin@sipverse.local';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'SipVerseAdmin123!';

const ORDER_STATUSES = [
  'Pending',
  'Processing',
  'Completed',
  'Cancelled',
];

// Uploaded drink photos are stored inside the public images folder so
// they can be served straight from the storefront.
const IMAGE_UPLOAD_DIR = path.join(__dirname, '..', 'public', 'images');

fs.mkdirSync(IMAGE_UPLOAD_DIR, { recursive: true });

const imageStorage = multer.diskStorage({
  destination: (req, file, callback) => callback(null, IMAGE_UPLOAD_DIR),
  filename: (req, file, callback) => {
    const extension = path.extname(file.originalname).toLowerCase() || '.jpg';

    const baseName = path
      .basename(file.originalname, extension)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'drink';

    const uniqueSuffix = `${Date.now()}-${Math.round(Math.random() * 1e6)}`;

    callback(null, `${baseName}-${uniqueSuffix}${extension}`);
  },
});

const uploadProductImage = multer({
  storage: imageStorage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, callback) => {
    if (file.mimetype && file.mimetype.startsWith('image/')) {
      return callback(null, true);
    }

    return callback(new Error('Please upload an image file.'));
  },
}).single('image');

// Wraps multer so upload problems become a friendly dashboard notice.
function handleProductImage(req, res, next) {
  uploadProductImage(req, res, (error) => {
    if (!error) {
      return next();
    }

    console.error('Product image upload error:', error);

    const message =
      error.code === 'LIMIT_FILE_SIZE'
        ? 'The drink photo must be 5 MB or smaller.'
        : error.message || 'Unable to upload that drink photo.';

    return redirectWithNotice(res, message);
  });
}

// Public URL for a freshly uploaded drink photo.
function getUploadedImagePath(file) {
  return file ? `/images/${file.filename}` : null;
}

// --------------------------------------------------
// Helper functions
// --------------------------------------------------

function redirectWithNotice(res, message) {
  return res.redirect(
    `/admin/dashboard?notice=${encodeURIComponent(message)}`
  );
}

function getProductData(body) {
  const name = (body.name || '').trim();
  const description = (body.description || '').trim();

  const price = Number(body.price);
  const stock = Number(body.stock);

  const categoryId = body.category_id
    ? Number(body.category_id)
    : null;

  const isValid =
    name.length > 0 &&
    Number.isFinite(price) &&
    price >= 0 &&
    Number.isFinite(stock) &&
    Number.isInteger(stock) &&
    stock >= 0 &&
    (categoryId === null ||
      (Number.isInteger(categoryId) && categoryId > 0));

  if (!isValid) {
    return null;
  }

  return {
    name,
    description,
    price,
    stock,
    categoryId,
  };
}

// A new upload wins; otherwise keep the photo already stored for the drink.
function resolveImagePath(file, submittedImage, fallbackImage = null) {
  return (
    getUploadedImagePath(file) ||
    (submittedImage || '').trim() ||
    fallbackImage ||
    null
  );
}

// --------------------------------------------------
// Admin login
// --------------------------------------------------

router.get('/login', (req, res) => {
  if (req.session.user?.role === 'admin') {
    return res.redirect('/admin/dashboard');
  }

  return res.render('admin/login', {
    error: null,
    email: ADMIN_EMAIL,
    password: ADMIN_PASSWORD,
  });
});

router.post('/login', (req, res) => {
  const email = (req.body.email || '').trim();
  const password = req.body.password || '';

  if (email !== ADMIN_EMAIL || password !== ADMIN_PASSWORD) {
    return res.status(401).render('admin/login', {
      error: 'Invalid administrator credentials.',
      email,
      password: '',
    });
  }

  req.session.regenerate((error) => {
    if (error) {
      console.error('Admin session error:', error);
      return res.status(500).send('Unable to create admin session.');
    }

    req.session.user = {
      name: 'Administrator',
      email,
      role: 'admin',
    };

    req.session.save((saveError) => {
      if (saveError) {
        console.error('Admin session save error:', saveError);
        return res.status(500).send('Unable to save admin session.');
      }

      return res.redirect('/admin/dashboard');
    });
  });
});

// --------------------------------------------------
// Admin dashboard
// --------------------------------------------------

router.get('/dashboard', requireAdmin, async (req, res) => {
  try {
    const [[productStats]] = await db.query(
      'SELECT COUNT(*) AS total FROM products'
    );

    const [[orderStats]] = await db.query(
      'SELECT COUNT(*) AS total FROM orders'
    );

    const [[customerStats]] = await db.query(
      "SELECT COUNT(*) AS total FROM users WHERE role = 'customer'"
    );

    const [[salesStats]] = await db.query(
      `SELECT COALESCE(SUM(total_amount), 0) AS total
       FROM orders
       WHERE status <> 'Cancelled'`
    );

    const [categories] = await db.query(
      'SELECT * FROM categories ORDER BY name'
    );

    const [products] = await db.query(
      `SELECT
         p.*,
         c.name AS category_name
       FROM products p
       LEFT JOIN categories c ON c.id = p.category_id
       ORDER BY p.id DESC`
    );

    const [orders] = await db.query(
      `SELECT
         o.*,
         u.name AS customer_name
       FROM orders o
       JOIN users u ON u.id = o.user_id
       ORDER BY o.created_at DESC`
    );

    const [orderItems] = await db.query(
      `SELECT
         oi.order_id,
         oi.quantity,
         oi.price,
         p.name,
         p.image
       FROM order_items oi
       JOIN products p ON p.id = oi.product_id
       ORDER BY oi.order_id DESC, p.name`
    );

    const itemsByOrder = new Map();

    for (const item of orderItems) {
      const items = itemsByOrder.get(item.order_id) || [];

      items.push({
        name: item.name,
        image: item.image,
        quantity: Number(item.quantity),
        price: Number(item.price),
      });
      itemsByOrder.set(item.order_id, items);
    }

    orders.forEach((order) => {
      order.items = itemsByOrder.get(order.id) || [];
    });

    return res.render('admin/dashboard', {
      user: req.session.user,

      stats: {
        products: productStats.total,
        orders: orderStats.total,
        customers: customerStats.total,
        sales: salesStats.total,
      },

      categories,
      products,
      orders,
      query: req.query,
    });
  } catch (error) {
    console.error('Unable to load admin dashboard:', error);
    return res.status(500).send('Unable to load dashboard.');
  }
});


// Create product

router.post(
  '/products/create',
  requireAdmin,
  handleProductImage,
  async (req, res) => {
  try {
    const product = getProductData(req.body);

    if (!product) {
      return redirectWithNotice(res, 'Please check the product fields.');
    }

    const image = resolveImagePath(req.file, req.body.image, null);

    await db.query(
      `INSERT INTO products
         (category_id, name, description, price, stock, image)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        product.categoryId,
        product.name,
        product.description,
        product.price,
        product.stock,
        image,
      ]
    );

    return redirectWithNotice(res, 'Product added successfully.');
  } catch (error) {
    console.error('Unable to create product:', error);
    return redirectWithNotice(res, 'Unable to add product.');
  }
  }
);

// Load sample catalog

router.post('/products/load-samples', requireAdmin, async (req, res) => {
  const samples = [
    ['Classic Americano', 'Bold espresso over ice for a clean coffee finish.', 85, 30, 'Coffee'],
    ['Caramel Macchiato', 'Smooth coffee layered with caramel and creamy milk.', 125, 24, 'Coffee'],
    ['Spanish Latte', 'Rich espresso sweetened with condensed milk.', 115, 22, 'Coffee'],
    ['Mocha Frappe', 'Chocolate coffee blended with ice and cream.', 135, 18, 'Coffee'],
    ['Iced Cafe Latte', 'Balanced espresso and creamy milk with a smooth finish.', 120, 26, 'Coffee'],
    ['Honey Cinnamon Latte', 'Warm cinnamon sweetness with silky espresso and milk.', 130, 21, 'Coffee'],
    ['White Chocolate Mocha', 'Velvety mocha with white chocolate and a rich cocoa finish.', 145, 17, 'Coffee'],
    ['Wintermelon Milk Tea', 'Creamy milk tea with a mellow wintermelon finish.', 99, 28, 'Milk Tea'],
    ['Taro Milk Tea', 'Silky taro milk tea with a naturally sweet flavor.', 105, 26, 'Milk Tea'],
    ['Matcha Cream Tea', 'Earthy matcha balanced with fresh milk and cream.', 125, 20, 'Milk Tea'],
    ['Brown Sugar Boba', 'Caramelized brown sugar milk tea with chewy pearls.', 119, 25, 'Milk Tea'],
    ['Cheese Foam Milk Tea', 'Creamy milk tea topped with a smooth cheese foam finish.', 129, 19, 'Milk Tea'],
    ['Okinawa Milk Tea', 'Toasty brown sugar flavor with soft milk tea and pearls.', 135, 18, 'Milk Tea'],
    ['Strawberry Fruit Tea', 'Bright strawberry tea with a refreshing fruity finish.', 109, 24, 'Fruit Tea'],
    ['Passionfruit Green Tea', 'Tropical passionfruit blended with chilled green tea.', 105, 27, 'Fruit Tea'],
    ['Peach Lychee Tea', 'Floral lychee and juicy peach over iced tea.', 110, 23, 'Fruit Tea'],
    ['Mango Fruit Tea', 'Sweet mango with a light and refreshing tea base.', 109, 25, 'Fruit Tea'],
    ['Blueberry Yogurt Tea', 'A cool tea blend with fruity blueberry and yogurt notes.', 115, 20, 'Fruit Tea'],
    ['Lychee Rose Tea', 'Floral rose aroma lifted by juicy lychee sweetness.', 112, 18, 'Fruit Tea'],
    ['Fresh Orange Juice', 'Brightly squeezed orange juice served chilled.', 89, 20, 'Juices'],
    ['Watermelon Cooler', 'Fresh watermelon blended into a cool summer drink.', 95, 18, 'Juices'],
    ['Pineapple Juice', 'Tropical pineapple juice with a crisp finish.', 92, 21, 'Juices'],
    ['Apple Citrus Juice', 'Apple and citrus fruits combined into a lively juice.', 98, 19, 'Juices'],
    ['Guava Lemonade', 'Juicy guava and citrus lemonade with a refreshing finish.', 105, 17, 'Juices'],
    ['Cucumber Mint Cooler', 'Cold cucumber and mint blended into a crisp cooling drink.', 96, 16, 'Juices'],
    ['Classic Cola', 'Chilled sparkling cola for an easy refreshment.', 65, 35, 'Soft Drinks'],
    ['Lemon Lime Soda', 'Crisp lemon-lime soda served over ice.', 65, 32, 'Soft Drinks'],
    ['Sparkling Grape Soda', 'Fizzy grape soda with a bold fruity sparkle.', 75, 30, 'Soft Drinks'],
    ['Coconut Water', 'Hydrating coconut water with a naturally light tropical taste.', 80, 24, 'Soft Drinks'],
  ];

  try {
    const [categories] = await db.query('SELECT id, name FROM categories');
    const categoryIds = new Map(categories.map((category) => [category.name, category.id]));
    const [existing] = await db.query('SELECT name FROM products');
    const existingNames = new Set(existing.map((product) => product.name.toLowerCase()));
    let added = 0;

    for (const [name, description, price, stock, categoryName] of samples) {
      if (existingNames.has(name.toLowerCase())) {
        continue;
      }

      await db.query(
        `INSERT INTO products (category_id, name, description, price, stock, image)
         VALUES (?, ?, ?, ?, ?, NULL)`,
        [categoryIds.get(categoryName) || null, name, description, price, stock]
      );
      added += 1;
    }

    return redirectWithNotice(res, `${added} sample drinks added to the catalog.`);
  } catch (error) {
    console.error('Unable to load sample catalog:', error);
    return redirectWithNotice(res, 'Unable to load the sample catalog.');
  }
});

// Update product

router.post(
  '/products/:id/update',
  requireAdmin,
  handleProductImage,
  async (req, res) => {
  try {
    const productId = Number(req.params.id);
    const product = getProductData(req.body);

    if (!Number.isInteger(productId) || productId <= 0 || !product) {
      return redirectWithNotice(res, 'Please check the product fields.');
    }

    const [existingRows] = await db.query(
      'SELECT image FROM products WHERE id = ? LIMIT 1',
      [productId]
    );

    if (existingRows.length === 0) {
      return redirectWithNotice(res, 'Product not found.');
    }

    const image = resolveImagePath(
      req.file,
      req.body.image,
      existingRows[0].image
    );

    const [result] = await db.query(
      `UPDATE products
       SET
         category_id = ?,
         name = ?,
         description = ?,
         price = ?,
         stock = ?,
         image = ?
       WHERE id = ?`,
      [
        product.categoryId,
        product.name,
        product.description,
        product.price,
        product.stock,
        image,
        productId,
      ]
    );

    if (result.affectedRows === 0 && result.changedRows === 0) {
      return redirectWithNotice(res, 'Product not found.');
    }

    return redirectWithNotice(res, 'Product updated successfully.');
  } catch (error) {
    console.error('Unable to update product:', error);
    return redirectWithNotice(res, 'Unable to update product.');
  }
  }
);

// Delete product

router.post('/products/:id/delete', requireAdmin, async (req, res) => {
  try {
    const productId = Number(req.params.id);

    if (!Number.isInteger(productId) || productId <= 0) {
      return redirectWithNotice(res, 'Invalid product ID.');
    }

    const [result] = await db.query(
      'DELETE FROM products WHERE id = ?',
      [productId]
    );

    if (result.affectedRows === 0) {
      return redirectWithNotice(res, 'Product not found.');
    }

    return redirectWithNotice(res, 'Product deleted successfully.');
  } catch (error) {
    console.error('Unable to delete product:', error);
    return redirectWithNotice(
      res,
      'Unable to delete product. It may be linked to an existing order.'
    );
  }
});

// Update order status


router.post('/orders/:id/status', requireAdmin, async (req, res) => {
  try {
    const orderId = Number(req.params.id);
    const { status } = req.body;

    if (!Number.isInteger(orderId) || orderId <= 0) {
      return redirectWithNotice(res, 'Invalid order ID.');
    }

    if (!ORDER_STATUSES.includes(status)) {
      return redirectWithNotice(res, 'Invalid order status.');
    }

    const [result] = await db.query(
      'UPDATE orders SET status = ? WHERE id = ?',
      [status, orderId]
    );

    if (result.affectedRows === 0) {
      return redirectWithNotice(res, 'Order not found or unchanged.');
    }

    return res.redirect('/admin/dashboard#orders');
  } catch (error) {
    console.error('Unable to update order status:', error);
    return redirectWithNotice(res, 'Unable to update order status.');
  }
});

// Admin logout

router.post('/logout', requireAdmin, (req, res) => {
  req.session.destroy((error) => {
    if (error) {
      console.error('Unable to destroy admin session:', error);
      return res.status(500).send('Unable to log out.');
    }

    res.clearCookie('connect.sid');
    return res.redirect('/admin/login');
  });
});


module.exports = router;