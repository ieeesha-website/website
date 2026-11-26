const express = require('express');
const submissionRouter = express.Router();

const {
  submitForm,
  scanTicket,
  getUserSubmission,
  getSubmissions,
  getSubmissionsForForm,
  exportSubmissionsToExcel,
  downloadFile,
} = require('../controllers/submissionController');

const upload = require('../middleware/uploadMiddleware');

const {
  protect,
  authorize,
  optionalProtect,
  authorizeSelfOr,
} = require('../middleware/authMiddleware');

const { VIEW_ROLES, SCAN_ROLES } = require('../constants/roles');

// 1. Submit — public route.
// optionalProtect attaches the authenticated user when available,
// while allowing guests to proceed.
// The controller enforces the form's requiresLogin setting.
submissionRouter.post('/', optionalProtect, upload.any(), submitForm);

// 2. Scan tickets.
// Only authenticated users with a permitted scanning role can scan.
submissionRouter.post('/scan', protect, authorize(...SCAN_ROLES), scanTicket);

// 3. View and export submissions.
// Restricted to VIEW_ROLES.

submissionRouter.get(
    '/export/:formId',
    protect,
    authorize(...VIEW_ROLES),
    exportSubmissionsToExcel,
);

submissionRouter.get(
    '/form/:formId',
    protect,
    authorize(...VIEW_ROLES),
    getSubmissionsForForm,
);

submissionRouter.get(
    '/download',
    protect,
    authorize(...VIEW_ROLES),
    downloadFile,
);

// 4. Retrieve a user's submission for a specific form.
// Regular users can access their own submission.
// Users with VIEW_ROLES can access submissions beyond their own.
submissionRouter.get(
    '/:userid/:formid',
    protect,
    authorizeSelfOr(...VIEW_ROLES),
    getUserSubmission,
);

// 5. Retrieve all submissions.
// Restricted to VIEW_ROLES.
submissionRouter.get('/', protect, authorize(...VIEW_ROLES), getSubmissions);

module.exports = submissionRouter;