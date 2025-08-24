// index.js (Node.js Backend)

require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 3000;

// --- Database Configuration ---
const sslConfig = process.env.NODE_ENV === 'production'
    ? { rejectUnauthorized: false }
    : false;

console.log('Attempting to connect to DB with:');
console.log('DB_USER:', process.env.DB_USER);
console.log('DB_HOST:', process.env.DB_HOST);
console.log('DB_DATABASE:', process.env.DB_DATABASE);
console.log('DB_PORT:', process.env.DB_PORT);
console.log('NODE_ENV:', process.env.NODE_ENV);
console.log('SSL Config used:', sslConfig);
console.log('DB_PASSWORD (first 5 chars):', process.env.DB_PASSWORD ? process.env.DB_PASSWORD.substring(0, 5) + '*****' : 'NOT SET');

const pool = new Pool({
    user: process.env.DB_USER,
    host: process.env.DB_HOST,
    database: process.env.DB_DATABASE,
    password: process.env.DB_PASSWORD,
    port: process.env.DB_PORT,
    ssl: sslConfig
});

pool.connect()
    .then(client => {
        console.log('Connected to PostgreSQL database successfully!');
        client.release();
    })
    .catch(err => {
        console.error('Error connecting to PostgreSQL database:', err.message);
    });

app.use(cors());
app.use(express.json());

// --- Helper Functions ---
function formatDateAndTime(dateInput) {
    if (!dateInput) return { formattedDate: 'Invalid date', formattedTime: '' };

    let d;
    if (typeof dateInput === 'string') {
        const safe = dateInput.replace(' ', 'T');
        d = new Date(safe);

    } else if (dateInput instanceof Date) {
        d = dateInput;
    } else {
        return { formattedDate: 'Invalid date', formattedTime: '' };
    }

    if (isNaN(d.getTime())) {
        return { formattedDate: 'Invalid date', formattedTime: '' };
    }

    const pad = (n) => n.toString().padStart(2, '0');

    const year = d.getFullYear();
    const month = pad(d.getMonth() + 1);
    const day = pad(d.getDate());

    let hours = d.getHours();
    const minutes = pad(d.getMinutes());
    const ampm = hours >= 12 ? 'PM' : 'AM';
    hours = hours % 12 || 12;

    return {
        formattedDate: `${year}-${month}-${day}`,
        formattedTime: `${pad(hours)}:${minutes} ${ampm}`
    };
}

// --- Telegram Notification ---
async function sendTelegramNotification(booking) {
    const { formattedDate, formattedTime } = formatDateAndTime(booking.datetime);
    const message = `
Customer's name: ${booking.name}
Telegram: ${booking.phone}
Treatment: ${booking.service}
Therapist: ${booking.therapy_name}
Duration: ${booking.duration}
Date: *${formattedDate}*
Time: *${formattedTime}*

Remark:
1. Aroma Oil: ${booking.aroma_oil || 'Not specified'}
2. Pressure: ${booking.pressure || 'Not specified'}
3. Body area to focus: ${booking.focus_area || 'None'}
4. Body area to avoid: ${booking.avoid_area || 'None'}

🔔 Please prepare the room and therapist.
`;

    try {
        await axios.post(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
            chat_id: process.env.TELEGRAM_CHAT_ID,
            text: message,
            parse_mode: 'Markdown',
        });
        console.log('✅ Telegram alert sent with bold date and time.');
    } catch (error) {
        console.error('❌ Failed to send Telegram alert:', error.message);
    }
}

async function sendTelegramCancellationAlert(booking) {
    const { formattedDate, formattedTime } = formatDateAndTime(booking.datetime);
    const message = `
❌ BOOKING CANCELLED

Customer's name: ${booking.name}
Treatment: ${booking.service}
Date: *${formattedDate}*
Time: *${formattedTime}*

⚠️ This booking has been cancelled.
`;

    try {
        await axios.post(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
            chat_id: process.env.TELEGRAM_CHAT_ID,
            text: message,
            parse_mode: 'Markdown',
        });
        console.log(`📣 Telegram cancellation alert sent for ${booking.name}`);
    } catch (error) {
        console.error('❌ Failed to send Telegram cancellation alert:', error.message);
    }
}

// --- API Routes ---
app.get('/booking_spa12', async (req, res) => {
    try {
        const result = await pool.query(
            'SELECT * FROM booking_spa12 ORDER BY booking_time DESC LIMIT 1;'
        );

        res.json(result.rows.map(row => {
            const { formattedDate, formattedTime } = formatDateAndTime(row.datetime);
            return {
                ...row,
                raw_datetime: row.datetime,     // keep original ISO datetime
                formattedDate,
                formattedTime
            };
        }));
    } catch (err) {
        console.error('Error fetching bookings:', err);
        res.status(500).json({ error: 'Failed to retrieve bookings from the database.' });
    }
});

