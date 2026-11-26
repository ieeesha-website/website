const { catchAsync, AppError } = require('../middleware/errorsMiddleware');
const mongoose = require('mongoose');
const Form = require('../models/FormModel');
const Submission = require('../models/SubmissionModel');
const Activity = require('../models/ActivityModel');
const {
  assertIdentityFields,
  assertIdentityOnEveryPath,
  withFlatFormFields
} = require('../utils/fieldIdentity');
const {
  resolveFormSections,
  validateFormDocument
} = require('../utils/formDefinition');
const { renderCustomSubmissionEmail } = require('../utils/sendEmail');
const { runWithOptionalTransaction } = require('../utils/runTransaction');
const {
  SAMPLE_MEMBER,
  SAMPLE_NAME,
  SAMPLE_TICKET_CODE,
  buildSampleSubmissions,
  findUnresolved,
} = require('../utils/emailPreview');
const QRCode = require('qrcode');

// Keep in sync with the `maxlength` on the Form schema, so an over-long value is
// refused with a useful message instead of a Mongoose ValidationError.
const EMAIL_SUBJECT_MAX = 200;
const EMAIL_BODY_MAX = 5000;

/**
 * Reject a field list that cannot produce usable, unique answer keys.
 *
 * Field ids are derived from labels (see utils/fieldId.js) and are what every
 * answer is stored under, so a label that slugs to nothing, or two labels that
 * slug to the same id, has to be refused up front. Previously these were only
 * caught deep inside Mongoose as a generic 500.
 *
 * @param {Array} fields
 */
/**
 * Read a boolean setting off a request body.
 *
 * Only a real boolean is accepted. The string "false" is truthy in JavaScript,
 * so a loose cast would silently switch a feature on, and an absent key has to
 * mean "leave it alone" so a partial update cannot reset it.
 *
 * @param {object} body
 * @param {string} key
 * @param {string} code  error code for a non-boolean value
 * @param {boolean|undefined} [fallback] value used when `key` is absent
 * @returns {boolean|undefined} undefined when the key is absent
 */
function readBooleanSetting(body, key, code, fallback = undefined) {
  const value = body[key];
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'boolean') {
    throw new AppError(`${key} must be true or false`, 400, code);
  }
  return value;
}

/**
 * Validate the author-written post-submission email settings.
 *
 * Shared by createForm and updateFormSettings so both reject the same mistakes.
 * `existing` carries the values already on the form, which matters for a partial
 * update: switching `sendEmailOnSubmission` on has to be checked against the
 * body already stored, not against an empty string.
 *
 * @param {object} body
 * @param {object} [existing] currently stored form values
 * @returns {object} only the keys present in `body`, plus the derived default
 */
function readSubmissionEmailSettings(body, existing = {}) {
  const out = {};

  const sendEmailOnSubmission = readBooleanSetting(
    body,
    'sendEmailOnSubmission',
    'INVALID_SEND_EMAIL_ON_SUBMISSION',
    undefined
  );
  if (sendEmailOnSubmission !== undefined) {
    out.sendEmailOnSubmission = sendEmailOnSubmission;
  }

  if (body.submissionEmailSubject !== undefined && body.submissionEmailSubject !== null) {
    if (typeof body.submissionEmailSubject !== 'string') {
      throw new AppError('submissionEmailSubject must be text', 400, 'INVALID_EMAIL_SUBJECT');
    }
    if (body.submissionEmailSubject.length > EMAIL_SUBJECT_MAX) {
      throw new AppError(
        `The email subject must be ${EMAIL_SUBJECT_MAX} characters or fewer`,
        400,
        'EMAIL_SUBJECT_TOO_LONG'
      );
    }
    out.submissionEmailSubject = body.submissionEmailSubject.trim();
  }

  if (body.submissionEmailBody !== undefined && body.submissionEmailBody !== null) {
    if (typeof body.submissionEmailBody !== 'string') {
      throw new AppError('submissionEmailBody must be text', 400, 'INVALID_EMAIL_BODY');
    }
    if (body.submissionEmailBody.length > EMAIL_BODY_MAX) {
      throw new AppError(
        `The email body must be ${EMAIL_BODY_MAX} characters or fewer`,
        400,
        'EMAIL_BODY_TOO_LONG'
      );
    }
    out.submissionEmailBody = body.submissionEmailBody.trim();
  }

  // Switching the feature on with nothing to send would mail every submitter a
  // blank page, so require the message at the moment it is enabled. Turning it
  // off keeps the stored text, so re-enabling does not lose the author's work.
  const enabled = out.sendEmailOnSubmission ?? existing.sendEmailOnSubmission;
  const bodyText = out.submissionEmailBody ?? existing.submissionEmailBody;
  if (enabled && !bodyText) {
    throw new AppError(
      'Write the email you want to send, or turn off "Email after submission"',
      400,
      'EMPTY_EMAIL_BODY'
    );
  }

  return out;
}

