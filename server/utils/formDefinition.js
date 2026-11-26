const { deriveFieldIds, describeFieldIdProblems } = require('./fieldId');
const {
  resolveSectionIds,
  assertValidSectionFlow
} = require('./sectionFlow');

const FIELD_TYPES = [
  'TextInput',
  'TextArea',
  'Dropdown',
  'Checkbox',
  'FileUpload'
];
const RESERVED_FIELD_IDS = new Set([
  '__proto__',
  'prototype',
  'constructor',
  'toString',
  'valueOf',
  'hasOwnProperty',
  'isPrototypeOf',
  'propertyIsEnumerable',
  'toLocaleString'
]);

function parseArray(value, label, AppError) {
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      throw new AppError(`${label} must be valid JSON`, 400, 'INVALID_FORM_DEFINITION');
    }
  }

  if (!Array.isArray(value)) {
    throw new AppError(`${label} must be a list`, 400, 'INVALID_FORM_DEFINITION');
  }

  return value;
}

function resolveFormSections({
  sections,
  fields,
  defaultFields,
  sectionTitle = 'Registration'
}, AppError) {
  if (sections !== undefined && fields !== undefined) {
    throw new AppError(
        'Provide either sections or fields, not both',
        400,
        'AMBIGUOUS_FORM_DEFINITION'
    );
  }

  let resolved;

  if (sections !== undefined) {
    resolved = parseArray(sections, 'sections', AppError);
  } else {
    const flatFields = fields === undefined
      ? defaultFields
      : parseArray(fields, 'fields', AppError);

    resolved = [{ title: sectionTitle, fields: flatFields }];
  }

  if (resolved.length === 0) {
    throw new AppError('A form needs at least one section', 400, 'NO_SECTIONS');
  }

  for (const [sectionIndex, section] of resolved.entries()) {
    if (!section || typeof section !== 'object' || Array.isArray(section)) {
      throw new AppError(
          `Section ${sectionIndex + 1} must be an object`,
          400,
          'INVALID_SECTION'
      );
    }

    if (typeof section.title !== 'string' || !section.title.trim()) {
      throw new AppError(
          `Section ${sectionIndex + 1} must have a title`,
          400,
          'INVALID_SECTION_TITLE'
      );
    }

    if (
        section.description !== undefined &&
        typeof section.description !== 'string'
    ) {
      throw new AppError(
          `Section "${section.title}" description must be text`,
          400,
          'INVALID_SECTION_DESCRIPTION'
      );
    }

    if (!Array.isArray(section.fields) || section.fields.length === 0) {
      throw new AppError(
          `Section "${section.title}" needs at least one field`,
          400,
          'NO_SECTION_FIELDS'
      );
    }

    for (const [fieldIndex, field] of section.fields.entries()) {
      if (!field || typeof field !== 'object' || Array.isArray(field)) {
        throw new AppError(
            `Section "${section.title}" contains an invalid field`,
            400,
            'INVALID_SECTION_FIELD'
        );
      }

      if (typeof field.label !== 'string' || !field.label.trim()) {
        throw new AppError(
            `Field ${fieldIndex + 1} in section "${section.title}" needs a label`,
            400,
            'INVALID_FIELD_LABEL'
        );
      }

      if (!FIELD_TYPES.includes(field.type)) {
        throw new AppError(
            `Field "${field.label}" has an invalid type`,
            400,
            'INVALID_FIELD_TYPE'
        );
      }

      if (field.required !== undefined && typeof field.required !== 'boolean') {
        throw new AppError(
            `Field "${field.label}" required must be true or false`,
            400,
            'INVALID_FIELD_REQUIRED'
        );
      }

      if (['Dropdown', 'Checkbox'].includes(field.type)) {
        if (!Array.isArray(field.options) || field.options.length === 0) {
          throw new AppError(
              `Field "${field.label}" needs at least one option`,
              400,
              'INVALID_FIELD_OPTIONS'
          );
        }

        const options = field.options.map(option =>
          typeof option === 'string' ? option.trim() : ''
        );

        if (options.some(option => !option)) {
          throw new AppError(
              `Field "${field.label}" contains an empty or invalid option`,
              400,
              'INVALID_FIELD_OPTIONS'
          );
        }

        if (new Set(options).size !== options.length) {
          throw new AppError(
              `Field "${field.label}" contains duplicate options`,
              400,
              'DUPLICATE_FIELD_OPTIONS'
          );
        }

        field.options = options;
      }

      field.label = field.label.trim();
      if (field.required === undefined) field.required = true;
    }
  }

  const allFields = resolved.flatMap(section => section.fields);
  const { ids, emptyLabels, duplicates } = deriveFieldIds(allFields);

  if (emptyLabels.length || duplicates.length) {
    throw new AppError(
        describeFieldIdProblems({ emptyLabels, duplicates }),
        400,
        'INVALID_FIELD_IDS'
    );
  }

  let fieldIndex = 0;
  for (const section of resolved) {
    for (const field of section.fields) {
      field.id = ids[fieldIndex++];
    }
  }

  const sectionIds = resolveSectionIds(resolved);
  resolved.forEach((section, index) => {
    section.id = sectionIds[index];
  });

  const seenIds = new Set();
  for (const field of allFields) {
    if (RESERVED_FIELD_IDS.has(field.id)) {
      throw new AppError(
          `Field label "${field.label}" produces a reserved field ID`,
          400,
          'INVALID_FIELD_IDS'
      );
    }
    if (seenIds.has(field.id)) {
      throw new AppError(
          `Multiple fields use the ID "${field.id}"`,
          400,
          'INVALID_FIELD_IDS'
      );
    }
    seenIds.add(field.id);
  }

  assertValidSectionFlow(resolved, AppError);
  return resolved;
}

async function validateFormDocument(form, AppError) {
  try {
    await form.validate();
  } catch (error) {
    if (error.name === 'ValidationError' || error.name === 'CastError') {
      throw new AppError(error.message, 400, 'INVALID_FORM_DEFINITION');
    }
    throw error;
  }
}

module.exports = {
  FIELD_TYPES,
  RESERVED_FIELD_IDS,
  resolveFormSections,
  validateFormDocument
};
