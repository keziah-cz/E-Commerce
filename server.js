
require('dotenv').config();

const express = require('express');
const session = require('express-session');
const path = require('path');
const db = require('./config/db');

const customerRoutes = require('./routes/customer');
const adminRoutes = require('./routes/admin');

const app = express();

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.use(session({
    name: 'connect.sid',
    secret: process.env.SESSION_SECRET || 'development_secret_change_me',
    resave: false,
    saveUninitialized: false,
    cookie: {
        httpOnly: true,
        sameSite: 'lax',
        secure: process.env.NODE_ENV === 'production',
        maxAge: 1000 * 60 * 60
    }
}));

app.use('/', customerRoutes);
app.use('/admin', adminRoutes);

app.use((req, res) => {
    res.status(404).send('Page not found.');
});

async function startServer() {
    try {
        const connection = await db.getConnection();
        console.log('MySQL connected successfully.');
        connection.release();

        const orderColumns = [
            ['contact_name', 'VARCHAR(150) NULL'],
            ['contact_phone', 'VARCHAR(40) NULL'],
            ['contact_email', 'VARCHAR(255) NULL'],
            ['address_city', 'VARCHAR(100) NULL'],
            ['address_barangay', 'VARCHAR(100) NULL'],
            ['address_street', 'VARCHAR(255) NULL'],
            ['address_details', 'VARCHAR(255) NULL'],
        ];

        for (const [column, definition] of orderColumns) {
            const [existingColumns] = await db.query(
                `SELECT COUNT(*) AS total
                 FROM INFORMATION_SCHEMA.COLUMNS
                 WHERE TABLE_SCHEMA = DATABASE()
                   AND TABLE_NAME = 'orders'
                   AND COLUMN_NAME = ?`,
                [column]
            );

            if (Number(existingColumns[0].total) === 0) {
                await db.query(`ALTER TABLE orders ADD COLUMN ${column} ${definition}`);
            }
        }

        const PORT = process.env.PORT || 3000;

        app.listen(PORT, () => {
            console.log(`SipVerse is running at http://localhost:${PORT}`);
        });
    } catch (error) {
        console.error('Could not connect to MySQL:', error.message);
        process.exit(1);
    }
}

startServer();