function validateFormDates(startDate, endDate) {
  const start = new Date(startDate);
  const end = new Date(endDate);

  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    throw new AppError('Invalid form dates', 400, 'INVALID_DATES');
  }

  if (start > end) {
    throw new AppError(
        'startDate must be before or equal to endDate',
        400,
        'INVALID_DATE_RANGE'
    );
  }

  return { start, end };
}

function validateMaxSubmissions(value) {
  if (value === undefined) return;

  if (
      typeof value !== 'number' ||
      !Number.isInteger(value) ||
      value < 1
  ) {
    throw new AppError(
        'maxSubmissions must be a positive integer',
        400,
        'INVALID_MAX_SUBMISSIONS'
    );
  }
}

// @desc    Create a new form
// @route   POST /api/forms
// @access  Private (Admin)
const createForm = catchAsync(async (req, res) => {
  const { title, description, sections, fields, type, startDate, endDate, maxSubmissions } = req.body;

  if (typeof title !== 'string' || !title.trim() || !type) {
    throw new AppError("Title and Type are required", 400);
  }

  // Check the type against the schema's own enum so there is a single source of
  // truth. Without this an unsupported type only fails later inside Mongoose and
  // surfaces as an opaque 500.
  const allowedTypes = Form.schema.path('type').enumValues;
  if (!allowedTypes.includes(type)) {
    throw new AppError(
      `"${type}" is not a valid form type. Expected one of: ${allowedTypes.join(', ')}.`,
      400,
      'INVALID_FORM_TYPE'
    );
  }

  const resolvedSections = resolveFormSections({
    sections,
    fields,
    defaultFields: [
      { label: 'Full Name', type: 'TextInput', required: true },
      { label: 'Email', type: 'TextInput', required: true }
    ],
    sectionTitle: 'Personal Information'
  }, AppError);

  const resolvedFields = resolvedSections.flatMap(section => section.fields);
  assertIdentityFields(resolvedFields, AppError);
  assertIdentityOnEveryPath(resolvedSections, AppError);

  // `requiresLogin` decides who may submit, and is enforced in submitForm.
  const requiresLogin = readBooleanSetting(
      req.body,
      'requiresLogin',
      'INVALID_REQUIRES_LOGIN',
      false
  );

  // Optional custom email to send after a submission. Same validation as the
  // edit path, so a form cannot be created in a state the editor would reject.
  const emailSettings = readSubmissionEmailSettings(req.body);

  validateMaxSubmissions(maxSubmissions);
  const defaultStartDate = new Date();
  const defaultEndDate = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  const { start, end } = validateFormDates(
      startDate || defaultStartDate,
      endDate || defaultEndDate
  );

  const form = new Form({
    title: title.trim(),
    description,
    sections: resolvedSections,
    type,
    requiresLogin,
    ...emailSettings,
    startDate: start,
    endDate: end,
    maxSubmissions,
    createdBy: req.user._id
  });

  await validateFormDocument(form, AppError);
  await form.save();
  res.status(201).json(form);
});

// @desc    Get a single active form
// @route   GET /api/form/:id
// @access  Public
const getForm = catchAsync(async (req, res) => {
  if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
    throw new AppError('Invalid form ID', 400, 'INVALID_FORM_ID');
  }

  const form = await Form.findById(req.params.id);

  if (!form) {
    throw new AppError('Form not found', 404);
  }

  const startDate = new Date(form.startDate);
  const endDate = new Date(form.endDate);
  endDate.setHours(23, 59, 59, 999);

  if (
    Number.isNaN(startDate.getTime()) ||
    Number.isNaN(endDate.getTime()) ||
    endDate < new Date() ||
    startDate > new Date() ||
    form.status !== 'Active'
  ) {
    throw new AppError('This form is currently closed.', 400);
  }

  res.json(form);
});

