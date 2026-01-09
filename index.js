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
    password: process.env.DB_PASSWORD || '@Dhylhq123', // Password sesuai file Anda
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

// --- [FIX] ENDPOINT 1: KATALOG KURSUS ---
// Menggunakan /api/courses agar sinkron dengan Frontend
app.get('/api/courses', (req, res) => {
    const sql = "SELECT * FROM courses ORDER BY created_at DESC";
    db.query(sql, (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

// --- [NEW] ENDPOINT 2: PENDAFTARAN KURSUS BARU (DARI DASHBOARD) ---
// Digunakan saat siswa klik "Tambah Kursus"
app.post('/api/enrollments/register', (req, res) => {
    const { user_id, course_id } = req.body;
    
    // Cek apakah sudah terdaftar
    const checkSql = "SELECT * FROM enrollments WHERE user_id = ? AND course_id = ?";
    db.query(checkSql, [user_id, course_id], (err, rows) => {
        if (rows && rows.length > 0) {
            return res.status(400).json({ message: "Anda sudah terdaftar di kursus ini." });
        }

        const sql = "INSERT INTO enrollments (user_id, course_id, payment_status) VALUES (?, ?, 'pending')";
        db.query(sql, [user_id, course_id], (err, result) => {
            if (err) return res.status(500).json(err);
            res.json({ message: "Pendaftaran berhasil, silakan bayar.", id: result.insertId });
        });
    });
});

// --- ENDPOINT 3: DASHBOARD SISWA ---
app.get('/api/enrollments/user/:userId', (req, res) => {
    const { userId } = req.params;
    
    // HAPUS "AND e.payment_status = 'paid'" agar semua kursus (baik pending/paid) muncul di dashboard
    const sql = `
        SELECT e.*, c.title, c.instructor, c.price
        FROM enrollments e 
        JOIN courses c ON e.course_id = c.id 
        WHERE e.user_id = ?
    `;

    db.query(sql, [userId], (err, rows) => {
        if (err) {
            console.error("Query Error:", err);
            return res.status(500).json(err);
        }
        console.log("Data ditemukan untuk user", userId, ":", rows.length, "baris"); 
        res.json(rows);
    });
});

// --- ENDPOINT 4: VERIFIKASI PEMBAYARAN (ADMIN) ---
app.post('/api/payments/verify/:enrollmentId', (req, res) => {
    const { enrollmentId } = req.params;
    const sqlUpdate = "UPDATE enrollments SET payment_status = 'paid' WHERE id = ?";
    
    db.query(sqlUpdate, [enrollmentId], (err, result) => {
        if (err) return res.status(500).json(err);

        const sqlInfo = `
            SELECT u.whatsapp, u.name, c.title 
            FROM enrollments e 
            JOIN users u ON e.user_id = u.id 
            JOIN courses c ON e.course_id = c.id 
            WHERE e.id = ?`;
            
        db.query(sqlInfo, [enrollmentId], (err, rows) => {
            if (rows && rows.length > 0) {
                const { whatsapp, name, title } = rows[0];
                sendWA(whatsapp, `Halo ${name}, pembayaran kursus ${title} telah BERHASIL diverifikasi!`);
            }
            res.json({ message: "Verifikasi sukses" });
        });
    });
});

// Ambil daftar pembayaran yang statusnya 'pending'
app.get('/api/admin/pending-payments', (req, res) => {
    const sql = `
        SELECT e.id, u.name as student_name, u.email, c.title as course_title, e.payment_method, c.price
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

// --- ENDPOINT 5: AUTH (LOGIN & REGISTER) ---
app.post('/api/login', (req, res) => {
    const { email, password } = req.body;
    db.query("SELECT * FROM users WHERE email = ?", [email], async (err, rows) => {
        if (err || rows.length === 0) return res.status(401).json({ message: "Email atau Password salah" });

        const user = rows[0];
        const isMatch = await bcrypt.compare(password, user.password);
        if (!isMatch) return res.status(401).json({ message: "Email atau Password salah" });

        const token = jwt.sign({ id: user.id, role: user.role }, 'SECRET_FARAFI_2024', { expiresIn: '1d' });
        res.json({ token, user: { id: user.id, name: user.name, role: user.role } });
    });
});

// --- ENDPOINT 6: PROSES PENDAFTARAN KURSUS BARU ---
// Pastikan rute ini yang digunakan di Frontend
app.post('/api/enrollments/add', (req, res) => {
    const { user_id, course_id, payment_method } = req.body;

    // Validasi input dasar
    if (!user_id || !course_id || !payment_method) {
        return res.status(400).json({ message: "Data tidak lengkap (user_id/course_id/method)" });
    }

    // Cek apakah user sudah terdaftar di kursus ini agar tidak duplikat
    const checkSql = "SELECT * FROM enrollments WHERE user_id = ? AND course_id = ?";
    db.query(checkSql, [user_id, course_id], (err, rows) => {
        if (err) return res.status(500).json({ error: "Database error", detail: err });
        
        if (rows && rows.length > 0) {
            // Ini akan memicu Error 400 di Frontend jika data sudah ada
            return res.status(400).json({ message: "Anda sudah terdaftar di kursus ini." });
        }

        const sql = `
            INSERT INTO enrollments 
            (user_id, course_id, payment_status, payment_method, progress_percentage) 
            VALUES (?, ?, 'pending', ?, 0)
        `;
        
        db.query(sql, [user_id, course_id, payment_method], (err, result) => {
            if (err) return res.status(500).json(err);
            res.json({ 
                message: "Pesanan berhasil dibuat", 
                enrollmentId: result.insertId 
            });
        });
    });
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`🚀 Server berjalan di port ${PORT}`));