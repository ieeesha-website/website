const Submission = require('../models/SubmissionModel');
const Form = require('../models/FormModel');
const User = require('../models/UserModel');
const mongoose = require('mongoose');
const QRCode = require('qrcode');
const ExcelJS = require('exceljs');
const {
  sendSubmissionReceivedEmail,
  sendCustomSubmissionEmail,
} = require('../utils/sendEmail');
const { nanoid } = require('nanoid');
const { catchAsync, AppError } = require('../middleware/errorsMiddleware');
const uploadToCloudinary = require('../utils/uploadToCloudinary');
const { composeAnswerValue } = require('../utils/otherOption');
const { validateSubmissionAnswers } = require('../utils/submissionValidation');
const {
  getFormFields: getDefinitionFields,
  isNameField,
  isEmailField
} = require('../utils/fieldIdentity');

/**
 * Flatten fields from the new sections-based form structure.
 * Answers themselves remain flat, keyed by field IDs.
 */
const getFormFields = (form) =>
    getDefinitionFields(form);

async function reserveSubmissionCapacity(form) {
  const existingCount = await Submission.countDocuments({ formId: form._id });
  await Form.updateOne(
      { _id: form._id },
      { $max: { submissionCount: existingCount } }
  );

  const now = new Date();
  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);
  const reserved = await Form.findOneAndUpdate(
      {
        _id: form._id,
        status: 'Active',
        startDate: { $lte: now },
        endDate: { $gte: startOfToday },
        $expr: {
          $lt: [
            { $ifNull: ['$submissionCount', 0] },
            { $ifNull: ['$maxSubmissions', Number.MAX_SAFE_INTEGER] }
          ]
        }
      },
      { $inc: { submissionCount: 1 } },
      { returnDocument: 'after' }
  ).select('+submissionCount');

  if (!reserved) {
    throw new AppError('Maximum submissions reached', 400, 'MAX_SUBMISSIONS_REACHED');
  }
}

async function releaseSubmissionCapacity(formId) {
  await Form.updateOne(
      { _id: formId, submissionCount: { $gt: 0 } },
      { $inc: { submissionCount: -1 } }
  );
}

/**
 * Format a date as YYYY-MM-DD using local time.
 */
const formatDate = (date) => {
  if (!date) return '-';

  const d = new Date(date);
  if (Number.isNaN(d.getTime())) return '-';

  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');

  return `${y}-${m}-${day}`;
};

/**
 * Format a date as 12-hour HH:mm AM/PM using local time.
 */
const formatTime = (date) => {
  if (!date) return '-';

  const d = new Date(date);
  if (Number.isNaN(d.getTime())) return '-';

  return `${String(d.getHours() % 12 || 12).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')} ${d.getHours() >= 12 ? 'PM' : 'AM'}`;
};

/**
 * Parse an object supplied either as JSON text or an actual object.
 */
const parseObjectInput = (value, label, defaultValue = {}) => {
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      throw new AppError(`${label} must be valid JSON`, 400);
    }
  }

  if (value === undefined || value === null) {
    return defaultValue;
  }

  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new AppError(`${label} must be a JSON object`, 400);
  }

  return value;
};

// @desc    Submit a form & Get Ticket
// @route   POST /api/submissions
// @access  Public — forms with requiresLogin require an account