// @desc    Get ALL forms (For Admin Dashboard Table)
// @route   GET /api/form/all
// @access  Private (Admin)
const getForms = catchAsync(async (req, res) => {
  // Pagination
  const requestedPage = Number(req.query.page);
  const requestedLimit = Number(req.query.limit);
  const page = Number.isInteger(requestedPage) && requestedPage > 0
    ? requestedPage
    : 1;
  const limit = Number.isInteger(requestedLimit) &&
      requestedLimit > 0 &&
      requestedLimit <= 100
    ? requestedLimit
    : 10;
  const skip = (page - 1) * limit;

  // Sort by newest first
  const [result] = await Form.aggregate([
    {
      $facet: {
        forms: [
          { $sort: { createdAt: -1 } },
          { $skip: skip },
          { $limit: limit },
        ],

        totalCount: [
          { $count: "count" }
        ],

        draftCount: [
          { $match: { status: "Draft" } },
          { $count: "count" }
        ],

        closedCount: [
          { $match: { status: "Closed" } },
          { $count: "count" }
        ],

        activeCount: [
          { $match: { status: "Active" } },
          { $count: "count" }
        ]
      }
    }
  ]);

  const forms = result.forms.map(withFlatFormFields);
  const count = result.totalCount[0]?.count || 0;
  const draftCount = result.draftCount[0]?.count || 0;
  const closedCount = result.closedCount[0]?.count || 0;
  const activeCount = result.activeCount[0]?.count || 0;
  
  res.json({
    count,
    draftCount,
    closedCount,
    activeCount,
    forms,
    pagination: {
      totalItems: count,
      totalPages: Math.ceil(count / limit),
      currentPage: page,
      itemsPerPage: limit,
    },
  });
});

// @desc    Delete a form
// @route   DELETE /api/forms/:id
// @access  Private (Admin)
const deleteForm = catchAsync(async (req, res) => {
  if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
    throw new AppError('Invalid form ID', 400, 'INVALID_FORM_ID');
  }

  const form = await Form.findById(req.params.id);
  if (!form) throw new AppError('Form not found', 404);

  await runWithOptionalTransaction(async session => {
    const deletion = Submission.deleteMany({ formId: form._id });
    if (session) deletion.session(session);
    await deletion;
    await form.deleteOne(session ? { session } : {});
  });
  res.json({ message: 'Form removed' });
});

// @desc    Toggle Form Status (Open/Close manually)
// @route   PUT /api/forms/:id/toggle
// @access  Private (Admin)
const toggleFormStatus = catchAsync(async (req, res) => {
  if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
    throw new AppError('Invalid form ID', 400, 'INVALID_FORM_ID');
  }
  const form = await Form.findById(req.params.id);
    if (!form) throw new AppError('Form not found', 404);

    form.status = form.status === 'Active' ? 'Closed' : 'Active';
    await form.save();

    res.json({ message: `Form is now ${form.status}` });
});

