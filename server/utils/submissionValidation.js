const validator = require('validator');
const {
  getFormSections,
  isEmailField,
  isNameField
} = require('./fieldIdentity');
const {
  resolveSectionIds,
  resolveVisitedSections
} = require('./sectionFlow');
const {
  isOtherCapable,
  selectsOther,
  otherText
} = require('./otherOption');
const {
  isPlaceholderValue,
  PLACEHOLDER_MESSAGE
} = require('./placeholderValue');

const isMissing = value =>
  value === undefined ||
  value === null ||
  (typeof value === 'string' && value.trim() === '') ||
  (Array.isArray(value) && value.length === 0);

function validateSubmissionAnswers(
    form,
    answers = {},
    otherAnswers = {},
    { uploadedFieldIds = [] } = {}
) {
  const sections = getFormSections(form);
  const sectionIds = resolveSectionIds(sections);
  const visitedSections = resolveVisitedSections(sections, answers);
  const visitedSectionIds = visitedSections.map(section => {
    const index = sections.indexOf(section);
    return section.id || sectionIds[index];
  });
  const fields = visitedSections.flatMap(section => section.fields || []);
  const uploaded = new Set(uploadedFieldIds);
  const errors = [];
  const cleanAnswers = {};
  const cleanOtherAnswers = {};

  const nameField = fields.find(isNameField);
  const emailField = fields.find(isEmailField);

  if (!nameField || nameField.type !== 'TextInput' || !nameField.required) {
    errors.push('A required name field must be present in a visited section.');
  }
  if (!emailField || emailField.type !== 'TextInput' || !emailField.required) {
    errors.push('A required email field must be present in a visited section.');
  }

  for (const field of fields) {
    const hasAnswer = Object.prototype.hasOwnProperty.call(answers, field.id);
    const raw = hasAnswer ? answers[field.id] : undefined;
    const missing = isMissing(raw);

    if (field.type === 'FileUpload' && uploaded.has(field.id) && missing) {
      continue;
    }

    if (field.required && missing) {
      errors.push(`Field '${field.label}' is required.`);
      continue;
    }

    if (missing) continue;

    let answer = raw;

    if (field.type === 'Dropdown') {
      if (
        typeof raw !== 'string' ||
        !Array.isArray(field.options) ||
        !field.options.includes(raw)
      ) {
        errors.push(`Invalid option for '${field.label}'.`);
        continue;
      }
    } else if (field.type === 'Checkbox') {
      if (
        !Array.isArray(raw) ||
        raw.some(item => typeof item !== 'string') ||
        raw.some(item => !(field.options || []).includes(item)) ||
        new Set(raw).size !== raw.length ||
        raw.some(isPlaceholderValue)
      ) {
        errors.push(`Invalid choices for '${field.label}'.`);
        continue;
      }
    } else if (field.type === 'TextInput' || field.type === 'TextArea') {
      if (typeof raw !== 'string') {
        errors.push(`Field '${field.label}' must be text.`);
        continue;
      }
      if (isPlaceholderValue(raw)) {
        errors.push(`Field '${field.label}': ${PLACEHOLDER_MESSAGE}`);
        continue;
      }
      if (isNameField(field)) answer = raw.trim();
      if (isEmailField(field)) answer = raw.trim().toLowerCase();
    } else if (field.type === 'FileUpload') {
      let parsedUrl;
      try {
        parsedUrl = new URL(raw);
      } catch {
        parsedUrl = null;
      }
      if (
        typeof raw !== 'string' ||
        !parsedUrl ||
        parsedUrl.protocol !== 'https:' ||
        parsedUrl.hostname !== 'res.cloudinary.com'
      ) {
        errors.push(`Field '${field.label}' must contain a valid Cloudinary file URL.`);
        continue;
      }
    }

    if (
      typeof answer === 'string' &&
      isPlaceholderValue(answer)
    ) {
      errors.push(`Field '${field.label}': ${PLACEHOLDER_MESSAGE}`);
      continue;
    }

    cleanAnswers[field.id] = answer;

    if (isOtherCapable(field) && selectsOther(field, answer)) {
      const detail = otherText(otherAnswers, field.id);
      if (!detail) {
        errors.push(
            `Field '${field.label}' needs a value because you selected "Other".`
        );
      } else if (detail.length > 200) {
        errors.push(`Field '${field.label}' Other text must be 200 characters or fewer.`);
      } else if (isPlaceholderValue(detail)) {
        errors.push(`Field '${field.label}': ${PLACEHOLDER_MESSAGE}`);
      } else {
        cleanOtherAnswers[field.id] = detail;
      }
    }

    if (isEmailField(field) && !validator.isEmail(String(answer))) {
      errors.push('Please enter a valid email address.');
    }
  }

  return {
    errors,
    answers: cleanAnswers,
    otherAnswers: cleanOtherAnswers,
    visitedSections,
    visitedSectionIds,
    fields
  };
}

module.exports = { validateSubmissionAnswers };
