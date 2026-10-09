import mongoose from 'mongoose';

/**
 * Connect to MongoDB using the MONGO_URI environment variable.
 * If MONGO_URI is not set yet, the server keeps running and features
 * that need the database simply stay unavailable until it is configured.
 */
export async function connectDB() {
  const uri = process.env.MONGO_URI;

  if (!uri) {
    console.warn('MONGO_URI is not set in .env — running WITHOUT database.');
    console.warn('Auth, order saving, and owner features are disabled until MONGO_URI is configured.');
    return;
  }

  try {
    // Fail fast instead of hanging: with the defaults a down or unreachable
    // database makes every DB-backed request wait 10s+ and then fail, which
    // the frontend shows as pages that "never load".
    mongoose.set('bufferTimeoutMS', 5000);
    await mongoose.connect(uri, {
      serverSelectionTimeoutMS: 5000,
      connectTimeoutMS: 5000
    });
    console.log('MongoDB connected successfully.');
  } catch (err) {
    console.error('MongoDB connection error:', err.message);
    console.warn('Continuing without database — fix MONGO_URI and restart the server.');
  }

  mongoose.connection.on('error', (err) => {
    console.error('MongoDB runtime error:', err.message);
  });
}
