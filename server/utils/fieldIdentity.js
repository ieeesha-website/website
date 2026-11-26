// Which form fields carry the submitter's identity.
//
// Every form must collect a name and an email address. `submitForm` refuses a
// submission without both, and the ticket QR, the confirmation email and the
// submissions export are all keyed on them, so a form that cannot ask for them
// is one nobody can submit to.
//
// The lookup is by pattern rather than by an exact id, because `field.id` is
// derived from the label (see fieldId.js). A field labelled "Email Address"
// becomes `email_address`, never `email`, so the id cannot be assumed. The
// patterns match the client-side pair in client/src/utils/formValidation.js —
// the two must stay in step or a form can pass the builder check and then be
// rejected at submission time.

const EMAIL_KEY_RE = /e[-_]?mail/i;
const NAME_KEY_RE = /^(full[_\-\s]?)?name$/i;
const { everyPathVisitsSection } = require('./sectionFlow');

const labelOf = (field) => String(field?.label || '').trim();

/** Does this field collect the submitter's email address? */
const isEmailField = (field) =>
  EMAIL_KEY_RE.test(field?.id || '') || EMAIL_KEY_RE.test(labelOf(field));

/** Does this field collect the submitter's name? */
const isNameField = (field) =>
  NAME_KEY_RE.test(field?.id || '') || NAME_KEY_RE.test(labelOf(field));

/** The first name-collecting field on a form, if it has one. */
const getFormSections = (form) => {
  if (Array.isArray(form?.sections) && form.sections.length > 0) {
    return form.sections;
  }

  if (Array.isArray(form?.fields) && form.fields.length > 0) {
    return [{
      id: 'registration',
      title: 'Registration',
      fields: form.fields
    }];
  }

  return [];
};

const getFormFields = (form) =>
  getFormSections(form).flatMap(section =>
    Array.isArray(section?.fields) ? section.fields : []
  );

const withFlatFormFields = (form) => {
  if (!form) return form;
  const value = typeof form.toObject === 'function'
    ? form.toObject()
    : { ...form };
  value.fields = getFormFields(value);
  return value;
};

const findNameField = (form) => getFormFields(form).find(isNameField);

/** The first email-collecting field on a form, if it has one. */
const findEmailField = (form) => getFormFields(form).find(isEmailField);

/**
 * Reject a field list that could never be submitted.
 *
 * `submitForm` already fails such a form at the last moment with a message about
 * the missing answer. Checking at creation time points at the cause instead: the
 * builder.
 *
 * @param {Array} fields
 * @param {import('mongoose').AppError} AppError
 * @throws {AppError} 400 MISSING_IDENTITY_FIELDS
 */
function assertIdentityFields(fields, AppError) {
  const missing = [];

  const nameField = (fields || []).find(isNameField);
  if (!nameField) {
    missing.push('a "Full Name" field');
  } else {
    if (!nameField.required) missing.push('the "Full Name" field marked as required');
    if (nameField.type !== 'TextInput') missing.push('the "Full Name" field as a text input');
  }

  const emailField = (fields || []).find(isEmailField);
  if (!emailField) {
    missing.push('an "Email" field');
  } else {
    if (!emailField.required) missing.push('the "Email" field marked as required');
    if (emailField.type !== 'TextInput') missing.push('the "Email" field as a text input');
  }

  if (missing.length === 0) return;

  throw new AppError(
    `This form cannot be submitted without ${missing.join(' and ')}. ` +
      'Every form must ask for a name and an email address, both required.',
    400,
    'MISSING_IDENTITY_FIELDS'
  );
}

function assertIdentityOnEveryPath(sections, AppError) {
  const checks = [
    [isNameField, 'a required Full Name field'],
    [isEmailField, 'a required Email field']
  ];

  for (const [matches, label] of checks) {
    const covered = everyPathVisitsSection(
        sections,
        section => (section?.fields || []).some(field =>
          matches(field) && field.required === true && field.type === 'TextInput'
        )
    );

    if (!covered) {
      throw new AppError(
          `Every possible form path must include ${label}.`,
          400,
          'MISSING_IDENTITY_FIELDS'
      );
    }
  }
}

module.exports = {
  EMAIL_KEY_RE,
  NAME_KEY_RE,
  isEmailField,
  isNameField,
  getFormSections,
  getFormFields,
  withFlatFormFields,
  findEmailField,
  findNameField,
  assertIdentityFields,
  assertIdentityOnEveryPath,
};
