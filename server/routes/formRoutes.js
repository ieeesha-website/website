const express = require('express');
const formRouter = express.Router();
const {
  createForm,
  getForm,
  getForms,
  deleteForm,
  toggleFormStatus,
  updateFormSettings,
  previewSubmissionEmail
} = require('../controllers/formController');

const { protect, authorize } = require('../middleware/authMiddleware');
const { WRITE_ROLES } = require('../constants/roles');

formRouter.get('/', getForms);
formRouter.get('/:id', getForm);

formRouter.post('/', protect, authorize(...WRITE_ROLES), createForm);
formRouter.delete('/:id', protect, authorize(...WRITE_ROLES), deleteForm);
formRouter.put('/:id/toggle', protect, authorize(...WRITE_ROLES), toggleFormStatus);
formRouter.put('/:id/settings', protect, authorize(...WRITE_ROLES), updateFormSettings);
formRouter.post('/preview-email', protect, authorize(...WRITE_ROLES), previewSubmissionEmail);

module.exports = formRouter;
