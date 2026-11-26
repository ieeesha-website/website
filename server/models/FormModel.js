const mongoose = require('mongoose');
const { slugifyFieldLabel } = require('../utils/fieldId');
const {
  resolveSectionIds,
  validateSectionFlow,
  SECTION_ID_RE,
  SUBMIT
} = require('../utils/sectionFlow');
const { RESERVED_FIELD_IDS } = require('../utils/formDefinition');

const fieldSchema = new mongoose.Schema({
  id: {
    type: String,
    required: true,
    trim: true,
    maxlength: 128,
    validate: {
      validator: value =>
        typeof value === 'string' &&
        /^[A-Za-z0-9_-]{1,128}$/.test(value) &&
        !RESERVED_FIELD_IDS.has(value),
      message: 'Field ID must be a unique, non-reserved identifier'
    }
  },
  label: {
    type: String,
    required: true,
    trim: true,
    validate: {
      validator: value => typeof value === 'string' && value.trim() !== '',
      message: 'Label must be a non-empty string'
    }
  },
  type: {
    type: String,
    required: true,
    enum: ['TextInput', 'TextArea', 'Dropdown', 'Checkbox', 'FileUpload']
  },
  required: {
    type: Boolean,
    default: true
  },
  options: {
    type: [{ type: String, trim: true }],
    default: undefined,
    validate: {
      validator: function(options) {
        if (!['Dropdown', 'Checkbox'].includes(this.type)) return true;
        if (
          !Array.isArray(options) ||
          options.length === 0 ||
          options.some(option => !option)
        ) {
          return false;
        }
        return new Set(options).size === options.length;
      },
      message: 'Choice fields require non-empty, unique options'
    }
  },
  routes: {
    type: [new mongoose.Schema({
      option: { type: String, required: true, trim: true },
      goToSection: { type: String, required: true, trim: true }
    }, { _id: false })],
    default: undefined,
    validate: {
      validator: function(routes) {
        if (!routes || routes.length === 0) return true;
        if (!['Dropdown', 'Checkbox'].includes(this.type)) return false;

        const options = this.options || [];
        const seen = new Set();
        return routes.every(route => {
          if (
            !route ||
            !route.option ||
            !route.goToSection ||
            !options.includes(route.option) ||
            seen.has(route.option)
          ) {
            return false;
          }
          seen.add(route.option);
          return true;
        });
      },
      message: 'Routes must reference unique existing options on a choice field'
    }
  }
});

const sectionSchema = new mongoose.Schema({
  id: {
    type: String,
    trim: true,
    validate: {
      validator: value =>
        value === undefined ||
        value === null ||
        (SECTION_ID_RE.test(value) && value !== SUBMIT),
      message: 'Section ID is invalid or reserved'
    }
  },
  title: {
    type: String,
    trim: true
  },
  description: {
    type: String,
    default: ''
  },
  nextSection: {
    type: String,
    default: '',
    trim: true
  },
  fields: {
    type: [fieldSchema],
    default: []
  }
});

const formSchema = new mongoose.Schema({
  activityID: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Activity'
  },
  status: {
    type: String,
    enum: ['Active', 'Closed', 'Draft', 'upcoming'],
    default: 'Draft'
  },
  title: String,
  description: String,
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },

  sections: {
    type: [sectionSchema],
    default: []
  },

  // Retained to read legacy forms created before fields were grouped into sections.
  fields: {
    type: [fieldSchema],
    default: undefined
  },

  type: {
    type: String,
    enum: ['attendance', 'recruitment', 'feedback', 'workshop', 'survey', 'other'],
    default: 'other'
  },
  startDate: {
    type: Date,
    required: true
  },
  endDate: {
    type: Date,
    required: true
  },
  maxSubmissions: {
    type: Number,
    default: Number.MAX_SAFE_INTEGER,
    min: 1,
    validate: {
      validator: Number.isInteger,
      message: 'maxSubmissions must be a positive integer'
    }
  },
  submissionCount: {
    type: Number,
    min: 0,
    select: false,
    validate: {
      validator: Number.isInteger,
      message: 'submissionCount must be a non-negative integer'
    }
  },
  sendEmailOnSubmission: {
    type: Boolean,
    default: false
  },
  submissionEmailSubject: {
    type: String,
    trim: true,
    default: '',
    maxlength: 200
  },
  submissionEmailBody: {
    type: String,
    trim: true,
    default: '',
    maxlength: 5000
  },
  requiresLogin: {
    type: Boolean,
    default: false
  }
}, {
  timestamps: true,
  toJSON: {
    transform(_document, value) {
      if (Array.isArray(value.sections) && value.sections.length) {
        value.fields = value.sections.flatMap(section => section.fields || []);
      }
      return value;
    }
  }
});

/**
 * Legacy forms used a flat `fields` array. Convert them on their next save and
 * resolve IDs only when the section definition is being changed.
 */
formSchema.pre('validate', function() {
  if ((!this.sections || this.sections.length === 0) && this.fields?.length) {
    this.sections = [{
      id: 'registration',
      title: 'Registration',
      fields: this.fields
    }];
    this.fields = undefined;
  }

  if (!this.isModified('sections')) return;

  const sections = this.sections || [];
  const resolvedIds = resolveSectionIds(sections);

  sections.forEach((section, index) => {
    section.id = resolvedIds[index];

    section.fields.forEach(field => {
      if (!field.id && field.label) {
        field.id = slugifyFieldLabel(field.label);
      }
    });
  });

  const problems = validateSectionFlow(sections);
  if (problems.length) {
    this.invalidate(
        'sections',
        problems.join(' '),
        sections,
        'INVALID_SECTION_FLOW'
    );
  }
});

const Form = mongoose.model('Form', formSchema);

module.exports = Form;