// @desc    Update a form's settings
// @route   PUT /api/form/:id/settings
// @access  Private (Admin)
const updateFormSettings = catchAsync(async (req, res) => {
  const { id } = req.params;
  const { startDate, endDate, maxSubmissions } = req.body;

  // Read the form first instead of relying on findByIdAndUpdate's return value.
  // The stored values are needed to judge a partial update: enabling the custom
  // email is only valid against the body already saved, and the date range has
  // to be checked against the dates that will actually result from the merge.
  // It also lets a missing form answer 404 instead of falling through.
  if (!mongoose.Types.ObjectId.isValid(id)) {
    throw new AppError('Invalid form ID', 400, 'INVALID_FORM_ID');
  }
  const existing = await Form.findById(id).select('+submissionCount').lean();
  if (!existing) throw new AppError('Form not found', 404);

  const updateFields = {};

  if (startDate !== undefined) updateFields.startDate = startDate;
  if (endDate !== undefined) updateFields.endDate = endDate;
  if (maxSubmissions !== undefined) updateFields.maxSubmissions = maxSubmissions;

  // Every key is optional, so a request that changes only the login setting
  // cannot accidentally blank the dates.
  const requiresLogin = readBooleanSetting(req.body, 'requiresLogin', 'INVALID_REQUIRES_LOGIN', undefined);
  if (requiresLogin !== undefined) updateFields.requiresLogin = requiresLogin;

  // Lets an existing form switch the post-submission email on or off, change the
  // wording, and turn `requiresLogin` on after the fact.
  Object.assign(updateFields, readSubmissionEmailSettings(req.body, existing));

  if (Object.keys(updateFields).length === 0) {
    throw new AppError('No settings were provided to update', 400, 'NO_SETTINGS');
  }

  // Compare the merged result, not just the two values that happen to be in this
  // request. Moving only endDate before the existing startDate used to slip
  // through and produce a form nobody can submit to.
  const { start, end } = validateFormDates(
      updateFields.startDate ?? existing.startDate,
      updateFields.endDate ?? existing.endDate
  );
  if (updateFields.startDate !== undefined) updateFields.startDate = start;
  if (updateFields.endDate !== undefined) updateFields.endDate = end;
  validateMaxSubmissions(updateFields.maxSubmissions);

  if (updateFields.maxSubmissions !== undefined) {
    const existingCount = await Submission.countDocuments({ formId: id });
    updateFields.submissionCount = Math.max(
        existingCount,
        existing.submissionCount || 0
    );
  }

  let updatedForm;
  await runWithOptionalTransaction(async session => {
      const sessionOptions = session ? { session } : {};
      const { submissionCount, ...settings } = updateFields;
      if (submissionCount !== undefined) {
        await Form.updateOne(
            { _id: id },
            { $max: { submissionCount } },
            sessionOptions
        );
      }

      const filter = { _id: id };
      if (settings.maxSubmissions !== undefined) {
        filter.$expr = {
          $lte: [
            { $ifNull: ['$submissionCount', 0] },
            settings.maxSubmissions
          ]
        };
      }

      updatedForm = await Form.findOneAndUpdate(
          filter,
          { $set: settings },
          { returnDocument: 'after', runValidators: true, ...sessionOptions }
      );
      if (!updatedForm) {
        throw new AppError(
            'maxSubmissions cannot be lower than the number of existing submissions.',
            400,
            'MAX_SUBMISSIONS_BELOW_CURRENT'
        );
      }

      if (updatedForm.activityID) {
        const activityUpdate = await Activity.updateOne(
            { _id: updatedForm.activityID },
            {
              $set: {
                startDate: updatedForm.startDate,
                endDate: updatedForm.endDate,
                title: updatedForm.title
              }
            },
            { ...sessionOptions, runValidators: true }
        );
        if (!activityUpdate.matchedCount) {
          throw new AppError(
              'The activity associated with this form no longer exists.',
              409,
              'ACTIVITY_NOT_FOUND'
          );
        }
      }
  });

  res.status(200).json({
    message: 'Form settings updated successfully',
    form: withFlatFormFields(updatedForm)
  });
});

