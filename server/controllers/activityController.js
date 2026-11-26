const mongoose = require('mongoose');
const { catchAsync, AppError } = require('../middleware/errorsMiddleware.js');
const Activity = require('../models/ActivityModel.js');
const FeaturedActivities = require('../models/FeaturedActivitiesModel.js');
const Form = require('../models/FormModel.js');
const Submission = require('../models/SubmissionModel.js');
const cloudinary = require('../config/cloudinary.js');
const sanitizeHtml = require('sanitize-html');
const {
  assertIdentityFields,
  assertIdentityOnEveryPath
} = require('../utils/fieldIdentity');
const { VIEW_ROLES } = require('../constants/roles');
const {
  resolveFormSections,
  validateFormDocument
} = require('../utils/formDefinition');
const { runWithOptionalTransaction } = require('../utils/runTransaction');

/**
 * Whether this caller is allowed to see unpublished activities.
 *
 * Both conditions are required, and the second one is the important one. The
 * dashboard and the public site call the same endpoints, and the session cookie
 * rides along on every request - including the ones made by /events and the home
 * page. Deciding this from the role alone therefore leaks: a board member signed
 * into the dashboard in the same browser would see unpublished activities on the
 * public pages too, which is exactly what `showOnSite` exists to prevent.
 *
 * So it is page-driven, not identity-driven. The public hooks never send
 * `includeHidden`; only the dashboard does. An anonymous visitor who types
 * `?includeHidden=true` still gets nothing, because the role check fails, so the
 * flag cannot be used to reach a draft from outside.
 */
const wantsHidden = (req) =>
  req.query?.includeHidden === 'true' &&
  Boolean(req.user && VIEW_ROLES.includes(req.user.role));

/**
 * The extra query that hides unpublished activities.
 *
 * `= true`, not `$ne: false`: anything that is not explicitly published stays off
 * the public site, so a document that somehow lost the field disappears rather
 * than being shown by accident. Run
 * `server/scripts/backfill-activity-show-on-site.js` before deploying, or every
 * activity created before the field existed will vanish from the public pages.
 */
const visibleOnly = (req) => (wantsHidden(req) ? {} : { showOnSite: true });


/**
 >> each activity has a form associated with it. <<

 * POST    /api/activities --> create a new activity      (createActivity)
 * GET     /api/activities --> get all activities         (getActivities)
 * GET     /api/activities/:id --> get activity by id     (getActivityById)
 * PUT     /api/activities/:id --> update activity by id  (updateActivity)
 * DELETE  /api/activities/:id --> delete activity by id  (deleteActivity)
*/

const uploadToCloudinary = (buffer) => {
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      { folder: 'activities' }, 
      (error, result) => {
        if (error) return reject(error);
        resolve(result);
      }
    );
    stream.end(buffer);
  });
};

const parseBoolean = (value, label) => {
  if (value === true || value === 'true') return true;
  if (value === false || value === 'false') return false;
  throw new AppError(`${label} must be true or false`, 400);
};

const sanitizeHtmlOptions = {
  allowedTags: ["h1","h2","h3","p","b","i","em","strong","u","s","del","mark","ul","ol","li","a","br","hr","blockquote","code","pre","span"],
  allowedAttributes: {
    a: ["href","target","rel"],
    "*": ["class","style"],
  },
};

