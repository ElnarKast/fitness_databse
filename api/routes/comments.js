const express = require('express');
const router = express.Router();
const db = require('../database');

// GET all member comments
router.get('/', async (req, res) => {
  try {
    const [rows] = await db.query(`
      SELECT mc.*, 
             m.first_name as member_first_name, m.last_name as member_last_name, m.email as member_email,
             t.first_name as trainer_first_name, t.last_name as trainer_last_name
      FROM member_comments mc
      JOIN members m ON mc.member_id = m.member_id
      JOIN trainers t ON mc.trainer_id = t.trainer_id
      ORDER BY mc.created_at DESC
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

// GET comments for a specific member
router.get('/member/:member_id', async (req, res) => {
  try {
    const [rows] = await db.query(`
      SELECT mc.*, 
             t.first_name as trainer_first_name, t.last_name as trainer_last_name
      FROM member_comments mc
      JOIN trainers t ON mc.trainer_id = t.trainer_id
      WHERE mc.member_id = ?
      ORDER BY mc.created_at DESC
    `, [req.params.member_id]);
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

// GET comments by a specific trainer
router.get('/trainer/:trainer_id', async (req, res) => {
  try {
    const [rows] = await db.query(`
      SELECT mc.*, 
             m.first_name as member_first_name, m.last_name as member_last_name
      FROM member_comments mc
      JOIN members m ON mc.member_id = m.member_id
      WHERE mc.trainer_id = ?
      ORDER BY mc.created_at DESC
    `, [req.params.trainer_id]);
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

// GET comments by type
router.get('/type/:comment_type', async (req, res) => {
  try {
    const [rows] = await db.query(`
      SELECT mc.*, 
             m.first_name as member_first_name, m.last_name as member_last_name,
             t.first_name as trainer_first_name, t.last_name as trainer_last_name
      FROM member_comments mc
      JOIN members m ON mc.member_id = m.member_id
      JOIN trainers t ON mc.trainer_id = t.trainer_id
      WHERE mc.comment_type = ?
      ORDER BY mc.created_at DESC
    `, [req.params.comment_type]);
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

// GET single comment by ID
router.get('/:id', async (req, res) => {
  try {
    const [rows] = await db.query(`
      SELECT mc.*, 
             m.first_name as member_first_name, m.last_name as member_last_name,
             t.first_name as trainer_first_name, t.last_name as trainer_last_name
      FROM member_comments mc
      JOIN members m ON mc.member_id = m.member_id
      JOIN trainers t ON mc.trainer_id = t.trainer_id
      WHERE mc.comment_id = ?
    `, [req.params.id]);
    
    if (rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Comment not found'
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

// POST create new comment (employee adds comment about member)
router.post('/', async (req, res) => {
  try {
    const { member_id, trainer_id, comment_text, comment_type } = req.body;
    
    // Validate required fields
    if (!member_id || !trainer_id || !comment_text || !comment_type) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields: member_id, trainer_id, comment_text, and comment_type are required'
      });
    }
    
    // Validate comment_type
    const validTypes = ['Complaint', 'Damage', 'Positive', 'Warning', 'Other'];
    if (!validTypes.includes(comment_type)) {
      return res.status(400).json({
        success: false,
        error: `Invalid comment_type. Must be one of: ${validTypes.join(', ')}`
      });
    }
    
    // Check if member exists
    const [member] = await db.query('SELECT member_id FROM members WHERE member_id = ?', [member_id]);
    if (member.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Member not found'
      });
    }
    
    // Check if trainer exists
    const [trainer] = await db.query('SELECT trainer_id FROM trainers WHERE trainer_id = ?', [trainer_id]);
    if (trainer.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Trainer not found'
      });
    }
    
    const [result] = await db.query(
      `INSERT INTO member_comments (member_id, trainer_id, comment_text, comment_type)
       VALUES (?, ?, ?, ?)`,
      [member_id, trainer_id, comment_text, comment_type]
    );
    
    res.status(201).json({
      success: true,
      message: 'Comment added successfully',
      data: { comment_id: result.insertId }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// PUT update comment
router.put('/:id', async (req, res) => {
  try {
    const { comment_text, comment_type } = req.body;
    
    // Validate comment_type if provided
    if (comment_type) {
      const validTypes = ['Complaint', 'Damage', 'Positive', 'Warning', 'Other'];
      if (!validTypes.includes(comment_type)) {
        return res.status(400).json({
          success: false,
          error: `Invalid comment_type. Must be one of: ${validTypes.join(', ')}`
        });
      }
    }
    
    const [result] = await db.query(
      `UPDATE member_comments 
       SET comment_text = COALESCE(?, comment_text), 
           comment_type = COALESCE(?, comment_type)
       WHERE comment_id = ?`,
      [comment_text, comment_type, req.params.id]
    );
    
    if (result.affectedRows === 0) {
      return res.status(404).json({
        success: false,
        error: 'Comment not found'
      });
    }
    
    res.json({
      success: true,
      message: 'Comment updated successfully'
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// DELETE comment
router.delete('/:id', async (req, res) => {
  try {
    const [result] = await db.query('DELETE FROM member_comments WHERE comment_id = ?', [req.params.id]);
    
    if (result.affectedRows === 0) {
      return res.status(404).json({
        success: false,
        error: 'Comment not found'
      });
    }
    
    res.json({
      success: true,
      message: 'Comment deleted successfully'
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

module.exports = router;
