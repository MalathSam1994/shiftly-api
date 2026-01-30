// shiftOffers.js
const express = require('express');
const pool = require('../db');

const router = express.Router();

function sendDbError(res, err, context) {
  const payload = {
    error: 'Database error',
    context: context || undefined,
    message: err?.message,
    code: err?.code,
    detail: err?.detail,
    constraint: err?.constraint,
    table: err?.table,
    column: err?.column,
    schema: err?.schema,
    routine: err?.routine,
    where: err?.where,
  };
  Object.keys(payload).forEach((k) => payload[k] == null && delete payload[k]);
  return res.status(500).json(payload);
}



/**
 * GET /shift-offers
 *
 * Query:
 *  - requestorUserId (required) : the user who is browsing available offers
 *  - shiftDate (optional)       : YYYY-MM-DD
 *  - divisionId (optional)
 *  - departmentId (optional)
 *  - shiftTypeId (optional)
 *
 * Eligibility:
 *  - offer.status = 'ACTIVE'
 *  - offer.visibility_scope = 'ALL_ELIGIBLE'  OR offer.target_user_id = requestorUserId
 *  - requestor has same staff_type as assignment.staff_type_id
 *  - assignment division/department within requestor allowed divisions/departments
 *  - requestor cannot see/take their own offer
 */
router.get('/', async (req, res) => {
  try {
    const { requestorUserId, shiftDate, divisionId, departmentId, shiftTypeId } = req.query;

    const reqId = parseInt(String(requestorUserId ?? ''), 10);
    if (!reqId || Number.isNaN(reqId)) {
      return res.status(400).json({ error: 'requestorUserId is required' });
    }

     const values = [
      reqId,
      (shiftDate != null && String(shiftDate).trim() !== '') ? String(shiftDate).trim() : null,
      (divisionId != null && String(divisionId).trim() !== '') ? parseInt(String(divisionId), 10) : null,
      (departmentId != null && String(departmentId).trim() !== '') ? parseInt(String(departmentId), 10) : null,
      (shiftTypeId != null && String(shiftTypeId).trim() !== '') ? parseInt(String(shiftTypeId), 10) : null,
    ];

    const q = `
      SELECT *
        FROM shiftly_api.fn_shift_offer_list(
          $1::int,
          $2::date,
          $3::int,
          $4::int,
          $5::int
        )
    `;

    const r = await pool.query(q, values);
    return res.json(r.rows);
  } catch (err) {
    console.error('Error querying DB (SHIFT OFFERS LIST):', err);
    return sendDbError(res, err, 'SHIFT OFFERS LIST');
  }
});



/**
 * GET /shift-offers/target-users
 *
 * Query:
 *  - ownerUserId (required)       : assignment owner who is offering
 *  - shiftAssignmentId (required) : the assignment being offered
 *
 * Returns eligible users for "Offer to a specific person" dropdown,
 * as computed by PostgreSQL rules.
 */
router.get('/target-users', async (req, res) => {
  try {
    const { ownerUserId, shiftAssignmentId } = req.query;

    const ownerId = parseInt(String(ownerUserId ?? ''), 10);
    const asgId = parseInt(String(shiftAssignmentId ?? ''), 10);
    if (!ownerId || Number.isNaN(ownerId) || !asgId || Number.isNaN(asgId)) {
      return res.status(400).json({ error: 'ownerUserId and shiftAssignmentId are required' });
    }

    const r = await pool.query(
      `SELECT * FROM shiftly_api.fn_shift_offer_target_users($1::int, $2::int)`,
      [ownerId, asgId]
    );

       // Ensure API JSON matches AppUser.fromJson expectations (id/user_name/user_desc/staff_type_id).
    // Older DB versions returned "user_id" which caused Dart parsing to fail silently in FutureBuilder.
    const rows = (r.rows || []).map((x) => ({
      ...x,
      id: x.id ?? x.user_id,
    }));
    return res.json(rows);
  } catch (err) {
    console.error('Error querying DB (SHIFT OFFERS TARGET USERS):', err);
    return sendDbError(res, err, 'SHIFT OFFERS TARGET USERS');
  }
});

