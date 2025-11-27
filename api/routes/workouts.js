const express = require('express');
const router = express.Router();
const db = require('../database');

// GET all workout types
router.get('/types', async (req, res) => {
  try {
    const [rows] = await db.query('SELECT * FROM workout_types ORDER BY workout_name');
    res.json({
      success: true,
      count: rows.length,
      data: rows
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// GET workout schedule
router.get('/schedule', async (req, res) => {
  try {
    const [rows] = await db.query(`
      SELECT ws.*, wt.workout_name, wt.difficulty_level, 
             t.first_name as trainer_first_name, t.last_name as trainer_last_name,
             c.club_name
      FROM workout_schedule ws
      JOIN workout_types wt ON ws.workout_type_id = wt.workout_type_id
      JOIN trainers t ON ws.trainer_id = t.trainer_id
      JOIN clubs c ON ws.club_id = c.club_id
      ORDER BY ws.schedule_date DESC, ws.start_time DESC
    `);
    res.json({
      success: true,
      count: rows.length,
      data: rows
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// GET upcoming workouts
router.get('/schedule/upcoming', async (req, res) => {
  try {
    const [rows] = await db.query(`
      SELECT ws.*, wt.workout_name, wt.difficulty_level, wt.duration_minutes,
             t.first_name as trainer_first_name, t.last_name as trainer_last_name,
             c.club_name
      FROM workout_schedule ws
      JOIN workout_types wt ON ws.workout_type_id = wt.workout_type_id
      JOIN trainers t ON ws.trainer_id = t.trainer_id
      JOIN clubs c ON ws.club_id = c.club_id
      WHERE ws.schedule_date >= CURDATE()
      ORDER BY ws.schedule_date ASC, ws.start_time ASC
    `);
    res.json({
      success: true,
      count: rows.length,
      data: rows
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// GET schedule by ID
router.get('/schedule/:id', async (req, res) => {
  try {
    const [rows] = await db.query(`
      SELECT ws.*, wt.workout_name, wt.description, wt.difficulty_level, wt.duration_minutes,
             t.first_name as trainer_first_name, t.last_name as trainer_last_name,
             c.club_name, c.address
      FROM workout_schedule ws
      JOIN workout_types wt ON ws.workout_type_id = wt.workout_type_id
      JOIN trainers t ON ws.trainer_id = t.trainer_id
      JOIN clubs c ON ws.club_id = c.club_id
      WHERE ws.schedule_id = ?
    `, [req.params.id]);
    
    if (rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Workout schedule not found'
      });
    }
    res.json({
      success: true,
      data: rows[0]
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// POST create workout type
router.post('/types', async (req, res) => {
  try {
    const { workout_name, description, duration_minutes, difficulty_level, max_participants } = req.body;
    
    const [result] = await db.query(
      `INSERT INTO workout_types (workout_name, description, duration_minutes, difficulty_level, max_participants)
       VALUES (?, ?, ?, ?, ?)`,
      [workout_name, description, duration_minutes, difficulty_level, max_participants]
    );
    
    res.status(201).json({
      success: true,
      message: 'Workout type created successfully',
      data: { workout_type_id: result.insertId }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// POST create workout schedule
router.post('/schedule', async (req, res) => {
  try {
    const { workout_type_id, trainer_id, club_id, schedule_date, start_time, available_spots } = req.body;
    
    // end_time is auto-calculated by database trigger based on workout_type duration
    // available_spots is also auto-set if not provided
    // Using NULL for end_time as a placeholder - trigger will calculate actual value
    const [result] = await db.query(
      `INSERT INTO workout_schedule (workout_type_id, trainer_id, club_id, schedule_date, start_time, end_time, available_spots)
       VALUES (?, ?, ?, ?, ?, NULL, ?)`,
      [workout_type_id, trainer_id, club_id, schedule_date, start_time, available_spots || null]
    );
    
    // Get the created schedule with calculated end_time
    const [newSchedule] = await db.query(
      'SELECT * FROM workout_schedule WHERE schedule_id = ?',
      [result.insertId]
    );
    
    res.status(201).json({
      success: true,
      message: 'Workout schedule created successfully',
      data: newSchedule[0]
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// PUT update workout schedule
router.put('/schedule/:id', async (req, res) => {
  try {
    const { schedule_date, start_time, end_time, available_spots } = req.body;
    
    const [result] = await db.query(
      `UPDATE workout_schedule 
       SET schedule_date = ?, start_time = ?, end_time = ?, available_spots = ?
       WHERE schedule_id = ?`,
      [schedule_date, start_time, end_time, available_spots, req.params.id]
    );
    
    if (result.affectedRows === 0) {
      return res.status(404).json({
        success: false,
        error: 'Workout schedule not found'
      });
    }
    
    res.json({
      success: true,
      message: 'Workout schedule updated successfully'
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// DELETE workout schedule
router.delete('/schedule/:id', async (req, res) => {
  try {
    const [result] = await db.query('DELETE FROM workout_schedule WHERE schedule_id = ?', [req.params.id]);
    
    if (result.affectedRows === 0) {
      return res.status(404).json({
        success: false,
        error: 'Workout schedule not found'
      });
    }
    
    res.json({
      success: true,
      message: 'Workout schedule deleted successfully'
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

module.exports = router;