const createActivity = catchAsync(async (req, res) => {
  let {
    title,
    content,
    description,
    type,
    speakers,
    location,
    registrationEnabled,
    showOnSite,
    fields,
    sections,
    startDate,
    endDate,
    maxSubmissions,
    formStatus
  } = req.body;

  if (!title || !content || !location) {
    throw new AppError("Title, content, and location are required", 400);
  }

  content = sanitizeHtml(content, sanitizeHtmlOptions);
  const activitySpeakers = speakers || [];

  if (!startDate) startDate = new Date();

  if (!endDate) {
    endDate = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  }

  const resolvedSections = resolveFormSections({
    sections,
    fields,
    defaultFields: [
      { label: 'Name', type: 'TextInput', required: true },
      { label: 'Email', type: 'TextInput', required: true }
    ]
  }, AppError);
  const resolvedFields = resolvedSections.flatMap(section => section.fields);
  assertIdentityFields(resolvedFields, AppError);
  assertIdentityOnEveryPath(resolvedSections, AppError);

  if (registrationEnabled !== undefined) {
    registrationEnabled = parseBoolean(registrationEnabled, 'registrationEnabled');
  }
  if (showOnSite !== undefined) showOnSite = parseBoolean(showOnSite, 'showOnSite');
  if (maxSubmissions === '') maxSubmissions = undefined;
  if (maxSubmissions === null) maxSubmissions = undefined;
  if (
    !Number.isInteger(Number(maxSubmissions)) &&
    maxSubmissions !== undefined &&
    maxSubmissions !== null
  ) {
    throw new AppError('maxSubmissions must be a positive integer', 400);
  }
  if (
    maxSubmissions !== undefined &&
    maxSubmissions !== null &&
    Number(maxSubmissions) < 1
  ) {
    throw new AppError('maxSubmissions must be a positive integer', 400);
  }

  const formStartDate = new Date(startDate);
  const formEndDate = new Date(endDate);
  if (
    Number.isNaN(formStartDate.getTime()) ||
    Number.isNaN(formEndDate.getTime()) ||
    formStartDate > formEndDate
  ) {
    throw new AppError('Activity start date must be before or equal to end date', 400);
  }

  const activity = new Activity({
    title,
    content,
    description: description || "",
    type,
    speakers: activitySpeakers,
    location,
    startDate,
    endDate,
    coverImage: '',
    coverImagePublicId: '',
    registrationEnabled: registrationEnabled ?? true,
    showOnSite: showOnSite ?? true
  });

  const form = new Form({
    title: activity.title,
    createdBy: req.user._id,
    sections: resolvedSections,
    startDate: formStartDate,
    endDate: formEndDate,
    maxSubmissions,
    type: 'attendance',
    status: formStatus || 'Active'
  });

  try {
    await activity.validate();
    await validateFormDocument(form, AppError);
  } catch (error) {
    if (error.name === 'ValidationError') {
      throw new AppError(error.message, 400, 'INVALID_ACTIVITY');
    }
    throw error;
  }

  let coverImageUrl = '';
  let coverImagePublicId = '';
  if (req.file) {
    const result = await uploadToCloudinary(req.file.buffer);
    coverImageUrl = result.secure_url;
    coverImagePublicId = result.public_id;
    activity.coverImage = coverImageUrl;
    activity.coverImagePublicId = coverImagePublicId;
  }

  try {
    await activity.save();
    form.activityID = activity._id;
    await form.save();
  } catch (error) {
    if (activity._id) await Activity.findByIdAndDelete(activity._id);
    if (coverImagePublicId) {
      await cloudinary.uploader.destroy(coverImagePublicId).catch(() => {});
    }
    throw error;
  }

  res.status(201).json({
    success: true,
    message: "Activity created with associated form",
    activity,
    form
  });
});


