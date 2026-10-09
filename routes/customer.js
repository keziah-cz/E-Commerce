
const express = require('express');
const bcrypt = require('bcrypt');
const db = require('../config/db');

const router = express.Router();

// --------------------------------------------------
// Helper functions
// --------------------------------------------------

const getCart = (req) => {
  if (!req.session.cart) {
    req.session.cart = {};
  }

  return req.session.cart;
};

const isCustomer = (req) => req.session.user?.role === 'customer';

const getCartIds = (cart) =>
  Object.keys(cart).filter((id) => Number(cart[id]) > 0);

// Build the cart payload used by the shop page and the cart drawer,
// so newly added drinks appear in the cart without a page refresh.
const buildCartPayload = async (cart) => {
  const ids = getCartIds(cart);

  if (ids.length === 0) {
    return { items: [], total: 0, count: 0 };
  }

  const placeholders = ids.map(() => '?').join(', ');

  const [rows] = await db.query(
    `SELECT id, name, price, image, stock
     FROM products
     WHERE id IN (${placeholders})`,
    ids.map(Number)
  );

  const items = rows.map((product) => {
    const quantity = Number(cart[product.id]);

    return {
      id: product.id,
      name: product.name,
      price: Number(product.price),
      image: product.image,
      stock: Number(product.stock),
      quantity,
      lineTotal: Number(product.price) * quantity,
    };
  });

  const total = items.reduce((sum, item) => sum + item.lineTotal, 0);

  const count = items.reduce((sum, item) => sum + item.quantity, 0);

  return { items, total, count };
};

const renderRegisterError = (res, message, name, email) => {
  return res.status(400).render('customer/register', {
    error: message,
    name,
    email,
  });
};

// --------------------------------------------------
// Home
// --------------------------------------------------

router.get('/', (req, res) => {
  if (isCustomer(req)) {
    return res.redirect('/shop');
  }

  return res.redirect('/login');
});

// --------------------------------------------------
// Customer login
// --------------------------------------------------

router.get('/login', (req, res) => {
  if (req.session.user) {
    return res.redirect('/shop');
  }

  return res.render('customer/login', {
    error: null,
    email: 'customer@sipverse.local',
    password: 'Customer123!',
    registered: req.query.registered === '1',
  });
});

router.post('/login', async (req, res) => {
  const email = (req.body.email || '').trim().toLowerCase();
  const password = req.body.password || '';

  try {
    const [users] = await db.query(
      `SELECT id, name, email, password, role
       FROM users
       WHERE email = ?
       LIMIT 1`,
      [email]
    );

    const user = users[0];

    if (
      !user ||
      user.role !== 'customer' ||
      !(await bcrypt.compare(password, user.password))
    ) {
      return res.status(401).render('customer/login', {
        error: 'Invalid customer email or password.',
        email,
        password: '',
        registered: false,
      });
    }

    req.session.regenerate((error) => {
      if (error) {
        console.error('Customer session error:', error);
        return res.status(500).send('Could not start your session.');
      }

      req.session.user = {
        id: user.id,
        name: user.name,
        email: user.email,
        role: 'customer',
      };

      req.session.cart = {};

      req.session.save((saveError) => {
        if (saveError) {
          console.error('Customer session save error:', saveError);
          return res.status(500).send('Could not save your session.');
        }

        return res.redirect('/shop');
      });
    });
  } catch (error) {
    console.error('Customer login error:', error);
    return res.status(500).send('Unable to sign in.');
  }
});

// --------------------------------------------------
// Customer registration
// --------------------------------------------------

router.get('/register', (req, res) => {
  if (req.session.user) {
    return res.redirect('/shop');
  }

  return res.render('customer/register', {
    error: null,
    name: '',
    email: '',
  });
});

