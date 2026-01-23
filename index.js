const express = require('express');
const mysql = require('mysql2');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const axios = require('axios');
require('dotenv').config();

const app = express();

const multer = require('multer');
const path = require('path');
const fs = require('fs');

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

// Pastikan folder 'uploads' ada
const uploadDir = 'uploads';
if (!fs.existsSync(uploadDir)){
    fs.mkdirSync(uploadDir);
}

// Konfigurasi Penyimpanan Multer
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, 'uploads/');
    },
    filename: (req, file, cb) => {
        // Beri nama unik: timestamp-namaasli
        cb(null, Date.now() + '-' + file.originalname);
    }
});

const upload = multer({ storage: storage });

// Daftarkan folder uploads agar bisa diakses via browser
app.use('/uploads', express.static('uploads'));

// --- [FIX] ENDPOINT 1: KATALOG KURSUS ---
// Menggunakan /api/courses agar sinkron dengan Frontend
app.get('/api/courses', (req, res) => {
    // Gunakan JOIN untuk mengambil nama instruktur dari tabel users
    const sql = `
        SELECT c.*, u.name AS instructor_name 
        FROM courses c
        LEFT JOIN users u ON c.instructor_id = u.id
        ORDER BY c.created_at DESC
    `;
    db.query(sql, (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

// Endpoint untuk siswa mengambil daftar materi beserta status selesainya
app.get('/api/courses/:courseId/lessons', (req, res) => {
    const { courseId } = req.params;
    const { userId } = req.query; // Ambil userId dari query string

    // Query untuk mengambil materi dan cek apakah user sudah menyelesaikannya
    const sql = `
        SELECT l.*, 
        (SELECT COUNT(*) FROM student_progress sp WHERE sp.lesson_id = l.id AND sp.user_id = ?) as is_completed
        FROM lessons l
        WHERE l.course_id = ?
        ORDER BY l.order_index ASC
    `;

    db.query(sql, [userId, courseId], (err, rows) => {
        if (err) {
            console.error("❌ SQL Error Student Lessons:", err.message);
            return res.status(500).json({ error: err.message });
        }
        
        if (rows.length === 0) {
            // Berikan array kosong jika belum ada materi, jangan 404 agar frontend tidak crash
            return res.json([]);
        }

        res.json(rows);
    });
});

// Route untuk mengambil materi kursus beserta status progres user
app.get('/api/courses/:courseId/lessons', (req, res) => {
  const { courseId } = req.params;
  const { userId } = req.query; // Diambil dari query parameter ?userId=...

  // Query SQL untuk menggabungkan data materi dengan progres dari tabel student_progress
  const sql = `
    SELECT 
      l.*, 
      IFNULL(sp.is_completed, 0) AS isCompleted 
    FROM lessons l
    LEFT JOIN student_progress sp ON l.id = sp.lesson_id AND sp.user_id = ?
    WHERE l.course_id = ?
    ORDER BY l.order_number ASC
  `;

  db.query(sql, [userId, courseId], (err, results) => {
    if (err) {
      return res.status(500).json({ error: "Gagal mengambil data materi" });
    }
    res.json(results);
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
    
    // Gunakan JOIN u2 untuk mengambil nama instruktur dari tabel users
    const sql = `
        SELECT 
            e.*, 
            c.title, 
            c.description, 
            u2.name AS instructor_name,  -- Mengambil nama asli instruktur
            c.image_url
        FROM enrollments e
        JOIN courses c ON e.course_id = c.id
        LEFT JOIN users u2 ON c.instructor_id = u2.id -- Relasi ke instruktur
        WHERE e.user_id = ?
    `;

    db.query(sql, [userId], (err, rows) => {
        if (err) {
            console.error("❌ SQL Error Detail:", err.message); // Cek ini di terminal server Anda
            return res.status(500).json({ error: err.message });
        }
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
    // Pastikan semua kolom menggunakan alias tabel (e untuk enrollments, u untuk users, c untuk courses)
    const sql = `
        SELECT 
            e.id, 
            u.name AS student_name, 
            u.email, 
            c.title AS course_title, 
            c.price,              -- Pastikan mengambil price dari tabel courses
            e.payment_method, 
            e.payment_status,
            e.updated_at
        FROM enrollments e
        JOIN users u ON e.user_id = u.id
        JOIN courses c ON e.course_id = c.id
        WHERE e.payment_status = 'pending'
        ORDER BY e.updated_at DESC
    `;

    db.query(sql, (err, rows) => {
        if (err) {
            console.error("❌ Error pada Pending Payments:", err.message); // Cek pesan error ini di terminal backend
            return res.status(500).json({ error: err.message });
        }
        res.json(rows);
    });
});

// --- ENDPOINT 5: AUTH (LOGIN & REGISTER) ---
app.post('/api/login', (req, res) => {
    const { email, password } = req.body;
    const sql = "SELECT * FROM users WHERE email = ?";
    
    db.query(sql, [email], async (err, result) => {
        if (err) return res.status(500).json({ message: "Kesalahan Database" });
        if (result.length === 0) return res.status(404).json({ message: "User tidak ditemukan" });

        const user = result[0];
        const isMatch = await bcrypt.compare(password, user.password);
        
        if (!isMatch) return res.status(401).json({ message: "Password salah" });

        const token = jwt.sign(
            { id: user.id, role: user.role }, 
            process.env.JWT_SECRET || 'secretkey', 
            { expiresIn: '1d' }
        );

        // PASTIKAN OBJEK USER DIKIRIM LENGKAP KE FRONTEND
        res.json({
            token,
            user: {
                id: user.id,
                name: user.name,
                email: user.email,
                role: user.role // Frontend butuh ini untuk redirect
            }
        });
    });
});

app.post('/api/register', async (req, res) => {
    const { name, email, whatsapp, password } = req.body;
    try {
        const hashedPassword = await bcrypt.hash(password, 10);
        const sql = "INSERT INTO users (name, email, whatsapp, password, role) VALUES (?, ?, ?, ?, 'siswa')";
        db.query(sql, [name, email, whatsapp, hashedPassword], (err, result) => {
            if (err) return res.status(500).json({ message: "Email sudah terdaftar atau error database" });
            res.json({ message: "Registrasi berhasil" });
        });
    } catch (error) {
        res.status(500).json(error);
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

// Endpoint untuk mengambil materi berdasarkan user yang login
app.get('/api/instructor/courses/:courseId/lessons', (req, res) => {
    const { courseId } = req.params;
    // Tambahkan ORDER BY order_index ASC agar urutan konsisten
    const sql = "SELECT * FROM lessons WHERE course_id = ? ORDER BY order_index ASC";
    db.query(sql, [courseId], (err, rows) => {
        if (err) return res.status(500).json(err);
        res.json(rows);
    });
});

// Endpoint untuk menandai materi selesai dan hitung persentase otomatis
app.post('/api/progress/complete', (req, res) => {
    const { userId, lessonId, courseId } = req.body;

    console.log(`--- Memulai Progres: User ${userId}, Course ${courseId} ---`);

    // 1. Simpan ke student_progress (Gunakan INSERT IGNORE agar tidak duplikat)
    const sqlInsert = "INSERT IGNORE INTO student_progress (user_id, lesson_id) VALUES (?, ?)";
    db.query(sqlInsert, [userId, lessonId], (err, result) => {
        if (err) {
            console.error("❌ Gagal Insert Progress:", err);
            return res.status(500).json(err);
        }

        // 2. Hitung TOTAL materi yang ada di kursus tersebut
        db.query("SELECT COUNT(*) as total FROM lessons WHERE course_id = ?", [courseId], (err, resTotal) => {
            const totalMateri = resTotal[0].total;
            console.log(`Total Materi di DB: ${totalMateri}`);

            // 3. Hitung materi yang SUDAH diselesaikan user INI pada kursus INI
            const sqlCountDone = `
                SELECT COUNT(*) as done 
                FROM student_progress sp 
                JOIN lessons l ON sp.lesson_id = l.id 
                WHERE sp.user_id = ? AND l.course_id = ?
            `;
            
            db.query(sqlCountDone, [userId, courseId], (err, resDone) => {
                const materiSelesai = resDone[0].done;
                console.log(`Materi Selesai oleh User: ${materiSelesai}`);

                // 4. Hitung Persentase
                const persentase = totalMateri > 0 ? Math.round((materiSelesai / totalMateri) * 100) : 0;
                console.log(`Hasil Hitung: ${persentase}%`);

                // 5. Update tabel enrollments
                const sqlUpdate = "UPDATE enrollments SET progress_percentage = ? WHERE user_id = ? AND course_id = ?";
                db.query(sqlUpdate, [persentase, userId, courseId], (err, updateResult) => {
                    if (err) {
                        console.error("❌ Gagal Update Enrollments:", err);
                        return res.status(500).json(err);
                    }
                    
                    console.log(`✅ Database Updated! Rows Affected: ${updateResult.affectedRows}`);
                    res.json({ 
                        success: true, 
                        progress: persentase,
                        message: `Progres diperbarui ke ${persentase}%` 
                    });
                });
            });
        });
    });
});

// Endpoint untuk mengambil bank soal dari database
app.get('/api/quiz/:courseId', (req, res) => {
    const { courseId } = req.params;
    const sql = "SELECT * FROM quiz_questions WHERE course_id = ? ORDER BY RAND()"; // Acak soal
    db.query(sql, [courseId], (err, rows) => {
        if (err) return res.status(500).json(err);
        res.json(rows);
    });
});

// Endpoint untuk submit hasil kuis
app.post('/api/quiz/submit', (req, res) => {
    // Ambil course_id (snake_case agar sinkron dengan frontend)
    const { userId, course_id, score, isPassed } = req.body;

    const sql = `
        UPDATE enrollments 
        SET quiz_score = ?, is_passed = ?, progress_percentage = 100 
        WHERE user_id = ? AND course_id = ?
    `;

    db.query(sql, [score, isPassed ? 1 : 0, userId, course_id], (err, result) => {
        if (err) {
            console.error(err);
            return res.status(500).json({ message: "Gagal menyimpan hasil kuis" });
        }
        res.json({ message: "Skor berhasil disimpan dan progres 100%" });
    });
});

// --- ENDPOINT: AMBIL SERTIFIKAT (KURSUS YANG LULUS) ---
app.get('/api/certificates/user/:userId', (req, res) => {
    const { userId } = req.params;
    
    // Ganti e.updated_at menjadi CURRENT_TIMESTAMP jika kolom belum ada, 
    // atau pastikan kolom tersebut sudah Anda tambahkan di database.
    const sql = `
        SELECT 
            e.id as cert_id, 
            c.title as course_name, 
            e.quiz_score, 
            NOW() as date -- Menggunakan waktu sekarang sebagai alternatif sementara
        FROM enrollments e
        JOIN courses c ON e.course_id = c.id
        WHERE e.user_id = ? AND e.is_passed = TRUE
    `;

    db.query(sql, [userId], (err, rows) => {
        if (err) {
            console.error("Query Error:", err);
            return res.status(500).json({ error: "Gagal mengambil data sertifikat", detail: err.message });
        }
        res.json(rows);
    });
});

// Endpoint untuk memantau semua progres belajar siswa
app.get('/api/admin/student-progress', (req, res) => {
    const sql = `
        SELECT 
            e.id, u.name, u.email, c.title as course_title, e.course_id,
            e.progress_percentage, e.quiz_score, e.is_passed, e.payment_status
        FROM enrollments e
        JOIN users u ON e.user_id = u.id
        JOIN courses c ON e.course_id = c.id
        WHERE e.payment_status = 'paid'
        ORDER BY e.progress_percentage DESC
    `;
    db.query(sql, (err, rows) => {
        if (err) return res.status(500).json(err);
        res.json(rows);
    });
});

// --- ENDPOINT INSTRUKTUR: KURSUS YANG DIAJAR ---
app.get('/api/instructor/courses/:instructorId', (req, res) => {
    const { instructorId } = req.params;
    const sql = "SELECT * FROM courses WHERE instructor_id = ?";
    db.query(sql, [instructorId], (err, rows) => {
        if (err) return res.status(500).json(err);
        res.json(rows);
    });
});

// --- ENDPOINT INSTRUKTUR: LIHAT SISWA DI KURSUS TERTENTU ---
app.get('/api/instructor/students/:courseId', (req, res) => {
    const { courseId } = req.params;
    const sql = `
        SELECT u.name, u.email, e.progress_percentage, e.quiz_score, e.is_passed
        FROM enrollments e
        JOIN users u ON e.user_id = u.id
        WHERE e.course_id = ? AND e.payment_status = 'paid'
    `;
    db.query(sql, [courseId], (err, rows) => {
        if (err) return res.status(500).json(err);
        res.json(rows);
    });
});

// Mendapatkan detail materi untuk dikelola instruktur
app.post('/api/instructor/lessons', upload.single('file'), (req, res) => {
    const { title, type, course_id, order_index, content_url } = req.body;
    
    // Jika ada file yang diupload, gunakan path file tersebut. Jika tidak, gunakan content_url (link video)
    const finalContentUrl = req.file 
        ? `http://localhost:5000/uploads/${req.file.filename}` 
        : content_url;

    const sql = `
        INSERT INTO lessons (title, type, content_url, course_id, order_index) 
        VALUES (?, ?, ?, ?, ?)
    `;

    db.query(sql, [title, type, finalContentUrl, course_id, order_index], (err, result) => {
        if (err) {
            console.error("❌ SQL Error:", err.message);
            return res.status(500).json({ error: err.message });
        }
        res.json({ message: "Materi berhasil disimpan!", id: result.insertId });
    });
});

// Endpoint untuk Bulk Update Urutan Materi
app.put('/api/instructor/lessons/reorder', (req, res) => {
    console.log("📢 REQUEST MASUK KE BACKEND!"); // Jika ini tidak muncul, berarti rute salah
    
    const { sortedIds } = req.body;
    console.log("📦 Body Data:", sortedIds);

    if (!sortedIds || !Array.isArray(sortedIds)) {
        console.log("❌ Validasi Gagal: sortedIds bukan array");
        return res.status(400).json({ error: "Data tidak valid" });
    }

    // Gunakan fungsi recursive sederhana untuk menjamin urutan
    let i = 0;
    const updateOneByOne = () => {
        if (i >= sortedIds.length) {
            console.log("✅ SEMUA ID BERHASIL DIUPDATE");
            return res.json({ success: true });
        }

        const id = sortedIds[i];
        const newOrder = i + 1;

        console.log(`Update ID ${id} -> Order ${newOrder}`);

        db.query("UPDATE lessons SET order_index = ? WHERE id = ?", [newOrder, id], (err) => {
            if (err) {
                console.error("❌ SQL ERROR DI DALAM LOOP:", err.message);
                return res.status(500).json({ error: err.message });
            }
            i++;
            updateOneByOne();
        });
    };

    updateOneByOne();
});

// Endpoint untuk Update/Edit Materi (Mendukung upload file baru atau ganti link)
app.put('/api/instructor/lessons/:id', upload.single('file'), (req, res) => {
    const { id } = req.params;
    const { title, type, content_url, order_index } = req.body;
    
    // Logika penentuan URL: Gunakan file baru jika ada, jika tidak gunakan URL lama
    let finalContentUrl = content_url;
    if (req.file) {
        finalContentUrl = `http://localhost:5000/uploads/${req.file.filename}`;
    }

    const sql = `
        UPDATE lessons 
        SET title = ?, type = ?, content_url = ?, order_index = ? 
        WHERE id = ?
    `;

    db.query(sql, [title, type, finalContentUrl, order_index, id], (err, result) => {
        if (err) {
            console.error("❌ SQL Edit Error:", err.message);
            return res.status(500).json({ error: "Gagal memperbarui materi" });
        }
        res.json({ message: "Materi berhasil diperbarui!" });
    });
});

// Ambil semua soal untuk kursus tertentu (untuk dikelola instruktur)
app.get('/api/instructor/quiz-questions/:courseId', (req, res) => {
    const { courseId } = req.params;
    const sql = "SELECT * FROM quiz_questions WHERE course_id = ? ORDER BY id DESC";
    db.query(sql, [courseId], (err, rows) => {
        if (err) return res.status(500).json({ message: "Gagal mengambil bank soal" });
        res.json(rows);
    });
});

// Tambah soal baru
app.post('/api/instructor/quiz-questions', (req, res) => {
    const { course_id, question, option_a, option_b, option_c, option_d, correct_option } = req.body;
    
    // correct_option akan berisi 'a', 'b', 'c', atau 'd' dari frontend
    const sql = `INSERT INTO quiz_questions 
        (course_id, question, option_a, option_b, option_c, option_d, correct_option) 
        VALUES (?, ?, ?, ?, ?, ?, ?)`;
    
    db.query(sql, [course_id, question, option_a, option_b, option_c, option_d, correct_option], (err, result) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ message: "Soal berhasil ditambahkan!" });
    });
});

// Hapus soal
app.delete('/api/instructor/quiz-questions/:questionId', (req, res) => {
    const { questionId } = req.params;
    const sql = "DELETE FROM quiz_questions WHERE id = ?";
    db.query(sql, [questionId], (err, result) => {
        if (err) return res.status(500).json({ message: "Gagal menghapus soal" });
        res.json({ message: "Soal berhasil dihapus" });
    });
});

// 1. Endpoint untuk Update Materi (Edit)
app.put('/api/instructor/lessons/:id', (req, res) => {
    const { id } = req.params;
    const { title, type, content_url, order_index } = req.body;
    const sql = "UPDATE lessons SET title = ?, type = ?, content_url = ?, order_index = ? WHERE id = ?";
    
    db.query(sql, [title, type, content_url, order_index, id], (err, result) => {
        if (err) return res.status(500).json({ message: "Gagal memperbarui materi" });
        res.json({ message: "Materi berhasil diperbarui" });
    });
});

// 2. Endpoint untuk Hapus Materi
app.delete('/api/instructor/lessons/:id', (req, res) => {
    const { id } = req.params;
    const sql = "DELETE FROM lessons WHERE id = ?";
    
    db.query(sql, [id], (err, result) => {
        if (err) return res.status(500).json({ message: "Gagal menghapus materi" });
        res.json({ message: "Materi berhasil dihapus" });
    });
});

// --- ENDPOINT ADMIN: VERIFIKASI PEMBAYARAN ---
app.post('/api/admin/verify-payment', (req, res) => {
    const { enrollmentId } = req.body;
    const sql = "UPDATE enrollments SET payment_status = 'paid', progress_percentage = 0 WHERE id = ?";
    
    db.query(sql, [enrollmentId], (err, result) => {
        if (err) return res.status(500).json(err);
        res.json({ message: "Pembayaran diverifikasi" });
    });
});

// Ambil daftar instruktur untuk pilihan dropdown
app.get('/api/admin/instructors', (req, res) => {
    const sql = "SELECT id, name FROM users WHERE role = 'instruktur'";
    db.query(sql, (err, rows) => {
        if (err) return res.status(500).json(err);
        res.json(rows);
    });
});

// --- [FIX] SIMPAN KURSUS BARU DENGAN AUTO ID ---
app.post('/api/admin/courses', (req, res) => {
    const { title, description, price, instructor_id, image_url, category } = req.body;
    const customId = generateCourseId(category);
    
    const sql = `
        INSERT INTO courses (id, title, description, price, instructor_id, image_url, category) 
        VALUES (?, ?, ?, ?, ?, ?, ?)
    `;
    
    db.query(sql, [customId, title, description, price, instructor_id, image_url, category], (err, result) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ message: "Kursus berhasil dibuat!", courseId: customId });
    });
});

// Endpoint untuk Update Kursus
app.put('/api/admin/courses/:id', (req, res) => {
    const { id } = req.params;
    const { title, description, price, instructor_id, image_url } = req.body;
    
    const sql = `
        UPDATE courses 
        SET title = ?, description = ?, price = ?, instructor_id = ?, image_url = ? 
        WHERE id = ?
    `;
    db.query(sql, [title, description, price, instructor_id, image_url, id], (err, result) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ message: "Kursus berhasil diperbarui" });
    });
});

// Endpoint untuk Hapus Kursus
app.delete('/api/admin/courses/:id', (req, res) => {
    const { id } = req.params;
    const sql = "DELETE FROM courses WHERE id = ?";
    db.query(sql, [id], (err, result) => {
        if (err) return res.status(500).json({ message: "Gagal menghapus kursus" });
        res.json({ message: "Kursus berhasil dihapus" });
    });
});

// Fungsi Helper untuk generate ID dengan Inisial Kategori
const generateCourseId = (category) => {
    let prefix = "CRS"; // Default
    
    // Logika penentuan prefix berdasarkan kategori
    switch (category) {
        case "Administrasi":
            prefix = "ADM";
            break;
        case "RPL":
            prefix = "PROG"; // Rekayasa Perangkat Lunak -> Programmer
            break;
        case "Desain Grafis":
            prefix = "DSGN";
            break;
        case "Drone":
            prefix = "DRN";
            break;
        case "Komputer":
            prefix = "COMP";
            break;
        case "Teknisi":
            prefix = "TEK";
            break;
    }
    
    const randomNum = Math.floor(1000 + Math.random() * 9000); 
    return `${prefix}-${randomNum}`;
};

// Ambil semua daftar pengguna
app.get('/api/admin/users', (req, res) => {
    const sql = "SELECT id, name, email, role, created_at FROM users ORDER BY created_at DESC";
    db.query(sql, (err, rows) => {
        if (err) return res.status(500).json(err);
        res.json(rows);
    });
});

// Update Role Pengguna (Siswa <-> Instruktur)
app.put('/api/admin/users/:id/role', (req, res) => {
    const { id } = req.params;
    const { role } = req.body;
    const sql = "UPDATE users SET role = ? WHERE id = ?";
    db.query(sql, [role, id], (err, result) => {
        if (err) return res.status(500).json(err);
        res.json({ message: "Role berhasil diperbarui" });
    });
});

// Hapus Pengguna
app.delete('/api/admin/users/:id', (req, res) => {
    const { id } = req.params;
    const sql = "DELETE FROM users WHERE id = ?";
    db.query(sql, [id], (err, result) => {
        if (err) return res.status(500).json(err);
        res.json({ message: "Pengguna berhasil dihapus" });
    });
});

// Update Profil Admin
app.put('/api/admin/update-profile', (req, res) => {
    const { id, name, email } = req.body;
    const sql = "UPDATE users SET name = ?, email = ? WHERE id = ?";
    db.query(sql, [name, email, id], (err, result) => {
        if (err) return res.status(500).json(err);
        res.json({ message: "Profil diperbarui!" });
    });
});

// Update Password (Sederhana)
app.put('/api/admin/update-password', (req, res) => {
    const { id, newPassword } = req.body;
    const sql = "UPDATE users SET password = ? WHERE id = ?";
    db.query(sql, [newPassword, id], (err, result) => {
        if (err) return res.status(500).json(err);
        res.json({ message: "Password berhasil diganti!" });
    });
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`🚀 Server berjalan di port ${PORT}`));