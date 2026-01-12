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

app.post('/api/register', async (req, res) => {
    const { name, email, whatsapp, password } = req.body;

    // Validasi input dasar
    if (!name || !email || !whatsapp || !password) {
        return res.status(400).json({ message: "Semua kolom wajib diisi!" });
    }

    try {
        const hashedPassword = await bcrypt.hash(password, 10);
        const sql = "INSERT INTO users (name, email, whatsapp, password, role) VALUES (?, ?, ?, ?, 'siswa')";
        
        db.query(sql, [name, email, whatsapp, hashedPassword], (err, result) => {
            if (err) {
                if (err.code === 'ER_DUP_ENTRY') {
                    return res.status(400).json({ message: "Email atau Nomor WA sudah terdaftar" });
                }
                return res.status(500).json({ message: "Gagal menyimpan ke database" });
            }
            res.status(201).json({ message: "Registrasi Berhasil" });
        });
    } catch (error) {
        res.status(500).json({ message: "Internal Server Error" });
    }
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

// Ambil materi kursus berdasarkan progres siswa
app.get('/api/courses/:courseId/lessons', (req, res) => {
    const { courseId } = req.params;
    const userId = req.query.userId; // Dari Auth Context

    const sql = `
        SELECT l.*, 
        (SELECT COUNT(*) FROM student_progress sp WHERE sp.lesson_id = l.id AND sp.user_id = ?) as isCompleted
        FROM lessons l 
        WHERE l.course_id = ? 
        ORDER BY l.order_index ASC
    `;
    db.query(sql, [userId, courseId], (err, rows) => {
        if (err) return res.status(500).json(err);
        res.json(rows);
    });
});

// Endpoint untuk menandai materi selesai dan hitung persentase otomatis
app.post('/api/progress/complete', (req, res) => {
    const { userId, lessonId, courseId } = req.body;

    // 1. Simpan progres materi
    const sqlInsert = "INSERT IGNORE INTO student_progress (user_id, lesson_id) VALUES (?, ?)";
    db.query(sqlInsert, [userId, lessonId], (err) => {
        if (err) return res.status(500).json(err);

        // 2. Hitung Total Materi di Kursus tsb
        db.query("SELECT COUNT(*) as total FROM lessons WHERE course_id = ?", [courseId], (err, resTotal) => {
            const totalMateri = resTotal[0].total;

            // 3. Hitung Materi yang sudah diselesaikan User di kursus tsb
            const sqlCountDone = `
                SELECT COUNT(*) as done FROM student_progress sp 
                JOIN lessons l ON sp.lesson_id = l.id 
                WHERE sp.user_id = ? AND l.course_id = ?
            `;
            db.query(sqlCountDone, [userId, courseId], (err, resDone) => {
                const materiSelesai = resDone[0].done;
                const persentase = Math.round((materiSelesai / totalMateri) * 100);

                // 4. Update persentase di tabel enrollments
                db.query(
                    "UPDATE enrollments SET progress_percentage = ? WHERE user_id = ? AND course_id = ?",
                    [persentase, userId, courseId],
                    () => {
                        res.json({ message: "Progres berhasil diperbarui", progress: persentase });
                    }
                );
            });
        });
    });
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`🚀 Server berjalan di port ${PORT}`));