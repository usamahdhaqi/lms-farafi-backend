const axios = require('axios');

const sendWhatsappNotification = async (targetPhone, message) => {
    try {
        const response = await axios.post('https://api.fonnte.com/send', {
            target: targetPhone,
            message: message,
            countryCode: '62', // Kode negara Indonesia
        }, {
            headers: {
                'Authorization': process.env.FONNTE_TOKEN // Simpan token di .env [cite: 80, 90]
            }
        });
        console.log('✅ Notifikasi WA Terkirim:', response.data);
    } catch (error) {
        console.error('❌ Gagal kirim WA:', error.message);
    }
};

module.exports = { sendWhatsappNotification };