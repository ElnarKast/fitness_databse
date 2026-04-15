const express = require('express');
const router = express.Router();
const db = require('../database');

// GET all loans
router.get('/', async (req, res) => {
  try {
    const [rows] = await db.query(`
      SELECT l.*,
             ms.membership_type, ms.start_date AS membership_start, ms.end_date AS membership_end,
             m.first_name, m.last_name, m.email,
             c.club_name
      FROM loans l
      JOIN memberships ms ON l.membership_id = ms.membership_id
      JOIN members m ON ms.member_id = m.member_id
      JOIN clubs c ON ms.club_id = c.club_id
      ORDER BY l.loan_id DESC
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

// GET loan by ID
router.get('/:id', async (req, res) => {
  try {
    const [rows] = await db.query(`
      SELECT l.*,
             ms.membership_type, ms.start_date AS membership_start, ms.end_date AS membership_end,
             m.first_name, m.last_name, m.email,
             c.club_name
      FROM loans l
      JOIN memberships ms ON l.membership_id = ms.membership_id
      JOIN members m ON ms.member_id = m.member_id
      JOIN clubs c ON ms.club_id = c.club_id
      WHERE l.loan_id = ?
    `, [req.params.id]);

    if (rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Loan not found'
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

// GET payment schedule for a loan
router.get('/:id/schedule', async (req, res) => {
  try {
    // Verify loan exists
    const [loan] = await db.query('SELECT loan_id FROM loans WHERE loan_id = ?', [req.params.id]);
    if (loan.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Loan not found'
      });
    }

    const [rows] = await db.query(`
      SELECT *
      FROM loan_payment_schedule
      WHERE loan_id = ?
      ORDER BY installment_number ASC
    `, [req.params.id]);

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

// POST create a new loan and generate its payment schedule
router.post('/', async (req, res) => {
  try {
    const { membership_id, principal, annual_interest_rate, term_months, start_date, status } = req.body;

    // Validate required fields
    if (!membership_id || !principal || !term_months || !start_date) {
      return res.status(400).json({
        success: false,
        error: 'membership_id, principal, term_months, and start_date are required'
      });
    }
    if (Number(principal) <= 0) {
      return res.status(400).json({
        success: false,
        error: 'principal must be greater than 0'
      });
    }
    if (!Number.isInteger(Number(term_months)) || Number(term_months) <= 0) {
      return res.status(400).json({
        success: false,
        error: 'term_months must be a positive integer'
      });
    }
    if (annual_interest_rate !== undefined && Number(annual_interest_rate) < 0) {
      return res.status(400).json({
        success: false,
        error: 'annual_interest_rate cannot be negative'
      });
    }
    const [membership] = await db.query(
      'SELECT membership_id FROM memberships WHERE membership_id = ?',
      [membership_id]
    );
    if (membership.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Membership not found'
      });
    }

    const [result] = await db.query(
      `INSERT INTO loans (membership_id, principal, annual_interest_rate, term_months, start_date, status)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [membership_id, principal, annual_interest_rate || 0.00, term_months, start_date, status || 'Active']
    );

    const loanId = result.insertId;

    // Generate payment schedule via stored procedure
    await db.query('CALL generate_loan_schedule(?)', [loanId]);

    res.status(201).json({
      success: true,
      message: 'Loan created and payment schedule generated successfully',
      data: { loan_id: loanId }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// POST regenerate payment schedule for an existing loan
router.post('/:id/generate-schedule', async (req, res) => {
  try {
    const [loan] = await db.query('SELECT loan_id FROM loans WHERE loan_id = ?', [req.params.id]);
    if (loan.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Loan not found'
      });
    }

    await db.query('CALL generate_loan_schedule(?)', [req.params.id]);

    res.json({
      success: true,
      message: 'Payment schedule regenerated successfully'
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// PUT update loan status
router.put('/:id', async (req, res) => {
  try {
    const { status } = req.body;

    const allowedStatuses = ['Active', 'Paid', 'Defaulted'];
    if (!status || !allowedStatuses.includes(status)) {
      return res.status(400).json({
        success: false,
        error: `status must be one of: ${allowedStatuses.join(', ')}`
      });
    }

    const [result] = await db.query(
      'UPDATE loans SET status = ? WHERE loan_id = ?',
      [status, req.params.id]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({
        success: false,
        error: 'Loan not found'
      });
    }

    res.json({
      success: true,
      message: 'Loan updated successfully'
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// PUT update installment status (mark as Paid / Overdue)
router.put('/:id/schedule/:payment_id', async (req, res) => {
  try {
    const { status } = req.body;

    const allowedStatuses = ['Pending', 'Paid', 'Overdue'];
    if (!status || !allowedStatuses.includes(status)) {
      return res.status(400).json({
        success: false,
        error: `status must be one of: ${allowedStatuses.join(', ')}`
      });
    }

    const [result] = await db.query(
      'UPDATE loan_payment_schedule SET status = ? WHERE loan_id = ? AND payment_id = ?',
      [status, req.params.id, req.params.payment_id]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({
        success: false,
        error: 'Payment installment not found'
      });
    }

    res.json({
      success: true,
      message: 'Installment status updated successfully'
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

module.exports = router;