app.post('/booking_spa12', async (req, res) => {
    const { service, therapyName, duration, price, name, phone, datetime, aromaOil, pressure, focusArea, avoidArea } = req.body;

    if (!service || !duration || !price || !name || !phone || !datetime || !therapyName) {
        return res.status(400).json({ error: 'All booking fields are required.' });
    }

    const therapistDaysOff = {
        "Mr.Duong": "Thursday",
        "Mr.Sali": "Monday",
        "Mr.Rozy": "Tuesday",
        "Ms.SreyNeth": "Friday",
        "Ms.SreyOun": "Wednesday"
    };

    const bookingDay = new Date(datetime).toLocaleString("en-US", { weekday: "long" });
    const therapistDayOff = therapistDaysOff[therapyName];

    if (bookingDay === therapistDayOff) {
        return res.status(400).json({
            error: `${therapyName} is off on ${therapistDayOff}. Please choose another date or therapist.`
        });
    }

    const cleanPrice = parseFloat(String(price).replace(/[^0-9.]/g, ''));
    const bookingStart = new Date(datetime);
    const durationMinutes = parseInt(duration.replace('min', ''));
    const bookingEnd = new Date(bookingStart.getTime() + durationMinutes * 60000);

    try {
        const conflictCheck = await pool.query(
            `SELECT * FROM booking_spa12
       WHERE therapy_name = $1
       AND datetime >= $2::timestamp - INTERVAL '2 hours'
       AND datetime <= $3::timestamp;`,
            [therapyName, bookingStart.toISOString(), bookingEnd.toISOString()]
        );

        for (let existing of conflictCheck.rows) {
            const existingStart = new Date(existing.datetime);
            const existingDurationMinutes = parseInt(existing.duration.replace('min', ''));

            const existingEnd = new Date(
                existingStart.getTime() +
                (existingDurationMinutes * 60000) + (10 * 60000)
            );

            if (bookingStart < existingEnd && bookingEnd > existingStart) {
                return res.status(409).json({
                    error: `Therapist ${therapyName} already has a booking from ${existingStart.toISOString()} to ${existingEnd.toISOString()}  Please choose another time.`
                });
            }
        }

        const result = await pool.query(
            `INSERT INTO booking_spa12(service, therapy_name, duration, price, name, phone, datetime, aroma_oil, pressure, focus_area, avoid_area)
       VALUES($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       RETURNING *;`,
            [service, therapyName, duration, cleanPrice, name, phone, bookingStart.toISOString(), aromaOil, pressure, focusArea, avoidArea]
        );

        await sendTelegramNotification(result.rows[0]);
        res.status(201).json(result.rows[0]);
    } catch (err) {
        console.error('❌ Booking insert failed:', err);
        res.status(500).json({ error: 'Failed to insert booking.' });
    }
});

app.delete('/booking_spa12/:id', async (req, res) => {
    const { id } = req.params;
    try {
        const result = await pool.query('DELETE FROM booking_spa12 WHERE id = $1 RETURNING *;', [id]);
        if (result.rowCount === 0) {
            return res.status(404).json({ error: `Booking with ID ${id} not found.` });
        }
        await sendTelegramCancellationAlert(result.rows[0]);
        res.status(200).json({ message: `Booking with ID ${id} deleted successfully.` });
    } catch (err) {
        console.error('Error deleting booking:', err);
        res.status(500).json({ error: 'Failed to delete booking from the database.' });
    }
});

// --- Testimonials ---
app.post('/api/testimonials', async (req, res) => {
    const { reviewerName, reviewerEmail, reviewTitle, reviewText, rating, genuineOpinion } = req.body;
    if (!reviewerName || !reviewerEmail || !reviewText || !rating || genuineOpinion === undefined) {
        return res.status(400).json({ error: 'All testimonial fields (except title) are required.' });
    }
    if (rating < 1 || rating > 5) {
        return res.status(400).json({ error: 'Rating must be between 1 and 5.' });
    }
    try {
        const result = await pool.query(
            'INSERT INTO testimonials(reviewer_name, reviewer_email, review_title, review_text, rating, genuine_opinion, created_at) VALUES($1, $2, $3, $4, $5, $6, NOW()) RETURNING *;',
            [reviewerName, reviewerEmail, reviewTitle, reviewText, rating, genuineOpinion]
        );
        res.status(201).json(result.rows[0]);
    } catch (err) {
        console.error('Error adding testimonial to database:', err);
        res.status(500).json({ error: 'Failed to add testimonial to the database.' });
    }
});

app.get('/api/testimonials', async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM testimonials ORDER BY created_at DESC;');
        res.json(result.rows);
    } catch (err) {
        console.error('Error fetching testimonials from database:', err);
        res.status(500).json({ error: 'Failed to retrieve testimonials from the database.' });
    }
});

app.delete('/api/testimonials/:id', async (req, res) => {
    const { id } = req.params;
    try {
        const result = await pool.query('DELETE FROM testimonials WHERE id = $1 RETURNING id;', [id]);
        if (result.rowCount === 0) {
            return res.status(404).json({ error: `Testimonial with ID ${id} not found.` });
        }
        res.status(200).json({ message: `Testimonial with ID ${id} deleted successfully.` });
    } catch (err) {
        console.error('Error deleting testimonial from database:', err.message || err);
        res.status(500).json({ error: `Failed to delete testimonial from the database: ${err.message || 'Unknown database error'}` });
    }
});

// --- Start the server ---
app.listen(PORT, () => {
    console.log(`Backend server running on http://localhost:${PORT}`);
    console.log('Ensure your frontend BASE_API_URL is set to this backend URL for full functionality.');
});