router.post('/register', async (req, res) => {
  const name = (req.body.name || '').trim();
  const email = (req.body.email || '').trim().toLowerCase();
  const password = req.body.password || '';
  const confirmPassword = req.body.confirmPassword || '';

  if (!name || !email || !password || !confirmPassword) {
    return renderRegisterError(
      res,
      'Please complete all fields.',
      name,
      email
    );
  }

  if (password.length < 8) {
    return renderRegisterError(
      res,
      'Password must contain at least 8 characters.',
      name,
      email
    );
  }

  if (password !== confirmPassword) {
    return renderRegisterError(
      res,
      'Passwords do not match.',
      name,
      email
    );
  }

  try {
    const hashedPassword = await bcrypt.hash(password, 12);

    await db.query(
      `INSERT INTO users (name, email, password, role)
       VALUES (?, ?, ?, 'customer')`,
      [name, email, hashedPassword]
    );

    return res.redirect('/login?registered=1');
  } catch (error) {
    console.error('Customer registration error:', error);

    if (error.code === 'ER_DUP_ENTRY') {
      return renderRegisterError(
        res,
        'This email is already registered.',
        name,
        email
      );
    }

    return renderRegisterError(
      res,
      'Could not create your account. Please try again.',
      name,
      email
    );
  }
});

// --------------------------------------------------
// Customer logout
// --------------------------------------------------

router.post('/logout', (req, res) => {
  req.session.destroy((error) => {
    if (error) {
      console.error('Customer logout error:', error);
      return res.status(500).send('Unable to log out.');
    }

    res.clearCookie('connect.sid');
    return res.redirect('/login');
  });
});

// --------------------------------------------------
// Shop
// --------------------------------------------------

router.get('/shop', async (req, res) => {
  if (!isCustomer(req)) {
    return res.redirect('/login');
  }

  try {
    const [categories] = await db.query(
      'SELECT * FROM categories ORDER BY name'
    );

    const [products] = await db.query(
      `SELECT
         p.*,
         c.name AS category_name
       FROM products p
       LEFT JOIN categories c ON c.id = p.category_id
       ORDER BY p.created_at DESC`
    );

    const cart = getCart(req);
    const cartPayload = await buildCartPayload(cart);

    return res.render('customer/shop', {
      user: req.session.user,
      categories,
      products,
      cartItems: cartPayload.items,
      cartTotal: cartPayload.total,
      cartCount: cartPayload.count,
      success: req.query.success || '',
    });
  } catch (error) {
    console.error('Shop loading error:', error);
    return res.status(500).send('Could not load the store.');
  }
});

// --------------------------------------------------
// Add item to cart
// --------------------------------------------------

// Requests made with fetch() receive JSON so the cart drawer can be
// refreshed on the spot instead of reloading the whole store page.
const wantsJson = (req) => {
  const accept = req.get('accept') || '';

  return (
    req.xhr ||
    req.get('content-type')?.includes('application/json') ||
    accept.includes('application/json')
  );
};

router.post('/cart/add/:id', async (req, res) => {
  if (!isCustomer(req)) {
    return res.status(401).json({
      error: 'Please sign in first.',
    });
  }

  const productId = Number(req.params.id);
  const requestedQuantity = Number(req.body.quantity);
  const quantity =
    Number.isFinite(requestedQuantity) && requestedQuantity > 0
      ? Math.floor(requestedQuantity)
      : 1;

  if (!Number.isInteger(productId) || productId <= 0) {
    return res.status(400).json({
      error: 'Invalid drink ID.',
    });
  }

  try {
    const [products] = await db.query(
      'SELECT id, stock FROM products WHERE id = ? LIMIT 1',
      [productId]
    );

    const product = products[0];

    if (!product) {
      return res.status(404).json({
        error: 'Drink not found.',
      });
    }

    const cart = getCart(req);
    const currentQuantity = Number(cart[productId] || 0);
    const nextQuantity = currentQuantity + quantity;

    if (nextQuantity > Number(product.stock)) {
      return res.status(400).json({
        error: `Only ${product.stock} available.`,
      });
    }

    cart[productId] = nextQuantity;

    const payload = await buildCartPayload(cart);

    return res.json({
      ok: true,
      count: payload.count,
      total: payload.total,
      items: payload.items,
      message: 'Added to your cart!',
    });
  } catch (error) {
    console.error('Add to cart error:', error);

    return res.status(500).json({
      error: 'Could not add item to your cart.',
    });
  }
});