const getActivities = catchAsync(async (req, res) => {
  // pagination feature
  let page = Number(req.query.page) || 1;
  let limit = Number(req.query.limit) || 10;

  if (!Number.isInteger(page) || page < 1)
    page = 1;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100)
    limit = 10;

  const skip = (page - 1) * limit;

  const sortOrder = req.query.sort === "desc" ? -1 : 1;

  // `.lean()` is required for correctness here, not a micro-optimisation.
  // Mongoose applies schema defaults when it *hydrates* a document, so a stored
  // activity with no `showOnSite` at all reads back as `true` in JS - while the
  // `{ showOnSite: true }` filter above, which runs against the raw BSON, does not
  // match it. Hydrated, the same activity would be excluded from the list but
  // reported as published, and the dashboard toggle would sit in the wrong
  // position. Lean keeps the reported value equal to the stored one, so the two
  // can never disagree.

  let {date, startDate, endDate, year} = req.query;
  let dateFilter = {};

  if (date) {
    date = new Date(date);

    if (Number.isNaN(date.getTime())) {
      throw new AppError("Invalid date.", 400);
    }

    const dayStart = new Date(date);
    dayStart.setHours(0, 0, 0, 0);

    const dayEnd = new Date(date);
    dayEnd.setHours(23, 59, 59, 999);

    dateFilter = {
      startDate: {$lte: dayEnd},
      endDate: {$gte: dayStart}
    }
  } else if (startDate && endDate) {
    startDate = new Date(startDate);
    endDate = new Date(endDate);

    if (
        Number.isNaN(startDate.getTime()) ||
        Number.isNaN(endDate.getTime())
    ) {
      throw new AppError("Invalid dates.", 400);
    }

    if (startDate > endDate) {
      throw new AppError("Start date cannot be after end date", 400);
    }

    dateFilter = {
      startDate: {$lte: endDate},
      endDate: {$gte: startDate}
    }
  } else if (year) {
    if (!/^\d{4}$/.test(year)) {
      throw new AppError("Invalid year.", 400);
    }

    year = Number(year);

    if (
        !Number.isInteger(year) ||
        year < 1000 ||
        year > 9999
    ) {
      throw new AppError("Invalid year.", 400);
    }

    const yearStart = new Date(year, 0, 1);
    const yearEnd = new Date(year, 11, 31, 23, 59, 59, 999);

    dateFilter = {
      startDate: {$lte: yearEnd},
      endDate: {$gte: yearStart}
    }
  }

  const filter = {
    $and: [
      visibleOnly(req),
      dateFilter
    ]
  }

  const [activities, numberOfActivities] = await Promise.all([
    Activity
      .find(filter)
      .skip(skip)
      .limit(limit)
      .sort({startDate: sortOrder})
      .lean(),

    Activity.countDocuments(filter)
  ]);

  const activityIDs = activities.map(activity => activity._id);

  const forms = await Form.find({
    activityID: {$in: activityIDs}
  }).lean();

  const formsMap = new Map(
      forms.map(form => [form.activityID.toString(), form])
  );

  const now = new Date();

  const formattedActivities = activities.map(activity => {
        const form = formsMap.get(activity._id.toString()); // to avoid N+1 problem.
        const endDatePassed = form?.endDate && new Date(form.endDate) < now;
        const computedStatus = form
          ? (endDatePassed || form.status === "Closed" ? "Closed" : form.status)
          : "No Form Found";
        return {
          _id: activity._id,
          title: activity.title,
          content: activity.content,
          description: activity.description,
          type: activity.type,
          speakers: activity.speakers,
          location: activity.location,
          startDate: activity.startDate,
          endDate: activity.endDate,
          createdAt: activity.createdAt,
          coverImage: activity.coverImage || "",
          registrationEnabled: activity.registrationEnabled,
          // Reported whatever the caller may see, so the dashboard can render the
          // toggle. Strict, to match the filter: a document with no value for the
          // field counts as unpublished, so reporting true for it here would put
          // the toggle in the wrong position.
          showOnSite: activity.showOnSite === true,
          status: computedStatus,

          formID: form ? form._id : null
        };
  });

  res.json({ 
    success: true, 
    pagination: {
      totalItems: numberOfActivities,
      totalPages: Math.ceil(numberOfActivities / limit),
      currentPage: page,
      itemsPerPage: limit
    },
    activities: formattedActivities
  });
});