const submitForm = catchAsync(async (req, res) => {
  const { formId } = req.body;

  const answers = parseObjectInput(req.body.answers, 'Answers', undefined);

  if (!formId || answers === undefined) {
    throw new AppError('Form ID and answers are required', 400);
  }

  let otherAnswers = parseObjectInput(
      req.body.otherAnswers,
      'otherAnswers'
  );

  // The optional authentication middleware sets req.user when a valid
  // authenticated session is present.
  const userid = req.user?._id || null;
  const userName = req.user?.name;

  // 1. Load the form.
  if (!mongoose.Types.ObjectId.isValid(formId)) {
    throw new AppError('Invalid form ID', 400, 'INVALID_FORM_ID');
  }
  const form = await Form.findById(formId);

  if (!form) {
    throw new AppError('Form not found', 404);
  }

  // 2. Check form status and expiry.
  const formEndDate = new Date(form.endDate);
  formEndDate.setHours(23, 59, 59, 999);
  const formStartDate = new Date(form.startDate);

  if (
      form.status !== 'Active' ||
      Number.isNaN(formEndDate.getTime()) ||
      Number.isNaN(formStartDate.getTime()) ||
      formEndDate < new Date() ||
      formStartDate > new Date()
  ) {
    throw new AppError('This form is currently closed', 400);
  }

  // 3. Enforce login requirement.
  if (form.requiresLogin && !userid) {
    throw new AppError('Please log in to submit this form', 401);
  }

  // 4. Get fields from either the canonical sections or a legacy flat form.
  const fields = getFormFields(form);
  const uploadedFiles = req.files || [];
  const uploadedFieldIds = uploadedFiles.map(file => file.fieldname);
  if (new Set(uploadedFieldIds).size !== uploadedFieldIds.length) {
    throw new AppError('Only one file may be uploaded per field', 400);
  }

  const validation = validateSubmissionAnswers(
      form,
      answers,
      otherAnswers,
      { uploadedFieldIds }
  );
  if (validation.errors.length) {
    throw new AppError(
        `Submission failed validation: ${validation.errors.join(' | ')}`,
        400,
        'INVALID_SUBMISSION'
    );
  }
  const cleanAnswers = validation.answers;
  const cleanOtherAnswers = validation.otherAnswers;
  for (const field of validation.fields) {
    if (
      field.type === 'FileUpload' &&
      Object.prototype.hasOwnProperty.call(answers, field.id) &&
      answers[field.id] !== null &&
      answers[field.id] !== '' &&
      !uploadedFieldIds.includes(field.id)
    ) {
      throw new AppError(`Upload a file for '${field.label}' using the file field`, 400);
    }
  }
  const nameField = validation.fields.find(isNameField);
  const emailField = validation.fields.find(isEmailField);
  const submittedName = cleanAnswers[nameField.id];
  const submittedEmail = cleanAnswers[emailField.id];

  // 8. Guest onboarding rule:
  // Guests cannot submit using an email already associated with an account.
  if (!userid) {
    const accountOwner = await User.findOne({
      email: submittedEmail,
    })
        .select('_id')
        .lean();

    if (accountOwner) {
      throw new AppError(
        'An account is already associated with this email address. Please log in with it to continue.',
        409,
        'EMAIL_HAS_ACCOUNT'
      );
    }
  }

  // 9. Check submission limit.
  // 6. Prevent duplicate submissions before reserving a capacity slot.
  let existingSubmission;

  if (userid) {
    existingSubmission = await Submission.findOne({
      formId,
      userId: userid,
    });
  } else {
    existingSubmission = await Submission.findOne({
      formId,
      registrantEmail: submittedEmail,
    });
  }

  if (existingSubmission) {
    throw new AppError(
      'You already submitted this form',
      400,
      'ALREADY_SUBMITTED'
    );
  }

  for (const file of uploadedFiles) {
    const field = validation.fields.find(f => f.id === file.fieldname);
    if (!field || field.type !== 'FileUpload') {
      throw new AppError(`Unexpected file upload field: ${file.fieldname}`, 400);
    }
  }

  await reserveSubmissionCapacity(form);
  let submissionSaved = false;
  try {
    for (const file of uploadedFiles) {
      const fileUrl = await uploadToCloudinary(
          file.buffer,
          `submissions/${formId}`,
          file.mimetype,
          `${file.originalname}-${nanoid(6)}`
      );
      cleanAnswers[file.fieldname] = fileUrl;
    }

    // Generate tickets only for attendance forms.
    let ticketCode;
    let qrImage;
    if (form.type === 'attendance') {
      ticketCode = `${formId}-${userid || 'guest'}-${nanoid(6)}`;
      qrImage = await QRCode.toDataURL(ticketCode);
    }

    const newSubmission = new Submission({
      formId,
      userId: userid,
      registrantEmail: submittedEmail,
      answers: cleanAnswers,
      otherAnswers: cleanOtherAnswers,
      visitedSectionIds: validation.visitedSectionIds,
      ...(ticketCode && { ticketCode }),
      ...(qrImage && { qrImage }),
    });

    await newSubmission.save();
    submissionSaved = true;

    // Prepare email data only from the validated, visited path.
    const recipientName = userName || submittedName || 'there';

    const dbSubmissions = {
      name: recipientName,
      email: submittedEmail,
      formTitle: form.title,
      formType: form.type,
      ticketCode,
      submittedAt: new Date().toISOString().slice(0, 10),
    };

    for (const field of validation.fields) {
      const raw = cleanAnswers[field.id];

      let value;

      if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
        value = raw.url || raw.path || raw.name || '';
      } else {
        value = composeAnswerValue(field, raw, cleanOtherAnswers);
      }

      if (field.label) {
        dbSubmissions[String(field.label).trim().toLowerCase()] = value;
      }

      if (field.id) {
        dbSubmissions[String(field.id).trim().toLowerCase()] = value;
      }
    }

    const dbUser = userid ? req.user : null;

    if (form.sendEmailOnSubmission) {
      sendCustomSubmissionEmail({
        to: submittedEmail,
        subject:
            (form.submissionEmailSubject &&
                form.submissionEmailSubject.trim()) ||
            `We received your submission for ${form.title}`,
        messageBody: form.submissionEmailBody,
        formTitle: form.title,
        userName: recipientName,
        ticketCode,
        qrDataUrl: form.type === 'attendance' ? qrImage : null,
        dbUser,
        dbSubmissions,
      }).catch(err => console.error('Email Error:', err));
    } else {
      sendSubmissionReceivedEmail({
        email: submittedEmail,
        userName: recipientName,
        formTitle: form.title,
        dbUser,
        dbSubmissions,
      }).catch(err => console.error('Email Error:', err));
    }

    res.status(201).json({
      status: 'success',
      message: 'Submitted successfully',
      ...(ticketCode && { ticketCode }),
      data: newSubmission,
    });
  } catch (error) {
    if (!submissionSaved) await releaseSubmissionCapacity(form._id);
    if (error.name === 'ValidationError') {
      throw new AppError(`Submission failed validation: ${error.message}`, 400);
    }
    if (error.code === 11000) {
      throw new AppError('You already submitted this form', 409, 'ALREADY_SUBMITTED');
    }
    throw error;
  }
});