// --------------------------------------------------
// Update cart quantity
// --------------------------------------------------

router.post('/cart/update/:id', async (req, res) => {
  if (!isCustomer(req)) {
    if (wantsJson(req)) {
      return res.status(401).json({ error: 'Please sign in first.' });
    }

    return res.redirect('/login');
  }

  const productId = Number(req.params.id);
  const quantity = Number(req.body.quantity);
  const json = wantsJson(req);

  const respond = async (message = '') => {
    if (!json) {
      return res.redirect('/shop');
    }

    const cartPayload = await buildCartPayload(getCart(req));

    return res.json({
      ok: true,
      count: cartPayload.count,
      total: cartPayload.total,
      items: cartPayload.items,
      message,
    });
  };

  if (!Number.isInteger(productId) || productId <= 0) {
    return respond('That drink could not be found.');
  }

  const cart = getCart(req);

  if (!Number.isFinite(quantity) || quantity <= 0) {
    delete cart[productId];
    return respond();
  }

  try {
    const [products] = await db.query(
      'SELECT stock FROM products WHERE id = ? LIMIT 1',
      [productId]
    );

    const product = products[0];

    if (!product || Number(product.stock) <= 0) {
      delete cart[productId];
      return respond('That drink is no longer available.');
    }

    const nextQuantity = Math.min(Math.floor(quantity), Number(product.stock));

    if (quantity > Number(product.stock)) {
      cart[productId] = nextQuantity;
      return respond(`Only ${product.stock} available.`);
    }

    cart[productId] = nextQuantity;

    return respond();
  } catch (error) {
    console.error('Cart update error:', error);

    if (json) {
      return res.status(500).json({
        error: 'Could not update your cart.',
      });
    }

    return res.redirect('/shop');
  }
});

// --------------------------------------------------
// Remove item from cart
// --------------------------------------------------

router.post('/cart/remove/:id', async (req, res) => {
  if (!isCustomer(req)) {
    if (wantsJson(req)) {
      return res.status(401).json({ error: 'Please sign in first.' });
    }

    return res.redirect('/login');
  }

  const productId = Number(req.params.id);

  if (Number.isInteger(productId) && productId > 0) {
    delete getCart(req)[productId];
  }

  if (!wantsJson(req)) {
    return res.redirect('/shop');
  }

  try {
    const payload = await buildCartPayload(getCart(req));

    return res.json({
      ok: true,
      count: payload.count,
      total: payload.total,
      items: payload.items,
      message: 'Drink removed from your cart.',
    });
  } catch (error) {
    console.error('Cart remove error:', error);

    return res.status(500).json({
      error: 'Could not remove that drink from your cart.',
    });
  }
});

// --------------------------------------------------
// Checkout
// --------------------------------------------------