const getActivityById = catchAsync(async (req, res) => {
  if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
    throw new AppError('Invalid Activity ID format', 400);
  }
  // The same filter as the list, applied through the same query, rather than a
  // second rule written separately. Anything less and the two drift: filtering the
  // list with `{ showOnSite: true }` while testing `activity.showOnSite === true`
  // in JS here would disagree, because Mongoose fills the default in on hydration
  // and a document with no stored value would then pass.
  const activity = await Activity.findOne({ _id: req.params.id, ...visibleOnly(req) }).lean();
  if (!activity) throw new AppError("Activity not found", 404);
  // Also fetch associated form
  const form = await Form.findOne({ activityID: activity._id });
  res.json({ success: true, activity, form });
});

const updateActivity = catchAsync(async (req, res) => {
  if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
    throw new AppError('Invalid Activity ID format', 400);
  }

  const existingActivity = await Activity.findById(req.params.id);
  if (!existingActivity) {
    throw new AppError("Activity not found", 404);
  }
  const oldCoverImagePublicId = existingActivity.coverImagePublicId;

  const allowedActivityFields = [
    'title',
    'content',
    'description',
    'type',
    'speakers',
    'location',
    'startDate',
    'endDate',
    'registrationEnabled',
    'showOnSite'
  ];
  const updateData = {};
  for (const key of allowedActivityFields) {
    if (req.body[key] !== undefined) updateData[key] = req.body[key];
  }
  if (updateData.content !== undefined) {
    updateData.content = sanitizeHtml(updateData.content, sanitizeHtmlOptions);
  }
  for (const key of ['registrationEnabled', 'showOnSite']) {
    if (updateData[key] !== undefined) {
      updateData[key] = parseBoolean(updateData[key], key);
    }
  }

  const resultingActivity = {
    ...existingActivity.toObject(),
    ...updateData
  };
  const startDate = new Date(resultingActivity.startDate);
  const endDate = new Date(resultingActivity.endDate);
  if (
    Number.isNaN(startDate.getTime()) ||
    Number.isNaN(endDate.getTime()) ||
    startDate > endDate
  ) {
    throw new AppError('Activity start date must be before or equal to end date', 400);
  }

  const form = await Form.findOne({ activityID: existingActivity._id });
  const formKeys = ['sections', 'fields', 'formStatus', 'maxSubmissions'];
  const hasFormUpdate = formKeys.some(key => req.body[key] !== undefined);
  if (hasFormUpdate && !form) {
    throw new AppError('Registration form not found for this activity', 404);
  }

  let resolvedSections;
  let requestedMaxSubmissions;
  if (form && (req.body.sections !== undefined || req.body.fields !== undefined)) {
    resolvedSections = resolveFormSections({
      sections: req.body.sections,
      fields: req.body.fields
    }, AppError);
    const formFields = resolvedSections.flatMap(section => section.fields);
    assertIdentityFields(formFields, AppError);
    assertIdentityOnEveryPath(resolvedSections, AppError);
    form.sections = resolvedSections;
  }

  if (form) {
    if (updateData.title !== undefined) form.title = updateData.title;
    form.startDate = startDate;
    form.endDate = endDate;

    if (req.body.formStatus !== undefined) {
      if (!Form.schema.path('status').enumValues.includes(req.body.formStatus)) {
        throw new AppError('Invalid form status', 400);
      }
      form.status = req.body.formStatus;
    }
    if (req.body.maxSubmissions !== undefined) {
      if (req.body.maxSubmissions === '') {
        requestedMaxSubmissions = Number.MAX_SAFE_INTEGER;
      } else {
        const maxSubmissions = Number(req.body.maxSubmissions);
        if (!Number.isInteger(maxSubmissions) || maxSubmissions < 1) {
          throw new AppError('maxSubmissions must be a positive integer', 400);
        }
        requestedMaxSubmissions = maxSubmissions;
      }
    }
  }

  existingActivity.set(updateData);
  try {
    await existingActivity.validate();
    if (form) await validateFormDocument(form, AppError);
  } catch (error) {
    if (error instanceof AppError) throw error;
    if (error.name === 'ValidationError' || error.name === 'CastError') {
      throw new AppError(error.message, 400, 'INVALID_ACTIVITY');
    }
    throw error;
  }

  let newCoverImagePublicId;
  if (req.file) {
    const result = await uploadToCloudinary(req.file.buffer);
    existingActivity.coverImage = result.secure_url;
    existingActivity.coverImagePublicId = result.public_id;
    newCoverImagePublicId = result.public_id;
  } else if (req.body.coverImage === '') {
    existingActivity.coverImage = '';
    existingActivity.coverImagePublicId = '';
  }

  try {
    await runWithOptionalTransaction(async session => {
      const sessionOptions = session ? { session } : {};
      if (form && requestedMaxSubmissions !== undefined) {
        const submissionCount = await Submission.countDocuments(
            { formId: form._id },
            sessionOptions
        );
        await Form.updateOne(
            { _id: form._id },
            { $max: { submissionCount } },
            sessionOptions
        );
      }
      await existingActivity.save(sessionOptions);
      if (form) await form.save(sessionOptions);
      if (form && requestedMaxSubmissions !== undefined) {
        const capacityUpdate = await Form.updateOne(
            {
              _id: form._id,
              $expr: {
                $lte: [
                  { $ifNull: ['$submissionCount', 0] },
                  requestedMaxSubmissions
                ]
              }
            },
            { $set: { maxSubmissions: requestedMaxSubmissions } },
            { ...sessionOptions, runValidators: true }
        );
        if (!capacityUpdate.matchedCount) {
          throw new AppError(
              'maxSubmissions cannot be lower than the number of existing submissions.',
              400,
              'MAX_SUBMISSIONS_BELOW_CURRENT'
          );
        }
      }
    });
  } catch (error) {
    if (newCoverImagePublicId) {
      await cloudinary.uploader.destroy(newCoverImagePublicId).catch(() => {});
    }
    throw error;
  }

  if (form && requestedMaxSubmissions !== undefined) {
    form.maxSubmissions = requestedMaxSubmissions;
  }

  if (
    oldCoverImagePublicId &&
    oldCoverImagePublicId !== existingActivity.coverImagePublicId
  ) {
    await cloudinary.uploader.destroy(oldCoverImagePublicId);
  }

  res.json({ success: true, activity: existingActivity, form });
});

