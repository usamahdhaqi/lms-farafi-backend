const express = require('express');
const mysql = require('mysql2');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const axios = require('axios');
require('dotenv').config();

const app = express();

// --- MIDDLEWARE ---
app.use(cors());
app.use(express.json());
app.use('/uploads', express.static('uploads')); 

// --- KONFIGURASI DATABASE ---
const db = mysql.createConnection({
    host: process.env.DB_HOST || 'localhost',
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '@Dhylhq123',
    database: process.env.DB_NAME || 'lms_lpk_farafi'
});

db.connect(err => {
    if (err) {
        console.error('❌ Database Error:', err);
        return;
    }
    console.log('✅ MySQL Connected: lms_lpk_farafi');
});

// --- UTILITY: INTEGRASI WHATSAPP ---
const sendWA = async (target, message) => {
    try {
        await axios.post('https://api.fonnte.com/send', {
            target: target,
            message: message
        }, {
            headers: { 'Authorization': process.env.FONNTE_TOKEN }
        });
    } catch (err) {
        console.error('Gagal kirim WA:', err.message);
    }
};

// --- ENDPOINT 1: KATALOG KURSUS (UNTUK LANDING PAGE) ---
app.get('/api/courses', (req, res) => {
    const sql = "SELECT * FROM courses ORDER BY created_at DESC";
    db.query(sql, (err, rows) => {
        if (err) return res.status(500).json(err);
        res.json(rows);
    });
});

// --- ENDPOINT 2: DASHBOARD SISWA (KURSUS YANG DIBELI) ---
app.get('/api/enrollments/user/:userId', (req, res) => {
    const { userId } = req.params;
    const sql = `
        SELECT e.*, c.title, c.instructor, c.category 
        FROM enrollments e 
        JOIN courses c ON e.course_id = c.id 
        WHERE e.user_id = ? AND e.payment_status = 'paid'
    `;
    db.query(sql, [userId], (err, rows) => {
        if (err) return res.status(500).json(err);
        res.json(rows);
    });
});

// --- ENDPOINT 3: ADMIN - LIST PEMBAYARAN PENDING ---
app.get('/api/admin/pending-payments', (req, res) => {
    const sql = `
        SELECT e.*, u.name as student_name, u.email, c.title as course_title 
        FROM enrollments e 
        JOIN users u ON e.user_id = u.id 
        JOIN courses c ON e.course_id = c.id 
        WHERE e.payment_status = 'pending'
    `;
    db.query(sql, (err, rows) => {
        if (err) return res.status(500).json(err);
        res.json(rows);
    });
});

// --- ENDPOINT 4: VERIFIKASI PEMBAYARAN (OLEH ADMIN) ---
app.post('/api/payments/verify/:enrollmentId', (req, res) => {
    const { enrollmentId } = req.params;

    // 1. Update Status
    const sqlUpdate = "UPDATE enrollments SET payment_status = 'paid' WHERE id = ?";
    db.query(sqlUpdate, [enrollmentId], (err, result) => {
        if (err) return res.status(500).json(err);

        // 2. Ambil data untuk notifikasi WA
        const sqlInfo = `
            SELECT u.whatsapp, u.name, c.title 
            FROM enrollments e 
            JOIN users u ON e.user_id = u.id 
            JOIN courses c ON e.course_id = c.id 
            WHERE e.id = ?`;
            
        db.query(sqlInfo, [enrollmentId], (err, rows) => {
            if (rows && rows.length > 0) {
                const { whatsapp, name, title } = rows[0];
                const msg = `Halo ${name}, pembayaran kursus ${title} telah BERHASIL diverifikasi. Selamat belajar!`;
                sendWA(whatsapp, msg);
            }
            res.json({ message: "Verifikasi berhasil & WA terkirim" });
        });
    });
});

// --- ENDPOINT 5: LOGIN ---
app.post('/api/login', (req, res) => {
    const { email, password } = req.body;
    db.query("SELECT * FROM users WHERE email = ?", [email], async (err, rows) => {
        if (err) return res.status(500).json(err);
        if (rows.length === 0) return res.status(404).json({ message: "User tidak ditemukan" });

        const user = rows[0];
        const isMatch = await bcrypt.compare(password, user.password);
        if (!isMatch) return res.status(401).json({ message: "Password salah" });

        const token = jwt.sign({ id: user.id, role: user.role }, 'SECRET_KEY_FARAFI', { expiresIn: '1d' });
        res.json({ 
            token, 
            user: { id: user.id, name: user.name, role: user.role } 
        });
    });
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));