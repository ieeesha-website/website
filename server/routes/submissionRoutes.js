const express = require('express');
const submissionRouter = express.Router();
const { 
  submitForm, 
  scanTicket, 
  getUserSubmission,
  getSubmissions,
  getSubmissionsForForm,
  updateAttendance,
  editSubmission, 
  exportSubmissionsToExcel,
  downloadFile
} = require('../controllers/submissionController');
const upload = require('../middleware/uploadMiddleware');

const { protect, authorize, optionalProtect, authorizeSelfOr } = require('../middleware/authMiddleware');
const { VIEW_ROLES, SCAN_ROLES } = require('../constants/roles');

// 1. Submit �?" public route. `optionalProtect` attaches `req.user` when a valid
//    session cookie exists (for member submissions) but lets guests through.
//    The controller enforces the form's `requiresLogin` setting.
submissionRouter.post('/', optionalProtect, upload.any(), submitForm);

// 2. Scan. Scanner's one action, and board/xcom may do it too. A plain
//    "member" is excluded: they have no dashboard at all.
submissionRouter.post('/scan', protect, authorize(...SCAN_ROLES), scanTicket);

// 3. View, Export & attendance check-in from the table. Board may check people
//    in here just as it may through /scan; every other action stays xcom-only.
submissionRouter.get('/export/:formId', protect, authorize(...VIEW_ROLES), exportSubmissionsToExcel);
submissionRouter.get('/form/:formId', protect, authorize(...VIEW_ROLES), getSubmissionsForForm);
submissionRouter.get('/download', protect, authorize(...VIEW_ROLES), downloadFile);
// Attendance toggle on the submissions table. Sits before the generic
// /:userid/:formid lookup so the more specific path always wins.
submissionRouter.put('/:id/attendance', protect, authorize(...VIEW_ROLES), updateAttendance);
// "Have I already submitted this form?" — the caller's own submission, which is
// why it lives in the public-facing form UI and only needs a session. Scoping
// the :userid to the session stops it being an IDOR over everyone else's
// answers. board/xcom keep the ability to look up any single submission.
submissionRouter.get(
  '/:userid/:formid',
  protect,
  authorizeSelfOr(...VIEW_ROLES),
  getUserSubmission,
);
submissionRouter.get('/', protect, authorize(...VIEW_ROLES), getSubmissions);
// submissionRouter.put('/:userid/:formid', protect, authorize(...WRITE_ROLES), editSubmission);

module.exports = submissionRouter; 