// @desc    Scan QR Code (Gatekeeper)
// @route   POST /api/submissions/scan
// @access  Private (Scanner/XCom)
const scanTicket = catchAsync(async (req, res) => {
  const { code } = req.body;

  if (!code || typeof code !== 'string') {
    throw new AppError('Ticket code is required', 400);
  }

  const submission = await Submission.findOneAndUpdate(
      { ticketCode: code, attended: { $ne: true } },
      { $set: { attended: true, attendedAt: new Date() } },
      { returnDocument: 'after' }
  );

  if (!submission) {
    const existing = await Submission.exists({ ticketCode: code });
    if (existing) throw new AppError('Already Scanned!', 400);
    throw new AppError('Invalid Ticket!', 404);
  }

  const user = submission.userId
      ? await User.findById(submission.userId)
      : null;

  res.json({
    success: true,
    message: `Welcome, ${user ? user.name : 'Guest'}!`,
    registrant: user ? user.name : submission.registrantEmail,
  });
});

// @desc    Export Responses to Excel
// @route   GET /api/submissions/export?formId=...
// @access  Private (XCom/Board)
const exportSubmissionsToExcel = catchAsync(async (req, res) => {
  const { formId } = req.params;

  if (!mongoose.Types.ObjectId.isValid(formId)) {
    throw new AppError('Invalid form ID', 400, 'INVALID_FORM_ID');
  }

  const form = await Form.findById(formId);

  if (!form) {
    throw new AppError('Form not found in database', 404);
  }

  const submissions = await Submission.find({ formId })
      .populate(
          'userId',
          'name email phone university college yearOfStudy position organization'
      )
      .sort('-createdAt')
      .lean();

  if (!submissions.length) {
    throw new AppError('No submissions found for this form', 404);
  }

  const fields = getFormFields(form);
  const tracksAttendance = form.type === 'attendance';

  const workbook = new ExcelJS.Workbook();
  const worksheet = workbook.addWorksheet('Responses');

  const userInfoColumns = [
    { header: 'User ID', key: 'userId', width: 28 },
    { header: 'Submitted Date', key: 'date', width: 15 },
    { header: 'Submitted Time', key: 'time', width: 12 },
    ...(tracksAttendance
        ? [
          { header: 'Attended', key: 'attended', width: 10 },
          { header: 'Attended Time', key: 'attendedTime', width: 15 },
        ]
        : []),
    { header: 'Name', key: 'userName', width: 25 },
    { header: 'Email', key: 'userEmail', width: 30 },
    { header: 'Phone', key: 'userPhone', width: 15 },
    { header: 'Position', key: 'userPosition', width: 15 },
    { header: 'Organization', key: 'userOrganization', width: 20 },
    { header: 'University', key: 'userUniversity', width: 25 },
    { header: 'College', key: 'userCollege', width: 25 },
    { header: 'Year of Study', key: 'userYearOfStudy', width: 12 },
  ];

  const answerColumns = fields.map(field => ({
    header: field.label || 'Question',
    key: field.id,
    width: 30,
  }));

  const columns = [...userInfoColumns, ...answerColumns];

  worksheet.columns = columns.map(col => ({
    key: col.key,
    width: col.width,
  }));

  // Grouping row.
  const sectionRow = worksheet.getRow(1);
  sectionRow.height = 28;

  const userInfoCell = sectionRow.getCell(1);
  userInfoCell.value = 'User Information';
  userInfoCell.font = {
    bold: true,
    size: 14,
    color: { argb: 'FFFFFFFF' },
  };
  userInfoCell.fill = {
    type: 'pattern',
    pattern: 'solid',
    fgColor: { argb: 'FF1F4E79' },
  };
  userInfoCell.alignment = {
    horizontal: 'center',
    vertical: 'middle',
  };

  worksheet.mergeCells(1, 1, 1, userInfoColumns.length);

  if (answerColumns.length > 0) {
    const answersCell = sectionRow.getCell(userInfoColumns.length + 1);
    answersCell.value = "User's Answers";
    answersCell.font = {
      bold: true,
      size: 14,
      color: { argb: 'FFFFFFFF' },
    };
    answersCell.fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FF548235' },
    };
    answersCell.alignment = {
      horizontal: 'center',
      vertical: 'middle',
    };

    worksheet.mergeCells(
        1,
        userInfoColumns.length + 1,
        1,
        columns.length
    );
  }

  // Header row.
  const headerRow = worksheet.getRow(2);

  columns.forEach((col, index) => {
    headerRow.getCell(index + 1).value = col.header;
  });

  headerRow.height = 20;

  headerRow.eachCell(cell => {
    cell.font = { bold: true };
    cell.fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FFDDEBF7' },
    };
    cell.alignment = {
      horizontal: 'center',
      vertical: 'middle',
    };
    cell.border = {
      top: { style: 'thin', color: { argb: 'FF9DC3E6' } },
      left: { style: 'thin', color: { argb: 'FF9DC3E6' } },
      bottom: { style: 'thin', color: { argb: 'FF9DC3E6' } },
      right: { style: 'thin', color: { argb: 'FF9DC3E6' } },
    };
  });

  // Map field IDs to field definitions for answer formatting.
  const fieldsById = new Map(fields.map(field => [field.id, field]));

  // Rows.
  for (const sub of submissions) {
    const rowData = {
      userId: sub.userId?._id?.toString() || '-',
      date: formatDate(sub.createdAt),
      time: formatTime(sub.createdAt),
      ...(tracksAttendance
          ? {
            attended: sub.attended ? 'Yes' : 'No',
            attendedTime: formatTime(sub.attendedAt),
          }
          : {}),
      userName: sub.userId?.name || 'Guest',
      userEmail: sub.registrantEmail || sub.userId?.email || '-',
      userPhone: sub.userId?.phone || '-',
      userPosition: sub.userId?.position || '-',
      userOrganization: sub.userId?.organization || '-',
      userUniversity: sub.userId?.university || '-',
      userCollege: sub.userId?.college || '-',
      userYearOfStudy: sub.userId?.yearOfStudy ?? '-',
    };

    if (sub.answers) {
      for (const [key, value] of Object.entries(sub.answers)) {
        const field = fieldsById.get(key);

        rowData[key] = field
            ? composeAnswerValue(field, value, sub.otherAnswers)
            : Array.isArray(value)
                ? value.join(' - ')
                : value;
      }
    }

    worksheet.addRow(rowData);
  }

  // Download.
  res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  );
  res.setHeader(
      'Content-Disposition',
      `attachment; filename=responses_${formId}.xlsx`
  );

  await workbook.xlsx.write(res);
  res.end();
});

