const express = require('express');
const cors = require('cors');
require('dotenv').config();

const app = express();
const PORT = process.env.API_PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Import routes
const membersRoutes = require('./routes/members');
const trainersRoutes = require('./routes/trainers');
const clubsRoutes = require('./routes/clubs');
const membershipsRoutes = require('./routes/memberships');
const workoutsRoutes = require('./routes/workouts');
const attendanceRoutes = require('./routes/attendance');
const commentsRoutes = require('./routes/comments');

// Use routes
app.use('/api/members', membersRoutes);
app.use('/api/trainers', trainersRoutes);
app.use('/api/clubs', clubsRoutes);
app.use('/api/memberships', membershipsRoutes);
app.use('/api/workouts', workoutsRoutes);
app.use('/api/attendance', attendanceRoutes);
app.use('/api/comments', commentsRoutes);

// Root endpoint
app.get('/', (req, res) => {
  res.json({
    message: 'Fitness Club API',
    version: '1.0.0',
    endpoints: {
      members: '/api/members',
      trainers: '/api/trainers',
      clubs: '/api/clubs',
      memberships: '/api/memberships',
      workouts: '/api/workouts',
      attendance: '/api/attendance',
      comments: '/api/comments'
    }
  });
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'OK', timestamp: new Date() });
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({
    error: 'Something went wrong!',
    message: err.message
  });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({
    error: 'Not Found',
    message: 'The requested resource was not found'
  });
});

// Start server
app.listen(PORT, () => {
  console.log(`
╔═══════════════════════════════════════╗
║   Fitness Club API Server Started    ║
╠═══════════════════════════════════════╣
║   Port: ${PORT}                        ║
║   Environment: ${process.env.NODE_ENV || 'development'}              ║
╚═══════════════════════════════════════╝
  `);
  console.log(`API available at: http://localhost:${PORT}`);
  console.log(`API documentation: http://localhost:${PORT}/`);
});

module.exports = app;