router.post('/checkout', async (req, res) => {
  if (!isCustomer(req)) {
    return res.redirect('/login');
  }

  const cart = getCart(req);
  const ids = getCartIds(cart);

  if (ids.length === 0) {
    return res.redirect('/shop');
  }

  const contactName = (req.body.name || '').trim();
  const contactPhone = (req.body.phone || '').trim();
  const contactEmail = (req.body.email || '').trim().toLowerCase();
  const addressCity = (req.body.city || '').trim();
  const addressBarangay = (req.body.barangay || '').trim();
  const addressStreet = (req.body.street || '').trim();
  const addressDetails = (req.body.addressDetails || '').trim();

  if (
    !contactName ||
    !contactPhone ||
    !contactEmail ||
    !addressCity ||
    !addressBarangay ||
    !addressStreet ||
    !addressDetails
  ) {
    return res.redirect('/shop?success=' + encodeURIComponent('Please complete your delivery details.'));
  }

  let connection;

  try {
    connection = await db.getConnection();

    await connection.beginTransaction();

    const placeholders = ids.map(() => '?').join(', ');

    const [products] = await connection.query(
      `SELECT id, name, price, stock
       FROM products
       WHERE id IN (${placeholders})
       FOR UPDATE`,
      ids.map(Number)
    );

    if (products.length !== ids.length) {
      throw new Error('A drink in your cart is no longer available.');
    }

    let total = 0;

    for (const product of products) {
      const quantity = Number(cart[product.id]);

      if (
        !Number.isInteger(quantity) ||
        quantity <= 0 ||
        quantity > Number(product.stock)
      ) {
        throw new Error(
          `${product.name}: insufficient stock. Please update your cart.`
        );
      }

      total += Number(product.price) * quantity;
    }

    const [order] = await connection.query(
      `INSERT INTO orders
         (user_id, total_amount, status, contact_name, contact_phone,
          contact_email, address_city, address_barangay, address_street,
          address_details)
       VALUES (?, ?, 'Pending', ?, ?, ?, ?, ?, ?, ?)`,
      [
        req.session.user.id,
        total,
        contactName,
        contactPhone,
        contactEmail,
        addressCity,
        addressBarangay,
        addressStreet,
        addressDetails,
      ]
    );

    for (const product of products) {
      const quantity = Number(cart[product.id]);

      await connection.query(
        `INSERT INTO order_items
           (order_id, product_id, quantity, price)
         VALUES (?, ?, ?, ?)`,
        [
          order.insertId,
          product.id,
          quantity,
          product.price,
        ]
      );

      await connection.query(
        'UPDATE products SET stock = stock - ? WHERE id = ?',
        [quantity, product.id]
      );
    }

    await connection.commit();

    req.session.cart = {};

    return res.redirect(
      '/shop?success=' +
        encodeURIComponent('Order placed successfully!')
    );
  } catch (error) {
    if (connection) {
      try {
        await connection.rollback();
      } catch (rollbackError) {
        console.error('Checkout rollback error:', rollbackError);
      }
    }

    console.error('Checkout error:', error);

    return res.redirect(
      '/shop?success=' +
        encodeURIComponent(error.message || 'Checkout failed. Please try again.')
    );
  } finally {
    if (connection) {
      connection.release();
    }
  }
});

// --------------------------------------------------
// Customer order status
// --------------------------------------------------

router.get('/orders', async (req, res) => {
  if (!isCustomer(req)) {
    return res.status(401).json({ error: 'Please sign in first.' });
  }

  try {
    const [orders] = await db.query(
      `SELECT
         o.id,
         o.total_amount,
         o.status,
         o.created_at,
         oi.quantity,
         oi.price,
         p.name,
         p.image
       FROM orders o
       LEFT JOIN order_items oi ON oi.order_id = o.id
       LEFT JOIN products p ON p.id = oi.product_id
       WHERE o.user_id = ?
      ORDER BY o.created_at DESC, o.id DESC`,
      [req.session.user.id]
    );

    const groupedOrders = [];

    for (const row of orders) {
      let order = groupedOrders.find((entry) => entry.id === row.id);

      if (!order) {
        order = {
          id: row.id,
          total: Number(row.total_amount),
          status: row.status,
          createdAt: row.created_at,
          items: [],
        };
        groupedOrders.push(order);
      }

      if (row.name) {
        order.items.push({
          name: row.name,
          image: row.image,
          quantity: Number(row.quantity),
          price: Number(row.price),
        });
      }
    }

    return res.json({ orders: groupedOrders });
  } catch (error) {
    console.error('Order status error:', error);
    return res.status(500).json({ error: 'Could not load your orders.' });
  }
});

// --------------------------------------------------
// Export router
// --------------------------------------------------

module.exports = router;