// Delete activity + related form + all related submissions
const deleteActivity = catchAsync(async (req, res) => {
  if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
    throw new AppError('Invalid Activity ID format', 400);
  }
  const activity = await Activity.findById(req.params.id);
  if (!activity) throw new AppError("Activity not found", 404);

  const form = await Form.findOne({ activityID: activity._id });
  await runWithOptionalTransaction(async session => {
      const sessionOptions = session ? { session } : {};
      if (form) {
        const deletion = Submission.deleteMany({ formId: form._id });
        if (session) deletion.session(session);
        await deletion;
        await form.deleteOne(sessionOptions);
      }
      await FeaturedActivities.updateMany(
        { activities: activity._id },
        { $pull: { activities: activity._id } },
        sessionOptions
      );
      await activity.deleteOne(sessionOptions);
  });

  if (activity.coverImagePublicId) {
    await cloudinary.uploader.destroy(activity.coverImagePublicId);
  }

  res.json({ success: true, message: "Activity + related form + submissions deleted" });
});

const addFeaturedActivity = async (req, res) => {
  try {
    const activityId = req.params.id;

    if (!mongoose.Types.ObjectId.isValid(activityId)) {
      return res.status(400).json({ message: "Invalid Activity ID format" });
    }
    if (!(await Activity.exists({ _id: activityId }))) {
      return res.status(404).json({ message: "Activity not found" });
    }

    let featuredDoc = await FeaturedActivities.findOne();

    // create new doc if it doesn't exist
    if (!featuredDoc) {
      featuredDoc = new FeaturedActivities({ activities: [] });
    }

    // ensure we don't have more than 2 activities
    if (featuredDoc.activities.length >= 2) {
      return res.status(400).json({ 
        message: "You can only display up to 2 activities. Please remove one first." 
      });
    }

    // avoid adding the same activity twice
    if (featuredDoc.activities.some(id => id.toString() === activityId)) {
      return res.status(400).json({ message: "This activity is already featured." });
    }

    // add the activity to the list
    featuredDoc.activities.push(activityId);
    await featuredDoc.save();

    res.status(200).json({
      message: "Activity added to featured list successfully",
      data: featuredDoc.activities
    });

  } catch (error) {
    console.error("Error adding featured activity:", error);
    res.status(500).json({ message: "Internal server error" });
  }
};

