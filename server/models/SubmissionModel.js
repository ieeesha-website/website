const mongoose = require('mongoose');
const Form = require('./FormModel');
const { AppError } = require('../middleware/errorsMiddleware');
const { validateSubmissionAnswers } = require('../utils/submissionValidation');

const submissionSchema = new mongoose.Schema({
  formId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Form',
    required: true
  },
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    default: null
  },
  registrantEmail: {
    type: String,
    required: true,
    trim: true,
    lowercase: true
  },
  answers: {
    type: Object,
    required: true,
    default: {}
  },
  otherAnswers: {
    type: Object,
    default: {}
  },
  visitedSectionIds: {
    type: [String],
    default: []
  },
  ticketCode: {
    type: String,
    unique: true,
    sparse: true
  },
  qrImage: String,
  attended: {
    type: Boolean,
    default: false
  },
  attendedAt: Date
}, {
  timestamps: true
});

submissionSchema.index(
    { formId: 1, userId: 1 },
    {
      unique: true,
      partialFilterExpression: {
        userId: { $type: 'objectId' }
      }
    }
);

submissionSchema.index(
    { formId: 1, registrantEmail: 1 },
    {
      unique: true,
      partialFilterExpression: {
        userId: { $type: 'null' }
      }
    }
);

/**
 * Validate only when form content changes. Attendance scans must not query or
 * revalidate the form, and all stored navigation metadata is server-derived.
 */
submissionSchema.pre('save', async function() {
  const contentChanged =
    this.isNew ||
    this.isModified('answers') ||
    this.isModified('otherAnswers') ||
    this.isModified('formId') ||
    this.isModified('registrantEmail');

  if (!contentChanged) return;

  const form = await Form.findById(this.formId);
  if (!form) {
    throw new AppError('Form not found.', 404, 'FORM_NOT_FOUND');
  }

  const result = validateSubmissionAnswers(
      form,
      this.answers || {},
      this.otherAnswers || {}
  );

  if (result.errors.length) {
    throw new AppError(
        `Submission failed validation: ${result.errors.join(' | ')}`,
        400,
        'INVALID_SUBMISSION'
    );
  }

  this.answers = result.answers;
  this.otherAnswers = result.otherAnswers;
  this.visitedSectionIds = result.visitedSectionIds;

  const emailField = result.fields.find(field =>
    /e[-_]?mail/i.test(field.id || '') ||
    /e[-_]?mail/i.test(field.label || '')
  );
  if (emailField) {
    this.registrantEmail = result.answers[emailField.id];
  }
});

/**
 * Keep atomic form-capacity counters in sync when submissions are removed.
 * Uninitialized legacy counters remain unset and are seeded from the database
 * the next time a submission reserves capacity.
 */
submissionSchema.pre('deleteMany', async function() {
  this._formSubmissionCounts = await this.model.aggregate([
    { $match: this.getFilter() },
    { $group: { _id: '$formId', count: { $sum: 1 } } }
  ]).session(this.getOptions().session || null);
});

submissionSchema.post('deleteMany', async function() {
  const counts = this._formSubmissionCounts || [];
  const session = this.getOptions().session;
  await Promise.all(counts.map(({ _id, count }) =>
    Form.updateOne(
        { _id, submissionCount: { $gte: count } },
        { $inc: { submissionCount: -count } },
        session ? { session } : {}
    )
  ));
});

const Submission = mongoose.model('Submission', submissionSchema);

module.exports = Submission;