/**
 * GET /shift-offers/any-eligible-exists
 *
 * Query:
 *  - ownerUserId (required)
 *  - shiftAssignmentId (required)
 *
 * Returns: { anyEligible: boolean }
 */
router.get('/any-eligible-exists', async (req, res) => {
  try {
    const { ownerUserId, shiftAssignmentId } = req.query;

    const ownerId = parseInt(String(ownerUserId ?? ''), 10);
    const asgId = parseInt(String(shiftAssignmentId ?? ''), 10);
    if (!ownerId || Number.isNaN(ownerId) || !asgId || Number.isNaN(asgId)) {
      return res.status(400).json({ error: 'ownerUserId and shiftAssignmentId are required' });
    }

    const r = await pool.query(
      `SELECT shiftly_api.fn_shift_offer_any_eligible_exists($1::int, $2::int) AS any_eligible`,
      [ownerId, asgId]
    );
    return res.json({ anyEligible: r.rows?.[0]?.any_eligible === true });
  } catch (err) {
    console.error('Error querying DB (SHIFT OFFERS ANY ELIGIBLE):', err);
    return sendDbError(res, err, 'SHIFT OFFERS ANY ELIGIBLE');
  }
});



/**
 * POST /shift-offers
 *
 * Body:
 *  - shift_assignment_id (required)
 *  - offered_by_user_id  (required)  : must match assignment.user_id (owner)
 *  - note               (optional)
 *  - visibility_scope   (optional)   : ALL_ELIGIBLE | TARGET_USER (default ALL_ELIGIBLE)
 *  - target_user_id     (optional)   : required if visibility_scope = TARGET_USER
 *
 * IMPORTANT: UPSERT by shift_assignment_id to avoid uq_shift_offers_assignment crashes.
 */
router.post('/', async (req, res) => {

  try {
    const {
      shift_assignment_id,
      offered_by_user_id,
      note,
      visibility_scope,
      target_user_id,
    } = req.body;

    const asgId = parseInt(String(shift_assignment_id ?? ''), 10);
    const byId = parseInt(String(offered_by_user_id ?? ''), 10);

    if (!asgId || Number.isNaN(asgId) || !byId || Number.isNaN(byId)) {
      return res.status(400).json({ error: 'shift_assignment_id and offered_by_user_id are required.' });
    }

    const scope = String(visibility_scope ?? 'ALL_ELIGIBLE').toUpperCase();
    const targetId = target_user_id == null ? null : parseInt(String(target_user_id), 10);

    const q = `
      SELECT *
        FROM shiftly_api.fn_shift_offer_upsert(
          $1::int,
          $2::int,
          $3::text,
          $4::int,
          $5::text
        )
    `;
    const r = await pool.query(q, [asgId, byId, scope, targetId, note ?? null]);
    return res.status(201).json(r.rows[0]);
  } catch (err) {
  
    console.error('Error creating/updating shift offer:', err);
    return sendDbError(res, err, 'SHIFT OFFERS CREATE');

  }
});


+/**
+ * POST /shift-offers/:id/cancel
+ *
+ * Body:
+ *  - cancelled_by_user_id (required)
+ *
+ * All security is enforced by PostgreSQL.
+ */
router.post('/:id/cancel', async (req, res) => {
  try {
    const offerId = parseInt(String(req.params.id ?? ''), 10);
    const cancelledByUserId = parseInt(String(req.body?.cancelled_by_user_id ?? ''), 10);

    if (!offerId || Number.isNaN(offerId) || !cancelledByUserId || Number.isNaN(cancelledByUserId)) {
      return res.status(400).json({ error: 'offerId and cancelled_by_user_id are required.' });
    }

    const r = await pool.query(
      `SELECT * FROM shiftly_api.fn_shift_offer_cancel($1::int, $2::int)`,
      [offerId, cancelledByUserId]
    );
    return res.json(r.rows[0]);
  } catch (err) {
    console.error('Error cancelling shift offer:', err);
    return sendDbError(res, err, 'SHIFT OFFERS CANCEL');
  }
});



module.exports = router;