const removeFeaturedActivity = async (req, res) => {
  try {
    const activityId = req.params.id;

    if (!mongoose.Types.ObjectId.isValid(activityId)) {
      throw new AppError("Invalid Activity ID format", 400);
    }

    // we use findOneAndUpdate to update the doc atomically
    const updatedDoc = await FeaturedActivities.findOneAndUpdate(
      {}, // we don't need to match anything
      { $pull: { activities: activityId } }, // remove the activity from the list
      { returnDocument: 'after' } // return the updated doc
    );

    // if no doc was found, return an error
    if (!updatedDoc) {
      throw new AppError("No featured activities list found.", 404);
    }

    res.status(200).json({
      message: "Activity removed from featured list successfully",
      data: updatedDoc.activities
    });

  } catch (error) {
    if (error instanceof AppError) {
      return res.status(error.statusCode).json({
        message: error.message,
        ...(error.code ? { code: error.code } : {})
      });
    }
    console.error("Error removing featured activity:", error);
    res.status(500).json({ message: "Internal server error" });
  }
};

const getFeaturedActivities = catchAsync(async (req, res) => {
  // `.lean()` for the same reason as getActivities: without it Mongoose fills the
  // schema default into a populated document that has no stored value, so the
  // filter below and the reported flag would disagree.
  const featuredDoc = await FeaturedActivities.findOne().populate('activities').lean();
  // Same rule as the list: the featured carousel is on the public home page, so a
  // hidden activity must not sit in it. A dashboard reader still sees the full
  // set, or they could not check what is queued up there.
  const seesHidden = wantsHidden(req);
  const activities = (featuredDoc?.activities || []).filter(
    (a) => seesHidden || a.showOnSite === true
  );

  const formatted = await Promise.all(
    activities.map(async (activity) => {
      const form = await Form.findOne({ activityID: activity._id });
      return {
        _id: activity._id,
        title: activity.title,
        content: activity.content,
        description: activity.description,
        type: activity.type,
        speakers: activity.speakers,
        location: activity.location,
        startDate: activity.startDate,
        endDate: activity.endDate,
        createdAt: activity.createdAt,
        coverImage: activity.coverImage || "",
          registrationEnabled: activity.registrationEnabled,
          // Strict, to match the filter above: a document with no value for the
          // field is unpublished as far as the public site is concerned, so
          // reporting true for it here would put the toggle in the wrong position.
          showOnSite: activity.showOnSite === true,
          status: form ? form.status : "No Form Found",

        formID: form ? form._id : null,
      };
    })
  );

  res.json({ success: true, activities: formatted });
});

const swapFeaturedActivities = async (req, res) => {
  try {
    const featuredDoc = await FeaturedActivities.findOne();
    if (!featuredDoc || featuredDoc.activities.length < 2) {
      return res.status(400).json({ message: "Need exactly 2 featured activities to swap." });
    }
    featuredDoc.activities.reverse();
    await featuredDoc.save();
    res.status(200).json({
      message: "Featured activities swapped successfully",
      data: featuredDoc.activities
    });
  } catch (error) {
    res.status(500).json({ message: "Internal server error" });
  }
};

module.exports = {
  createActivity,
  getActivities,
  getActivityById,
  updateActivity,
  deleteActivity,
  addFeaturedActivity,
  removeFeaturedActivity,
  getFeaturedActivities,
  swapFeaturedActivities,
};