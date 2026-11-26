const fs = require("fs");
const path = require("path");
const envPath = [
  path.resolve(process.cwd(), "..env"),
  path.join(__dirname, "..env"),
  path.join(__dirname, "env"),
].find(candidate => fs.existsSync(candidate));
require("dotenv").config({ path: envPath, quiet: true });

const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const connectDB = require("./config/db");
const cookieParser = require("cookie-parser");
const { routersHandler } = require("./utils/routesHandler");

const app = express();
const databaseReady = connectDB();

if (process.env.NODE_ENV === "development") {
  process.env.CORS_ORIGINS =
      "http://localhost:5173,http://localhost:5000,http://localhost:3000,https://www.ieeesha.org";
}

const allowedOrigins = (process.env.CORS_ORIGINS || "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);

app.use(helmet());

app.use(
    cors({
      origin: (origin, callback) => {
        if (!origin || allowedOrigins.includes(origin)) {
          callback(null, true);
          return;
        }

        callback(new Error("Not allowed by CORS"));
      },
      credentials: true,
    })
);

app.use(express.json());
app.use(cookieParser());

app.use("/uploads", express.static(path.join(__dirname, "uploads")));

app.use((req, res, next) => {
  databaseReady.then(() => next()).catch(next);
});

routersHandler(app);

const PORT = process.env.PORT || 5000;

if (require.main === module) {
  databaseReady
      .then(() => {
        app.listen(PORT, () => console.log(`Server ready on port ${PORT}.`));
      })
      .catch(error => {
        console.error(`Database connection failed: ${error.message}`);
        process.exitCode = 1;
      });
}

// REQUIRED for Vercel / serverless
module.exports = app;