// @desc    Get single submission
// @route   GET /api/submission/:formid/:userid
// @access  Private
const getUserSubmission = catchAsync(async (req, res) => {
  const { formid, userid } = req.params;
  if (
    !mongoose.Types.ObjectId.isValid(formid) ||
    !mongoose.Types.ObjectId.isValid(userid)
  ) {
    throw new AppError('Invalid submission lookup ID', 400);
  }

  const submission = await Submission.findOne({
    formId: formid,
    userId: userid,
  });

  if (!submission) {
    throw new AppError('Submission not found', 404);
  }

  res.json(submission);
});

// @desc    Get all submissions
// @route   GET /api/submission
// @access  Private (Admin)
const getSubmissions = catchAsync(async (req, res) => {
  const [result] = await Submission.aggregate([
    {
      $facet: {
        submissions: [
          { $sort: { createdAt: -1 } },
        ],
        totalCount: [
          { $count: 'count' },
        ],
        attendedCount: [
          { $match: { attended: true } },
          { $count: 'count' },
        ],
        notAttendedCount: [
          { $match: { attended: false } },
          { $count: 'count' },
        ],
      },
    },
  ]);

  const submissions = await Submission.populate(
      result.submissions,
      [
        {
          path: 'formId',
          select: 'title type',
        },
        {
          path: 'userId',
          select: 'name email',
        },
      ]
  );

  res.json({
    totalCount: result.totalCount[0]?.count || 0,
    attendedCount: result.attendedCount[0]?.count || 0,
    notAttendedCount: result.notAttendedCount[0]?.count || 0,
    submissions,
  });
});

