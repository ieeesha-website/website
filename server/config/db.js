// server/config/db.js
const mongoose = require('mongoose');

const connectDB = async () => {
  const uri = process.env.MONGO_URI;
  if (typeof uri !== 'string' || !uri.trim()) {
    throw new Error(
        'MONGO_URI is not configured. Add it to server/..env or server/.env.'
    );
  }

  const conn = await mongoose.connect(uri);
  console.log(`MongoDB Connected: ${conn.connection.host}`);
};

module.exports = connectDB;