// Render a form's submission email without sending it, for the builder preview.
//
// The message goes through renderCustomSubmissionEmail, the same function
// sendCustomSubmissionEmail calls, so the preview is the real message rather
// than a reimplementation that can drift. Two renderings come back: one as a
// registered member and one as a guest, because db-user[...] resolves for the
// first and stays as literal text for the second, and an author cannot see that
// difference any other way.
const previewSubmissionEmail = catchAsync(async (req, res) => {
  const {
    formTitle,
    formType,
    sections,
    fields,
    asGuest,
    subject,
    messageBody
  } = req.body || {};

  if (formTitle !== undefined && typeof formTitle !== 'string') {
    throw new AppError('formTitle must be text', 400, 'INVALID_FORM_TITLE');
  }

  if (formType !== undefined && typeof formType !== 'string') {
    throw new AppError('formType must be text', 400, 'INVALID_FORM_TYPE');
  }

  if (subject !== undefined && typeof subject !== 'string') {
    throw new AppError('subject must be text', 400, 'INVALID_EMAIL_SUBJECT');
  }

  if (messageBody !== undefined && typeof messageBody !== 'string') {
    throw new AppError('messageBody must be text', 400, 'INVALID_EMAIL_BODY');
  }

  // The preview now accepts sections instead of the former flat fields array.
  if (sections !== undefined && !Array.isArray(sections)) {
    throw new AppError('sections must be a list', 400, 'INVALID_SECTIONS');
  }
  if (fields !== undefined && !Array.isArray(fields)) {
    throw new AppError('fields must be a list', 400, 'INVALID_FIELDS');
  }
  if (sections !== undefined && fields !== undefined) {
    throw new AppError(
        'Provide either sections or fields, not both',
        400,
        'AMBIGUOUS_FORM_DEFINITION'
    );
  }

  // Validate the section structure before flattening it.
  if (sections) {
    for (const [index, section] of sections.entries()) {
      if (!section || typeof section !== 'object' || Array.isArray(section)) {
        throw new AppError(
          `Section ${index + 1} must be an object`,
          400,
          'INVALID_SECTION'
        );
      }

      if (!Array.isArray(section.fields)) {
        throw new AppError(
          `Section ${index + 1} must contain a fields array`,
          400,
          'INVALID_SECTION_FIELDS'
        );
      }

      if (
          section.fields.some(
              field => !field || typeof field !== 'object' || Array.isArray(field)
          )
      ) {
        throw new AppError(
          `Section ${index + 1} contains an invalid field`,
          400,
          'INVALID_SECTION_FIELD'
        );
      }
    }
  }

  if (
    fields &&
    fields.some(field => !field || typeof field !== 'object' || Array.isArray(field))
  ) {
    throw new AppError('fields contains an invalid field', 400, 'INVALID_FIELD');
  }

  const title = (formTitle || '').trim() || 'Untitled form';

  // The email preview utility still works with flat fields.
  // Flatten the sections only for generating sample answers.
  const safeFields = sections
      ? sections.flatMap(section => section.fields)
      : fields || [];

  const asMember = asGuest !== true;

  // Only attendance forms carry a QR code.
  const hasQr = formType === 'attendance';
  const qrDataUrl = hasQr
      ? await QRCode.toDataURL(SAMPLE_TICKET_CODE)
      : null;

  const dbSubmissions = buildSampleSubmissions(safeFields);
  dbSubmissions.formTitle = title;
  dbSubmissions.formType = formType || '';

  const base = {
    subject: subject || `We received your submission for ${title}`,
    messageBody: messageBody || '',
    formTitle: title,
    userName: SAMPLE_NAME,
    ticketCode: SAMPLE_TICKET_CODE,
    qrDataUrl,
    dbSubmissions
  };

  const reportSubmissions = {
    ...dbSubmissions,
    ...(qrDataUrl ? { qrurl: qrDataUrl, qrcode: qrDataUrl } : {})
  };

  const memberContext = {
    dbUser: SAMPLE_MEMBER,
    dbSubmissions: reportSubmissions
  };

  const guestContext = {
    dbUser: null,
    dbSubmissions: reportSubmissions
  };

  const member = renderCustomSubmissionEmail({
    ...base,
    dbUser: SAMPLE_MEMBER
  });

  const guest = asMember
      ? member
      : renderCustomSubmissionEmail({
        ...base,
        dbUser: null
      });

  const subjectAndBody = `${base.subject}\n${base.messageBody}`;

  // QR placeholders are not errors when the form doesn't generate a QR.
  const withoutStrippedQr = list =>
      hasQr
          ? list
          : list.filter(p => !['qrcode', 'qrurl'].includes(p.key.toLowerCase()));

  res.status(200).json({
    subject: asMember ? member.subject : guest.subject,
    member: member.html,
    guest: guest.html,

    // Report unresolved placeholders for the member preview.
    unresolved: asMember
        ? withoutStrippedQr(findUnresolved(subjectAndBody, memberContext))
            .map(p => p.token)
        : [],

    // Guest db-user placeholders are expected because guests have no account.
    guestUnresolved: asMember
        ? []
        : withoutStrippedQr(findUnresolved(subjectAndBody, guestContext))
            .filter(p => p.scope === 'db-user')
            .map(p => p.token)
  });
});

module.exports = { 
  createForm, 
  getForm,
  getForms,
  deleteForm,
  toggleFormStatus,
  updateFormSettings,
  previewSubmissionEmail,
  // Exported for the verification script and for reuse by other controllers.
  readBooleanSetting,
  readSubmissionEmailSettings,
  EMAIL_SUBJECT_MAX,
  EMAIL_BODY_MAX
};

/*
== known gaps (see the repo analysis) ==

`requiresLogin`, `sendEmailOnSubmission` and the custom email subject/body are all
settable here, and `requiresLogin` is enforced by `submitForm`. The builder's
edit modal is the only place that can change them; there is still no way to
change `fields` or `type` after a form exists.

`activityID` is not marked unique in FormModel, so forms created without one
are fine today — the concern in the original review does not apply.
*/