// @desc    Edit submission
// @route   PUT /api/submission/:id
// @access  Private (Admin)
const editSubmission = catchAsync(async (req, res) => {
  if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
    throw new AppError('Invalid submission ID', 400);
  }
  const submission = await Submission.findById(req.params.id);

  if (!submission) {
    throw new AppError('Submission not found', 404);
  }

  const { answers, otherAnswers } = req.body;

  if (answers !== undefined) {
    submission.answers = parseObjectInput(answers, 'Answers');
  }

  if (otherAnswers !== undefined) {
    submission.otherAnswers = parseObjectInput(
        otherAnswers,
        'otherAnswers'
    );
  }

  await submission.save();

  res.json(submission);
});

const getSubmissionsForForm = catchAsync(async (req, res) => {
  const { formId } = req.params;
  if (!mongoose.Types.ObjectId.isValid(formId)) {
    throw new AppError('Invalid form ID', 400, 'INVALID_FORM_ID');
  }

  // This endpoint must remain accessible for closed/expired forms.
  // It is intended for administrative review.
  const form = await Form.findById(formId)
      .select('title type sections fields')
      .lean();

  if (!form) {
    throw new AppError('Form not found', 404);
  }
  form.fields = getFormFields(form);

  const submissions = await Submission.find({ formId })
      .populate('userId', 'name email')
      .sort({ createdAt: -1 });

  res.json({
    total: submissions.length,
    submissions,
    form,
  });
});

// @desc    Download uploaded file
// @route   GET /api/submissions/download?url=...
// @access  Private
const downloadFile = catchAsync(async (req, res) => {
  const { url } = req.query;

  if (!url || typeof url !== 'string') {
    throw new AppError('URL is required', 400);
  }

  let parsedUrl;

  try {
    parsedUrl = new URL(url);
  } catch {
    throw new AppError('Invalid URL', 400);
  }

  // Only allow HTTPS Cloudinary-hosted files.
  // This prevents arbitrary server-side URL fetching (SSRF).
  if (
      parsedUrl.protocol !== 'https:' ||
      parsedUrl.hostname !== 'res.cloudinary.com'
  ) {
    throw new AppError('Unsupported file URL', 400);
  }

  const response = await fetch(parsedUrl.toString(), {
    redirect: 'error',
  });

  if (!response.ok) {
    throw new AppError('File not found', 404);
  }

  const contentType =
      response.headers.get('content-type') || 'application/octet-stream';

  res.setHeader('Content-Type', contentType);
  res.setHeader('Content-Disposition', 'attachment');

  const buffer = Buffer.from(await response.arrayBuffer());

  res.send(buffer);
});

module.exports = {
  submitForm,
  scanTicket,
  getUserSubmission,
  getSubmissions,
  getSubmissionsForForm,
  editSubmission,
  exportSubmissionsToExcel,
  downloadFile,
};