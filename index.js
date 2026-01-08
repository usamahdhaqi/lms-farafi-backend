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
app.use('/uploads', express.static('uploads')); // Untuk akses file bukti transfer

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

// --- UTILITY: INTEGRASI WHATSAPP (FONNTE) ---
const sendWA = async (target, message) => {
    try {
        await axios.post('https://api.fonnte.com/send', {
            target: target,
            message: message
        }, {
            headers: { 'Authorization': process.env.FONNTE_TOKEN }
        });
        console.log(`✅ WA Terkirim ke ${target}`);
    } catch (error) {
        console.error('❌ Gagal kirim WA:', error.message);
    }
};

// --- ENDPOINT 1: AUTENTIKASI (FASE 1) ---

// Register
app.post('/auth/register', async (req, res) => {
    const { name, email, whatsapp, password } = req.body;

    // Tambahkan Log untuk debugging di terminal backend
    console.log("Data diterima:", req.body);

    if (!name || !email || !whatsapp || !password) {
        return res.status(400).json({ message: "Semua kolom wajib diisi!" });
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    const sql = "INSERT INTO users (name, email, whatsapp, password, role) VALUES (?, ?, ?, ?, 'siswa')";
    
    db.query(sql, [name, email, whatsapp, hashedPassword], (err, result) => {
        if (err) {
            console.error("MySQL Error:", err); // Lihat terminal backend untuk detail error asli
            if (err.code === 'ER_DUP_ENTRY') {
                return res.status(400).json({ message: "Email atau Nomor WA sudah terdaftar" });
            }
            return res.status(500).json({ message: "Gagal menyimpan ke database: " + err.message });
        }
        res.status(201).json({ message: "Registrasi Berhasil" });
    });
});

// Login
app.post('/auth/login', (req, res) => {
    const { email, password } = req.body;
    const sql = "SELECT * FROM users WHERE email = ?";
    
    db.query(sql, [email], async (err, results) => {
        if (err || results.length === 0) return res.status(401).json({ message: "User tidak ditemukan" });

        const user = results[0];
        const isMatch = await bcrypt.compare(password, user.password);
        
        if (!isMatch) return res.status(401).json({ message: "Password salah" });

        const token = jwt.sign({ id: user.id, role: user.role }, process.env.JWT_SECRET || 'farafi_secret', { expiresIn: '2h' });
        res.json({ token, user: { id: user.id, name: user.name, role: user.role } });
    });
});

// --- ENDPOINT 2: PEMBELAJARAN (FASE 2) ---

// Update Progress Materi
app.post('/api/courses/:courseId/lessons/:lessonId/complete', (req, res) => {
    const { courseId, lessonId } = req.params;
    const { userId } = req.body; // Idealnya diambil dari decode JWT middleware

    const sql = "UPDATE enrollments SET progress_percentage = progress_percentage + 10 WHERE user_id = ? AND course_id = ?";
    db.query(sql, [userId, courseId], (err, result) => {
        if (err) return res.status(500).json(err);
        res.json({ message: "Progress updated" });
    });
});

// --- ENDPOINT 3: EVALUASI & KUIS (FASE 3) ---

app.post('/api/courses/:courseId/quiz/submit', (req, res) => {
    const { courseId } = req.params;
    const { userId, score } = req.body;
    const isPassed = score >= 75;

    const sql = "UPDATE enrollments SET quiz_score = ?, is_passed = ? WHERE user_id = ? AND course_id = ?";
    db.query(sql, [score, isPassed, userId, courseId], (err, result) => {
        if (err) return res.status(500).json(err);
        res.json({ is_passed: isPassed, score: score });
    });
});

// --- ENDPOINT 4: ADMIN & VERIFIKASI (FASE 1 & 4) ---

// Verifikasi Pembayaran Manual oleh Admin
app.post('/api/payments/verify/:enrollmentId', (req, res) => {
    const { enrollmentId } = req.params;

    // 1. Update Status Pembayaran
    const sql = "UPDATE enrollments SET payment_status = 'paid' WHERE id = ?";
    db.query(sql, [enrollmentId], (err, result) => {
        if (err) return res.status(500).json(err);

        // 2. Ambil data user untuk kirim WA
        const getUserSql = `
            SELECT u.whatsapp, u.name, c.title 
            FROM enrollments e 
            JOIN users u ON e.user_id = u.id 
            JOIN courses c ON e.course_id = c.id 
            WHERE e.id = ?`;
            
        db.query(getUserSql, [enrollmentId], (err, rows) => {
            if (rows.length > 0) {
                const { whatsapp, name, title } = rows[0];
                const message = `Halo ${name}, pembayaran untuk kursus ${title} telah DITERIMA. Sekarang Anda bisa mulai belajar di dashboard LPK Farafi.`;
                sendWA(whatsapp, message);
            }
        });

        res.json({ message: "Pembayaran Diverifikasi & WA Terkirim" });
    });
});

// --- SERVER LISTEN ---
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
    console.log(`🚀 Server LPK Farafi running on port ${PORT}`);
});